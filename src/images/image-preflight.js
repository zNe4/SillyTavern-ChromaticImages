/**
 * @file Browser-native image dimension preflight inspector for Chromatic Images.
 *
 * Enforces:
 * - Minimum width and height of 8 pixels.
 * - Maximum width and height of 16384 pixels.
 * - Primary decoding via createImageBitmap() with guaranteed bitmap.close() resource cleanup.
 * - Robust fallback decoding via browser-native Image() and URL.createObjectURL().
 * - Resource cleanup and AbortSignal cancellation support across both decoders.
 * - Late settlement suppression: late decoder settlement after cancellation releases resources
 *   without marking the operation successful.
 * - Zero external dependencies, pure dependency-injection seams for deterministic testing.
 */

export const IMAGE_MIN_DIMENSION = 8;
export const IMAGE_MAX_DIMENSION = 16384;

export const PREFLIGHT_ERROR_CODES = Object.freeze({
    INVALID_OPTIONS: 'invalid-options',
    CANCELLED: 'cancelled',
    INVALID_BLOB_OBJECT: 'invalid-blob-object',
    EMPTY_IMAGE_BLOB: 'empty-image-blob',
    DECODE_FAILED: 'decode-failed',
    DIMENSIONS_OUT_OF_RANGE: 'dimensions-out-of-range',
    DIMENSIONS_UNKNOWN: 'dimensions-unknown',
});

const ALLOWED_PREFLIGHT_KEYS = new Set([
    'signal',
    'createImageBitmap',
    'createImage',
    'createObjectURL',
    'revokeObjectURL',
]);

/**
 * Checks whether a value is a plain JavaScript object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Validates whether dimensions are strictly positive finite integers.
 *
 * @param {unknown} w
 * @param {unknown} h
 * @returns {boolean}
 */
function isValidDimensionNumber(w, h) {
    return (
        typeof w === 'number' &&
        typeof h === 'number' &&
        Number.isFinite(w) &&
        Number.isFinite(h) &&
        Number.isInteger(w) &&
        Number.isInteger(h) &&
        w > 0 &&
        h > 0
    );
}

/**
 * Validates dimension bounds [IMAGE_MIN_DIMENSION, IMAGE_MAX_DIMENSION].
 *
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function isWithinDimensionBounds(w, h) {
    return (
        w >= IMAGE_MIN_DIMENSION &&
        w <= IMAGE_MAX_DIMENSION &&
        h >= IMAGE_MIN_DIMENSION &&
        h <= IMAGE_MAX_DIMENSION
    );
}

/**
 * Inspects the pixel dimensions of an image Blob or File.
 *
 * @param {unknown} blob Image Blob or File object.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] Optional caller AbortSignal.
 * @param {Function} [options.createImageBitmap] Optional injected createImageBitmap.
 * @param {Function} [options.createImage] Optional injected Image constructor/factory.
 * @param {Function} [options.createObjectURL] Optional injected URL.createObjectURL.
 * @param {Function} [options.revokeObjectURL] Optional injected URL.revokeObjectURL.
 * @returns {Promise<{
 *   ok: boolean,
 *   width: number | null,
 *   height: number | null,
 *   errors: string[],
 * }>}
 */
export async function inspectImageDimensions(blob, options = {}) {
    if (!isPlainObject(options)) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.INVALID_OPTIONS],
        };
    }

    for (const key of Object.keys(options)) {
        if (!ALLOWED_PREFLIGHT_KEYS.has(key)) {
            return {
                ok: false,
                width: null,
                height: null,
                errors: [PREFLIGHT_ERROR_CODES.INVALID_OPTIONS],
            };
        }
    }

    if ('signal' in options && options.signal !== undefined) {
        const sig = options.signal;
        if (
            sig === null ||
            typeof sig !== 'object' ||
            typeof sig.aborted !== 'boolean' ||
            typeof sig.addEventListener !== 'function' ||
            typeof sig.removeEventListener !== 'function'
        ) {
            return {
                ok: false,
                width: null,
                height: null,
                errors: [PREFLIGHT_ERROR_CODES.INVALID_OPTIONS],
            };
        }
    }

    if (options.signal?.aborted) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
        };
    }

    if (
        blob === null ||
        typeof blob !== 'object' ||
        typeof blob.size !== 'number' ||
        typeof blob.slice !== 'function'
    ) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.INVALID_BLOB_OBJECT],
        };
    }

    if (blob.size === 0) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.EMPTY_IMAGE_BLOB],
        };
    }

    // 1. Primary Inspector: createImageBitmap
    const createBitmapFn =
        options.createImageBitmap ?? globalThis.createImageBitmap;

    let primaryAttempted = false;

    if (typeof createBitmapFn === 'function') {
        primaryAttempted = true;
        let callerAbortHandler = null;

        const abortPromise = new Promise((_, reject) => {
            if (options.signal?.aborted) {
                reject({ kind: PREFLIGHT_ERROR_CODES.CANCELLED });
                return;
            }
            if (options.signal) {
                callerAbortHandler = () => {
                    reject({ kind: PREFLIGHT_ERROR_CODES.CANCELLED });
                };
                options.signal.addEventListener('abort', callerAbortHandler, {
                    once: true,
                });
            }
        });

        let bitmap = null;
        try {
            const bitmapPromise = Promise.resolve(createBitmapFn(blob));

            // Ensure late settling bitmap is closed if cancelled before settlement
            bitmapPromise
                .then((lateBitmap) => {
                    if (
                        options.signal?.aborted &&
                        lateBitmap &&
                        typeof lateBitmap.close === 'function'
                    ) {
                        try {
                            lateBitmap.close();
                        } catch {
                            // ignore
                        }
                    }
                })
                .catch(() => {});

            bitmap = await Promise.race([bitmapPromise, abortPromise]);

            if (options.signal?.aborted) {
                if (bitmap && typeof bitmap.close === 'function') {
                    try {
                        bitmap.close();
                    } catch {
                        // ignore
                    }
                }
                return {
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
                };
            }

            const w = bitmap?.width;
            const h = bitmap?.height;

            if (!isValidDimensionNumber(w, h)) {
                return {
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.DIMENSIONS_UNKNOWN],
                };
            }

            if (!isWithinDimensionBounds(w, h)) {
                return {
                    ok: false,
                    width: w,
                    height: h,
                    errors: [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE],
                };
            }

            return {
                ok: true,
                width: w,
                height: h,
                errors: [],
            };
        } catch (err) {
            if (
                options.signal?.aborted ||
                (err && err.kind === PREFLIGHT_ERROR_CODES.CANCELLED)
            ) {
                return {
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
                };
            }
            // Primary decoder failed: fall through to fallback decoder
        } finally {
            if (options.signal && callerAbortHandler) {
                options.signal.removeEventListener('abort', callerAbortHandler);
                callerAbortHandler = null;
            }
            if (bitmap && typeof bitmap.close === 'function') {
                try {
                    bitmap.close();
                } catch {
                    // ignore
                }
            }
        }
    }

    if (options.signal?.aborted) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
        };
    }

    // 2. Fallback Inspector: Image() + URL.createObjectURL()
    const createUrlFn =
        options.createObjectURL ?? globalThis.URL?.createObjectURL;
    const revokeUrlFn =
        options.revokeObjectURL ?? globalThis.URL?.revokeObjectURL;
    const createImageFn =
        options.createImage ??
        (() => (typeof globalThis.Image === 'function' ? new globalThis.Image() : null));

    if (
        typeof createUrlFn !== 'function' ||
        typeof revokeUrlFn !== 'function' ||
        typeof createImageFn !== 'function'
    ) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
        };
    }

    let img;
    try {
        img = createImageFn();
    } catch {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
        };
    }

    if (!img || typeof img !== 'object') {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
        };
    }

    let objectUrl = null;
    try {
        objectUrl = createUrlFn(blob);
    } catch {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
        };
    }

    if (typeof objectUrl !== 'string' || objectUrl.length === 0) {
        return {
            ok: false,
            width: null,
            height: null,
            errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
        };
    }

    return new Promise((resolve) => {
        let settled = false;

        const cleanup = () => {
            img.onload = null;
            img.onerror = null;
            if (options.signal && onAbort) {
                options.signal.removeEventListener('abort', onAbort);
            }
            if (objectUrl && typeof revokeUrlFn === 'function') {
                try {
                    revokeUrlFn(objectUrl);
                } catch {
                    // ignore
                }
                objectUrl = null;
            }
        };

        const onAbort = () => {
            if (!settled) {
                settled = true;
                cleanup();
                resolve({
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
                });
            }
        };

        if (options.signal) {
            options.signal.addEventListener('abort', onAbort, { once: true });
            if (options.signal.aborted) {
                onAbort();
                return;
            }
        }

        img.onload = () => {
            if (settled) {
                return;
            }
            settled = true;
            const w = img.naturalWidth ?? img.width;
            const h = img.naturalHeight ?? img.height;
            cleanup();

            if (options.signal?.aborted) {
                resolve({
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
                });
                return;
            }

            if (!isValidDimensionNumber(w, h)) {
                resolve({
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.DIMENSIONS_UNKNOWN],
                });
                return;
            }

            if (!isWithinDimensionBounds(w, h)) {
                resolve({
                    ok: false,
                    width: w,
                    height: h,
                    errors: [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE],
                });
                return;
            }

            resolve({
                ok: true,
                width: w,
                height: h,
                errors: [],
            });
        };

        img.onerror = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();

            if (options.signal?.aborted) {
                resolve({
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.CANCELLED],
                });
                return;
            }

            resolve({
                ok: false,
                width: null,
                height: null,
                errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
            });
        };

        try {
            img.src = objectUrl;
        } catch {
            if (!settled) {
                settled = true;
                cleanup();
                resolve({
                    ok: false,
                    width: null,
                    height: null,
                    errors: [PREFLIGHT_ERROR_CODES.DECODE_FAILED],
                });
            }
        }
    });
}

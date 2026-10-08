/**
 * @file SillyTavern-local image I/O primitives for Chromatic Images.
 *
 * Implements:
 * - Strict durable user image path validation (/user/images/...).
 * - PNG/JPEG/WEBP magic byte signature detection.
 * - Browser-native Blob/File to canonical data URL conversion (FileReader).
 * - Same-origin local path reading without CSRF header coupling.
 * - Sequential multi-reference preparation with pre-conversion budget checks.
 * - Generated raw base64 validation and upload to POST /api/images/upload.
 *
 * Guarantees:
 * - Zero provider network calls; zero paid requests.
 * - Zero logging or echoing of prompts, credentials, base64, or data URLs.
 * - Zero Node Buffer dependencies in production browser code.
 * - Fail-closed deterministic structured returns on all validation/network errors.
 */

export const USER_IMAGES_ROOT = '/user/images/';
export const MAX_PATH_CODE_UNITS = 4096;
export const MAX_FILENAME_CODE_UNITS = 128;

// Hard reference constants (clamp-down seams only; callers cannot expand)
export const MAX_REFERENCE_COUNT = 3;
export const MAX_REFERENCE_IMAGE_BYTES = 31457280; // 30 MiB
export const MAX_REFERENCE_AGGREGATE_BYTES = 31457280; // 30 MiB

// Defensive upload ceiling for generated images
export const MAX_GENERATED_IMAGE_BYTES = 31457280; // 30 MiB

// Route upload endpoint
export const IMAGE_UPLOAD_ROUTE = '/api/images/upload';

// Supported formats and MIME types
export const SUPPORTED_IMAGE_FORMATS = Object.freeze(['png', 'jpeg', 'webp']);
export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze([
    'image/png',
    'image/jpeg',
    'image/webp',
]);

// Error codes
export const LOCAL_IO_ERROR_CODES = Object.freeze({
    // Options and validation errors
    INVALID_OPTIONS: 'invalid-options',
    CANCELLED: 'cancelled',
    DEPENDENCY_MISSING: 'dependency-missing',

    // Path errors
    INVALID_PATH_TYPE: 'invalid-path-type',
    PATH_EMPTY: 'path-empty',
    PATH_TOO_LONG: 'path-too-long',
    PATH_NOT_TRIMMED: 'path-not-trimmed',
    PATH_FORBIDDEN_CHARACTERS: 'path-forbidden-characters',
    PATH_INVALID_ROOT: 'path-invalid-root',
    PATH_DOUBLE_SLASH: 'path-double-slash',
    PATH_TRAILING_SLASH: 'path-trailing-slash',
    PATH_TRAVERSAL_DETECTED: 'path-traversal-detected',
    PATH_ENCODED_TRAVERSAL: 'path-encoded-traversal',
    PATH_MALFORMED_ENCODING: 'path-malformed-encoding',
    UNSUPPORTED_IMAGE_EXTENSION: 'unsupported-image-extension',

    // Signature errors
    TRUNCATED_IMAGE_BYTES: 'truncated-image-bytes',
    UNSUPPORTED_IMAGE_SIGNATURE: 'unsupported-image-signature',
    MIME_SIGNATURE_MISMATCH: 'mime-signature-mismatch',

    // Blob errors
    INVALID_BLOB_OBJECT: 'invalid-blob-object',
    EMPTY_IMAGE_BLOB: 'empty-image-blob',
    IMAGE_SIZE_EXCEEDS_LIMIT: 'image-size-exceeds-limit',
    BLOB_READ_FAILED: 'blob-read-failed',
    MALFORMED_READER_OUTPUT: 'malformed-reader-output',

    // Fetch errors
    FETCH_NETWORK_ERROR: 'fetch-network-error',
    FETCH_NON_2XX_STATUS: 'fetch-non-2xx-status',
    FETCH_REDIRECT_DETECTED: 'fetch-redirect-detected',

    // Reference batch errors
    TOO_MANY_REFERENCES: 'too-many-references',
    INVALID_REFERENCE_INPUT: 'invalid-reference-input',
    AGGREGATE_SIZE_EXCEEDED: 'aggregate-reference-size-exceeded',

    // Upload errors
    DATA_URL_REJECTED: 'data-url-rejected',
    INVALID_BASE64_PAYLOAD: 'invalid-base64-payload',
    INVALID_FILENAME: 'invalid-filename',
    UPLOAD_NETWORK_ERROR: 'upload-network-error',
    UPLOAD_HTTP_ERROR: 'upload-http-error',
    UPLOAD_MALFORMED_RESPONSE: 'upload-malformed-response',
    UPLOAD_INVALID_RETURNED_PATH: 'upload-invalid-returned-path',
});

const BASE64_PAYLOAD_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;

const ALLOWED_SIGNATURE_OPTION_KEYS = new Set(['expectedMime']);
const ALLOWED_BLOB_OPTION_KEYS = new Set(['maxBytes', 'signal', 'readDataUrl']);
const ALLOWED_LOAD_OPTION_KEYS = new Set(['maxBytes', 'signal', 'readDataUrl', 'fetch']);
const ALLOWED_PREPARE_OPTION_KEYS = new Set([
    'maxReferences',
    'maxAggregateBytes',
    'maxSingleImageBytes',
    'signal',
    'readDataUrl',
    'fetch',
]);
const ALLOWED_UPLOAD_OPTION_KEYS = new Set([
    'image',
    'filename',
    'maxBytes',
    'signal',
    'fetch',
    'getRequestHeaders',
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
 * Validates that an options object has only permitted keys.
 *
 * @param {unknown} options
 * @param {Set<string>} allowedKeys
 * @param {string[]} errors
 * @returns {boolean}
 */
function validateAllowedOptionKeys(options, allowedKeys, errors) {
    if (!isPlainObject(options)) {
        errors.push(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
        return false;
    }
    for (const key of Object.keys(options)) {
        if (!allowedKeys.has(key)) {
            errors.push(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
            return false;
        }
    }
    return true;
}

/**
 * Validates and resolves a limit option against a hard ceiling.
 *
 * Behavior:
 * - undefined/omitted -> returns hardLimit
 * - valid positive integer <= hardLimit -> returns requested value
 * - valid positive integer > hardLimit -> clamps to hardLimit
 * - invalid explicit value -> records INVALID_OPTIONS and returns null
 *
 * @param {unknown} value
 * @param {number} hardLimit
 * @param {string[]} errors
 * @returns {number | null}
 */
export function resolveClampedLimit(value, hardLimit, errors) {
    if (value === undefined) {
        return hardLimit;
    }
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0
    ) {
        if (!errors.includes(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS)) {
            errors.push(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
        }
        return null;
    }
    return Math.min(value, hardLimit);
}

/**
 * Validates an AbortSignal object shape.
 *
 * @param {unknown} signal
 * @param {string[]} errors
 * @returns {{ ok: boolean, isCancelled: boolean }}
 */
function validateAbortSignal(signal, errors) {
    if (signal === undefined) {
        return { ok: true, isCancelled: false };
    }
    if (
        signal === null ||
        typeof signal !== 'object' ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function'
    ) {
        if (!errors.includes(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS)) {
            errors.push(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
        }
        return { ok: false, isCancelled: false };
    }
    return { ok: true, isCancelled: signal.aborted };
}

/**
 * Determines whether an error was caused by caller cancellation.
 *
 * @param {unknown} err
 * @param {AbortSignal | undefined} signal
 * @returns {boolean}
 */
function isAbortError(err, signal) {
    if (signal?.aborted) {
        return true;
    }
    if (err && typeof err === 'object') {
        if (err.name === 'AbortError' || err.kind === LOCAL_IO_ERROR_CODES.CANCELLED) {
            return true;
        }
    }
    return false;
}

/**
 * Validates whether a path qualifies as a strict durable SillyTavern user image path.
 *
 * Strict Grammar Rules:
 * - String length between 1 and 4096 code units.
 * - Trimmed (no leading/trailing whitespace).
 * - No NUL or control characters (0x00-0x1F, 0x7F).
 * - No backslashes.
 * - No query string (?) or fragment (#).
 * - No scheme indicator (://) or protocol-relative (//).
 * - Must strictly start with '/user/images/'.
 * - Must not start with '/user/images//' (no double slash).
 * - Must not be exactly '/user/images/' (cannot end with slash).
 * - No consecutive slashes (//) anywhere.
 * - No trailing slash.
 * - Percent-encoding validation: must be valid URI encoding, no encoded slashes, no encoded dots, no double-encoding.
 * - Path traversal validation: no '.' or '..' segments; no trailing dots in segments.
 * - File extension must be one of: .png, .jpg, .jpeg, .webp (case-insensitive check).
 *
 * @param {unknown} path
 * @returns {{ ok: boolean, path: string | null, errors: string[] }}
 */
export function validateDurableUserImagePath(path) {
    if (typeof path !== 'string') {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.INVALID_PATH_TYPE] };
    }
    if (path.length === 0) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_EMPTY] };
    }
    if (path.length > MAX_PATH_CODE_UNITS) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_TOO_LONG] };
    }
    if (path !== path.trim()) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_NOT_TRIMMED] };
    }

    // Forbidden characters
    if (/[\x00-\x1f\x7f]/.test(path)) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS] };
    }
    if (path.includes('\\') || path.includes('?') || path.includes('#')) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS] };
    }
    if (path.includes('://') || path.startsWith('//')) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS] };
    }

    // Root check
    if (!path.startsWith(USER_IMAGES_ROOT)) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_INVALID_ROOT] };
    }
    if (path.startsWith(`${USER_IMAGES_ROOT}/`)) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_DOUBLE_SLASH] };
    }
    if (path === USER_IMAGES_ROOT) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_TRAILING_SLASH] };
    }
    if (path.includes('//')) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_DOUBLE_SLASH] };
    }
    if (path.endsWith('/')) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_TRAILING_SLASH] };
    }

    // Percent-encoding checks
    if (path.includes('%')) {
        let decoded;
        try {
            decoded = decodeURIComponent(path);
        } catch {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_MALFORMED_ENCODING] };
        }

        // Encoded slashes, backslashes, dots, or double-encoding (%25)
        if (/%2f|%5c/i.test(path)) {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL] };
        }
        if (/%2e/i.test(path)) {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL] };
        }
        if (/%25/i.test(path)) {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL] };
        }

        // Decoded string traversal check
        if (!decoded.startsWith(USER_IMAGES_ROOT) || decoded.includes('\\') || /[\x00-\x1f\x7f]/.test(decoded)) {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL] };
        }
        const decodedSegments = decoded.slice(USER_IMAGES_ROOT.length).split('/');
        for (const seg of decodedSegments) {
            if (seg === '.' || seg === '..') {
                return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL] };
            }
        }
    }

    // Segment checks
    const segments = path.slice(USER_IMAGES_ROOT.length).split('/');
    for (const segment of segments) {
        if (segment === '.' || segment === '..') {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_TRAVERSAL_DETECTED] };
        }
        if (segment.endsWith('.')) {
            return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS] };
        }
    }

    // Extension check on final segment
    const filename = segments[segments.length - 1];
    const extMatch = filename.match(/\.([A-Za-z0-9]+)$/);
    if (!extMatch) {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_EXTENSION] };
    }
    const ext = extMatch[1].toLowerCase();
    if (ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg' && ext !== 'webp') {
        return { ok: false, path: null, errors: [LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_EXTENSION] };
    }

    return { ok: true, path, errors: [] };
}

/**
 * Detects supported image format (PNG, JPEG, WEBP) from magic bytes.
 *
 * @param {Uint8Array | ArrayBuffer | unknown} bytes
 * @param {object} [options]
 * @param {string} [options.expectedMime]
 * @returns {{
 *   ok: boolean,
 *   format: 'png' | 'jpeg' | 'webp' | null,
 *   mime: 'image/png' | 'image/jpeg' | 'image/webp' | null,
 *   errors: string[],
 * }}
 */
export function detectSupportedImageFormat(bytes, options = {}) {
    const errors = [];
    if (!validateAllowedOptionKeys(options, ALLOWED_SIGNATURE_OPTION_KEYS, errors)) {
        return { ok: false, format: null, mime: null, errors };
    }

    let u8;
    if (bytes instanceof Uint8Array) {
        u8 = bytes;
    } else if (bytes instanceof ArrayBuffer) {
        u8 = new Uint8Array(bytes);
    } else if (ArrayBuffer.isView(bytes)) {
        u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else {
        return { ok: false, format: null, mime: null, errors: [LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_SIGNATURE] };
    }

    if (u8.length < 3) {
        return { ok: false, format: null, mime: null, errors: [LOCAL_IO_ERROR_CODES.TRUNCATED_IMAGE_BYTES] };
    }

    let detectedFormat = null;
    let detectedMime = null;

    // PNG check (requires >= 8 bytes: 89 50 4E 47 0D 0A 1A 0A)
    if (
        u8.length >= 8 &&
        u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
        u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a
    ) {
        detectedFormat = 'png';
        detectedMime = 'image/png';
    }
    // JPEG check (requires >= 3 bytes: FF D8 FF)
    else if (
        u8.length >= 3 &&
        u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff
    ) {
        detectedFormat = 'jpeg';
        detectedMime = 'image/jpeg';
    }
    // WEBP check (requires >= 12 bytes: RIFF....WEBP)
    else if (
        u8.length >= 12 &&
        u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && // RIFF
        u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50   // WEBP
    ) {
        detectedFormat = 'webp';
        detectedMime = 'image/webp';
    } else {
        // Potential truncated prefix checks
        if (u8.length < 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e) {
            return { ok: false, format: null, mime: null, errors: [LOCAL_IO_ERROR_CODES.TRUNCATED_IMAGE_BYTES] };
        }
        if (u8.length < 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) {
            return { ok: false, format: null, mime: null, errors: [LOCAL_IO_ERROR_CODES.TRUNCATED_IMAGE_BYTES] };
        }
        return { ok: false, format: null, mime: null, errors: [LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_SIGNATURE] };
    }

    if (options.expectedMime !== undefined) {
        if (typeof options.expectedMime !== 'string' || options.expectedMime.toLowerCase() !== detectedMime) {
            return { ok: false, format: null, mime: null, errors: [LOCAL_IO_ERROR_CODES.MIME_SIGNATURE_MISMATCH] };
        }
    }

    return { ok: true, format: detectedFormat, mime: detectedMime, errors: [] };
}

/**
 * Validates reader-generated data URL string.
 *
 * @param {unknown} result
 * @returns {{ ok: boolean, payload: string | null }}
 */
function validateReaderDataUrlResult(result) {
    if (typeof result !== 'string' || !result.startsWith('data:')) {
        return { ok: false, payload: null };
    }
    const commaIndex = result.indexOf(';base64,');
    if (commaIndex === -1) {
        return { ok: false, payload: null };
    }
    const payload = result.slice(commaIndex + 8);
    if (payload.length === 0 || !BASE64_PAYLOAD_PATTERN.test(payload)) {
        return { ok: false, payload: null };
    }
    return { ok: true, payload };
}

/**
 * Reads a Blob as a data URL using browser FileReader.
 *
 * @param {Blob} blob
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
function readBlobViaFileReader(blob, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            const abortErr = new Error('Operation cancelled by caller');
            abortErr.name = 'AbortError';
            reject(abortErr);
            return;
        }

        let settled = false;
        const reader = new FileReader();

        const cleanup = () => {
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
        };

        const onAbort = () => {
            if (!settled) {
                settled = true;
                cleanup();
                try {
                    reader.abort();
                } catch {
                    // Ignore abort errors
                }
                const abortErr = new Error('Operation cancelled by caller');
                abortErr.name = 'AbortError';
                reject(abortErr);
            }
        };

        reader.onload = () => {
            if (!settled) {
                settled = true;
                cleanup();
                resolve(reader.result);
            }
        };

        reader.onerror = () => {
            if (!settled) {
                settled = true;
                cleanup();
                reject(reader.error || new Error('FileReader error'));
            }
        };

        reader.onabort = () => {
            if (!settled) {
                settled = true;
                cleanup();
                const abortErr = new Error('Operation aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
            }
        };

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        if (signal?.aborted) {
            onAbort();
            return;
        }

        reader.readAsDataURL(blob);
    });
}

/**
 * Converts a validated image Blob or File to a canonical data URL.
 *
 * @param {unknown} blob
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.readDataUrl]
 * @returns {Promise<{
 *   ok: boolean,
 *   dataUrl: string | null,
 *   format: 'png' | 'jpeg' | 'webp' | null,
 *   mime: 'image/png' | 'image/jpeg' | 'image/webp' | null,
 *   byteLength: number,
 *   errors: string[],
 * }>}
 */
export async function imageBlobToDataUrl(blob, options = {}) {
    const errors = [];
    if (!validateAllowedOptionKeys(options, ALLOWED_BLOB_OPTION_KEYS, errors)) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, errors };
    }

    const effectiveMaxBytes = resolveClampedLimit(options.maxBytes, MAX_REFERENCE_IMAGE_BYTES, errors);
    const signalState = validateAbortSignal(options.signal, errors);

    if (errors.length > 0) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, errors };
    }
    if (signalState.isCancelled) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    if (
        blob === null ||
        typeof blob !== 'object' ||
        typeof blob.size !== 'number' ||
        typeof blob.slice !== 'function'
    ) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, errors: [LOCAL_IO_ERROR_CODES.INVALID_BLOB_OBJECT] };
    }

    if (blob.size === 0) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, errors: [LOCAL_IO_ERROR_CODES.EMPTY_IMAGE_BLOB] };
    }

    if (blob.size > effectiveMaxBytes) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT] };
    }

    // Check signature prefix before full data-URL conversion
    let prefixBuffer;
    try {
        const prefixSlice = blob.slice(0, 16);
        prefixBuffer = await prefixSlice.arrayBuffer();
    } catch (err) {
        if (isAbortError(err, options.signal)) {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.BLOB_READ_FAILED] };
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    const sigResult = detectSupportedImageFormat(prefixBuffer);
    if (!sigResult.ok) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: sigResult.errors };
    }

    // Check declared MIME if present
    if (typeof blob.type === 'string' && blob.type.trim().length > 0) {
        const normalizedBlobType = blob.type.trim().toLowerCase();
        if (
            (normalizedBlobType.startsWith('image/') || SUPPORTED_IMAGE_MIME_TYPES.includes(normalizedBlobType)) &&
            normalizedBlobType !== sigResult.mime
        ) {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.MIME_SIGNATURE_MISMATCH] };
        }
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    // Data-URL conversion
    let rawDataUrlResult;
    try {
        if (typeof options.readDataUrl === 'function') {
            rawDataUrlResult = await options.readDataUrl(blob, { signal: options.signal });
        } else if (typeof globalThis.FileReader === 'function') {
            rawDataUrlResult = await readBlobViaFileReader(blob, options.signal);
        } else {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING] };
        }
    } catch (err) {
        if (isAbortError(err, options.signal)) {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.BLOB_READ_FAILED] };
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    // Validate reader output
    const validation = validateReaderDataUrlResult(rawDataUrlResult);
    if (!validation.ok) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: blob.size, errors: [LOCAL_IO_ERROR_CODES.MALFORMED_READER_OUTPUT] };
    }

    const canonicalDataUrl = `data:${sigResult.mime};base64,${validation.payload}`;
    return {
        ok: true,
        dataUrl: canonicalDataUrl,
        format: sigResult.format,
        mime: sigResult.mime,
        byteLength: blob.size,
        errors: [],
    };
}

/**
 * Loads a SillyTavern-local user image path as a canonical data URL.
 *
 * Guarantees:
 * - Strictly same-origin GET with redirect: 'error'.
 * - No CSRF getRequestHeaders dependency.
 * - Authoritative size check performed before base64 conversion.
 *
 * @param {unknown} path
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.readDataUrl]
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<{
 *   ok: boolean,
 *   dataUrl: string | null,
 *   format: 'png' | 'jpeg' | 'webp' | null,
 *   mime: 'image/png' | 'image/jpeg' | 'image/webp' | null,
 *   byteLength: number,
 *   status: number | null,
 *   errors: string[],
 * }>}
 */
export async function loadUserImageAsDataUrl(path, options = {}) {
    const errors = [];
    if (!validateAllowedOptionKeys(options, ALLOWED_LOAD_OPTION_KEYS, errors)) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors };
    }

    const pathValidation = validateDurableUserImagePath(path);
    if (!pathValidation.ok) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors: pathValidation.errors };
    }

    const effectiveMaxBytes = resolveClampedLimit(options.maxBytes, MAX_REFERENCE_IMAGE_BYTES, errors);
    const signalState = validateAbortSignal(options.signal, errors);

    if (errors.length > 0) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors };
    }
    if (signalState.isCancelled) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    const fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING] };
    }

    let response;
    try {
        response = await fetchFn(pathValidation.path, {
            method: 'GET',
            redirect: 'error',
            credentials: 'same-origin',
            signal: options.signal,
        });
    } catch (err) {
        if (isAbortError(err, options.signal)) {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.FETCH_NETWORK_ERROR] };
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response?.status ?? null, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    if (response === null || typeof response !== 'object') {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.FETCH_NETWORK_ERROR] };
    }

    // Observable redirect detection
    if (response.redirected === true) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response.status ?? null, errors: [LOCAL_IO_ERROR_CODES.FETCH_REDIRECT_DETECTED] };
    }

    if (response.status < 200 || response.status >= 300) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response.status, errors: [LOCAL_IO_ERROR_CODES.FETCH_NON_2XX_STATUS] };
    }

    // Early Content-Length optimization if present
    const clHeader = response.headers?.get ? response.headers.get('content-length') : null;
    if (clHeader !== null) {
        const parsedCl = parseInt(clHeader, 10);
        if (Number.isFinite(parsedCl) && parsedCl > effectiveMaxBytes) {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: parsedCl, status: response.status, errors: [LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT] };
        }
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    let blob;
    try {
        blob = await response.blob();
    } catch (err) {
        if (isAbortError(err, options.signal)) {
            return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response.status, errors: [LOCAL_IO_ERROR_CODES.BLOB_READ_FAILED] };
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: 0, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    const conversion = await imageBlobToDataUrl(blob, {
        maxBytes: effectiveMaxBytes,
        signal: options.signal,
        readDataUrl: options.readDataUrl,
    });

    if (!conversion.ok) {
        return {
            ok: false,
            dataUrl: null,
            format: conversion.format,
            mime: conversion.mime,
            byteLength: conversion.byteLength,
            status: response.status,
            errors: conversion.errors,
        };
    }

    if (options.signal?.aborted) {
        return { ok: false, dataUrl: null, format: null, mime: null, byteLength: conversion.byteLength, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    // Check Content-Type header if present
    const ctHeader = response.headers?.get ? response.headers.get('content-type') : null;
    if (ctHeader && typeof ctHeader === 'string' && ctHeader.trim().length > 0) {
        const mimeInHeader = ctHeader.split(';')[0].trim().toLowerCase();
        if (SUPPORTED_IMAGE_MIME_TYPES.includes(mimeInHeader) && mimeInHeader !== conversion.mime) {
            return {
                ok: false,
                dataUrl: null,
                format: null,
                mime: null,
                byteLength: conversion.byteLength,
                status: response.status,
                errors: [LOCAL_IO_ERROR_CODES.MIME_SIGNATURE_MISMATCH],
            };
        }
    }

    return {
        ok: true,
        dataUrl: conversion.dataUrl,
        format: conversion.format,
        mime: conversion.mime,
        byteLength: conversion.byteLength,
        status: response.status,
        errors: [],
    };
}

/**
 * Prepares multiple reference images sequentially with pre-conversion budget checks.
 *
 * Guarantees:
 * - Hard count limit of 3 references.
 * - Remaining aggregate budget evaluated before each base64 conversion.
 * - Halts immediately without fetching/converting later items if budget exceeded.
 * - Preserves exact source ordering.
 *
 * @param {unknown} inputs
 * @param {object} [options]
 * @param {number} [options.maxReferences]
 * @param {number} [options.maxAggregateBytes]
 * @param {number} [options.maxSingleImageBytes]
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.readDataUrl]
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<{
 *   ok: boolean,
 *   references: string[],
 *   items: Array<{ format: string, mime: string, byteLength: number }>,
 *   totalByteLength: number,
 *   errors: string[],
 * }>}
 */
export async function prepareImageReferences(inputs, options = {}) {
    const errors = [];
    if (!Array.isArray(inputs)) {
        return { ok: false, references: [], items: [], totalByteLength: 0, errors: [LOCAL_IO_ERROR_CODES.INVALID_OPTIONS] };
    }
    if (!validateAllowedOptionKeys(options, ALLOWED_PREPARE_OPTION_KEYS, errors)) {
        return { ok: false, references: [], items: [], totalByteLength: 0, errors };
    }

    const effectiveMaxCount = resolveClampedLimit(options.maxReferences, MAX_REFERENCE_COUNT, errors);
    const effectiveMaxAggregate = resolveClampedLimit(options.maxAggregateBytes, MAX_REFERENCE_AGGREGATE_BYTES, errors);
    const effectiveMaxPerImage = resolveClampedLimit(options.maxSingleImageBytes, MAX_REFERENCE_IMAGE_BYTES, errors);
    const signalState = validateAbortSignal(options.signal, errors);

    if (errors.length > 0) {
        return { ok: false, references: [], items: [], totalByteLength: 0, errors };
    }
    if (signalState.isCancelled) {
        return { ok: false, references: [], items: [], totalByteLength: 0, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    if (inputs.length > effectiveMaxCount) {
        return { ok: false, references: [], items: [], totalByteLength: 0, errors: [LOCAL_IO_ERROR_CODES.TOO_MANY_REFERENCES] };
    }
    if (inputs.length === 0) {
        return { ok: true, references: [], items: [], totalByteLength: 0, errors: [] };
    }

    const references = [];
    const items = [];
    let accumulatedDecodedBytes = 0;

    for (let i = 0; i < inputs.length; i++) {
        if (options.signal?.aborted) {
            return { ok: false, references: [], items: [], totalByteLength: accumulatedDecodedBytes, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }

        const item = inputs[i];
        const remainingBudget = effectiveMaxAggregate - accumulatedDecodedBytes;
        const itemBudget = Math.min(effectiveMaxPerImage, remainingBudget);

        if (itemBudget <= 0) {
            return {
                ok: false,
                references: [],
                items: [],
                totalByteLength: accumulatedDecodedBytes,
                errors: [LOCAL_IO_ERROR_CODES.AGGREGATE_SIZE_EXCEEDED],
            };
        }

        let itemResult;
        if (typeof item === 'string') {
            // Local path input
            itemResult = await loadUserImageAsDataUrl(item, {
                maxBytes: itemBudget,
                signal: options.signal,
                readDataUrl: options.readDataUrl,
                fetch: options.fetch,
            });
        } else if (
            item !== null &&
            typeof item === 'object' &&
            typeof item.size === 'number' &&
            typeof item.slice === 'function'
        ) {
            // Blob / File input: check remaining budget before data-URL conversion
            if (item.size > remainingBudget) {
                return {
                    ok: false,
                    references: [],
                    items: [],
                    totalByteLength: accumulatedDecodedBytes,
                    errors: [LOCAL_IO_ERROR_CODES.AGGREGATE_SIZE_EXCEEDED],
                };
            }
            itemResult = await imageBlobToDataUrl(item, {
                maxBytes: itemBudget,
                signal: options.signal,
                readDataUrl: options.readDataUrl,
            });
        } else {
            return {
                ok: false,
                references: [],
                items: [],
                totalByteLength: accumulatedDecodedBytes,
                errors: [LOCAL_IO_ERROR_CODES.INVALID_REFERENCE_INPUT],
            };
        }

        if (options.signal?.aborted) {
            return {
                ok: false,
                references: [],
                items: [],
                totalByteLength: accumulatedDecodedBytes,
                errors: [LOCAL_IO_ERROR_CODES.CANCELLED],
            };
        }

        if (!itemResult.ok) {
            // If the item failed due to per-item size limit when remaining budget was smaller than per-image limit, map to aggregate limit
            const finalErrors = [...itemResult.errors];
            if (
                finalErrors.includes(LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT) &&
                remainingBudget < effectiveMaxPerImage
            ) {
                const idx = finalErrors.indexOf(LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT);
                finalErrors[idx] = LOCAL_IO_ERROR_CODES.AGGREGATE_SIZE_EXCEEDED;
            }
            return {
                ok: false,
                references: [],
                items: [],
                totalByteLength: accumulatedDecodedBytes,
                errors: finalErrors,
            };
        }

        accumulatedDecodedBytes += itemResult.byteLength;
        references.push(itemResult.dataUrl);
        items.push({
            format: itemResult.format,
            mime: itemResult.mime,
            byteLength: itemResult.byteLength,
        });
    }

    return {
        ok: true,
        references,
        items,
        totalByteLength: accumulatedDecodedBytes,
        errors: [],
    };
}

/**
 * Uploads a validated generated raw base64 image to SillyTavern's local storage route.
 *
 * Guarantees:
 * - Derives upload format ('png', 'jpeg', or 'webp') from binary byte signatures.
 * - SillyTavern defaults to `${Date.now()}.${format}` if filename is omitted.
 * - Strictly single-dispatch POST /api/images/upload (zero retries).
 * - Independently validates the returned path against strict /user/images/... grammar.
 *
 * @param {object} options
 * @param {string} options.image Raw base64 string (no data URL).
 * @param {string} [options.filename] Safe basename <= 128 characters.
 * @param {number} [options.maxBytes] Clamped to MAX_GENERATED_IMAGE_BYTES.
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetch]
 * @param {Function} [options.getRequestHeaders]
 * @returns {Promise<{
 *   ok: boolean,
 *   path: string | null,
 *   format: 'png' | 'jpeg' | 'webp' | null,
 *   byteLength: number,
 *   status: number | null,
 *   errors: string[],
 * }>}
 */
export async function uploadGeneratedImageBase64(options = {}) {
    const errors = [];
    if (!validateAllowedOptionKeys(options, ALLOWED_UPLOAD_OPTION_KEYS, errors)) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors };
    }

    const effectiveMaxBytes = resolveClampedLimit(options.maxBytes, MAX_GENERATED_IMAGE_BYTES, errors);
    const signalState = validateAbortSignal(options.signal, errors);

    if (errors.length > 0) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors };
    }
    if (signalState.isCancelled) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    if (typeof options.image !== 'string' || options.image.length === 0) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.INVALID_BASE64_PAYLOAD] };
    }

    if (options.image.startsWith('data:')) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.DATA_URL_REJECTED] };
    }

    if (!BASE64_PAYLOAD_PATTERN.test(options.image)) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.INVALID_BASE64_PAYLOAD] };
    }

    let padding = 0;
    if (options.image.endsWith('==')) {
        padding = 2;
    } else if (options.image.endsWith('=')) {
        padding = 1;
    }
    const decodedBytes = Math.floor((options.image.length / 4) * 3) - padding;

    if (decodedBytes === 0) {
        return { ok: false, path: null, format: null, byteLength: 0, status: null, errors: [LOCAL_IO_ERROR_CODES.INVALID_BASE64_PAYLOAD] };
    }

    if (decodedBytes > effectiveMaxBytes) {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT] };
    }

    // Inspect prefix bytes (24 chars base64 = 18 decoded bytes)
    const prefixSlice = options.image.slice(0, 24);
    let binaryPrefix;
    try {
        binaryPrefix = globalThis.atob(prefixSlice);
    } catch {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.INVALID_BASE64_PAYLOAD] };
    }

    const prefixBytes = new Uint8Array(binaryPrefix.length);
    for (let i = 0; i < binaryPrefix.length; i++) {
        prefixBytes[i] = binaryPrefix.charCodeAt(i);
    }

    const sigResult = detectSupportedImageFormat(prefixBytes);
    if (!sigResult.ok) {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: sigResult.errors };
    }

    // Optional filename validation
    if ('filename' in options && options.filename !== undefined) {
        if (
            typeof options.filename !== 'string' ||
            options.filename.length === 0 ||
            options.filename.length > MAX_FILENAME_CODE_UNITS ||
            !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(options.filename)
        ) {
            return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.INVALID_FILENAME] };
        }
    }

    const fetchFn = options.fetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING] };
    }

    const getHeadersFn = options.getRequestHeaders ?? globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;
    if (typeof getHeadersFn !== 'function') {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING] };
    }

    let stHeaders;
    try {
        stHeaders = getHeadersFn();
    } catch {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING] };
    }
    if (!isPlainObject(stHeaders)) {
        return { ok: false, path: null, format: null, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING] };
    }

    const headers = {
        ...stHeaders,
        'Content-Type': 'application/json',
    };

    const uploadPayload = {
        image: options.image,
        format: sigResult.format,
    };
    if (options.filename) {
        uploadPayload.filename = options.filename;
    }

    let response;
    try {
        response = await fetchFn(IMAGE_UPLOAD_ROUTE, {
            method: 'POST',
            headers,
            body: JSON.stringify(uploadPayload),
            signal: options.signal,
        });
    } catch (err) {
        if (isAbortError(err, options.signal)) {
            return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.UPLOAD_NETWORK_ERROR] };
    }

    if (options.signal?.aborted) {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response?.status ?? null, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    if (response === null || typeof response !== 'object') {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: null, errors: [LOCAL_IO_ERROR_CODES.UPLOAD_NETWORK_ERROR] };
    }

    if (response.status < 200 || response.status >= 300) {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.UPLOAD_HTTP_ERROR] };
    }

    if (options.signal?.aborted) {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    let body;
    try {
        body = await response.json();
    } catch (err) {
        if (isAbortError(err, options.signal)) {
            return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
        }
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.UPLOAD_MALFORMED_RESPONSE] };
    }

    if (options.signal?.aborted) {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.CANCELLED] };
    }

    if (!isPlainObject(body) || typeof body.path !== 'string') {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.UPLOAD_MALFORMED_RESPONSE] };
    }

    // Independently validate returned path
    const pathValidation = validateDurableUserImagePath(body.path);
    if (!pathValidation.ok) {
        return { ok: false, path: null, format: sigResult.format, byteLength: decodedBytes, status: response.status, errors: [LOCAL_IO_ERROR_CODES.UPLOAD_INVALID_RETURNED_PATH] };
    }

    return {
        ok: true,
        path: pathValidation.path,
        format: sigResult.format,
        byteLength: decodedBytes,
        status: response.status,
        errors: [],
    };
}

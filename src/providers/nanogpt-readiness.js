/**
 * @file Credential readiness probe for SillyTavern's NanoGPT secret.
 *
 * Checks whether an active NanoGPT API key is configured in SillyTavern's
 * server-side secrets store by probing POST /api/secrets/read with a bounded
 * operation deadline.
 *
 * Guarantees:
 * - Probes only the safe metadata route (POST /api/secrets/read).
 * - Never calls raw secret exposure routes (/api/secrets/find or /api/secrets/view).
 * - Fails closed on malformed response envelopes or descriptors.
 * - Enforces a strict 5,000 ms hard deadline covering dispatch and JSON body parsing.
 * - Single-request execution with zero automatic retries.
 * - Privacy: zero logging or retention of response bodies, masked values, labels, or IDs.
 * - Clean listener and timer cleanup on every exit path; no unhandled promise rejections.
 */

import { CREDENTIAL_STATUS } from '../constants.js';

export const SECRETS_READ_ROUTE = '/api/secrets/read';
export const NANOGPT_SECRET_KEY = 'api_key_nanogpt';
export const CREDENTIAL_READINESS_DEFAULT_TIMEOUT_MS = 5000;

export const CREDENTIAL_ERROR_CODES = Object.freeze({
    INVALID_OPTIONS: 'invalid-options',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
    NETWORK_ERROR: 'network-error',
    HTTP_ERROR: 'http-error',
    MALFORMED_RESPONSE: 'malformed-response',
    MALFORMED_DESCRIPTOR: 'malformed-descriptor',
    DEPENDENCY_MISSING: 'dependency-missing',
});

const ALLOWED_READINESS_OPTION_KEYS = new Set([
    'fetch',
    'getRequestHeaders',
    'signal',
    'timeoutMs',
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
 * Validates dependencies and caller options before dispatch.
 *
 * @param {unknown} options
 * @returns {{
 *   ok: true,
 *   fetchFn: typeof fetch,
 *   getHeadersFn: Function,
 * } | {
 *   ok: false,
 *   error: { kind: string, message: string },
 * }}
 */
function validateReadinessOptions(options) {
    if (!isPlainObject(options)) {
        return {
            ok: false,
            error: {
                kind: CREDENTIAL_ERROR_CODES.INVALID_OPTIONS,
                message: 'Options must be a plain object.',
            },
        };
    }

    for (const key of Object.keys(options)) {
        if (!ALLOWED_READINESS_OPTION_KEYS.has(key)) {
            return {
                ok: false,
                error: {
                    kind: CREDENTIAL_ERROR_CODES.INVALID_OPTIONS,
                    message: 'Unknown credential readiness option.',
                },
            };
        }
    }

    if ('timeoutMs' in options && options.timeoutMs !== undefined) {
        if (
            typeof options.timeoutMs !== 'number' ||
            !Number.isFinite(options.timeoutMs) ||
            !Number.isInteger(options.timeoutMs) ||
            options.timeoutMs <= 0
        ) {
            return {
                ok: false,
                error: {
                    kind: CREDENTIAL_ERROR_CODES.INVALID_OPTIONS,
                    message: 'timeoutMs must be a positive finite integer.',
                },
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
                error: {
                    kind: CREDENTIAL_ERROR_CODES.INVALID_OPTIONS,
                    message: 'signal must be an AbortSignal instance.',
                },
            };
        }
    }

    const fetchFn = options.fetch || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return {
            ok: false,
            error: {
                kind: CREDENTIAL_ERROR_CODES.DEPENDENCY_MISSING,
                message: 'No usable fetch function found in environment or options.',
            },
        };
    }

    const getHeadersFn =
        options.getRequestHeaders ||
        globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;
    if (typeof getHeadersFn !== 'function') {
        return {
            ok: false,
            error: {
                kind: CREDENTIAL_ERROR_CODES.DEPENDENCY_MISSING,
                message: 'SillyTavern getRequestHeaders context function is not available.',
            },
        };
    }

    return { ok: true, fetchFn, getHeadersFn };
}

/**
 * Inspects parsed secret state and applies fail-closed classification.
 *
 * @param {unknown} data
 * @returns {{
 *   status: string,
 *   error: { kind: string, message: string } | null,
 * }}
 */
function classifySecretResponse(data) {
    if (!isPlainObject(data)) {
        return {
            status: CREDENTIAL_STATUS.UNAVAILABLE,
            error: {
                kind: CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE,
                message: 'Secrets response payload is not a plain object.',
            },
        };
    }

    // Omitted key fails closed to unavailable
    if (!(NANOGPT_SECRET_KEY in data)) {
        return {
            status: CREDENTIAL_STATUS.UNAVAILABLE,
            error: {
                kind: CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE,
                message: `Key '${NANOGPT_SECRET_KEY}' is omitted from secrets response.`,
            },
        };
    }

    const entries = data[NANOGPT_SECRET_KEY];

    // Explicit null indicates no secret configured
    if (entries === null) {
        return {
            status: CREDENTIAL_STATUS.NOT_CONFIGURED,
            error: null,
        };
    }

    // Must be an array if not null
    if (!Array.isArray(entries)) {
        return {
            status: CREDENTIAL_STATUS.UNAVAILABLE,
            error: {
                kind: CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE,
                message: `Entry for '${NANOGPT_SECRET_KEY}' must be null or an array.`,
            },
        };
    }

    // Empty array indicates no secret configured
    if (entries.length === 0) {
        return {
            status: CREDENTIAL_STATUS.NOT_CONFIGURED,
            error: null,
        };
    }

    // Validate ALL descriptors before reporting configured.
    // One active descriptor must not conceal another malformed array entry.
    let hasActive = false;
    for (const item of entries) {
        if (
            item === null ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof item.active !== 'boolean'
        ) {
            return {
                status: CREDENTIAL_STATUS.UNAVAILABLE,
                error: {
                    kind: CREDENTIAL_ERROR_CODES.MALFORMED_DESCRIPTOR,
                    message: 'One or more secret descriptors are malformed.',
                },
            };
        }
        if (item.active === true) {
            hasActive = true;
        }
    }

    if (hasActive) {
        return {
            status: CREDENTIAL_STATUS.CONFIGURED,
            error: null,
        };
    }

    return {
        status: CREDENTIAL_STATUS.NOT_CONFIGURED,
        error: null,
    };
}

/**
 * Checks NanoGPT credential readiness against SillyTavern's secret store.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] Injected fetch function.
 * @param {Function} [options.getRequestHeaders] Injected getRequestHeaders function.
 * @param {AbortSignal} [options.signal] Optional caller AbortSignal.
 * @param {number} [options.timeoutMs] Optional operation timeout in milliseconds.
 * @returns {Promise<{
 *   status: 'configured' | 'not-configured' | 'unavailable' | 'cancelled',
 *   error: { kind: string, message: string } | null,
 * }>}
 */
export async function checkNanoGptCredentialReadiness(options = {}) {
    const validation = validateReadinessOptions(options);
    if (!validation.ok) {
        return {
            status: CREDENTIAL_STATUS.UNAVAILABLE,
            error: validation.error,
        };
    }

    // Already-aborted signal causes zero fetch calls
    if (options.signal?.aborted) {
        return {
            status: CREDENTIAL_STATUS.CANCELLED,
            error: {
                kind: CREDENTIAL_ERROR_CODES.CANCELLED,
                message: 'Credential readiness check cancelled by caller before request.',
            },
        };
    }

    const { fetchFn, getHeadersFn } = validation;
    const timeoutLimit =
        options.timeoutMs ?? CREDENTIAL_READINESS_DEFAULT_TIMEOUT_MS;

    let timedOut = false;
    let cancelled = false;
    let timerHandle = null;
    let callerAbortHandler = null;
    let internalAbortHandler = null;

    const internalController = new AbortController();

    try {
        if (options.signal) {
            callerAbortHandler = () => {
                cancelled = true;
                internalController.abort(
                    options.signal.reason || new Error('Cancelled by caller'),
                );
            };
            options.signal.addEventListener('abort', callerAbortHandler, {
                once: true,
            });
        }

        timerHandle = setTimeout(() => {
            timedOut = true;
            internalController.abort(
                new Error('Credential readiness check timed out'),
            );
        }, timeoutLimit);

        const abortPromise = new Promise((_, reject) => {
            if (internalController.signal.aborted) {
                if (timedOut) {
                    reject({ kind: CREDENTIAL_ERROR_CODES.TIMEOUT });
                } else {
                    reject({ kind: CREDENTIAL_ERROR_CODES.CANCELLED });
                }
                return;
            }
            internalAbortHandler = () => {
                if (timedOut) {
                    reject({ kind: CREDENTIAL_ERROR_CODES.TIMEOUT });
                } else {
                    reject({ kind: CREDENTIAL_ERROR_CODES.CANCELLED });
                }
            };
            internalController.signal.addEventListener(
                'abort',
                internalAbortHandler,
                { once: true },
            );
        });

        const pipelinePromise = (async () => {
            const stHeaders =
                typeof getHeadersFn === 'function'
                    ? getHeadersFn({ omitContentType: true })
                    : {};
            const headers = { ...stHeaders };

            const response = await fetchFn(SECRETS_READ_ROUTE, {
                method: 'POST',
                headers,
                signal: internalController.signal,
            });

            if (response === null || typeof response !== 'object') {
                return {
                    status: CREDENTIAL_STATUS.UNAVAILABLE,
                    error: {
                        kind: CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE,
                        message: 'Secrets endpoint returned an invalid response object.',
                    },
                };
            }

            if (response.status < 200 || response.status >= 300) {
                return {
                    status: CREDENTIAL_STATUS.UNAVAILABLE,
                    error: {
                        kind: CREDENTIAL_ERROR_CODES.HTTP_ERROR,
                        message: `Secrets endpoint returned HTTP ${response.status}.`,
                    },
                };
            }

            let data;
            try {
                data = await response.json();
            } catch {
                return {
                    status: CREDENTIAL_STATUS.UNAVAILABLE,
                    error: {
                        kind: CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE,
                        message: 'Secrets response JSON could not be parsed.',
                    },
                };
            }

            return classifySecretResponse(data);
        })();

        // Suppress unhandled rejection if fetch/JSON pipeline settles late after timeout/abort
        pipelinePromise.catch(() => {});

        const result = await Promise.race([pipelinePromise, abortPromise]);
        return result;
    } catch (err) {
        if (
            cancelled ||
            options.signal?.aborted ||
            err?.kind === CREDENTIAL_ERROR_CODES.CANCELLED
        ) {
            return {
                status: CREDENTIAL_STATUS.CANCELLED,
                error: {
                    kind: CREDENTIAL_ERROR_CODES.CANCELLED,
                    message: 'Credential readiness check cancelled by caller.',
                },
            };
        }
        if (timedOut || err?.kind === CREDENTIAL_ERROR_CODES.TIMEOUT) {
            return {
                status: CREDENTIAL_STATUS.UNAVAILABLE,
                error: {
                    kind: CREDENTIAL_ERROR_CODES.TIMEOUT,
                    message: 'Credential readiness check timed out.',
                },
            };
        }
        return {
            status: CREDENTIAL_STATUS.UNAVAILABLE,
            error: {
                kind: CREDENTIAL_ERROR_CODES.NETWORK_ERROR,
                message: 'Network error occurred during credential readiness check.',
            },
        };
    } finally {
        if (timerHandle !== null) {
            clearTimeout(timerHandle);
            timerHandle = null;
        }
        if (options.signal && callerAbortHandler) {
            options.signal.removeEventListener('abort', callerAbortHandler);
            callerAbortHandler = null;
        }
        if (internalAbortHandler) {
            internalController.signal.removeEventListener(
                'abort',
                internalAbortHandler,
            );
            internalAbortHandler = null;
        }
    }
}

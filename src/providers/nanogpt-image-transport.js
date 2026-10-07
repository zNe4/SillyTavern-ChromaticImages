/**
 * @file Pure single-request transport core for NanoGPT image requests.
 *
 * Establishes and strictly enforces single-dispatch semantics for one potentially
 * billable NanoGPT image request. Does not encode production endpoint routes,
 * authentication headers, or credentials (deferred to M03-D2).
 *
 * Key guarantees:
 * - At most one dispatch per explicit caller invocation (zero automatic retries).
 * - Conservative billing uncertainty: all post-dispatch failures use uncertainBilling: true.
 * - Deadline and cancellation coverage across both dispatch and response.json() parsing.
 * - Guaranteed resource cleanup (timer clearing and AbortSignal listener removal) on every exit path.
 * - Preserves received HTTP status codes whenever an HTTP response was obtained.
 * - Privacy: error outputs never leak RP prompts, credentials, or image payloads.
 */

/**
 * Deterministic error codes returned by transport core.
 */
export const TRANSPORT_ERROR_CODES = Object.freeze({
    INVALID_OPTIONS: 'invalid-options',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
    NETWORK_FAILURE: 'network-failure',
    AUTHENTICATION_FAILURE: 'authentication-failure',
    RATE_LIMIT_FAILURE: 'rate-limit-failure',
    PROVIDER_FAILURE: 'provider-failure',
    MALFORMED_RESPONSE: 'malformed-response',
});

const ALLOWED_OPTION_KEYS = new Set(['request', 'dispatch', 'timeoutMs', 'signal']);

/**
 * Dispatches a single NanoGPT image request via an injected dispatch function.
 *
 * @param {unknown} options Transport options.
 * @returns {Promise<{
 *   ok: true,
 *   status: number,
 *   body: unknown,
 *   dispatchAttempted: true,
 *   uncertainBilling: false,
 *   error: null,
 * } | {
 *   ok: false,
 *   status: number | null,
 *   body: null,
 *   dispatchAttempted: boolean,
 *   uncertainBilling: boolean,
 *   error: {
 *     kind: string,
 *     message: string,
 *   },
 * }>}
 */
export async function sendNanoGptImageTransportRequest(options) {
    if (!isPlainObject(options)) {
        return createPreDispatchFailure(
            TRANSPORT_ERROR_CODES.INVALID_OPTIONS,
            'Transport options must be a plain object.'
        );
    }

    for (const key of Object.keys(options)) {
        if (!ALLOWED_OPTION_KEYS.has(key)) {
            return createPreDispatchFailure(
                TRANSPORT_ERROR_CODES.INVALID_OPTIONS,
                'Unknown option provided to transport.'
            );
        }
    }

    if (!isPlainObject(options.request)) {
        return createPreDispatchFailure(
            TRANSPORT_ERROR_CODES.INVALID_OPTIONS,
            'Request payload must be a plain object.'
        );
    }

    if (typeof options.dispatch !== 'function') {
        return createPreDispatchFailure(
            TRANSPORT_ERROR_CODES.INVALID_OPTIONS,
            'Dispatch must be a function.'
        );
    }

    if ('timeoutMs' in options && options.timeoutMs !== undefined) {
        if (
            typeof options.timeoutMs !== 'number' ||
            !Number.isInteger(options.timeoutMs) ||
            options.timeoutMs <= 0
        ) {
            return createPreDispatchFailure(
                TRANSPORT_ERROR_CODES.INVALID_OPTIONS,
                'Timeout must be a positive finite integer.'
            );
        }
    }

    if ('signal' in options && options.signal !== undefined) {
        if (
            options.signal === null ||
            typeof options.signal !== 'object' ||
            typeof options.signal.aborted !== 'boolean' ||
            typeof options.signal.addEventListener !== 'function' ||
            typeof options.signal.removeEventListener !== 'function'
        ) {
            return createPreDispatchFailure(
                TRANSPORT_ERROR_CODES.INVALID_OPTIONS,
                'Signal must be an AbortSignal instance.'
            );
        }
    }

    // Check pre-dispatch cancellation
    if (options.signal && options.signal.aborted) {
        return createPreDispatchFailure(
            TRANSPORT_ERROR_CODES.CANCELLED,
            'Transport operation was cancelled before dispatch.'
        );
    }

    let receivedStatus = null;
    let timedOut = false;
    let cancelled = false;
    let dispatchAttempted = false;
    let timerHandle = null;
    let callerAbortHandler = null;

    const internalController = new AbortController();

    try {
        // Attach caller abort listener if provided
        if (options.signal) {
            callerAbortHandler = () => {
                cancelled = true;
                internalController.abort(options.signal.reason || new Error('Cancelled by caller'));
            };
            options.signal.addEventListener('abort', callerAbortHandler, { once: true });
        }

        // Arm optional timeout timer if provided
        if (typeof options.timeoutMs === 'number') {
            timerHandle = setTimeout(() => {
                timedOut = true;
                internalController.abort(new Error('Operation timed out'));
            }, options.timeoutMs);
        }

        const abortPromise = new Promise((_, reject) => {
            if (internalController.signal.aborted) {
                if (timedOut) {
                    reject({ kind: TRANSPORT_ERROR_CODES.TIMEOUT });
                } else {
                    reject({ kind: TRANSPORT_ERROR_CODES.CANCELLED });
                }
                return;
            }
            internalController.signal.addEventListener('abort', () => {
                if (timedOut) {
                    reject({ kind: TRANSPORT_ERROR_CODES.TIMEOUT });
                } else {
                    reject({ kind: TRANSPORT_ERROR_CODES.CANCELLED });
                }
            }, { once: true });
        });

        const pipelinePromise = (async () => {
            dispatchAttempted = true;
            const response = await options.dispatch(options.request, { signal: internalController.signal });

            if (response === null || typeof response !== 'object') {
                throw { kind: TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE, status: null };
            }

            if (
                typeof response.status === 'number' &&
                Number.isInteger(response.status) &&
                response.status >= 100 &&
                response.status <= 599
            ) {
                receivedStatus = response.status;
            } else {
                throw { kind: TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE, status: null };
            }

            // Non-2xx responses do not parse body
            if (response.status < 200 || response.status >= 300) {
                return { status: response.status, body: null };
            }

            // For 2xx responses, validate .json() method
            if (typeof response.json !== 'function') {
                throw { kind: TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE, status: receivedStatus };
            }

            let parsedBody;
            try {
                parsedBody = await response.json();
            } catch {
                if (timedOut) {
                    throw { kind: TRANSPORT_ERROR_CODES.TIMEOUT };
                }
                if (cancelled || (options.signal && options.signal.aborted)) {
                    throw { kind: TRANSPORT_ERROR_CODES.CANCELLED };
                }
                throw { kind: TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE, status: receivedStatus };
            }

            return { status: response.status, body: parsedBody };
        })();

        // Suppress unhandled rejection if pipeline rejects late after timeout/abort
        pipelinePromise.catch(() => {});

        const result = await Promise.race([pipelinePromise, abortPromise]);

        if (result.status >= 200 && result.status < 300) {
            return {
                ok: true,
                status: result.status,
                body: result.body,
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        }

        // Handle non-2xx HTTP status
        let errorKind = TRANSPORT_ERROR_CODES.PROVIDER_FAILURE;
        let errorMessage = 'Provider returned an error response.';

        if (result.status === 401 || result.status === 403) {
            errorKind = TRANSPORT_ERROR_CODES.AUTHENTICATION_FAILURE;
            errorMessage = 'Provider authentication failed.';
        } else if (result.status === 429) {
            errorKind = TRANSPORT_ERROR_CODES.RATE_LIMIT_FAILURE;
            errorMessage = 'Provider rate limit exceeded.';
        }

        return {
            ok: false,
            status: result.status,
            body: null,
            dispatchAttempted: true,
            uncertainBilling: true,
            error: {
                kind: errorKind,
                message: errorMessage,
            },
        };
    } catch (err) {
        let kind = TRANSPORT_ERROR_CODES.NETWORK_FAILURE;
        let message = 'Transport network failure occurred during dispatch.';
        let errorStatus = receivedStatus;

        if (timedOut || (err && err.kind === TRANSPORT_ERROR_CODES.TIMEOUT)) {
            kind = TRANSPORT_ERROR_CODES.TIMEOUT;
            message = 'Transport operation timed out.';
        } else if (cancelled || (options.signal && options.signal.aborted) || (err && err.kind === TRANSPORT_ERROR_CODES.CANCELLED)) {
            kind = TRANSPORT_ERROR_CODES.CANCELLED;
            message = 'Transport operation was cancelled by caller.';
        } else if (err && err.kind === TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE) {
            kind = TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE;
            message = 'Provider returned a malformed response.';
            if (err.status !== undefined) {
                errorStatus = err.status;
            }
        } else if (!dispatchAttempted) {
            kind = TRANSPORT_ERROR_CODES.INVALID_OPTIONS;
            message = 'Transport initialization failed before dispatch.';
        }

        return {
            ok: false,
            status: errorStatus,
            body: null,
            dispatchAttempted,
            uncertainBilling: dispatchAttempted,
            error: {
                kind,
                message,
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
    }
}

/**
 * Creates a pre-dispatch failure result.
 *
 * @param {string} kind
 * @param {string} message
 * @returns {{
 *   ok: false,
 *   status: null,
 *   body: null,
 *   dispatchAttempted: false,
 *   uncertainBilling: false,
 *   error: {
 *     kind: string,
 *     message: string,
 *   },
 * }}
 */
function createPreDispatchFailure(kind, message) {
    return {
        ok: false,
        status: null,
        body: null,
        dispatchAttempted: false,
        uncertainBilling: false,
        error: {
            kind,
            message,
        },
    };
}

/**
 * Checks whether a value is a plain JavaScript object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        return false;
    }

    const proto = Object.getPrototypeOf(value);

    return (
        proto === Object.prototype ||
        proto === null
    );
}

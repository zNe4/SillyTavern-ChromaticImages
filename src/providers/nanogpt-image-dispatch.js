/**
 * @file Production dispatch adapter for NanoGPT image generation requests.
 *
 * Connects the pure M03-D1 single-request transport core to the same-origin
 * SillyTavern NanoGPT images proxy routes:
 * 1. Normalized route: GET/POST /api/sd/nanogpt/images (marker: v1)
 * 2. Subscription-compatible generations route: GET/POST /api/sd/nanogpt/images/generations (marker: v1-compat)
 *
 * Key guarantees:
 * - Zero raw NanoGPT credential ownership, retrieval, or persistence in browser JS.
 * - Single-request dispatch without automatic retries.
 * - Conservative billing uncertainty: all post-dispatch failures preserve uncertainBilling: true.
 * - Pre-flight capability verification with isolated session-memory caching.
 * - Universal proxy marker verification (v1 vs v1-compat) across all dispatches.
 * - Whole-operation timeout budgeting and caller cancellation propagation.
 * - Privacy: zero console logging of RP scene prompts, base64 images, or credentials.
 */

import { sendNanoGptImageTransportRequest } from './nanogpt-image-transport.js';

export const NANOGPT_PROXY_ROUTE = '/api/sd/nanogpt/images';
export const NANOGPT_PROXY_MARKER_HEADER = 'x-st-nanogpt-proxy';
export const NANOGPT_PROXY_MARKER_VALUE = 'v1';

export const NANOGPT_PROXY_GENERATIONS_ROUTE = '/api/sd/nanogpt/images/generations';
export const NANOGPT_PROXY_GENERATIONS_MARKER_VALUE = 'v1-compat';

export const CAPABILITY_DEFAULT_TIMEOUT_MS = 5000;

export const DISPATCH_ERROR_CODES = Object.freeze({
    SILLYTAVERN_UPDATE_REQUIRED: 'sillytavern-update-required',
    CAPABILITY_NETWORK_ERROR: 'capability-network-error',
    CAPABILITY_MALFORMED_RESPONSE: 'capability-malformed-response',
    CANCELLED: 'cancelled',
    TIMEOUT: 'timeout',
    LOCAL_DEPENDENCY_MISSING: 'local-dependency-missing',
    INVALID_DISPATCH_OPTIONS: 'invalid-dispatch-options',
    PROXY_RESPONSE_UNVERIFIED: 'sillytavern-proxy-response-unverified',
});

const ALLOWED_PRODUCTION_SERVICE_KEYS = new Set([
    'request',
    'timeoutMs',
    'signal',
    'dispatch',
    'fetch',
    'getRequestHeaders',
    'forceCheck',
]);

const ALLOWED_CAPABILITY_OPTION_KEYS = new Set([
    'fetch',
    'getRequestHeaders',
    'forceCheck',
    'signal',
    'timeoutMs',
]);

/**
 * Session-memory cache for positive normalized capability check.
 * Never persisted to localStorage, extensionSettings, or chat files.
 * @type {boolean | null}
 */
let cachedCapabilitySupported = null;

/**
 * Session-memory cache for positive compatibility generations capability check.
 * Never persisted to localStorage, extensionSettings, or chat files.
 * @type {boolean | null}
 */
let cachedGenerationsCapabilitySupported = null;

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

/**
 * Validates local options and dependencies before any network operation.
 *
 * @param {unknown} options
 * @returns {{ ok: true, fetchFn: typeof fetch, getHeadersFn: Function } | { ok: false, error: { kind: string, message: string } }}
 */
function validatePreFlightDependenciesAndOptions(options) {
    if (!isPlainObject(options)) {
        return {
            ok: false,
            error: {
                kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                message: 'Options must be a plain object.',
            },
        };
    }

    for (const key of Object.keys(options)) {
        if (!ALLOWED_PRODUCTION_SERVICE_KEYS.has(key)) {
            return {
                ok: false,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: `Unknown option '${key}' provided to dispatch service.`,
                },
            };
        }
    }

    if (!isPlainObject(options.request)) {
        return {
            ok: false,
            error: {
                kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                message: 'Request payload must be a plain object.',
            },
        };
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
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
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
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: 'signal must be an AbortSignal instance.',
                },
            };
        }
    }

    if ('dispatch' in options && options.dispatch !== undefined) {
        if (typeof options.dispatch !== 'function') {
            return {
                ok: false,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: 'dispatch must be a function if provided.',
                },
            };
        }
    }

    if ('forceCheck' in options && options.forceCheck !== undefined) {
        if (typeof options.forceCheck !== 'boolean') {
            return {
                ok: false,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: 'forceCheck must be a boolean if provided.',
                },
            };
        }
    }

    const fetchFn = options.fetch || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return {
            ok: false,
            error: {
                kind: DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING,
                message: 'No usable fetch function found in environment or options.',
            },
        };
    }

    // getRequestHeaders is unconditionally required before GET and POST
    const getHeadersFn = options.getRequestHeaders || globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;
    if (typeof getHeadersFn !== 'function') {
        return {
            ok: false,
            error: {
                kind: DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING,
                message: 'SillyTavern getRequestHeaders context function is not available.',
            },
        };
    }

    return { ok: true, fetchFn, getHeadersFn };
}

/**
 * Shared capability verification core parameterized by route, marker, and expected payload.
 *
 * @param {object} params
 * @param {string} params.route
 * @param {string} params.markerValue
 * @param {string} params.expectedRoute
 * @param {string} params.featureDescription
 * @param {() => boolean | null} params.getCached
 * @param {(val: boolean | null) => void} params.setCached
 * @param {object} params.options
 * @returns {Promise<{
 *   supported: boolean,
 *   cached: boolean,
 *   status: number | null,
 *   error: { kind: string, message: string } | null,
 * }>}
 */
async function checkCapabilityCore({
    route,
    markerValue: expectedMarkerValue,
    expectedRoute,
    featureDescription,
    getCached,
    setCached,
    options = {},
}) {
    if (!isPlainObject(options)) {
        return {
            supported: false,
            cached: false,
            status: null,
            error: {
                kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                message: 'Options must be a plain object.',
            },
        };
    }

    for (const key of Object.keys(options)) {
        if (!ALLOWED_CAPABILITY_OPTION_KEYS.has(key)) {
            return {
                supported: false,
                cached: false,
                status: null,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: `Unknown option '${key}' provided to capability check.`,
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
                supported: false,
                cached: false,
                status: null,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
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
                supported: false,
                cached: false,
                status: null,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: 'signal must be an AbortSignal instance.',
                },
            };
        }
    }

    if ('forceCheck' in options && options.forceCheck !== undefined) {
        if (typeof options.forceCheck !== 'boolean') {
            return {
                supported: false,
                cached: false,
                status: null,
                error: {
                    kind: DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS,
                    message: 'forceCheck must be a boolean if provided.',
                },
            };
        }
    }

    const fetchFn = options.fetch || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        return {
            supported: false,
            cached: false,
            status: null,
            error: {
                kind: DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING,
                message: 'No usable fetch function found in environment or options.',
            },
        };
    }

    const getHeadersFn = options.getRequestHeaders || globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;
    if (typeof getHeadersFn !== 'function') {
        return {
            supported: false,
            cached: false,
            status: null,
            error: {
                kind: DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING,
                message: 'SillyTavern getRequestHeaders context function is not available.',
            },
        };
    }

    // Cache hit in current page session
    if (getCached() === true && !options.forceCheck) {
        return {
            supported: true,
            cached: true,
            status: 200,
            error: null,
        };
    }

    // Check pre-call cancellation
    if (options.signal?.aborted) {
        return {
            supported: false,
            cached: false,
            status: null,
            error: {
                kind: DISPATCH_ERROR_CODES.CANCELLED,
                message: 'Capability check cancelled by caller before request.',
            },
        };
    }

    let timedOut = false;
    let cancelled = false;
    let timerHandle = null;
    let callerAbortHandler = null;

    const internalController = new AbortController();

    try {
        if (options.signal) {
            callerAbortHandler = () => {
                cancelled = true;
                internalController.abort(options.signal.reason || new Error('Cancelled by caller'));
            };
            options.signal.addEventListener('abort', callerAbortHandler, { once: true });
        }

        const timeoutLimit = options.timeoutMs ?? CAPABILITY_DEFAULT_TIMEOUT_MS;
        timerHandle = setTimeout(() => {
            timedOut = true;
            internalController.abort(new Error('Capability check timed out'));
        }, timeoutLimit);

        const abortPromise = new Promise((_, reject) => {
            if (internalController.signal.aborted) {
                if (timedOut) {
                    reject({ kind: DISPATCH_ERROR_CODES.TIMEOUT });
                } else {
                    reject({ kind: DISPATCH_ERROR_CODES.CANCELLED });
                }
                return;
            }
            internalController.signal.addEventListener('abort', () => {
                if (timedOut) {
                    reject({ kind: DISPATCH_ERROR_CODES.TIMEOUT });
                } else {
                    reject({ kind: DISPATCH_ERROR_CODES.CANCELLED });
                }
            }, { once: true });
        });

        const pipelinePromise = (async () => {
            const stHeaders = typeof getHeadersFn === 'function' ? getHeadersFn() : {};
            const headers = { ...stHeaders };

            const response = await fetchFn(route, {
                method: 'GET',
                headers,
                signal: internalController.signal,
            });

            if (response === null || typeof response !== 'object') {
                return {
                    supported: false,
                    cached: false,
                    status: null,
                    error: {
                        kind: DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE,
                        message: 'Capability endpoint returned an invalid response object.',
                    },
                };
            }

            const markerValue = response?.headers?.get ? response.headers.get(NANOGPT_PROXY_MARKER_HEADER) : null;
            const isMarked = markerValue === expectedMarkerValue;

            if (response.status === 200 && isMarked) {
                let body;
                try {
                    body = await response.json();
                } catch {
                    return {
                        supported: false,
                        cached: false,
                        status: 200,
                        error: {
                            kind: DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE,
                            message: 'Capability response JSON could not be parsed.',
                        },
                    };
                }

                if (body && typeof body === 'object' && body.ok === true && body.route === expectedRoute) {
                    setCached(true);
                    return {
                        supported: true,
                        cached: false,
                        status: 200,
                        error: null,
                    };
                }

                return {
                    supported: false,
                    cached: false,
                    status: 200,
                    error: {
                        kind: DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE,
                        message: 'Capability response payload was malformed.',
                    },
                };
            }

            if (response.status === 404 && !isMarked) {
                return {
                    supported: false,
                    cached: false,
                    status: 404,
                    error: {
                        kind: DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED,
                        message: `SillyTavern update required: this feature requires SillyTavern with ${featureDescription}.`,
                    },
                };
            }

            if (response.status === 200 && !isMarked) {
                return {
                    supported: false,
                    cached: false,
                    status: 200,
                    error: {
                        kind: DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE,
                        message: 'SillyTavern returned HTTP 200 but lacked the proxy marker header.',
                    },
                };
            }

            return {
                supported: false,
                cached: false,
                status: response.status,
                error: {
                    kind: DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE,
                    message: `Unexpected status ${response.status} from capability endpoint.`,
                },
            };
        })();

        // Suppress unhandled rejection if fetch/pipeline rejects late after timeout/abort
        pipelinePromise.catch(() => {});

        const result = await Promise.race([pipelinePromise, abortPromise]);
        return result;
    } catch (err) {
        if (cancelled || (options.signal && options.signal.aborted) || (err && err.kind === DISPATCH_ERROR_CODES.CANCELLED)) {
            return {
                supported: false,
                cached: false,
                status: null,
                error: {
                    kind: DISPATCH_ERROR_CODES.CANCELLED,
                    message: 'Capability check cancelled by caller.',
                },
            };
        }
        if (timedOut || (err && err.kind === DISPATCH_ERROR_CODES.TIMEOUT)) {
            return {
                supported: false,
                cached: false,
                status: null,
                error: {
                    kind: DISPATCH_ERROR_CODES.TIMEOUT,
                    message: 'Capability check timed out.',
                },
            };
        }
        return {
            supported: false,
            cached: false,
            status: null,
            error: {
                kind: DISPATCH_ERROR_CODES.CAPABILITY_NETWORK_ERROR,
                message: 'Network error occurred during capability check.',
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
 * Checks whether the current SillyTavern host provides the normalized NanoGPT images proxy.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] Injected fetch implementation.
 * @param {Function} [options.getRequestHeaders] Injected getRequestHeaders function.
 * @param {boolean} [options.forceCheck] If true, bypasses the in-memory cache and re-verifies.
 * @param {AbortSignal} [options.signal] Optional caller AbortSignal.
 * @param {number} [options.timeoutMs] Optional timeout in milliseconds.
 * @returns {Promise<{
 *   supported: boolean,
 *   cached: boolean,
 *   status: number | null,
 *   error: { kind: string, message: string } | null,
 * }>}
 */
export async function checkNanoGptImagesCapability(options = {}) {
    return checkCapabilityCore({
        route: NANOGPT_PROXY_ROUTE,
        markerValue: NANOGPT_PROXY_MARKER_VALUE,
        expectedRoute: 'nanogpt-images',
        featureDescription: 'normalized NanoGPT image support',
        getCached: () => cachedCapabilitySupported,
        setCached: (val) => { cachedCapabilitySupported = val; },
        options,
    });
}

/**
 * Checks whether the current SillyTavern host provides the NanoGPT compatibility generations image proxy.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] Injected fetch implementation.
 * @param {Function} [options.getRequestHeaders] Injected getRequestHeaders function.
 * @param {boolean} [options.forceCheck] If true, bypasses the in-memory cache and re-verifies.
 * @param {AbortSignal} [options.signal] Optional caller AbortSignal.
 * @param {number} [options.timeoutMs] Optional timeout in milliseconds.
 * @returns {Promise<{
 *   supported: boolean,
 *   cached: boolean,
 *   status: number | null,
 *   error: { kind: string, message: string } | null,
 * }>}
 */
export async function checkNanoGptGenerationsCapability(options = {}) {
    return checkCapabilityCore({
        route: NANOGPT_PROXY_GENERATIONS_ROUTE,
        markerValue: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE,
        expectedRoute: 'nanogpt-images-generations',
        featureDescription: 'NanoGPT compatibility image generations support',
        getCached: () => cachedGenerationsCapabilitySupported,
        setCached: (val) => { cachedGenerationsCapabilitySupported = val; },
        options,
    });
}

/**
 * Clears the in-memory normalized capability cache.
 */
export function clearNanoGptImagesCapabilityCache() {
    cachedCapabilitySupported = null;
}

/**
 * Clears the in-memory compatibility generations capability cache.
 */
export function clearNanoGptGenerationsCapabilityCache() {
    cachedGenerationsCapabilitySupported = null;
}

/**
 * Creates a low-level dispatch function targeting POST /api/sd/nanogpt/images.
 *
 * @param {object} [dependencies]
 * @param {typeof fetch} [dependencies.fetch] Injected fetch implementation.
 * @param {Function} [dependencies.getRequestHeaders] Injected getRequestHeaders function.
 * @returns {(request: unknown, options?: { signal?: AbortSignal }) => Promise<Response>}
 */
export function createNanoGptImageDispatch(dependencies = {}) {
    if (!isPlainObject(dependencies)) {
        throw new Error('Dependencies must be a plain object.');
    }

    const fetchFn = dependencies.fetch || globalThis.fetch;
    const getHeadersFn = dependencies.getRequestHeaders || globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;

    return async function (request, options) {
        if (!isPlainObject(request)) {
            throw new Error('Request payload must be a plain object.');
        }

        const stHeaders = typeof getHeadersFn === 'function' ? getHeadersFn() : {};
        const headers = {
            ...stHeaders,
            'Content-Type': 'application/json',
        };

        return fetchFn(NANOGPT_PROXY_ROUTE, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
            signal: options?.signal,
        });
    };
}

/**
 * Creates a low-level dispatch function targeting POST /api/sd/nanogpt/images/generations.
 *
 * @param {object} [dependencies]
 * @param {typeof fetch} [dependencies.fetch] Injected fetch implementation.
 * @param {Function} [dependencies.getRequestHeaders] Injected getRequestHeaders function.
 * @returns {(request: unknown, options?: { signal?: AbortSignal }) => Promise<Response>}
 */
export function createNanoGptGenerationsDispatch(dependencies = {}) {
    if (!isPlainObject(dependencies)) {
        throw new Error('Dependencies must be a plain object.');
    }

    const fetchFn = dependencies.fetch || globalThis.fetch;
    const getHeadersFn = dependencies.getRequestHeaders || globalThis.SillyTavern?.getContext?.()?.getRequestHeaders;

    return async function (request, options) {
        if (!isPlainObject(request)) {
            throw new Error('Request payload must be a plain object.');
        }

        const stHeaders = typeof getHeadersFn === 'function' ? getHeadersFn() : {};
        const headers = {
            ...stHeaders,
            'Content-Type': 'application/json',
        };

        return fetchFn(NANOGPT_PROXY_GENERATIONS_ROUTE, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
            signal: options?.signal,
        });
    };
}

/**
 * Shared production request execution core parameterized by route, marker, and capability/dispatch handlers.
 *
 * @param {object} params
 * @param {string} params.route
 * @param {string} params.markerValue
 * @param {(opts: any) => Promise<any>} params.checkCapabilityFn
 * @param {() => void} params.clearCacheFn
 * @param {(deps: any) => (req: any, opts?: any) => Promise<Response>} params.createDefaultDispatchFn
 * @param {object} params.options
 * @returns {Promise<{
 *   ok: boolean,
 *   status: number | null,
 *   body: unknown,
 *   dispatchAttempted: boolean,
 *   uncertainBilling: boolean,
 *   error: { kind: string, message: string } | null,
 * }>}
 */
async function sendProductionRequestCore({
    route,
    markerValue: expectedMarkerValue,
    checkCapabilityFn,
    clearCacheFn,
    createDefaultDispatchFn,
    options = {},
}) {
    // 1. Pre-Flight Validation of all inputs and dependencies
    const validation = validatePreFlightDependenciesAndOptions(options);
    if (!validation.ok) {
        return {
            ok: false,
            status: null,
            body: null,
            dispatchAttempted: false,
            uncertainBilling: false,
            error: validation.error,
        };
    }

    const { fetchFn, getHeadersFn } = validation;
    const overallStartTime = Date.now();
    const hasOverallTimeout = typeof options.timeoutMs === 'number';

    // 2. Pre-Operation Cancellation Check
    if (options.signal?.aborted) {
        return {
            ok: false,
            status: null,
            body: null,
            dispatchAttempted: false,
            uncertainBilling: false,
            error: {
                kind: DISPATCH_ERROR_CODES.CANCELLED,
                message: 'Operation cancelled by caller before request.',
            },
        };
    }

    // 3. Pre-Flight Capability Verification
    let capabilityTimeout = CAPABILITY_DEFAULT_TIMEOUT_MS;
    if (hasOverallTimeout) {
        capabilityTimeout = Math.min(options.timeoutMs, CAPABILITY_DEFAULT_TIMEOUT_MS);
    }

    const capability = await checkCapabilityFn({
        fetch: fetchFn,
        getRequestHeaders: getHeadersFn,
        signal: options.signal,
        timeoutMs: capabilityTimeout,
        forceCheck: options.forceCheck,
    });

    if (!capability.supported) {
        return {
            ok: false,
            status: capability.status,
            body: null,
            dispatchAttempted: false,
            uncertainBilling: false,
            error: capability.error,
        };
    }

    // 4. Calculate Remaining Timeout Budget for D1
    let remainingTimeoutMs;
    if (hasOverallTimeout) {
        const elapsedMs = Date.now() - overallStartTime;
        remainingTimeoutMs = options.timeoutMs - elapsedMs;
        if (remainingTimeoutMs <= 0) {
            return {
                ok: false,
                status: null,
                body: null,
                dispatchAttempted: false,
                uncertainBilling: false,
                error: {
                    kind: DISPATCH_ERROR_CODES.TIMEOUT,
                    message: 'Operation timed out before dispatch.',
                },
            };
        }
    }

    // 5. Build Universal Tracked Dispatch Wrapper
    const baseDispatch = options.dispatch
        ?? createDefaultDispatchFn({
            fetch: fetchFn,
            getRequestHeaders: getHeadersFn,
        });

    const trackingState = { lastResponse: null };

    const trackedDispatch = async (request, dispatchOptions) => {
        const response = await baseDispatch(request, dispatchOptions);

        const markerValue = response?.headers?.get?.(NANOGPT_PROXY_MARKER_HEADER) ?? null;

        trackingState.lastResponse = {
            status: response?.status ?? null,
            isMarked: markerValue === expectedMarkerValue,
            markerValue,
        };

        return response;
    };

    // 6. Invoke M03-D1 Transport Core
    const d1Result = await sendNanoGptImageTransportRequest({
        request: options.request,
        dispatch: trackedDispatch,
        timeoutMs: remainingTimeoutMs,
        signal: options.signal,
    });

    // 7. Verify Marker on Post-Dispatch Response
    if (trackingState.lastResponse) {
        const { isMarked, status } = trackingState.lastResponse;

        if (!isMarked) {
            // Unmarked response invalidates capability cache and must never be clean success
            clearCacheFn();

            return {
                ok: false,
                status: d1Result.status ?? status,
                body: null,
                dispatchAttempted: true,
                uncertainBilling: true,
                error: {
                    kind: DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED,
                    message: (d1Result.status === 404 || status === 404)
                        ? `SillyTavern route ${route} was not found or missing proxy marker.`
                        : `Response from ${route} lacked the required SillyTavern proxy marker header.`,
                },
            };
        }
    }

    return d1Result;
}

/**
 * Dispatches a production NanoGPT image request through SillyTavern's normalized proxy.
 *
 * Guarantees:
 * - Pre-flight input, dependency, and capability validation before D1 is called.
 * - Universal marker verification wrapping every dispatch implementation (default or custom).
 * - Single-dispatch execution with conservative billing uncertainty preservation.
 *
 * @param {object} options
 * @returns {Promise<{
 *   ok: boolean,
 *   status: number | null,
 *   body: unknown,
 *   dispatchAttempted: boolean,
 *   uncertainBilling: boolean,
 *   error: { kind: string, message: string } | null,
 * }>}
 */
export async function sendProductionNanoGptImageRequest(options = {}) {
    return sendProductionRequestCore({
        route: NANOGPT_PROXY_ROUTE,
        markerValue: NANOGPT_PROXY_MARKER_VALUE,
        checkCapabilityFn: checkNanoGptImagesCapability,
        clearCacheFn: clearNanoGptImagesCapabilityCache,
        createDefaultDispatchFn: createNanoGptImageDispatch,
        options,
    });
}

/**
 * Dispatches a production NanoGPT image request through SillyTavern's compatibility generations proxy.
 *
 * Guarantees:
 * - Pre-flight input, dependency, and capability validation before D1 is called.
 * - Universal marker verification (v1-compat) wrapping every dispatch implementation (default or custom).
 * - Single-dispatch execution with conservative billing uncertainty preservation.
 *
 * @param {object} options
 * @returns {Promise<{
 *   ok: boolean,
 *   status: number | null,
 *   body: unknown,
 *   dispatchAttempted: boolean,
 *   uncertainBilling: boolean,
 *   error: { kind: string, message: string } | null,
 * }>}
 */
export async function sendProductionNanoGptGenerationsRequest(options = {}) {
    return sendProductionRequestCore({
        route: NANOGPT_PROXY_GENERATIONS_ROUTE,
        markerValue: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE,
        checkCapabilityFn: checkNanoGptGenerationsCapability,
        clearCacheFn: clearNanoGptGenerationsCapabilityCache,
        createDefaultDispatchFn: createNanoGptGenerationsDispatch,
        options,
    });
}

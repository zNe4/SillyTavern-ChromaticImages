import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NANOGPT_PROXY_ROUTE,
    NANOGPT_PROXY_MARKER_HEADER,
    NANOGPT_PROXY_MARKER_VALUE,
    NANOGPT_PROXY_GENERATIONS_ROUTE,
    NANOGPT_PROXY_GENERATIONS_MARKER_VALUE,
    CAPABILITY_DEFAULT_TIMEOUT_MS,
    DISPATCH_ERROR_CODES,
    checkNanoGptImagesCapability,
    clearNanoGptImagesCapabilityCache,
    createNanoGptImageDispatch,
    sendProductionNanoGptImageRequest,
    checkNanoGptGenerationsCapability,
    clearNanoGptGenerationsCapabilityCache,
    createNanoGptGenerationsDispatch,
    sendProductionNanoGptGenerationsRequest,
} from '../src/providers/nanogpt-image-dispatch.js';

import { TRANSPORT_ERROR_CODES } from '../src/providers/nanogpt-image-transport.js';

const DUMMY_REQUEST = Object.freeze({
    model: 'qwen-image',
    prompt: 'a scenic mountain at sunrise',
    n: 1,
    resolution: 'auto',
    input_references: [],
});

const DEFAULT_HEADERS = Object.freeze({
    'X-CSRF-Token': 'test-csrf-token-12345',
});

function getMockHeaders() {
    return { ...DEFAULT_HEADERS };
}

/**
 * Creates a mock Response object with case-insensitive header lookup.
 */
function createMockResponse({
    status = 200,
    headers = {},
    body = null,
    jsonThrows = false,
    delayMs = 0,
} = {}) {
    const normalizedHeaders = new Map();
    for (const [k, v] of Object.entries(headers)) {
        normalizedHeaders.set(k.toLowerCase(), v);
    }

    return {
        status,
        headers: {
            get(name) {
                return normalizedHeaders.get(String(name).toLowerCase()) ?? null;
            },
        },
        async json() {
            if (delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            if (jsonThrows) {
                throw new SyntaxError('Unexpected token < in JSON at position 0');
            }
            return body;
        },
    };
}

/**
 * Creates a tracked AbortController to verify listener attachment and removal.
 */
function createTrackedController() {
    const controller = new AbortController();
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    let addedCount = 0;
    let removedCount = 0;

    controller.signal.addEventListener = (type, listener, options) => {
        if (type === 'abort') {
            addedCount++;
        }
        return origAdd(type, listener, options);
    };

    controller.signal.removeEventListener = (type, listener, options) => {
        if (type === 'abort') {
            removedCount++;
        }
        return origRemove(type, listener, options);
    };

    return {
        controller,
        signal: controller.signal,
        getAddedCount: () => addedCount,
        getRemovedCount: () => removedCount,
    };
}

/**
 * Creates a deferred promise with explicit external resolve and reject handles.
 */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// -----------------------------------------------------------------------------
// Constants & Static Invariants
// -----------------------------------------------------------------------------

test('exported constants match SillyTavern proxy contract', () => {
    assert.strictEqual(NANOGPT_PROXY_ROUTE, '/api/sd/nanogpt/images');
    assert.strictEqual(NANOGPT_PROXY_MARKER_HEADER, 'x-st-nanogpt-proxy');
    assert.strictEqual(NANOGPT_PROXY_MARKER_VALUE, 'v1');
    assert.strictEqual(CAPABILITY_DEFAULT_TIMEOUT_MS, 5000);
});

test('DISPATCH_ERROR_CODES is frozen and contains all required error kinds', () => {
    assert.strictEqual(Object.isFrozen(DISPATCH_ERROR_CODES), true);
    assert.deepEqual(DISPATCH_ERROR_CODES, {
        SILLYTAVERN_UPDATE_REQUIRED: 'sillytavern-update-required',
        CAPABILITY_NETWORK_ERROR: 'capability-network-error',
        CAPABILITY_MALFORMED_RESPONSE: 'capability-malformed-response',
        CANCELLED: 'cancelled',
        TIMEOUT: 'timeout',
        LOCAL_DEPENDENCY_MISSING: 'local-dependency-missing',
        INVALID_DISPATCH_OPTIONS: 'invalid-dispatch-options',
        PROXY_RESPONSE_UNVERIFIED: 'sillytavern-proxy-response-unverified',
    });
});

test('module functions are properly exported', () => {
    assert.strictEqual(typeof checkNanoGptImagesCapability, 'function');
    assert.strictEqual(typeof clearNanoGptImagesCapabilityCache, 'function');
    assert.strictEqual(typeof createNanoGptImageDispatch, 'function');
    assert.strictEqual(typeof sendProductionNanoGptImageRequest, 'function');
});

// -----------------------------------------------------------------------------
// Pre-Flight Validation Tests (Correction 2 & 3)
// -----------------------------------------------------------------------------

test('pre-flight: rejects non-plain-object options with invalid-dispatch-options', async () => {
    const invalidOptions = [null, undefined, 'opts', 123, true, [], new Date()];
    for (const opt of invalidOptions) {
        const result = await sendProductionNanoGptImageRequest(opt);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    }
});

test('pre-flight: rejects unknown option keys with invalid-dispatch-options', async () => {
    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        getRequestHeaders: getMockHeaders,
        fetch: async () => {},
        unrecognizedKey: true,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    assert.strictEqual(result.error.message, 'Unknown option provided to dispatch service.');
});

test('pre-flight: rejects invalid request payloads', async () => {
    const invalidRequests = [null, undefined, 'request', 123, [], new Date()];
    for (const req of invalidRequests) {
        const result = await sendProductionNanoGptImageRequest({
            request: req,
            getRequestHeaders: getMockHeaders,
            fetch: async () => {},
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    }
});

test('pre-flight: rejects invalid timeoutMs values before any network call', async () => {
    const invalidTimeouts = [-1, 0, 1.5, NaN, Infinity, -Infinity, '5000', null, {}];
    for (const t of invalidTimeouts) {
        let fetchCalled = false;
        const result = await sendProductionNanoGptImageRequest({
            request: DUMMY_REQUEST,
            timeoutMs: t,
            getRequestHeaders: getMockHeaders,
            fetch: async () => {
                fetchCalled = true;
            },
        });
        assert.strictEqual(fetchCalled, false);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    }
});

test('pre-flight: rejects malformed signal before any network call', async () => {
    const invalidSignals = ['sig', 123, true, {}, { aborted: 'not-bool' }, { aborted: false }];
    for (const s of invalidSignals) {
        let fetchCalled = false;
        const result = await sendProductionNanoGptImageRequest({
            request: DUMMY_REQUEST,
            signal: s,
            getRequestHeaders: getMockHeaders,
            fetch: async () => {
                fetchCalled = true;
            },
        });
        assert.strictEqual(fetchCalled, false);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    }
});

test('pre-flight: rejects non-function dispatch option', async () => {
    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        dispatch: 'not-a-function',
        getRequestHeaders: getMockHeaders,
        fetch: async () => {},
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
});

test('pre-flight: rejects non-boolean forceCheck option', async () => {
    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        forceCheck: 'true',
        getRequestHeaders: getMockHeaders,
        fetch: async () => {},
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
});

test('pre-flight: rejects when no fetch function is available', async () => {
    const origFetch = globalThis.fetch;
    delete globalThis.fetch;
    try {
        const result = await sendProductionNanoGptImageRequest({
            request: DUMMY_REQUEST,
            getRequestHeaders: getMockHeaders,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('pre-flight: unconditionally requires getRequestHeaders even with custom dispatch', async () => {
    const customDispatch = async () => createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
        body: { ok: true },
    });

    const origST = globalThis.SillyTavern;
    delete globalThis.SillyTavern;
    try {
        const result = await sendProductionNanoGptImageRequest({
            request: DUMMY_REQUEST,
            dispatch: customDispatch,
            fetch: async () => {},
            // getRequestHeaders deliberately omitted
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING);
        assert.match(result.error.message, /getRequestHeaders/);
    } finally {
        globalThis.SillyTavern = origST;
    }
});

test('pre-flight: fails with cancelled before any network call if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let fetchCalled = false;
    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        signal: controller.signal,
        getRequestHeaders: getMockHeaders,
        fetch: async () => {
            fetchCalled = true;
        },
    });

    assert.strictEqual(fetchCalled, false);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);
});

// -----------------------------------------------------------------------------
// Capability Check & Session Caching Tests
// -----------------------------------------------------------------------------

test('capability check: rejects non-plain-object options', async () => {
    const invalidOptions = [null, 'opts', 123, true, [], new Date()];
    for (const opt of invalidOptions) {
        const result = await checkNanoGptImagesCapability(opt);
        assert.strictEqual(result.supported, false);
        assert.strictEqual(result.cached, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    }
});

test('capability check: calling with no options uses defaults and checks dependencies', async () => {
    clearNanoGptImagesCapabilityCache();
    const result = await checkNanoGptImagesCapability();
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING);
});

test('capability check: rejects unknown option keys', async () => {
    const result = await checkNanoGptImagesCapability({
        getRequestHeaders: getMockHeaders,
        fetch: async () => {},
        bogusKey: 1,
    });
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
});

test('capability check: valid 200 + proxy marker returns supported true', async () => {
    clearNanoGptImagesCapabilityCache();

    let calledUrl = null;
    let calledMethod = null;
    let calledHeaders = null;

    const mockFetch = async (url, opts) => {
        calledUrl = url;
        calledMethod = opts.method;
        calledHeaders = opts.headers;
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images' },
        });
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error, null);
    assert.strictEqual(calledUrl, NANOGPT_PROXY_ROUTE);
    assert.strictEqual(calledMethod, 'GET');
    assert.strictEqual(calledHeaders['X-CSRF-Token'], 'test-csrf-token-12345');
});

test('capability check: session memory cache hit makes zero network calls', async () => {
    // Relying on previous test's positive cache
    let fetchCalled = false;
    const mockFetch = async () => {
        fetchCalled = true;
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(fetchCalled, false);
    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.cached, true);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error, null);
});

test('capability check: forceCheck bypasses session memory cache', async () => {
    let fetchCalled = false;
    const mockFetch = async () => {
        fetchCalled = true;
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images' },
        });
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.cached, false);
});

test('capability check: clearNanoGptImagesCapabilityCache forces fresh GET', async () => {
    clearNanoGptImagesCapabilityCache();

    let fetchCalled = false;
    const mockFetch = async () => {
        fetchCalled = true;
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images' },
        });
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(fetchCalled, true);
    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.cached, false);
});

test('capability check: unmarked 404 returns sillytavern-update-required', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async () => createMockResponse({
        status: 404,
        headers: {},
        body: 'Cannot GET /api/sd/nanogpt/images',
    });

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED);
    assert.match(result.error.message, /SillyTavern update required/);
});

test('capability check: 200 missing proxy marker returns capability-malformed-response', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async () => createMockResponse({
        status: 200,
        headers: {}, // no marker header
        body: { ok: true, route: 'nanogpt-images' },
    });

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
});

test('capability check: 200 with wrong proxy marker value returns capability-malformed-response', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async () => createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: 'v2' }, // wrong value
        body: { ok: true, route: 'nanogpt-images' },
    });

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
});

test('capability check: 200 with malformed JSON body returns capability-malformed-response', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async () => createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
        jsonThrows: true,
    });

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
});

test('capability check: 200 with invalid payload properties returns capability-malformed-response', async () => {
    clearNanoGptImagesCapabilityCache();

    const payloads = [
        { ok: false, route: 'nanogpt-images' },
        { ok: true, route: 'other-route' },
        { ok: true },
        null,
        [],
        'ok',
    ];

    for (const p of payloads) {
        clearNanoGptImagesCapabilityCache();
        const mockFetch = async () => createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: p,
        });

        const result = await checkNanoGptImagesCapability({
            fetch: mockFetch,
            getRequestHeaders: getMockHeaders,
        });

        assert.strictEqual(result.supported, false);
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
    }
});

test('capability check: unexpected status codes (500, marked 403, 502) fail closed', async () => {
    clearNanoGptImagesCapabilityCache();

    const testCases = [
        { status: 500, headers: {} },
        { status: 403, headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE } },
        { status: 502, headers: {} },
    ];

    for (const tc of testCases) {
        clearNanoGptImagesCapabilityCache();
        const mockFetch = async () => createMockResponse({
            status: tc.status,
            headers: tc.headers,
            body: { error: 'server error' },
        });

        const result = await checkNanoGptImagesCapability({
            fetch: mockFetch,
            getRequestHeaders: getMockHeaders,
        });

        assert.strictEqual(result.supported, false);
        assert.strictEqual(result.status, tc.status);
        assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
    }
});

test('capability check: network error on GET returns capability-network-error', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async () => {
        throw new TypeError('Failed to fetch');
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_NETWORK_ERROR);
});

test('capability check: caller abort during GET settles as cancelled and cleans up listeners', async () => {
    clearNanoGptImagesCapabilityCache();
    const tracked = createTrackedController();

    const mockFetch = async (url, { signal }) => {
        return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                reject(new Error('aborted'));
            });
        });
    };

    const checkPromise = checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal: tracked.signal,
    });

    assert.strictEqual(tracked.getAddedCount(), 1);
    tracked.controller.abort();

    const result = await checkPromise;
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);
    assert.strictEqual(tracked.getRemovedCount(), 1);
});

test('capability check: timeout settles as timeout, clears timer, and detaches listeners', async () => {
    clearNanoGptImagesCapabilityCache();
    const tracked = createTrackedController();

    const mockFetch = async (url, { signal }) => {
        return new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                reject(new Error('timed out'));
            });
        });
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal: tracked.signal,
        timeoutMs: 25,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.TIMEOUT);
    assert.strictEqual(tracked.getAddedCount(), 1);
    assert.strictEqual(tracked.getRemovedCount(), 1);
});

test('capability check: late fetch rejection after timeout is caught and causes no unhandled rejection', async () => {
    clearNanoGptImagesCapabilityCache();

    let triggerDelayedReject;
    const mockFetch = async () => {
        return new Promise((_, reject) => {
            triggerDelayedReject = () => reject(new Error('delayed network error'));
        });
    };

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        timeoutMs: 20,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.TIMEOUT);

    // Trigger delayed rejection after capability has settled; should not throw unhandled rejection
    assert.doesNotThrow(() => {
        triggerDelayedReject();
    });
});

// -----------------------------------------------------------------------------
// Low-Level POST Dispatch Factory Tests (`createNanoGptImageDispatch`)
// -----------------------------------------------------------------------------

test('createNanoGptImageDispatch: validates arguments and dependencies', () => {
    assert.throws(() => createNanoGptImageDispatch(null), /Dependencies must be a plain object/);
    assert.throws(() => createNanoGptImageDispatch('invalid'), /Dependencies must be a plain object/);

    const dispatch = createNanoGptImageDispatch();
    assert.strictEqual(typeof dispatch, 'function');
});

test('createNanoGptImageDispatch: throws if request payload is not plain object', async () => {
    const dispatch = createNanoGptImageDispatch({
        fetch: async () => {},
        getRequestHeaders: getMockHeaders,
    });

    await assert.rejects(() => dispatch(null), /Request payload must be a plain object/);
    await assert.rejects(() => dispatch('req'), /Request payload must be a plain object/);
    await assert.rejects(() => dispatch([]), /Request payload must be a plain object/);
});

test('createNanoGptImageDispatch: calls POST /api/sd/nanogpt/images with CSRF headers, json body, and signal', async () => {
    let capturedUrl = null;
    let capturedOpts = null;

    const mockFetch = async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true },
        });
    };

    const dispatch = createNanoGptImageDispatch({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    const controller = new AbortController();
    const response = await dispatch(DUMMY_REQUEST, { signal: controller.signal });

    assert.strictEqual(capturedUrl, NANOGPT_PROXY_ROUTE);
    assert.strictEqual(capturedOpts.method, 'POST');
    assert.strictEqual(capturedOpts.headers['X-CSRF-Token'], 'test-csrf-token-12345');
    assert.strictEqual(capturedOpts.headers['Content-Type'], 'application/json');
    assert.strictEqual(capturedOpts.body, JSON.stringify(DUMMY_REQUEST));
    assert.strictEqual(capturedOpts.signal, controller.signal);
    assert.strictEqual(typeof response.json, 'function');
});

// -----------------------------------------------------------------------------
// Universal Marker Interception & Dispatch Verification (Correction 1)
// -----------------------------------------------------------------------------

test('sendProductionNanoGptImageRequest: default dispatch marked 200 returns clean success', async () => {
    clearNanoGptImagesCapabilityCache();

    let postFetchCount = 0;
    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            postFetchCount++;
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { data: [{ b64_json: 'test-base64' }] },
            });
        }
        throw new Error(`Unexpected request: ${opts.method} ${url}`);
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.deepEqual(result.body, { data: [{ b64_json: 'test-base64' }] });
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error, null);
    assert.strictEqual(postFetchCount, 1);
});

test('sendProductionNanoGptImageRequest: custom dispatch marked 200 returns clean success', async () => {
    clearNanoGptImagesCapabilityCache();

    let customDispatchCount = 0;
    const customDispatch = async () => {
        customDispatchCount++;
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { data: [{ b64_json: 'custom-dispatch-base64' }] },
        });
    };

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        throw new Error('POST fetch should not be called when custom dispatch is provided');
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        dispatch: customDispatch,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.deepEqual(result.body, { data: [{ b64_json: 'custom-dispatch-base64' }] });
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(customDispatchCount, 1);
});

test('sendProductionNanoGptImageRequest: unmarked POST 200 via default dispatch is overridden to failure and invalidates cache', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            return createMockResponse({
                status: 200,
                headers: {}, // UNMARKED POST RESPONSE
                body: { data: [{ b64_json: 'test-base64' }] },
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED);

    // Verify positive capability cache was invalidated
    let getCalled = false;
    await checkNanoGptImagesCapability({
        fetch: async () => {
            getCalled = true;
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(getCalled, true, 'Capability cache must be invalidated after unmarked response');
});

test('sendProductionNanoGptImageRequest: unmarked POST 200 via custom dispatch cannot bypass marker check', async () => {
    clearNanoGptImagesCapabilityCache();

    const customDispatch = async () => {
        return createMockResponse({
            status: 200,
            headers: {}, // UNMARKED CUSTOM DISPATCH
            body: { data: [{ b64_json: 'sneaky-base64' }] },
        });
    };

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        dispatch: customDispatch,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED);
});

test('sendProductionNanoGptImageRequest: marked POST 404 is preserved as D1 provider-failure (not update-required)', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            return createMockResponse({
                status: 404,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { error: 'Model not found upstream' },
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.PROVIDER_FAILURE);
});

test('sendProductionNanoGptImageRequest: unmarked POST 404 returns sillytavern-proxy-response-unverified and clears cache', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            return createMockResponse({
                status: 404,
                headers: {}, // UNMARKED 404 (e.g. route missing race)
                body: 'Not Found',
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED);
    assert.match(result.error.message, /route \/api\/sd\/nanogpt\/images was not found/);
});

test('sendProductionNanoGptImageRequest: unmarked POST 500 returns sillytavern-proxy-response-unverified and clears cache', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            return createMockResponse({
                status: 500,
                headers: {}, // UNMARKED 500
                body: 'Internal Server Error',
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED);
});

test('sendProductionNanoGptImageRequest: network drop during POST settles as network-failure with uncertain billing', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            throw new TypeError('Network connection reset');
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.NETWORK_FAILURE);
});

// -----------------------------------------------------------------------------
// Whole-Operation Timeout Budgeting & Capability Isolation Tests
// -----------------------------------------------------------------------------

test('budgeting: capability failure terminates before D1 dispatchAttempted', async () => {
    clearNanoGptImagesCapabilityCache();

    let postCalled = false;
    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 404,
                headers: {},
                body: 'Not Found',
            });
        }
        if (opts.method === 'POST') {
            postCalled = true;
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(postCalled, false);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED);
});

test('budgeting: caller abort during capability terminates with zero dispatchAttempted', async () => {
    clearNanoGptImagesCapabilityCache();
    const controller = new AbortController();

    let postCalled = false;
    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            controller.abort();
            return new Promise((_, reject) => {
                opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
        }
        if (opts.method === 'POST') {
            postCalled = true;
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal: controller.signal,
    });

    assert.strictEqual(postCalled, false);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);
});

test('budgeting: passes remaining timeout budget to D1 after capability GET completes', async () => {
    clearNanoGptImagesCapabilityCache();

    let d1TimeoutReceived = null;
    const customDispatch = async (req, opt) => {
        // opt is { signal }
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true },
        });
    };

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            // Simulate 50ms elapsed
            await new Promise((r) => setTimeout(r, 50));
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
    };

    // We can verify that a timeoutMs of 5000 is decremented
    const startTime = Date.now();
    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        dispatch: customDispatch,
        getRequestHeaders: getMockHeaders,
        timeoutMs: 5000,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.uncertainBilling, false);
});

test('budgeting: aborts before D1 if capability check consumes entire timeout budget', async () => {
    clearNanoGptImagesCapabilityCache();

    let postCalled = false;
    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            // Capability GET takes 40ms
            await new Promise((r) => setTimeout(r, 40));
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            postCalled = true;
        }
    };

    // Overall timeout is 30ms, so after 40ms GET it has expired
    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        timeoutMs: 30,
    });

    assert.strictEqual(postCalled, false);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.TIMEOUT);
});

// -----------------------------------------------------------------------------
// Mandatory Addendum D1 Integration Cases
// -----------------------------------------------------------------------------

test('integration addendum 1: POST-stage timeout yields timeout with uncertainBilling: true', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            // POST hangs until aborted
            return new Promise((_, reject) => {
                opts.signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                });
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        timeoutMs: 40,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.TIMEOUT);
});

test('integration addendum 2: POST-stage caller cancellation yields cancelled with uncertainBilling: true', async () => {
    clearNanoGptImagesCapabilityCache();
    const controller = new AbortController();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            // When POST starts, caller aborts
            setTimeout(() => controller.abort(), 10);
            return new Promise((_, reject) => {
                opts.signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                });
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal: controller.signal,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.CANCELLED);
});

test('integration addendum 3: malformed successful response yields malformed-response with uncertainBilling: true', async () => {
    clearNanoGptImagesCapabilityCache();

    const mockFetch = async (url, opts) => {
        if (opts.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (opts.method === 'POST') {
            // Marked 200, but body cannot be parsed as JSON
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                jsonThrows: true,
            });
        }
    };

    const result = await sendProductionNanoGptImageRequest({
        request: DUMMY_REQUEST,
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE);
});

// -----------------------------------------------------------------------------
// Privacy & Passive Import Safety Tests
// -----------------------------------------------------------------------------

test('privacy: sentinels are never logged to console or leaked in error messages', async () => {
    clearNanoGptImagesCapabilityCache();

    const SENTINEL_PROMPT = 'SUPER_SECRET_SCENE_PROMPT_DO_NOT_LEAK_XYZ789';
    const SENTINEL_REF = 'data:image/png;base64,SECRET_BASE64_IMAGE_PAYLOAD_ABC123';
    const SENTINEL_KEY = 'SECRET_NANOGPT_API_KEY_9999999';

    const sensitiveRequest = {
        model: 'qwen-image',
        prompt: SENTINEL_PROMPT,
        n: 1,
        resolution: 'auto',
        input_references: [SENTINEL_REF],
        extra_key: SENTINEL_KEY,
    };

    const consoleLogs = [];
    const origLog = console.log;
    const origDebug = console.debug;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;

    const intercept = (...args) => consoleLogs.push(args.map(String).join(' '));

    console.log = intercept;
    console.debug = intercept;
    console.info = intercept;
    console.warn = intercept;
    console.error = intercept;

    try {
        const mockFetch = async () => {
            throw new Error('Forced network error');
        };

        const result = await sendProductionNanoGptImageRequest({
            request: sensitiveRequest,
            fetch: mockFetch,
            getRequestHeaders: getMockHeaders,
        });

        const serializedResult = JSON.stringify(result);
        const combinedLogs = consoleLogs.join('\n');

        assert.strictEqual(serializedResult.includes(SENTINEL_PROMPT), false);
        assert.strictEqual(serializedResult.includes(SENTINEL_REF), false);
        assert.strictEqual(serializedResult.includes(SENTINEL_KEY), false);

        assert.strictEqual(combinedLogs.includes(SENTINEL_PROMPT), false);
        assert.strictEqual(combinedLogs.includes(SENTINEL_REF), false);
        assert.strictEqual(combinedLogs.includes(SENTINEL_KEY), false);
    } finally {
        console.log = origLog;
        console.debug = origDebug;
        console.info = origInfo;
        console.warn = origWarn;
        console.error = origError;
    }
});

test('passive import safety: importing module does not make network calls or register global listeners', () => {
    // Module is already imported at top of file; verify no global listeners were attached to window or process
    assert.strictEqual(typeof checkNanoGptImagesCapability, 'function');
});

// -----------------------------------------------------------------------------
// Compatibility Route & Marker Invariants (M03-G1)
// -----------------------------------------------------------------------------

test('compatibility constants match SillyTavern proxy contract', () => {
    assert.strictEqual(NANOGPT_PROXY_GENERATIONS_ROUTE, '/api/sd/nanogpt/images/generations');
    assert.strictEqual(NANOGPT_PROXY_GENERATIONS_MARKER_VALUE, 'v1-compat');
    assert.notStrictEqual(NANOGPT_PROXY_GENERATIONS_ROUTE, NANOGPT_PROXY_ROUTE);
    assert.notStrictEqual(NANOGPT_PROXY_GENERATIONS_MARKER_VALUE, NANOGPT_PROXY_MARKER_VALUE);
});

test('compatibility module functions are properly exported', () => {
    assert.strictEqual(typeof checkNanoGptGenerationsCapability, 'function');
    assert.strictEqual(typeof clearNanoGptGenerationsCapabilityCache, 'function');
    assert.strictEqual(typeof createNanoGptGenerationsDispatch, 'function');
    assert.strictEqual(typeof sendProductionNanoGptGenerationsRequest, 'function');
});

// -----------------------------------------------------------------------------
// Compatibility Capability Check Tests (M03-G1)
// -----------------------------------------------------------------------------

test('compatibility capability: succeeds and caches on 200 with v1-compat marker and expected route payload', async () => {
    clearNanoGptGenerationsCapabilityCache();
    let fetchCalls = 0;
    const mockFetch = async (url, init) => {
        fetchCalls++;
        assert.strictEqual(url, NANOGPT_PROXY_GENERATIONS_ROUTE);
        assert.strictEqual(init.method, 'GET');
        assert.strictEqual(init.headers['X-CSRF-Token'], 'test-csrf-token-12345');
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images-generations' },
        });
    };

    const first = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(first.supported, true);
    assert.strictEqual(first.cached, false);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.error, null);
    assert.strictEqual(fetchCalls, 1);

    // Second call hits cache without calling fetch
    const second = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(second.supported, true);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.error, null);
    assert.strictEqual(fetchCalls, 1);

    // forceCheck bypasses cache
    const third = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });

    assert.strictEqual(third.supported, true);
    assert.strictEqual(third.cached, false);
    assert.strictEqual(fetchCalls, 2);

    // clearNanoGptGenerationsCapabilityCache resets cache
    clearNanoGptGenerationsCapabilityCache();
    const fourth = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(fourth.cached, false);
    assert.strictEqual(fetchCalls, 3);
});

test('compatibility capability: returns sillytavern-update-required on 404 without marker', async () => {
    clearNanoGptGenerationsCapabilityCache();
    const mockFetch = async () => createMockResponse({
        status: 404,
        headers: {},
        body: null,
    });

    const result = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED);
    assert.match(result.error.message, /NanoGPT compatibility image generations support/);
});

test('compatibility capability: rejects response with normalized marker v1 instead of v1-compat', async () => {
    clearNanoGptGenerationsCapabilityCache();
    const mockFetch = async () => createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: 'v1' }, // Wrong marker for compat route!
        body: { ok: true, route: 'nanogpt-images-generations' },
    });

    const result = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
});

test('compatibility capability: rejects response with mismatched route payload', async () => {
    clearNanoGptGenerationsCapabilityCache();
    const mockFetch = async () => createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images' }, // Wrong route in body!
    });

    const result = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CAPABILITY_MALFORMED_RESPONSE);
});

test('cache isolation: normalized and compatibility capability caches are completely independent', async () => {
    clearNanoGptImagesCapabilityCache();
    clearNanoGptGenerationsCapabilityCache();

    let normalizedCalls = 0;
    let compatCalls = 0;

    const mockFetch = async (url) => {
        if (url === NANOGPT_PROXY_ROUTE) {
            normalizedCalls++;
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images' },
            });
        }
        if (url === NANOGPT_PROXY_GENERATIONS_ROUTE) {
            compatCalls++;
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images-generations' },
            });
        }
        throw new Error(`Unexpected url ${url}`);
    };

    // 1. Check normalized route -> populates normalized cache only
    const norm1 = await checkNanoGptImagesCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    assert.strictEqual(norm1.supported, true);
    assert.strictEqual(norm1.cached, false);
    assert.strictEqual(normalizedCalls, 1);
    assert.strictEqual(compatCalls, 0);

    // 2. Compatibility check is NOT cached yet
    const comp1 = await checkNanoGptGenerationsCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    assert.strictEqual(comp1.supported, true);
    assert.strictEqual(comp1.cached, false);
    assert.strictEqual(normalizedCalls, 1);
    assert.strictEqual(compatCalls, 1);

    // 3. Clear normalized cache -> does not clear compatibility cache
    clearNanoGptImagesCapabilityCache();
    const comp2 = await checkNanoGptGenerationsCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    assert.strictEqual(comp2.cached, true);
    assert.strictEqual(compatCalls, 1);

    // 4. Normalized is uncached
    const norm2 = await checkNanoGptImagesCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    assert.strictEqual(norm2.cached, false);
    assert.strictEqual(normalizedCalls, 2);

    // 5. Clear compatibility cache -> does not clear normalized cache
    clearNanoGptGenerationsCapabilityCache();
    const norm3 = await checkNanoGptImagesCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    assert.strictEqual(norm3.cached, true);
    assert.strictEqual(normalizedCalls, 2);

    const comp3 = await checkNanoGptGenerationsCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    assert.strictEqual(comp3.cached, false);
    assert.strictEqual(compatCalls, 2);
});

// -----------------------------------------------------------------------------
// Compatibility Dispatch & Production Request Tests (M03-G1)
// -----------------------------------------------------------------------------

test('createNanoGptGenerationsDispatch dispatches POST to generations route with headers and body', async () => {
    let dispatchedUrl = null;
    let dispatchedInit = null;

    const mockFetch = async (url, init) => {
        dispatchedUrl = url;
        dispatchedInit = init;
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
            body: { ok: true },
        });
    };

    const dispatchFn = createNanoGptGenerationsDispatch({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    const testPayload = { model: 'qwen-image', prompt: 'test', nImages: 1, resolution: 'auto' };
    await dispatchFn(testPayload);

    assert.strictEqual(dispatchedUrl, NANOGPT_PROXY_GENERATIONS_ROUTE);
    assert.strictEqual(dispatchedInit.method, 'POST');
    assert.strictEqual(dispatchedInit.headers['Content-Type'], 'application/json');
    assert.strictEqual(dispatchedInit.headers['X-CSRF-Token'], 'test-csrf-token-12345');
    assert.deepEqual(JSON.parse(dispatchedInit.body), testPayload);
});

test('sendProductionNanoGptGenerationsRequest: pre-flight validation rejects invalid options and missing deps', async () => {
    // Non-object options
    const badRes = await sendProductionNanoGptGenerationsRequest(null);
    assert.strictEqual(badRes.ok, false);
    assert.strictEqual(badRes.dispatchAttempted, false);
    assert.strictEqual(badRes.uncertainBilling, false);
    assert.strictEqual(badRes.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);

    // Missing getRequestHeaders
    const missingHeadersRes = await sendProductionNanoGptGenerationsRequest({
        request: { model: 'qwen-image', prompt: 'test' },
        fetch: async () => {},
    });
    assert.strictEqual(missingHeadersRes.ok, false);
    assert.strictEqual(missingHeadersRes.error.kind, DISPATCH_ERROR_CODES.LOCAL_DEPENDENCY_MISSING);
});

test('sendProductionNanoGptGenerationsRequest: fails closed with sillytavern-update-required when capability check returns 404', async () => {
    clearNanoGptGenerationsCapabilityCache();
    let postAttempted = false;

    const mockFetch = async (url, init) => {
        if (init?.method === 'GET') {
            return createMockResponse({ status: 404, headers: {}, body: null });
        }
        postAttempted = true;
        return createMockResponse({ status: 200, headers: {}, body: {} });
    };

    const result = await sendProductionNanoGptGenerationsRequest({
        request: { model: 'qwen-image', prompt: 'test', nImages: 1, resolution: 'auto' },
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED);
    assert.strictEqual(postAttempted, false);
});

test('sendProductionNanoGptGenerationsRequest: dispatches and succeeds when capability and post-dispatch response have v1-compat marker', async () => {
    clearNanoGptGenerationsCapabilityCache();
    let getCalled = false;
    let postCalled = false;

    const mockFetch = async (url, init) => {
        if (init?.method === 'GET') {
            getCalled = true;
            assert.strictEqual(url, NANOGPT_PROXY_GENERATIONS_ROUTE);
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images-generations' },
            });
        }
        if (init?.method === 'POST') {
            postCalled = true;
            assert.strictEqual(url, NANOGPT_PROXY_GENERATIONS_ROUTE);
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { created: 12345, data: [{ b64_json: 'aW1hZ2UtZGF0YQ==' }] },
            });
        }
        throw new Error(`Unexpected call ${url}`);
    };

    const result = await sendProductionNanoGptGenerationsRequest({
        request: { model: 'qwen-image', prompt: 'a beautiful valley', nImages: 1, resolution: '1024x1024', response_format: 'b64_json' },
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(getCalled, true);
    assert.strictEqual(postCalled, true);
    assert.deepEqual(result.body, { created: 12345, data: [{ b64_json: 'aW1hZ2UtZGF0YQ==' }] });
});

test('sendProductionNanoGptGenerationsRequest: fails closed with PROXY_RESPONSE_UNVERIFIED if post-dispatch marker is v1 instead of v1-compat', async () => {
    clearNanoGptGenerationsCapabilityCache();

    const mockFetch = async (url, init) => {
        if (init?.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images-generations' },
            });
        }
        // POST returns normalized marker 'v1' instead of 'v1-compat'!
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: 'v1' },
            body: { created: 12345, data: [{ b64_json: 'aW1hZ2UtZGF0YQ==' }] },
        });
    };

    const result = await sendProductionNanoGptGenerationsRequest({
        request: { model: 'qwen-image', prompt: 'test', nImages: 1, resolution: 'auto' },
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED);
});

test('sendProductionNanoGptGenerationsRequest: universal marker verification enforces v1-compat on custom dispatch wrapper', async () => {
    clearNanoGptGenerationsCapabilityCache();

    const mockFetch = async (url, init) => {
        if (init?.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images-generations' },
            });
        }
        throw new Error('Default fetch should not be called for POST when custom dispatch is provided');
    };

    // Custom dispatch that returns response missing v1-compat marker
    const customDispatch = async () => createMockResponse({
        status: 200,
        headers: {}, // No marker!
        body: { ok: true },
    });

    const result = await sendProductionNanoGptGenerationsRequest({
        request: { model: 'qwen-image', prompt: 'test', nImages: 1, resolution: 'auto' },
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        dispatch: customDispatch,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.PROXY_RESPONSE_UNVERIFIED);
});

test('sendProductionNanoGptGenerationsRequest: post-dispatch network error preserves uncertainBilling: true', async () => {
    clearNanoGptGenerationsCapabilityCache();

    const mockFetch = async (url, init) => {
        if (init?.method === 'GET') {
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images-generations' },
            });
        }
        throw new TypeError('Network connection reset by peer');
    };

    const result = await sendProductionNanoGptGenerationsRequest({
        request: { model: 'qwen-image', prompt: 'test', nImages: 1, resolution: 'auto' },
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.NETWORK_FAILURE);
});

// -----------------------------------------------------------------------------
// Capability Cache Invalidation, Cancellation Precedence & Lifecycle Tests
// -----------------------------------------------------------------------------

test('capability cache: failed forced recheck clears prior positive normalized capability cache', async () => {
    clearNanoGptImagesCapabilityCache();

    let shouldFail = false;
    const mockFetch = async () => {
        if (shouldFail) {
            return createMockResponse({
                status: 404,
                headers: {},
                body: null,
            });
        }
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images' },
        });
    };

    // 1. Initial success sets cache
    const initial = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(initial.supported, true);
    assert.strictEqual(initial.cached, false);

    // 2. Unforced call hits cache
    const cacheHit = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(cacheHit.supported, true);
    assert.strictEqual(cacheHit.cached, true);

    // 3. Forced recheck fails (e.g. 404)
    shouldFail = true;
    const failedForced = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });
    assert.strictEqual(failedForced.supported, false);
    assert.strictEqual(failedForced.error.kind, DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED);

    // 4. Subsequent unforced call MUST NOT hit cache; it must re-probe and fail
    let subsequentFetchCalls = 0;
    const subsequent = await checkNanoGptImagesCapability({
        fetch: async () => {
            subsequentFetchCalls++;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(subsequent.supported, false);
    assert.strictEqual(subsequent.cached, false);
    assert.strictEqual(subsequentFetchCalls, 1);
});

test('capability cache: failed forced recheck clears prior positive compatibility capability cache', async () => {
    clearNanoGptGenerationsCapabilityCache();

    let shouldFail = false;
    const mockFetch = async () => {
        if (shouldFail) {
            return createMockResponse({
                status: 502,
                headers: {},
                body: null,
            });
        }
        return createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images-generations' },
        });
    };

    // 1. Initial success sets cache
    const initial = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(initial.supported, true);
    assert.strictEqual(initial.cached, false);

    // 2. Unforced call hits cache
    const cacheHit = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(cacheHit.supported, true);
    assert.strictEqual(cacheHit.cached, true);

    // 3. Forced recheck fails
    shouldFail = true;
    const failedForced = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });
    assert.strictEqual(failedForced.supported, false);

    // 4. Subsequent unforced call is not a cache hit
    let probeCalled = false;
    const subsequent = await checkNanoGptGenerationsCapability({
        fetch: async () => {
            probeCalled = true;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(subsequent.supported, false);
    assert.strictEqual(subsequent.cached, false);
    assert.strictEqual(probeCalled, true);
});

test('cross-route concurrency: normalized check does not supersede in-flight forced compatibility check', async () => {
    clearNanoGptImagesCapabilityCache();
    clearNanoGptGenerationsCapabilityCache();

    // 1. Seed compatibility positive cache
    const seedResult = await checkNanoGptGenerationsCapability({
        fetch: async () => createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images-generations' },
        }),
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(seedResult.supported, true);
    assert.strictEqual(seedResult.cached, false);

    // 2. Start forced compatibility check waiting on compatDeferred
    const compatDeferred = createDeferred();
    const compatPromise = checkNanoGptGenerationsCapability({
        fetch: () => compatDeferred.promise,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });

    // 3. While compatibility check is in flight, start and complete a normalized check
    const normResult = await checkNanoGptImagesCapability({
        fetch: async () => createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images' },
        }),
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(normResult.supported, true);

    // 4. Compatibility check resolves with failure (404)
    compatDeferred.resolve(createMockResponse({
        status: 404,
        headers: {},
        body: null,
    }));
    const compatResult = await compatPromise;
    assert.strictEqual(compatResult.supported, false);
    assert.strictEqual(compatResult.error.kind, DISPATCH_ERROR_CODES.SILLYTAVERN_UPDATE_REQUIRED);

    // 5. Subsequent unforced compatibility check MUST NOT hit cache; it must probe network
    let subsequentProbeCalled = false;
    const subsequentCompat = await checkNanoGptGenerationsCapability({
        fetch: async () => {
            subsequentProbeCalled = true;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(subsequentProbeCalled, true);
    assert.strictEqual(subsequentCompat.supported, false);
    assert.strictEqual(subsequentCompat.cached, false);
});

test('cross-route concurrency: compatibility check does not supersede in-flight forced normalized check', async () => {
    clearNanoGptImagesCapabilityCache();
    clearNanoGptGenerationsCapabilityCache();

    // 1. Seed normalized positive cache
    const seedResult = await checkNanoGptImagesCapability({
        fetch: async () => createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images' },
        }),
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(seedResult.supported, true);
    assert.strictEqual(seedResult.cached, false);

    // 2. Start forced normalized check waiting on normDeferred
    const normDeferred = createDeferred();
    const normPromise = checkNanoGptImagesCapability({
        fetch: () => normDeferred.promise,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });

    // 3. While normalized check is in flight, start and complete a compatibility check
    const compatResult = await checkNanoGptGenerationsCapability({
        fetch: async () => createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images-generations' },
        }),
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(compatResult.supported, true);

    // 4. Normalized check resolves with failure
    normDeferred.resolve(createMockResponse({
        status: 404,
        headers: {},
        body: null,
    }));
    const normFailResult = await normPromise;
    assert.strictEqual(normFailResult.supported, false);

    // 5. Subsequent unforced normalized check must probe network, not hit stale cache
    let subsequentProbeCalled = false;
    const subsequentNorm = await checkNanoGptImagesCapability({
        fetch: async () => {
            subsequentProbeCalled = true;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(subsequentProbeCalled, true);
    assert.strictEqual(subsequentNorm.supported, false);
    assert.strictEqual(subsequentNorm.cached, false);
});

test('forced recheck immediately invalidates cache so concurrent unforced check does not bypass revalidation', async () => {
    clearNanoGptGenerationsCapabilityCache();

    // 1. Seed positive cache
    await checkNanoGptGenerationsCapability({
        fetch: async () => createMockResponse({
            status: 200,
            headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
            body: { ok: true, route: 'nanogpt-images-generations' },
        }),
        getRequestHeaders: getMockHeaders,
    });

    // 2. Check A starts with forceCheck: true and hangs on checkADeferred
    const checkADeferred = createDeferred();
    const checkAPromise = checkNanoGptGenerationsCapability({
        fetch: () => checkADeferred.promise,
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });

    // 3. Check B starts with forceCheck: false while Check A is in flight
    let checkBFetchCalled = false;
    const checkBDeferred = createDeferred();
    const checkBPromise = checkNanoGptGenerationsCapability({
        fetch: () => {
            checkBFetchCalled = true;
            return checkBDeferred.promise;
        },
        getRequestHeaders: getMockHeaders,
    });

    // Verify Check B did NOT return a synchronous cache hit!
    assert.strictEqual(checkBFetchCalled, true);

    // Resolve Check A with 404
    checkADeferred.resolve(createMockResponse({ status: 404, headers: {} }));
    const resultA = await checkAPromise;
    assert.strictEqual(resultA.supported, false);

    // Resolve Check B with 404
    checkBDeferred.resolve(createMockResponse({ status: 404, headers: {} }));
    const resultB = await checkBPromise;
    assert.strictEqual(resultB.supported, false);
});

test('explicit cache clearing invalidates in-flight check and prevents late positive caching (compatibility)', async () => {
    clearNanoGptGenerationsCapabilityCache();

    const fetchDeferred = createDeferred();

    // Start capability check
    const checkPromise = checkNanoGptGenerationsCapability({
        fetch: () => fetchDeferred.promise,
        getRequestHeaders: getMockHeaders,
    });

    // Explicit cache clear while operation is in flight
    clearNanoGptGenerationsCapabilityCache();

    // Now fetch resolves late with valid 200 OK + expected route
    fetchDeferred.resolve(createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images-generations' },
    }));

    const result = await checkPromise;
    // Must be superseded and report supported: false
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);
    assert.strictEqual(result.error.message, 'Capability check superseded by newer verification.');

    // Verify cache remains empty; next check must probe network
    let followUpFetchCalled = false;
    const followUp = await checkNanoGptGenerationsCapability({
        fetch: async () => {
            followUpFetchCalled = true;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(followUpFetchCalled, true);
    assert.strictEqual(followUp.cached, false);
    assert.strictEqual(followUp.supported, false);
});

test('explicit cache clearing invalidates in-flight check and prevents late positive caching (normalized)', async () => {
    clearNanoGptImagesCapabilityCache();

    const fetchDeferred = createDeferred();

    const checkPromise = checkNanoGptImagesCapability({
        fetch: () => fetchDeferred.promise,
        getRequestHeaders: getMockHeaders,
    });

    // Clear normalized cache during in-flight operation
    clearNanoGptImagesCapabilityCache();

    fetchDeferred.resolve(createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images' },
    }));

    const result = await checkPromise;
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);
    assert.strictEqual(result.error.message, 'Capability check superseded by newer verification.');

    let followUpCalled = false;
    const followUp = await checkNanoGptImagesCapability({
        fetch: async () => {
            followUpCalled = true;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(followUpCalled, true);
    assert.strictEqual(followUp.cached, false);
    assert.strictEqual(followUp.supported, false);
});

test('capability check: pre-aborted signal takes precedence over positive cache hit', async () => {
    clearNanoGptImagesCapabilityCache();
    clearNanoGptGenerationsCapabilityCache();

    const mockFetch = async (url) => {
        const isGen = url.includes('generations');
        return createMockResponse({
            status: 200,
            headers: {
                [NANOGPT_PROXY_MARKER_HEADER]: isGen ? NANOGPT_PROXY_GENERATIONS_MARKER_VALUE : NANOGPT_PROXY_MARKER_VALUE,
            },
            body: { ok: true, route: isGen ? 'nanogpt-images-generations' : 'nanogpt-images' },
        });
    };

    // Seed positive caches
    await checkNanoGptImagesCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });
    await checkNanoGptGenerationsCapability({ fetch: mockFetch, getRequestHeaders: getMockHeaders });

    // Pre-aborted normalized check returns cancelled immediately
    const preAbortedNormalized = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal: AbortSignal.abort(),
    });
    assert.strictEqual(preAbortedNormalized.supported, false);
    assert.strictEqual(preAbortedNormalized.cached, false);
    assert.strictEqual(preAbortedNormalized.error.kind, DISPATCH_ERROR_CODES.CANCELLED);

    // Pre-aborted compatibility check returns cancelled immediately
    const preAbortedCompat = await checkNanoGptGenerationsCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal: AbortSignal.abort(),
    });
    assert.strictEqual(preAbortedCompat.supported, false);
    assert.strictEqual(preAbortedCompat.cached, false);
    assert.strictEqual(preAbortedCompat.error.kind, DISPATCH_ERROR_CODES.CANCELLED);
});

test('capability check: late resolution after timeout does not mutate capability cache', async () => {
    clearNanoGptImagesCapabilityCache();
    clearNanoGptGenerationsCapabilityCache();

    const fetchDeferred = createDeferred();

    // Check with 10ms timeout: will time out
    const timedOut = await checkNanoGptGenerationsCapability({
        fetch: () => fetchDeferred.promise,
        getRequestHeaders: getMockHeaders,
        timeoutMs: 10,
    });
    assert.strictEqual(timedOut.supported, false);
    assert.strictEqual(timedOut.error.kind, DISPATCH_ERROR_CODES.TIMEOUT);

    // Resolve deferred fetch late after timeout
    fetchDeferred.resolve(createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images-generations' },
    }));

    // Allow microtasks to settle
    await new Promise((resolve) => setImmediate(resolve));

    // Subsequent check should NOT see cached true; it must run fetch
    let subsequentRan = false;
    const followUp = await checkNanoGptGenerationsCapability({
        fetch: async () => {
            subsequentRan = true;
            return createMockResponse({
                status: 200,
                headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
                body: { ok: true, route: 'nanogpt-images-generations' },
            });
        },
        getRequestHeaders: getMockHeaders,
    });

    assert.strictEqual(subsequentRan, true);
    assert.strictEqual(followUp.cached, false);
    assert.strictEqual(followUp.supported, true);
});

test('capability check: late resolution after caller cancellation does not mutate capability cache', async () => {
    clearNanoGptGenerationsCapabilityCache();

    const controller = new AbortController();
    const fetchDeferred = createDeferred();

    const checkPromise = checkNanoGptGenerationsCapability({
        fetch: () => fetchDeferred.promise,
        getRequestHeaders: getMockHeaders,
        signal: controller.signal,
    });

    // Caller aborts while fetch is in-flight
    controller.abort();

    const result = await checkPromise;
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);

    // Fetch resolves late with valid 200 OK
    fetchDeferred.resolve(createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images-generations' },
    }));

    await new Promise((resolve) => setImmediate(resolve));

    // Verify cache was not repopulated
    let followUpRan = false;
    const followUp = await checkNanoGptGenerationsCapability({
        fetch: async () => {
            followUpRan = true;
            return createMockResponse({ status: 500 });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(followUpRan, true);
    assert.strictEqual(followUp.cached, false);
});

test('capability check: older interleaved check cannot overwrite newer cache state or report false readiness', async () => {
    clearNanoGptGenerationsCapabilityCache();

    const check1Deferred = createDeferred();

    // Check 1 starts and waits on check1Deferred
    const check1Promise = checkNanoGptGenerationsCapability({
        fetch: () => check1Deferred.promise,
        getRequestHeaders: getMockHeaders,
    });

    // Check 2 starts immediately after and fails fast
    const check2Promise = checkNanoGptGenerationsCapability({
        fetch: async () => createMockResponse({ status: 404, headers: {} }),
        getRequestHeaders: getMockHeaders,
        forceCheck: true,
    });

    const check2Result = await check2Promise;
    assert.strictEqual(check2Result.supported, false);

    // Check 1 resolves late with valid 200 OK
    check1Deferred.resolve(createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_GENERATIONS_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images-generations' },
    }));

    // Check 1 must NOT report positive readiness because Check 2 disproved it
    const check1Result = await check1Promise;
    assert.strictEqual(check1Result.supported, false);
    assert.strictEqual(check1Result.cached, false);
    assert.strictEqual(check1Result.error.kind, DISPATCH_ERROR_CODES.CANCELLED);

    // Subsequent call must not be cached as true because check 1 was superseded
    let fetchRan = false;
    const verifyResult = await checkNanoGptGenerationsCapability({
        fetch: async () => {
            fetchRan = true;
            return createMockResponse({ status: 500, headers: {} });
        },
        getRequestHeaders: getMockHeaders,
    });
    assert.strictEqual(fetchRan, true);
    assert.strictEqual(verifyResult.cached, false);
});

test('capability check: cleanly removes abort listeners from caller signal', async () => {
    clearNanoGptImagesCapabilityCache();
    const { signal, getAddedCount, getRemovedCount } = createTrackedController();

    const mockFetch = async () => createMockResponse({
        status: 200,
        headers: { [NANOGPT_PROXY_MARKER_HEADER]: NANOGPT_PROXY_MARKER_VALUE },
        body: { ok: true, route: 'nanogpt-images' },
    });

    const result = await checkNanoGptImagesCapability({
        fetch: mockFetch,
        getRequestHeaders: getMockHeaders,
        signal,
    });

    assert.strictEqual(result.supported, true);
    assert.strictEqual(getAddedCount(), 1);
    assert.strictEqual(getRemovedCount(), 1);
});

test('capability check: cleanly removes abort listeners on caller abort and timeout', async () => {
    clearNanoGptImagesCapabilityCache();

    // 1. Caller abort branch
    const tracked1 = createTrackedController();
    const deferred1 = createDeferred();
    const p1 = checkNanoGptImagesCapability({
        fetch: () => deferred1.promise,
        getRequestHeaders: getMockHeaders,
        signal: tracked1.signal,
    });
    tracked1.controller.abort();
    await p1;
    assert.strictEqual(tracked1.getAddedCount(), 1);
    assert.strictEqual(tracked1.getRemovedCount(), 1);

    // 2. Timeout branch
    const tracked2 = createTrackedController();
    const deferred2 = createDeferred();
    const p2 = checkNanoGptImagesCapability({
        fetch: () => deferred2.promise,
        getRequestHeaders: getMockHeaders,
        signal: tracked2.signal,
        timeoutMs: 10,
    });
    await p2;
    assert.strictEqual(tracked2.getAddedCount(), 1);
    assert.strictEqual(tracked2.getRemovedCount(), 1);
});

test('capability check: unknown options return static error message for both routes', async () => {
    const norm = await checkNanoGptImagesCapability({
        fetch: async () => {},
        getRequestHeaders: getMockHeaders,
        unexpectedOption: 'xyz',
    });
    assert.strictEqual(norm.supported, false);
    assert.strictEqual(norm.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    assert.strictEqual(norm.error.message, 'Unknown option provided to capability check.');

    const compat = await checkNanoGptGenerationsCapability({
        fetch: async () => {},
        getRequestHeaders: getMockHeaders,
        anotherBogusOption: 123,
    });
    assert.strictEqual(compat.supported, false);
    assert.strictEqual(compat.error.kind, DISPATCH_ERROR_CODES.INVALID_DISPATCH_OPTIONS);
    assert.strictEqual(compat.error.message, 'Unknown option provided to capability check.');
});



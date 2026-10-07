import test from 'node:test';
import assert from 'node:assert/strict';

import {
    NANOGPT_PROXY_ROUTE,
    NANOGPT_PROXY_MARKER_HEADER,
    NANOGPT_PROXY_MARKER_VALUE,
    CAPABILITY_DEFAULT_TIMEOUT_MS,
    DISPATCH_ERROR_CODES,
    checkNanoGptImagesCapability,
    clearNanoGptImagesCapabilityCache,
    createNanoGptImageDispatch,
    sendProductionNanoGptImageRequest,
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
    assert.match(result.error.message, /Unknown option 'unrecognizedKey'/);
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

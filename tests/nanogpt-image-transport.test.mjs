import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    TRANSPORT_ERROR_CODES,
    sendNanoGptImageTransportRequest,
} from '../src/providers/nanogpt-image-transport.js';

import {
    normalizeNanoGptImageResponse,
} from '../src/providers/nanogpt-image-response.js';

const DUMMY_REQUEST = Object.freeze({
    model: 'qwen-image',
    prompt: 'a picturesque mountain at sunset',
});

const VALID_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
// Constants and Exports
// -----------------------------------------------------------------------------

test('exported TRANSPORT_ERROR_CODES is frozen and has expected values', () => {
    assert.strictEqual(Object.isFrozen(TRANSPORT_ERROR_CODES), true);
    assert.deepEqual(TRANSPORT_ERROR_CODES, {
        INVALID_OPTIONS: 'invalid-options',
        CANCELLED: 'cancelled',
        TIMEOUT: 'timeout',
        NETWORK_FAILURE: 'network-failure',
        AUTHENTICATION_FAILURE: 'authentication-failure',
        RATE_LIMIT_FAILURE: 'rate-limit-failure',
        PROVIDER_FAILURE: 'provider-failure',
        MALFORMED_RESPONSE: 'malformed-response',
    });
});

test('sendNanoGptImageTransportRequest is a function', () => {
    assert.strictEqual(typeof sendNanoGptImageTransportRequest, 'function');
});

// -----------------------------------------------------------------------------
// Options Validation & Conservative Pre-dispatch Invariants
// -----------------------------------------------------------------------------

test('rejects non-plain-object options with invalid-options and zero dispatch', async () => {
    const invalidOptionsList = [
        null,
        undefined,
        'options',
        123,
        true,
        [DUMMY_REQUEST],
        new Date(),
        new (class CustomOptions {})(),
    ];

    for (const opt of invalidOptionsList) {
        const result = await sendNanoGptImageTransportRequest(opt);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.INVALID_OPTIONS);
    }
});

test('rejects unknown option keys with invalid-options', async () => {
    let dispatchCalled = 0;
    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCalled++;
            return { status: 200, json: async () => ({}) };
        },
        unexpectedProperty: 'disallowed',
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.INVALID_OPTIONS);
    assert.strictEqual(dispatchCalled, 0);
});

test('rejects missing or non-plain-object request with invalid-options', async () => {
    const invalidRequests = [
        undefined,
        null,
        'string-request',
        123,
        true,
        [],
        new Date(),
    ];

    for (const req of invalidRequests) {
        let dispatchCalled = 0;
        const result = await sendNanoGptImageTransportRequest({
            request: req,
            dispatch: async () => {
                dispatchCalled++;
                return { status: 200, json: async () => ({}) };
            },
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.INVALID_OPTIONS);
        assert.strictEqual(dispatchCalled, 0);
    }
});

test('rejects missing or non-function dispatch with invalid-options', async () => {
    const invalidDispatches = [
        undefined,
        null,
        'not-a-function',
        123,
        true,
        {},
        [],
    ];

    for (const disp of invalidDispatches) {
        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: disp,
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.INVALID_OPTIONS);
    }
});

test('rejects invalid timeoutMs values with invalid-options', async () => {
    const invalidTimeouts = [
        0,
        -1,
        -100,
        NaN,
        Infinity,
        -Infinity,
        1.5,
        '1000',
        null,
        [],
        {},
    ];

    for (const timeoutMs of invalidTimeouts) {
        let dispatchCalled = 0;
        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => {
                dispatchCalled++;
                return { status: 200, json: async () => ({}) };
            },
            timeoutMs,
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.INVALID_OPTIONS);
        assert.strictEqual(dispatchCalled, 0);
    }
});

test('rejects invalid signal objects with invalid-options', async () => {
    const invalidSignals = [
        null,
        'signal',
        123,
        true,
        {},
        { aborted: false }, // missing addEventListener
    ];

    for (const signal of invalidSignals) {
        let dispatchCalled = 0;
        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => {
                dispatchCalled++;
                return { status: 200, json: async () => ({}) };
            },
            signal,
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, false);
        assert.strictEqual(result.uncertainBilling, false);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.INVALID_OPTIONS);
        assert.strictEqual(dispatchCalled, 0);
    }
});

// -----------------------------------------------------------------------------
// Pre-dispatch Cancellation
// -----------------------------------------------------------------------------

test('fails closed before dispatch if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    let dispatchCalled = 0;
    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCalled++;
            return { status: 200, json: async () => ({}) };
        },
        signal: controller.signal,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, false);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.CANCELLED);
    assert.strictEqual(dispatchCalled, 0);
});

// -----------------------------------------------------------------------------
// Successful 2xx Responses
// -----------------------------------------------------------------------------

test('returns parsed body and unambiguous outcome on 200 OK', async () => {
    let dispatchCount = 0;
    let receivedPayload = null;
    let receivedSignal = null;

    const mockBody = { data: [{ b64_json: 'image-base64-data' }] };

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async (payload, opts) => {
            dispatchCount++;
            receivedPayload = payload;
            receivedSignal = opts?.signal;
            return {
                status: 200,
                json: async () => mockBody,
            };
        },
    });

    assert.strictEqual(dispatchCount, 1);
    assert.deepEqual(receivedPayload, DUMMY_REQUEST);
    assert.strictEqual(receivedSignal instanceof AbortSignal, true);
    assert.strictEqual(receivedSignal.aborted, false);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.deepEqual(result.body, mockBody);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, false);
    assert.strictEqual(result.error, null);
});

test('supports other 2xx status codes (201, 204 with json)', async () => {
    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => ({
            status: 201,
            json: async () => ({ created: true }),
        }),
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 201);
    assert.deepEqual(result.body, { created: true });
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, false);
});

// -----------------------------------------------------------------------------
// HTTP Non-2xx Classification & Conservative Uncertainty
// -----------------------------------------------------------------------------

test('classifies 401 and 403 as authentication-failure with uncertain billing', async () => {
    for (const status of [401, 403]) {
        let dispatchCount = 0;
        let jsonCalled = 0;

        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => {
                dispatchCount++;
                return {
                    status,
                    json: async () => {
                        jsonCalled++;
                        return { error: 'auth' };
                    },
                };
            },
        });

        assert.strictEqual(dispatchCount, 1);
        assert.strictEqual(jsonCalled, 0, 'non-2xx response must not parse body');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, status);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, true);
        assert.strictEqual(result.uncertainBilling, true);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.AUTHENTICATION_FAILURE);
    }
});

test('classifies 429 as rate-limit-failure with uncertain billing', async () => {
    let dispatchCount = 0;
    let jsonCalled = 0;

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCount++;
            return {
                status: 429,
                json: async () => {
                    jsonCalled++;
                    return { error: 'rate' };
                },
            };
        },
    });

    assert.strictEqual(dispatchCount, 1);
    assert.strictEqual(jsonCalled, 0);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 429);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.RATE_LIMIT_FAILURE);
});

test('classifies other 4xx and 5xx as provider-failure with uncertain billing', async () => {
    const errorStatuses = [400, 404, 422, 500, 502, 503, 504];

    for (const status of errorStatuses) {
        let dispatchCount = 0;
        let jsonCalled = 0;

        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => {
                dispatchCount++;
                return {
                    status,
                    json: async () => {
                        jsonCalled++;
                        return { error: 'provider' };
                    },
                };
            },
        });

        assert.strictEqual(dispatchCount, 1);
        assert.strictEqual(jsonCalled, 0);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, status);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, true);
        assert.strictEqual(result.uncertainBilling, true);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.PROVIDER_FAILURE);
    }
});

// -----------------------------------------------------------------------------
// Network & Dispatch Rejection
// -----------------------------------------------------------------------------

test('classifies dispatch rejection as network-failure with status: null and uncertain billing', async () => {
    const networkErrors = [
        new Error('ECONNRESET'),
        new TypeError('Failed to fetch'),
        new Error('Socket hung up'),
    ];

    for (const netErr of networkErrors) {
        let dispatchCount = 0;

        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => {
                dispatchCount++;
                throw netErr;
            },
        });

        assert.strictEqual(dispatchCount, 1);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, true);
        assert.strictEqual(result.uncertainBilling, true);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.NETWORK_FAILURE);
    }
});

// -----------------------------------------------------------------------------
// Malformed Responses & Status Preservation
// -----------------------------------------------------------------------------

test('classifies non-object or null dispatch return as malformed-response with status: null', async () => {
    const badReturns = [null, undefined, 'not-an-object', 123, true, []];

    for (const bad of badReturns) {
        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => bad,
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, true);
        assert.strictEqual(result.uncertainBilling, true);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE);
    }
});

test('classifies invalid status codes as malformed-response with status: null', async () => {
    const invalidStatuses = ['200', 99, 600, NaN, null, undefined];

    for (const st of invalidStatuses) {
        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => ({ status: st, json: async () => ({}) }),
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, null);
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, true);
        assert.strictEqual(result.uncertainBilling, true);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE);
    }
});

test('preserves received 200 status when 2xx response lacks .json function', async () => {
    const bad200s = [
        { status: 200 }, // missing .json
        { status: 200, json: 'not-a-function' },
        { status: 200, json: null },
    ];

    for (const bad of bad200s) {
        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => bad,
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, 200, 'must preserve known HTTP 200 status');
        assert.strictEqual(result.body, null);
        assert.strictEqual(result.dispatchAttempted, true);
        assert.strictEqual(result.uncertainBilling, true);
        assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE);
    }
});

test('preserves received 200 status when .json() rejects with JSON parse error', async () => {
    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => ({
            status: 200,
            json: async () => {
                throw new SyntaxError('Unexpected token < in JSON at position 0');
            },
        }),
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 200, 'must preserve known HTTP 200 status on body parse failure');
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.MALFORMED_RESPONSE);
});

// -----------------------------------------------------------------------------
// Whole-lifecycle Timeout Semantics
// -----------------------------------------------------------------------------

test('timeout during dispatch yields status: null and uncertain billing', async () => {
    let dispatchCount = 0;

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async (_req, opts) => {
            dispatchCount++;
            return new Promise((resolve, reject) => {
                opts.signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                });
            });
        },
        timeoutMs: 20,
    });

    assert.strictEqual(dispatchCount, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.TIMEOUT);
});

test('timeout during response.json() preserves received 200 status', async () => {
    let dispatchCount = 0;

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCount++;
            return {
                status: 200,
                json: () => new Promise((_resolve) => {
                    // Intentionally hang body parsing to trigger whole-lifecycle timeout
                }),
            };
        },
        timeoutMs: 25,
    });

    assert.strictEqual(dispatchCount, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 200, 'must preserve received status 200 on body parsing timeout');
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.TIMEOUT);
});

test('omitting timeoutMs does not arm internal timer and allows normal completion', async () => {
    let dispatchCount = 0;

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCount++;
            // Small async pause to ensure execution without timeout
            await new Promise((r) => setTimeout(r, 20));
            return {
                status: 200,
                json: async () => ({ success: true }),
            };
        },
    });

    assert.strictEqual(dispatchCount, 1);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 200);
    assert.deepEqual(result.body, { success: true });
});

// -----------------------------------------------------------------------------
// Whole-lifecycle Caller Cancellation Semantics
// -----------------------------------------------------------------------------

test('caller cancellation during dispatch yields status: null and uncertain billing', async () => {
    const controller = new AbortController();
    let dispatchCount = 0;

    const resultPromise = sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCount++;
            return new Promise((_resolve) => {
                // Wait until aborted
            });
        },
        signal: controller.signal,
    });

    // Abort after initiating dispatch
    setTimeout(() => {
        controller.abort();
    }, 15);

    const result = await resultPromise;

    assert.strictEqual(dispatchCount, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.CANCELLED);
});

test('caller cancellation during response.json() preserves received 200 status', async () => {
    const controller = new AbortController();
    let dispatchCount = 0;

    const resultPromise = sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            dispatchCount++;
            return {
                status: 200,
                json: () => new Promise((_resolve) => {
                    // Hang body stream to await caller abort
                }),
            };
        },
        signal: controller.signal,
    });

    // Abort after dispatch returns 200 but while json is pending
    setTimeout(() => {
        controller.abort();
    }, 15);

    const result = await resultPromise;

    assert.strictEqual(dispatchCount, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 200, 'must preserve status 200 when cancelled during body parsing');
    assert.strictEqual(result.body, null);
    assert.strictEqual(result.dispatchAttempted, true);
    assert.strictEqual(result.uncertainBilling, true);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.CANCELLED);
});

// -----------------------------------------------------------------------------
// Resource Cleanup Guarantees (Timer & Signal Listener)
// -----------------------------------------------------------------------------

test('cleans up caller signal listener on normal success', async () => {
    const tracked = createTrackedController();

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => ({
            status: 200,
            json: async () => ({ ok: true }),
        }),
        signal: tracked.signal,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(tracked.getAddedCount(), 1, 'listener must be added');
    assert.strictEqual(tracked.getRemovedCount(), 1, 'listener must be removed in finally');
});

test('cleans up caller signal listener on provider HTTP failure', async () => {
    const tracked = createTrackedController();

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => ({
            status: 500,
        }),
        signal: tracked.signal,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(tracked.getAddedCount(), 1);
    assert.strictEqual(tracked.getRemovedCount(), 1);
});

test('cleans up caller signal listener on timeout', async () => {
    const tracked = createTrackedController();

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => new Promise(() => {}),
        signal: tracked.signal,
        timeoutMs: 15,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.TIMEOUT);
    assert.strictEqual(tracked.getAddedCount(), 1);
    assert.strictEqual(tracked.getRemovedCount(), 1);
});

test('cleans up caller signal listener on caller cancellation', async () => {
    const tracked = createTrackedController();

    const promise = sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => new Promise(() => {}),
        signal: tracked.signal,
    });

    setTimeout(() => {
        tracked.controller.abort();
    }, 15);

    const result = await promise;

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.CANCELLED);
    assert.strictEqual(tracked.getAddedCount(), 1);
    assert.strictEqual(tracked.getRemovedCount(), 1);
});

test('clears timeout timer on successful completion', async () => {
    let timerCleared = false;
    const origClearTimeout = globalThis.clearTimeout;

    try {
        globalThis.clearTimeout = (handle) => {
            timerCleared = true;
            return origClearTimeout(handle);
        };

        const result = await sendNanoGptImageTransportRequest({
            request: DUMMY_REQUEST,
            dispatch: async () => ({
                status: 200,
                json: async () => ({ ok: true }),
            }),
            timeoutMs: 5000,
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(timerCleared, true, 'clearTimeout must be invoked on success');
    } finally {
        globalThis.clearTimeout = origClearTimeout;
    }
});

// -----------------------------------------------------------------------------
// Race Hardening & Late Settlement
// -----------------------------------------------------------------------------

test('late resolution or rejection after timeout does not alter outcome or leak uncaught error', async () => {
    let lateResolved = false;

    const result = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => {
            return new Promise((resolve) => {
                setTimeout(() => {
                    lateResolved = true;
                    resolve({
                        status: 200,
                        json: async () => ({ late: true }),
                    });
                }, 40);
            });
        },
        timeoutMs: 15,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.kind, TRANSPORT_ERROR_CODES.TIMEOUT);

    // Wait for the late resolution timer to fire
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(lateResolved, true);
    // Outcome remains the timeout failure
    assert.strictEqual(result.status, null);
    assert.strictEqual(result.body, null);
});

// -----------------------------------------------------------------------------
// Privacy & Sensitive Data Protection
// -----------------------------------------------------------------------------

test('never leaks prompt content, credentials, or base64 data in error results', async () => {
    const sensitivePrompt = 'TOP_SECRET_ROLEPLAY_PROMPT_12345';
    const sensitiveToken = 'SECRET_NANO_KEY_ABCDEFG';
    const sensitiveRequest = {
        model: 'qwen-image',
        prompt: sensitivePrompt,
        apiKey: sensitiveToken,
    };

    const scenarios = [
        // Network failure
        async () => sendNanoGptImageTransportRequest({
            request: sensitiveRequest,
            dispatch: async () => { throw new Error('connection died'); },
        }),
        // Timeout
        async () => sendNanoGptImageTransportRequest({
            request: sensitiveRequest,
            dispatch: async () => new Promise(() => {}),
            timeoutMs: 10,
        }),
        // HTTP 401
        async () => sendNanoGptImageTransportRequest({
            request: sensitiveRequest,
            dispatch: async () => ({ status: 401 }),
        }),
        // Malformed response
        async () => sendNanoGptImageTransportRequest({
            request: sensitiveRequest,
            dispatch: async () => ({ status: 200, json: () => { throw new Error('bad json'); } }),
        }),
    ];

    for (const runScenario of scenarios) {
        const result = await runScenario();
        assert.strictEqual(result.ok, false);

        const serialized = JSON.stringify(result);
        assert.strictEqual(serialized.includes(sensitivePrompt), false, 'prompt must not appear in result');
        assert.strictEqual(serialized.includes(sensitiveToken), false, 'token must not appear in result');
        assert.strictEqual(result.error.message.includes(sensitivePrompt), false);
        assert.strictEqual(result.error.message.includes(sensitiveToken), false);
    }
});

test('transport module source code contains no console logging calls', () => {
    const filePath = path.resolve('src/providers/nanogpt-image-transport.js');
    const source = fs.readFileSync(filePath, 'utf8');

    const consoleMatches = source.match(/console\.(log|info|warn|error|debug|trace)\s*\(/g);
    assert.strictEqual(consoleMatches, null, 'Source code must not contain console.* logging');
});

// -----------------------------------------------------------------------------
// Compatibility Contract Handoff Demonstration to M03-C
// -----------------------------------------------------------------------------

test('demonstrates successful compatibility handoff from M03-D1 transport body to M03-C normalizer', async () => {
    /**
     * NOTE: This test demonstrates contract compatibility between M03-D1 transport output
     * and M03-C response normalization for mock/test handoff purposes.
     * The normalized endpoint route remains preferred for production once unverified envelope is resolved.
     */
    const mockOpenAiEnvelope = {
        created: 1728259200,
        data: [
            {
                b64_json: VALID_BASE64,
            },
        ],
    };

    const transportResult = await sendNanoGptImageTransportRequest({
        request: DUMMY_REQUEST,
        dispatch: async () => ({
            status: 200,
            json: async () => mockOpenAiEnvelope,
        }),
    });

    assert.strictEqual(transportResult.ok, true);
    assert.strictEqual(transportResult.status, 200);
    assert.strictEqual(transportResult.uncertainBilling, false);

    // Pass transport body into M03-C normalizeNanoGptImageResponse
    const normalized = normalizeNanoGptImageResponse(transportResult.body, {
        source: 'openai-compatible',
    });

    assert.strictEqual(normalized.ok, true);
    assert.deepEqual(normalized.image, {
        kind: 'base64',
        data: VALID_BASE64,
    });
    assert.strictEqual(normalized.errors.length, 0);
});

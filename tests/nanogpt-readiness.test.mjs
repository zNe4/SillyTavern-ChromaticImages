import assert from 'node:assert/strict';
import test from 'node:test';

import { CREDENTIAL_STATUS } from '../src/constants.js';
import {
    CREDENTIAL_ERROR_CODES,
    NANOGPT_SECRET_KEY,
    SECRETS_READ_ROUTE,
    checkNanoGptCredentialReadiness,
} from '../src/providers/nanogpt-readiness.js';

function createMockResponse(status, body, { delayMs = 0, throwJson = false } = {}) {
    return {
        status,
        async json() {
            if (delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            if (throwJson) {
                throw new Error('JSON parse error');
            }
            return body;
        },
    };
}

test('1. Options preflight: rejects invalid options shapes and unknown keys', async () => {
    const invalidOptions = [null, 'string', 123, []];
    for (const opt of invalidOptions) {
        const result = await checkNanoGptCredentialReadiness(opt);
        assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.INVALID_OPTIONS);
    }

    const mockDeps = {
        fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: null }),
        getRequestHeaders: () => ({}),
    };

    const unknownOptResult = await checkNanoGptCredentialReadiness({ ...mockDeps, unknownKey: true });
    assert.strictEqual(unknownOptResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(unknownOptResult.error?.kind, CREDENTIAL_ERROR_CODES.INVALID_OPTIONS);
    assert.strictEqual(unknownOptResult.error?.message, 'Unknown credential readiness option.');

    const invalidTimeoutResult = await checkNanoGptCredentialReadiness({ ...mockDeps, timeoutMs: -5 });
    assert.strictEqual(invalidTimeoutResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(invalidTimeoutResult.error?.kind, CREDENTIAL_ERROR_CODES.INVALID_OPTIONS);

    const invalidSignalResult = await checkNanoGptCredentialReadiness({ ...mockDeps, signal: 'not-a-signal' });
    assert.strictEqual(invalidSignalResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(invalidSignalResult.error?.kind, CREDENTIAL_ERROR_CODES.INVALID_OPTIONS);
});

test('2. Dependencies preflight: fails safely when fetch or getRequestHeaders missing', async () => {
    const origFetch = globalThis.fetch;
    const origST = globalThis.SillyTavern;

    try {
        delete globalThis.fetch;
        globalThis.SillyTavern = {};

        const noFetchResult = await checkNanoGptCredentialReadiness({});
        assert.strictEqual(noFetchResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(noFetchResult.error?.kind, CREDENTIAL_ERROR_CODES.DEPENDENCY_MISSING);

        const noHeadersResult = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, {}),
        });
        assert.strictEqual(noHeadersResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(noHeadersResult.error?.kind, CREDENTIAL_ERROR_CODES.DEPENDENCY_MISSING);
    } finally {
        globalThis.fetch = origFetch;
        globalThis.SillyTavern = origST;
    }
});

test('3. Pre-aborted signal causes zero fetch calls and returns cancelled', async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error('Pre-aborted'));

    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => {
            fetchCalls += 1;
            return createMockResponse(200, { [NANOGPT_SECRET_KEY]: null });
        },
        getRequestHeaders: () => ({}),
        signal: controller.signal,
    });

    assert.strictEqual(fetchCalls, 0);
    assert.strictEqual(result.status, CREDENTIAL_STATUS.CANCELLED);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.CANCELLED);
});

test('4. Caller abort mid-flight returns cancelled', async () => {
    const controller = new AbortController();
    let fetchStarted = false;

    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => {
            fetchStarted = true;
            controller.abort(new Error('Caller cancelled mid-flight'));
            return new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Fetch cancelled')), 10);
            });
        },
        getRequestHeaders: () => ({}),
        signal: controller.signal,
    });

    assert.strictEqual(fetchStarted, true);
    assert.strictEqual(result.status, CREDENTIAL_STATUS.CANCELLED);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.CANCELLED);
});

test('5. Hanging fetch triggers deadline timeout and aborts internal controller', async () => {
    let abortedInternal = false;

    const result = await checkNanoGptCredentialReadiness({
        fetch: async (_url, options) => {
            options?.signal?.addEventListener('abort', () => {
                abortedInternal = true;
            });
            return new Promise(() => {
                // Never settles
            });
        },
        getRequestHeaders: () => ({}),
        timeoutMs: 50,
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.TIMEOUT);
    assert.strictEqual(abortedInternal, true);
});

test('6. Hanging response.json() triggers deadline timeout', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => ({
            status: 200,
            async json() {
                return new Promise(() => {
                    // Never settles
                });
            },
        }),
        getRequestHeaders: () => ({}),
        timeoutMs: 50,
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.TIMEOUT);
});

test('7. Late settlement after timeout does not produce unhandled rejections', async () => {
    let settledLate = false;

    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            settledLate = true;
            return createMockResponse(200, { [NANOGPT_SECRET_KEY]: null });
        },
        getRequestHeaders: () => ({}),
        timeoutMs: 40,
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.TIMEOUT);

    // Wait past the late settlement window to verify stability
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(settledLate, true);
});

test('8. Network error during fetch returns unavailable network-error', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => {
            throw new Error('Connection refused');
        },
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.NETWORK_ERROR);
});

test('9. HTTP non-2xx status returns unavailable http-error', async () => {
    for (const status of [400, 401, 403, 404, 500, 502]) {
        const result = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(status, {}),
            getRequestHeaders: () => ({}),
        });

        assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.HTTP_ERROR);
    }
});

test('10. Malformed JSON response body returns unavailable malformed-response', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => createMockResponse(200, null, { throwJson: true }),
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE);
});

test('11. Non-plain-object response payload returns unavailable malformed-response', async () => {
    for (const payload of ['string', 123, true, [], null]) {
        const result = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, payload),
            getRequestHeaders: () => ({}),
        });

        assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE);
    }
});

test('12. Fail closed on omitted api_key_nanogpt key', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => createMockResponse(200, { other_key: 'value' }),
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
    assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE);
});

test('13. Fail closed on non-null non-array api_key_nanogpt entry', async () => {
    for (const entry of ['string', 123, true, { not: 'an-array' }]) {
        const result = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: entry }),
            getRequestHeaders: () => ({}),
        });

        assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE);
    }
});

test('14. Explicit null api_key_nanogpt returns not-configured with null error', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: null }),
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.NOT_CONFIGURED);
    assert.strictEqual(result.error, null);
});

test('15. Empty array api_key_nanogpt returns not-configured with null error', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: [] }),
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.NOT_CONFIGURED);
    assert.strictEqual(result.error, null);
});

test('16. Valid descriptors with all active === false returns not-configured', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => createMockResponse(200, {
            [NANOGPT_SECRET_KEY]: [
                { id: '1', value: '***', label: 'Old Key', active: false },
                { id: '2', value: '***', label: 'Backup', active: false },
            ],
        }),
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.NOT_CONFIGURED);
    assert.strictEqual(result.error, null);
});

test('17. Valid descriptor with active === true returns configured', async () => {
    const result = await checkNanoGptCredentialReadiness({
        fetch: async () => createMockResponse(200, {
            [NANOGPT_SECRET_KEY]: [
                { id: '1', value: '***', label: 'Inactive', active: false },
                { id: '2', value: '***', label: 'Active Key', active: true },
            ],
        }),
        getRequestHeaders: () => ({}),
    });

    assert.strictEqual(result.status, CREDENTIAL_STATUS.CONFIGURED);
    assert.strictEqual(result.error, null);
});

test('18. Fail closed on malformed descriptor object in array', async () => {
    const malformedArrays = [
        ['not-an-object'],
        [null],
        [42],
        [{ id: '1', active: 'not-a-boolean' }],
        [{ id: '1' }], // active missing
        [{ id: '1', active: null }],
        // Active descriptor MUST NOT conceal malformed descriptor
        [{ id: '1', active: true }, 'malformed'],
        [{ id: '1', active: true }, { id: '2', active: 'invalid' }],
    ];

    for (const arr of malformedArrays) {
        const result = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: arr }),
            getRequestHeaders: () => ({}),
        });

        assert.strictEqual(result.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(result.error?.kind, CREDENTIAL_ERROR_CODES.MALFORMED_DESCRIPTOR);
    }
});

test('19. Protocol verification: exact route POST /api/secrets/read with omitContentType', async () => {
    let capturedUrl = null;
    let capturedMethod = null;
    let capturedHeadersArg = null;

    const result = await checkNanoGptCredentialReadiness({
        fetch: async (url, options) => {
            capturedUrl = url;
            capturedMethod = options.method;
            return createMockResponse(200, { [NANOGPT_SECRET_KEY]: null });
        },
        getRequestHeaders: (args) => {
            capturedHeadersArg = args;
            return { 'X-CSRF': 'token' };
        },
    });

    assert.strictEqual(capturedUrl, SECRETS_READ_ROUTE);
    assert.strictEqual(capturedMethod, 'POST');
    assert.deepEqual(capturedHeadersArg, { omitContentType: true });
    assert.strictEqual(result.status, CREDENTIAL_STATUS.NOT_CONFIGURED);
});

test('20. Privacy Invariant: secret descriptors and keys never leak into return structure or logs', async () => {
    const origLog = console.log;
    const origDebug = console.debug;
    const origError = console.error;
    let logCalls = 0;

    try {
        console.log = () => { logCalls += 1; };
        console.debug = () => { logCalls += 1; };
        console.error = () => { logCalls += 1; };

        const secretPayload = {
            [NANOGPT_SECRET_KEY]: [
                {
                    id: 'sensitive-uuid-12345',
                    value: 'sensitive-masked-value-******',
                    label: 'sensitive-label-text',
                    active: true,
                },
            ],
            other_secret: [{ value: 'should-be-dropped' }],
        };

        const result = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, secretPayload),
            getRequestHeaders: () => ({}),
        });

        assert.strictEqual(result.status, CREDENTIAL_STATUS.CONFIGURED);
        assert.strictEqual(result.error, null);
        assert.strictEqual(logCalls, 0);

        // Verify result object contains only safe fields
        const serialized = JSON.stringify(result);
        assert.doesNotMatch(serialized, /sensitive/);
        assert.doesNotMatch(serialized, /12345/);
        assert.doesNotMatch(serialized, /\*\*\*\*\*\*/);
        assert.doesNotMatch(serialized, /other_secret/);
    } finally {
        console.log = origLog;
        console.debug = origDebug;
        console.error = origError;
    }
});

test('21. Privacy Invariant: sentinel sensitive strings in thrown exceptions and invalid options never leak', async () => {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origDebug = console.debug;
    const loggedMessages = [];

    const intercept = (...args) => {
        loggedMessages.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    try {
        console.log = intercept;
        console.warn = intercept;
        console.error = intercept;
        console.debug = intercept;

        const SENTINEL_SECRET = 'SENTINEL_SECRET_TOKEN_ABC123_XYZ789';

        // Case A: Sentinel in unknown option key
        const optResult = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: null }),
            getRequestHeaders: () => ({}),
            [SENTINEL_SECRET]: 'sensitive-val',
        });
        assert.strictEqual(optResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(optResult.error?.message, 'Unknown credential readiness option.');
        assert.doesNotMatch(JSON.stringify(optResult), new RegExp(SENTINEL_SECRET));

        // Case B: Sentinel in thrown fetch error
        const fetchResult = await checkNanoGptCredentialReadiness({
            fetch: async () => {
                throw new Error(`Failed with sensitive ${SENTINEL_SECRET}`);
            },
            getRequestHeaders: () => ({}),
        });
        assert.strictEqual(fetchResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(fetchResult.error?.kind, CREDENTIAL_ERROR_CODES.NETWORK_ERROR);
        assert.doesNotMatch(JSON.stringify(fetchResult), new RegExp(SENTINEL_SECRET));

        // Case C: Sentinel in thrown JSON parse error
        const jsonResult = await checkNanoGptCredentialReadiness({
            fetch: async () => ({
                status: 200,
                async json() {
                    throw new Error(`JSON failed with sensitive ${SENTINEL_SECRET}`);
                },
            }),
            getRequestHeaders: () => ({}),
        });
        assert.strictEqual(jsonResult.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(jsonResult.error?.kind, CREDENTIAL_ERROR_CODES.MALFORMED_RESPONSE);
        assert.doesNotMatch(JSON.stringify(jsonResult), new RegExp(SENTINEL_SECRET));

        // Verify zero console logs captured the sentinel
        for (const msg of loggedMessages) {
            assert.doesNotMatch(msg, new RegExp(SENTINEL_SECRET));
        }
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        console.debug = origDebug;
    }
});

test('22. Lifecycle cleanup: caller abort listener and timers are cleaned up across all exit paths', async () => {
    function createTrackedSignal() {
        const controller = new AbortController();
        let listenerCount = 0;
        const origAdd = controller.signal.addEventListener.bind(controller.signal);
        const origRemove = controller.signal.removeEventListener.bind(controller.signal);

        controller.signal.addEventListener = (event, handler, options) => {
            listenerCount += 1;
            return origAdd(event, handler, options);
        };
        controller.signal.removeEventListener = (event, handler, options) => {
            listenerCount -= 1;
            return origRemove(event, handler, options);
        };

        return {
            controller,
            signal: controller.signal,
            getListenerCount: () => listenerCount,
        };
    }

    // 1. Success exit path
    {
        const tracked = createTrackedSignal();
        const res = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(200, { [NANOGPT_SECRET_KEY]: null }),
            getRequestHeaders: () => ({}),
            signal: tracked.signal,
        });
        assert.strictEqual(res.status, CREDENTIAL_STATUS.NOT_CONFIGURED);
        assert.strictEqual(tracked.getListenerCount(), 0);
    }

    // 2. HTTP error exit path
    {
        const tracked = createTrackedSignal();
        const res = await checkNanoGptCredentialReadiness({
            fetch: async () => createMockResponse(500, {}),
            getRequestHeaders: () => ({}),
            signal: tracked.signal,
        });
        assert.strictEqual(res.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(tracked.getListenerCount(), 0);
    }

    // 3. Network error exit path
    {
        const tracked = createTrackedSignal();
        const res = await checkNanoGptCredentialReadiness({
            fetch: async () => {
                throw new Error('Network failed');
            },
            getRequestHeaders: () => ({}),
            signal: tracked.signal,
        });
        assert.strictEqual(res.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(tracked.getListenerCount(), 0);
    }

    // 4. Timeout exit path
    {
        const tracked = createTrackedSignal();
        const res = await checkNanoGptCredentialReadiness({
            fetch: async () => new Promise(() => {}),
            getRequestHeaders: () => ({}),
            signal: tracked.signal,
            timeoutMs: 30,
        });
        assert.strictEqual(res.status, CREDENTIAL_STATUS.UNAVAILABLE);
        assert.strictEqual(tracked.getListenerCount(), 0);
    }

    // 5. Caller cancellation exit path
    {
        const tracked = createTrackedSignal();
        const resPromise = checkNanoGptCredentialReadiness({
            fetch: async () => new Promise((resolve) => setTimeout(resolve, 100)),
            getRequestHeaders: () => ({}),
            signal: tracked.signal,
        });
        tracked.controller.abort();
        const res = await resPromise;
        assert.strictEqual(res.status, CREDENTIAL_STATUS.CANCELLED);
        assert.strictEqual(tracked.getListenerCount(), 0);
    }
});

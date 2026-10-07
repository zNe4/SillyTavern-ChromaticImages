import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    RESPONSE_SOURCE_OPENAI_COMPATIBLE,
    RESPONSE_SOURCE_NORMALIZED,
    SUPPORTED_RESPONSE_SOURCES,
    normalizeNanoGptImageResponse,
} from '../src/providers/nanogpt-image-response.js';

const VALID_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VALID_HTTPS_URL = 'https://api.nano-gpt.com/cdn/generated-image-12345.png';

// -----------------------------------------------------------------------------
// Constants and Exports
// -----------------------------------------------------------------------------

test('exported constants have expected values and immutability', () => {
    assert.strictEqual(RESPONSE_SOURCE_OPENAI_COMPATIBLE, 'openai-compatible');
    assert.strictEqual(RESPONSE_SOURCE_NORMALIZED, 'normalized');

    assert.strictEqual(Object.isFrozen(SUPPORTED_RESPONSE_SOURCES), true);
    assert.deepEqual([...SUPPORTED_RESPONSE_SOURCES], ['openai-compatible', 'normalized']);
});

// -----------------------------------------------------------------------------
// Options Validation & Contract Isolation
// -----------------------------------------------------------------------------

test('rejects non-plain object options with invalid-options', () => {
    const invalidOptions = [
        null,
        undefined,
        'openai-compatible',
        123,
        true,
        [RESPONSE_SOURCE_OPENAI_COMPATIBLE],
        new Date(),
        new (class CustomOptions {})(),
    ];

    for (const opt of invalidOptions) {
        const result = normalizeNanoGptImageResponse({ data: [{ b64_json: 'AAAA' }] }, opt);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['invalid-options']);
    }
});

test('rejects missing or unsupported source option with unsupported-response-source', () => {
    const badSources = [
        {},
        { source: '' },
        { source: 'invalid-source' },
        { source: 'native' },
        { source: 'gemini' },
        { source: 123 },
        { source: null },
    ];

    for (const opt of badSources) {
        const result = normalizeNanoGptImageResponse({ data: [{ b64_json: 'AAAA' }] }, opt);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.ok(result.errors.includes('unsupported-response-source'));
    }
});

test('rejects unknown option keys with unknown-option and deduplicates code', () => {
    const result = normalizeNanoGptImageResponse(
        { data: [{ b64_json: 'AAAA' }] },
        {
            source: 'openai-compatible',
            apiKey: 'secret',
            timeout: 5000,
        }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.image, null);
    assert.deepEqual(result.errors, ['unknown-option']);
});

test('source: normalized fails closed with unverified-normalized-response-contract', () => {
    // Even if the response is shaped identically to compatibility format
    const compatShaped = {
        data: [{ b64_json: 'AAAA' }],
    };
    const res1 = normalizeNanoGptImageResponse(compatShaped, {
        source: 'normalized',
    });

    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.image, null);
    assert.deepEqual(res1.errors, ['unverified-normalized-response-contract']);

    // Even if the response is an empty object
    const res2 = normalizeNanoGptImageResponse({}, {
        source: 'normalized',
    });
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.image, null);
    assert.deepEqual(res2.errors, ['unverified-normalized-response-contract']);
});

// -----------------------------------------------------------------------------
// Documented OpenAI-Compatible Success Responses
// -----------------------------------------------------------------------------

test('accepts single valid base64 image in openai-compatible format', () => {
    const response = {
        data: [
            {
                b64_json: VALID_BASE64,
            },
        ],
    };

    const result = normalizeNanoGptImageResponse(response, {
        source: 'openai-compatible',
    });

    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.image, {
        kind: 'base64',
        data: VALID_BASE64,
    });
});

test('accepts single valid remote HTTPS URL in openai-compatible format', () => {
    const response = {
        data: [
            {
                url: VALID_HTTPS_URL,
            },
        ],
    };

    const result = normalizeNanoGptImageResponse(response, {
        source: 'openai-compatible',
    });

    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.image, {
        kind: 'remote-url',
        url: VALID_HTTPS_URL,
    });
});

test('accepts signed remote HTTPS URL with query parameters', () => {
    const signedUrl = 'https://api.nano-gpt.com/v1/storage/output.webp?token=sig_987654321&expires=1790000000';
    const response = {
        data: [
            {
                url: signedUrl,
            },
        ],
    };

    const result = normalizeNanoGptImageResponse(response, {
        source: 'openai-compatible',
    });

    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.strictEqual(result.image.kind, 'remote-url');
    assert.strictEqual(result.image.url, signedUrl);
});

test('tolerates documented top-level metadata without treating it as an error', () => {
    const responseWithMetadata = {
        created: 1760000000,
        data: [
            {
                b64_json: 'AAAA',
            },
        ],
        cost: 0.02,
        paymentSource: 'balance',
        remainingBalance: 4.88,
        model: 'hidream',
        id: 'img_abc123',
    };

    const result = normalizeNanoGptImageResponse(responseWithMetadata, {
        source: 'openai-compatible',
    });

    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.image, {
        kind: 'base64',
        data: 'AAAA',
    });
    assert.deepEqual(result.errors, []);
});

test('accepts null-prototype envelope and entry objects', () => {
    const nullProtoEntry = Object.create(null);
    nullProtoEntry.b64_json = 'AAAA';

    const nullProtoEnvelope = Object.create(null);
    nullProtoEnvelope.data = [nullProtoEntry];

    const result = normalizeNanoGptImageResponse(nullProtoEnvelope, {
        source: 'openai-compatible',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.image.kind, 'base64');
    assert.strictEqual(result.image.data, 'AAAA');
});

// -----------------------------------------------------------------------------
// Envelope Validation & Provider Errors
// -----------------------------------------------------------------------------

test('rejects non-plain object response envelopes with invalid-response-envelope', () => {
    const invalidEnvelopes = [
        null,
        undefined,
        'string',
        12345,
        true,
        false,
        [{ b64_json: 'AAAA' }],
        new Date(),
        new (class CustomResponse {})(),
    ];

    for (const env of invalidEnvelopes) {
        const result = normalizeNanoGptImageResponse(env, {
            source: 'openai-compatible',
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['invalid-response-envelope']);
    }
});

test('detects provider error envelopes and rejects with provider-error-response', () => {
    const errorEnvelopes = [
        // Standard OpenAI error format
        {
            error: {
                message: 'Rate limit exceeded',
                type: 'rate_limit_error',
                code: 'rate_limit',
            },
        },
        // Error with string message
        {
            error: 'Authentication failed',
        },
        // NanoGPT style error
        {
            error: {
                message: 'model is required for /api/v1/images.',
                type: 'invalid_request_error',
                code: 'missing_model',
                parameter: 'model',
            },
            code: 'missing_model',
        },
        // Explicit object: error
        {
            object: 'error',
            message: 'Internal server error',
        },
        // Explicit status: error
        {
            status: 'error',
            message: 'Inference failed',
        },
        // Explicit type: error
        {
            type: 'error',
            message: 'Quota exhausted',
        },
        // Error envelope masquerading with data property
        {
            error: { message: 'Failed generation' },
            data: [{ b64_json: 'AAAA' }],
        },
    ];

    for (const env of errorEnvelopes) {
        const result = normalizeNanoGptImageResponse(env, {
            source: 'openai-compatible',
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['provider-error-response']);
    }
});

// -----------------------------------------------------------------------------
// Data Array Validation
// -----------------------------------------------------------------------------

test('rejects missing or non-array data property with missing-response-data', () => {
    const badDataEnvelopes = [
        {},
        { data: null },
        { data: 'string' },
        { data: 123 },
        { data: true },
        { data: { b64_json: 'AAAA' } },
    ];

    for (const env of badDataEnvelopes) {
        const result = normalizeNanoGptImageResponse(env, {
            source: 'openai-compatible',
        });

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['missing-response-data']);
    }
});

test('rejects empty data array with empty-response-data', () => {
    const result = normalizeNanoGptImageResponse(
        { data: [] },
        { source: 'openai-compatible' }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.image, null);
    assert.deepEqual(result.errors, ['empty-response-data']);
});

test('rejects multiple image items in data with multiple-response-images', () => {
    const result = normalizeNanoGptImageResponse(
        {
            data: [
                { b64_json: 'AAAA' },
                { b64_json: 'BBBB' },
            ],
        },
        { source: 'openai-compatible' }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.image, null);
    assert.deepEqual(result.errors, ['multiple-response-images']);
});

test('rejects non-plain object entry in data[0] with invalid-image-entry', () => {
    const badEntries = [
        null,
        undefined,
        'string',
        123,
        true,
        ['nested'],
        new Date(),
        new (class CustomEntry {})(),
    ];

    for (const entry of badEntries) {
        const result = normalizeNanoGptImageResponse(
            { data: [entry] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['invalid-image-entry']);
    }
});

// -----------------------------------------------------------------------------
// Image Entry Fields & Mutual Exclusivity
// -----------------------------------------------------------------------------

test('rejects entry missing both b64_json and url with missing-image-fields', () => {
    const missingCases = [
        {},
        { revised_prompt: 'A prompt' },
        { b64_json: null, url: null },
        { b64_json: undefined, url: undefined },
    ];

    for (const entry of missingCases) {
        const result = normalizeNanoGptImageResponse(
            { data: [entry] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['missing-image-fields']);
    }
});

test('rejects entry containing both b64_json and url with conflicting-image-fields', () => {
    const result = normalizeNanoGptImageResponse(
        {
            data: [
                {
                    b64_json: 'AAAA',
                    url: 'https://example.com/image.png',
                },
            ],
        },
        { source: 'openai-compatible' }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.image, null);
    assert.deepEqual(result.errors, ['conflicting-image-fields']);
});

// -----------------------------------------------------------------------------
// Base64 Payload Validation
// -----------------------------------------------------------------------------

test('rejects invalid or malformed base64 with invalid-image-base64', () => {
    const badBase64List = [
        ['empty string', ''],
        ['whitespace only', '   '],
        ['data URL instead of raw base64', 'data:image/png;base64,AAAA'],
        ['internal whitespace', 'AA AA'],
        ['newline in payload', 'AAAA\nBBBB'],
        ['invalid characters', 'AAAA$BBBB'],
        ['base64url url-safe dashes', 'AAAA-BBBB'],
        ['invalid padding 3 equals', 'A==='],
        ['invalid padding 1 equal on 2 chars', 'AA='],
        ['padding in middle', 'AA==AAAA'],
        ['odd length unpadded', 'AAA'],
        ['number type', 12345],
        ['boolean type', true],
        ['array type', ['AAAA']],
    ];

    for (const [desc, val] of badBase64List) {
        const result = normalizeNanoGptImageResponse(
            { data: [{ b64_json: val }] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(
            result.ok,
            false,
            `Expected invalid-image-base64 for case: ${desc}`
        );
        assert.strictEqual(result.image, null);
        assert.deepEqual(result.errors, ['invalid-image-base64']);
    }
});

// -----------------------------------------------------------------------------
// Remote URL Validation
// -----------------------------------------------------------------------------

test('rejects malformed URLs with invalid-image-url', () => {
    const badUrls = [
        ['empty string', ''],
        ['whitespace only', '   '],
        ['relative root path', '/images/output.png'],
        ['relative path', 'images/output.png'],
        ['malformed syntax', 'http s://not-a-url'],
        ['number type', 123],
        ['object type', {}],
    ];

    for (const [desc, val] of badUrls) {
        const result = normalizeNanoGptImageResponse(
            { data: [{ url: val }] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(
            result.ok,
            false,
            `Expected invalid-image-url for: ${desc}`
        );
        assert.deepEqual(result.errors, ['invalid-image-url']);
    }
});

test('rejects non-HTTPS URL schemes with unsafe-image-url-protocol', () => {
    const unsafeProtocolUrls = [
        ['http', 'http://example.com/image.png'],
        ['data URL', 'data:image/png;base64,AAAA'],
        ['blob URL', 'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000'],
        ['file URL', 'file:///etc/passwd'],
        ['ftp URL', 'ftp://example.com/image.png'],
        ['javascript URL', 'javascript:alert(1)'],
    ];

    for (const [desc, url] of unsafeProtocolUrls) {
        const result = normalizeNanoGptImageResponse(
            { data: [{ url }] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(
            result.ok,
            false,
            `Expected unsafe-image-url-protocol for: ${desc}`
        );
        assert.deepEqual(result.errors, ['unsafe-image-url-protocol']);
    }
});

test('rejects URLs with embedded credentials with unsafe-image-url-credentials', () => {
    const credentialUrls = [
        'https://user:pass@example.com/image.png',
        'https://user@example.com/image.png',
        'https://:pass@example.com/image.png',
    ];

    for (const url of credentialUrls) {
        const result = normalizeNanoGptImageResponse(
            { data: [{ url }] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.errors, ['unsafe-image-url-credentials']);
    }
});

test('rejects obvious localhost, loopback, and private targets with unsafe-image-url-target', () => {
    const privateTargets = [
        // Local hostnames
        ['localhost', 'https://localhost/image.png'],
        ['sub.localhost', 'https://sub.localhost/image.png'],
        ['local domain', 'https://router.local/image.png'],
        ['internal domain', 'https://auth.internal/image.png'],
        ['lan domain', 'https://gateway.lan/image.png'],

        // IPv4 Loopback (127.0.0.0/8)
        ['127.0.0.1', 'https://127.0.0.1/image.png'],
        ['127.0.1.1', 'https://127.0.1.1/image.png'],

        // IPv4 Current Network (0.0.0.0/8)
        ['0.0.0.0', 'https://0.0.0.0/image.png'],

        // IPv4 Private Class A (10.0.0.0/8)
        ['10.0.0.1', 'https://10.0.0.1/image.png'],
        ['10.254.1.1', 'https://10.254.1.1/image.png'],

        // IPv4 Private Class B (172.16.0.0/12)
        ['172.16.0.1', 'https://172.16.0.1/image.png'],
        ['172.31.255.254', 'https://172.31.255.254/image.png'],

        // IPv4 Private Class C (192.168.0.0/16)
        ['192.168.0.1', 'https://192.168.0.1/image.png'],
        ['192.168.1.100', 'https://192.168.1.100/image.png'],

        // IPv4 Link-local (169.254.0.0/16)
        ['169.254.169.254', 'https://169.254.169.254/image.png'],

        // IPv4 CGNAT (100.64.0.0/10)
        ['100.64.0.1', 'https://100.64.0.1/image.png'],

        // IPv6 Loopback
        ['IPv6 loopback ::1', 'https://[::1]/image.png'],

        // IPv6 Link-local (fe80::/10)
        ['IPv6 link-local', 'https://[fe80::1]/image.png'],

        // IPv6 Unique Local (fc00::/7)
        ['IPv6 ULA fd00', 'https://[fd00::1]/image.png'],
        ['IPv6 ULA fc00', 'https://[fc00::1]/image.png'],

        // IPv4-mapped IPv6 loopback
        ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/image.png'],
    ];

    for (const [desc, url] of privateTargets) {
        const result = normalizeNanoGptImageResponse(
            { data: [{ url }] },
            { source: 'openai-compatible' }
        );

        assert.strictEqual(
            result.ok,
            false,
            `Expected unsafe-image-url-target for: ${desc} (${url})`
        );
        assert.deepEqual(result.errors, ['unsafe-image-url-target']);
    }
});

// -----------------------------------------------------------------------------
// Immutability, Privacy & Module Purity
// -----------------------------------------------------------------------------

test('does not mutate deeply frozen input response or options objects', () => {
    const entry = Object.freeze({
        b64_json: 'AAAA',
    });
    const response = Object.freeze({
        created: 123456,
        data: Object.freeze([entry]),
    });
    const options = Object.freeze({
        source: 'openai-compatible',
    });

    const result = normalizeNanoGptImageResponse(response, options);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.image.data, 'AAAA');
});

test('error outputs never leak sensitive signed tokens, query parameters, or base64', () => {
    const sensitiveToken = 'SECRET_SIGNATURE_KEY_1234567890';
    const sensitivePayload = 'TOP_SECRET_PAYLOAD_999999';

    // 1. Unsafe target with sensitive query
    const res1 = normalizeNanoGptImageResponse(
        {
            data: [{ url: `https://127.0.0.1/image.png?sig=${sensitiveToken}` }],
        },
        { source: 'openai-compatible' }
    );
    assert.strictEqual(res1.ok, false);
    const json1 = JSON.stringify(res1);
    assert.strictEqual(json1.includes(sensitiveToken), false);

    // 2. Malformed base64 with sensitive token
    const res2 = normalizeNanoGptImageResponse(
        {
            data: [{ b64_json: `INVALID$BASE64$${sensitivePayload}` }],
        },
        { source: 'openai-compatible' }
    );
    assert.strictEqual(res2.ok, false);
    const json2 = JSON.stringify(res2);
    assert.strictEqual(json2.includes(sensitivePayload), false);
});

test('production module source contains no network, DOM, or credential access', () => {
    const modulePath = path.resolve('src/providers/nanogpt-image-response.js');
    const source = fs.readFileSync(modulePath, 'utf8');

    const forbiddenTokens = [
        'fetch(',
        'XMLHttpRequest',
        'globalThis.SillyTavern',
        'SillyTavern',
        'getContext',
        'getRequestHeaders',
        'extensionSettings',
        'SECRET_KEYS',
        'localStorage',
        'sessionStorage',
        'document',
        'window',
        'FileReader',
        'Blob',
        'Buffer',
        'console.log',
        'console.debug',
        'console.info',
        'setTimeout',
        'setInterval',
    ];

    for (const token of forbiddenTokens) {
        assert.strictEqual(
            source.includes(token),
            false,
            `Production source must not contain: ${token}`
        );
    }
});

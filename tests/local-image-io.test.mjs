/**
 * @file Unit tests for SillyTavern-local image I/O primitives (M03-E).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    USER_IMAGES_ROOT,
    MAX_PATH_CODE_UNITS,
    MAX_FILENAME_CODE_UNITS,
    MAX_REFERENCE_COUNT,
    MAX_REFERENCE_IMAGE_BYTES,
    MAX_REFERENCE_AGGREGATE_BYTES,
    MAX_GENERATED_IMAGE_BYTES,
    IMAGE_UPLOAD_ROUTE,
    SUPPORTED_IMAGE_FORMATS,
    SUPPORTED_IMAGE_MIME_TYPES,
    LOCAL_IO_ERROR_CODES,
    resolveClampedLimit,
    validateDurableUserImagePath,
    detectSupportedImageFormat,
    imageBlobToDataUrl,
    loadUserImageAsDataUrl,
    prepareImageReferences,
    uploadGeneratedImageBase64,
} from '../src/images/local-image-io.js';

// Minimal synthetic binary signatures (small fixtures, no large memory allocations)
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_MAGIC = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // file size
    0x57, 0x45, 0x42, 0x50, // WEBP
    0x56, 0x50, 0x38, 0x20, // VP8
]);

// Base64 representations of minimal signatures
const PNG_B64 = Buffer.from(PNG_MAGIC).toString('base64');
const JPEG_B64 = Buffer.from(JPEG_MAGIC).toString('base64');
const WEBP_B64 = Buffer.from(WEBP_MAGIC).toString('base64');

// Injected test reader for Node unit tests
const testReader = async (blob) => {
    const buf = Buffer.from(await blob.arrayBuffer());
    const mime = blob.type || 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
};

// ============================================================================
// 1. Module Constants & Limits
// ============================================================================

test('1.1 module exports expected constants and error codes', () => {
    assert.equal(USER_IMAGES_ROOT, '/user/images/');
    assert.equal(MAX_PATH_CODE_UNITS, 4096);
    assert.equal(MAX_FILENAME_CODE_UNITS, 128);
    assert.equal(MAX_REFERENCE_COUNT, 3);
    assert.equal(MAX_REFERENCE_IMAGE_BYTES, 31457280);
    assert.equal(MAX_REFERENCE_AGGREGATE_BYTES, 31457280);
    assert.equal(MAX_GENERATED_IMAGE_BYTES, 31457280);
    assert.equal(IMAGE_UPLOAD_ROUTE, '/api/images/upload');
    assert.deepEqual(SUPPORTED_IMAGE_FORMATS, ['png', 'jpeg', 'webp']);
    assert.deepEqual(SUPPORTED_IMAGE_MIME_TYPES, ['image/png', 'image/jpeg', 'image/webp']);
    assert.ok(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
});

// ============================================================================
// 2. Limit Options Validation & Clamping (Clarification 1)
// ============================================================================

test('2.1 resolveClampedLimit uses hard default when undefined', () => {
    const errors = [];
    assert.equal(resolveClampedLimit(undefined, 3, errors), 3);
    assert.equal(resolveClampedLimit(undefined, 31457280, errors), 31457280);
    assert.equal(errors.length, 0);
});

test('2.2 resolveClampedLimit accepts lower positive integer', () => {
    const errors = [];
    assert.equal(resolveClampedLimit(2, 3, errors), 2);
    assert.equal(resolveClampedLimit(100, 31457280, errors), 100);
    assert.equal(errors.length, 0);
});

test('2.3 resolveClampedLimit clamps values above hard ceiling to ceiling', () => {
    const errors = [];
    assert.equal(resolveClampedLimit(10, 3, errors), 3);
    assert.equal(resolveClampedLimit(50000000, 31457280, errors), 31457280);
    assert.equal(errors.length, 0);
});

test('2.4 resolveClampedLimit fails closed on invalid limit options', () => {
    const invalidValues = [0, -1, NaN, Infinity, 1.5, '2', {}, [], null];
    for (const val of invalidValues) {
        const errors = [];
        const res = resolveClampedLimit(val, 3, errors);
        assert.equal(res, null, `Expected null for invalid value: ${val}`);
        assert.ok(errors.includes(LOCAL_IO_ERROR_CODES.INVALID_OPTIONS));
    }
});

// ============================================================================
// 3. Durable User Image Path Validation
// ============================================================================

test('3.1 validateDurableUserImagePath accepts valid root-relative paths', () => {
    assert.deepEqual(validateDurableUserImagePath('/user/images/hina.png'), {
        ok: true,
        path: '/user/images/hina.png',
        errors: [],
    });
    assert.deepEqual(validateDurableUserImagePath('/user/images/refs/outfit1/hina_front.webp'), {
        ok: true,
        path: '/user/images/refs/outfit1/hina_front.webp',
        errors: [],
    });
    assert.deepEqual(validateDurableUserImagePath('/user/images/sub/deep/test.jpeg'), {
        ok: true,
        path: '/user/images/sub/deep/test.jpeg',
        errors: [],
    });
    assert.deepEqual(validateDurableUserImagePath('/user/images/sub/test.jpg'), {
        ok: true,
        path: '/user/images/sub/test.jpg',
        errors: [],
    });
    assert.deepEqual(validateDurableUserImagePath('/user/images/妃奈 1.PNG'), {
        ok: true,
        path: '/user/images/妃奈 1.PNG',
        errors: [],
    });
});

test('3.2 validateDurableUserImagePath rejects invalid types and empty strings', () => {
    assert.equal(validateDurableUserImagePath(null).errors[0], LOCAL_IO_ERROR_CODES.INVALID_PATH_TYPE);
    assert.equal(validateDurableUserImagePath(123).errors[0], LOCAL_IO_ERROR_CODES.INVALID_PATH_TYPE);
    assert.equal(validateDurableUserImagePath({}).errors[0], LOCAL_IO_ERROR_CODES.INVALID_PATH_TYPE);
    assert.equal(validateDurableUserImagePath('').errors[0], LOCAL_IO_ERROR_CODES.PATH_EMPTY);
});

test('3.3 validateDurableUserImagePath rejects untrimmed paths or paths exceeding length', () => {
    assert.equal(validateDurableUserImagePath(' /user/images/a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_NOT_TRIMMED);
    assert.equal(validateDurableUserImagePath('/user/images/a.png ').errors[0], LOCAL_IO_ERROR_CODES.PATH_NOT_TRIMMED);

    const longPath = `/user/images/${'a'.repeat(4090)}.png`;
    assert.equal(validateDurableUserImagePath(longPath).errors[0], LOCAL_IO_ERROR_CODES.PATH_TOO_LONG);
});

test('3.4 validateDurableUserImagePath rejects control characters and forbidden characters', () => {
    assert.equal(validateDurableUserImagePath('/user/images/hina\x00.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('/user/images/hina\r.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('/user/images/hina\n.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('/user/images/hina\\foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('/user/images/hina.png?v=1').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('/user/images/hina.png#thumb').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('https://evil.com/user/images/a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
    assert.equal(validateDurableUserImagePath('//user/images/a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);
});

test('3.5 validateDurableUserImagePath enforces root prefix and slashes', () => {
    assert.equal(validateDurableUserImagePath('/images/a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_INVALID_ROOT);
    assert.equal(validateDurableUserImagePath('user/images/a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_INVALID_ROOT);
    assert.equal(validateDurableUserImagePath('/user/images//a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_DOUBLE_SLASH);
    assert.equal(validateDurableUserImagePath('/user/images/sub//a.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_DOUBLE_SLASH);
    assert.equal(validateDurableUserImagePath('/user/images/').errors[0], LOCAL_IO_ERROR_CODES.PATH_TRAILING_SLASH);
    assert.equal(validateDurableUserImagePath('/user/images/sub/').errors[0], LOCAL_IO_ERROR_CODES.PATH_TRAILING_SLASH);
});

test('3.6 validateDurableUserImagePath rejects path traversal and encoded traversal', () => {
    // Literal traversal
    assert.equal(validateDurableUserImagePath('/user/images/../secrets.json').errors[0], LOCAL_IO_ERROR_CODES.PATH_TRAVERSAL_DETECTED);
    assert.equal(validateDurableUserImagePath('/user/images/sub/../foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_TRAVERSAL_DETECTED);
    assert.equal(validateDurableUserImagePath('/user/images/./foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_TRAVERSAL_DETECTED);
    assert.equal(validateDurableUserImagePath('/user/images/sub./foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_FORBIDDEN_CHARACTERS);

    // Encoded traversal
    assert.equal(validateDurableUserImagePath('/user/images/%2e%2e/foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL);
    assert.equal(validateDurableUserImagePath('/user/images/%2E%2E/foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL);
    assert.equal(validateDurableUserImagePath('/user/images/%2e/foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL);
    assert.equal(validateDurableUserImagePath('/user/images/%2ffoo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL);
    assert.equal(validateDurableUserImagePath('/user/images/%5cfoo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL);
    assert.equal(validateDurableUserImagePath('/user/images/%252e/foo.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_ENCODED_TRAVERSAL);

    // Malformed encoding
    assert.equal(validateDurableUserImagePath('/user/images/foo%2.png').errors[0], LOCAL_IO_ERROR_CODES.PATH_MALFORMED_ENCODING);
});

test('3.7 validateDurableUserImagePath rejects unsupported file extensions', () => {
    const badExts = ['foo.gif', 'foo.svg', 'foo.bmp', 'foo.mp4', 'foo.webm', 'foo.json', 'foo.txt', 'foo'];
    for (const b of badExts) {
        assert.equal(validateDurableUserImagePath(`/user/images/${b}`).errors[0], LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_EXTENSION);
    }
});

// ============================================================================
// 4. Byte Signature Detection
// ============================================================================

test('4.1 detectSupportedImageFormat recognizes PNG, JPEG, WEBP magic bytes', () => {
    assert.deepEqual(detectSupportedImageFormat(PNG_MAGIC), {
        ok: true,
        format: 'png',
        mime: 'image/png',
        errors: [],
    });
    assert.deepEqual(detectSupportedImageFormat(JPEG_MAGIC), {
        ok: true,
        format: 'jpeg',
        mime: 'image/jpeg',
        errors: [],
    });
    assert.deepEqual(detectSupportedImageFormat(WEBP_MAGIC), {
        ok: true,
        format: 'webp',
        mime: 'image/webp',
        errors: [],
    });
    // ArrayBuffer input
    assert.deepEqual(detectSupportedImageFormat(PNG_MAGIC.buffer), {
        ok: true,
        format: 'png',
        mime: 'image/png',
        errors: [],
    });
});

test('4.2 detectSupportedImageFormat handles truncated bytes', () => {
    assert.equal(detectSupportedImageFormat(new Uint8Array([0x89])).errors[0], LOCAL_IO_ERROR_CODES.TRUNCATED_IMAGE_BYTES);
    assert.equal(detectSupportedImageFormat(new Uint8Array([0x89, 0x50, 0x4e])).errors[0], LOCAL_IO_ERROR_CODES.TRUNCATED_IMAGE_BYTES);
    assert.equal(detectSupportedImageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46])).errors[0], LOCAL_IO_ERROR_CODES.TRUNCATED_IMAGE_BYTES);
});

test('4.3 detectSupportedImageFormat rejects unsupported signatures', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    assert.equal(detectSupportedImageFormat(gif).errors[0], LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_SIGNATURE);

    const bmp = new Uint8Array([0x42, 0x4d, 0x00, 0x00]); // BM
    assert.equal(detectSupportedImageFormat(bmp).errors[0], LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_SIGNATURE);

    const txt = new TextEncoder().encode('Hello, world!');
    assert.equal(detectSupportedImageFormat(txt).errors[0], LOCAL_IO_ERROR_CODES.UNSUPPORTED_IMAGE_SIGNATURE);
});

test('4.4 detectSupportedImageFormat validates expectedMime parameter', () => {
    assert.deepEqual(detectSupportedImageFormat(PNG_MAGIC, { expectedMime: 'image/png' }), {
        ok: true,
        format: 'png',
        mime: 'image/png',
        errors: [],
    });
    assert.deepEqual(detectSupportedImageFormat(PNG_MAGIC, { expectedMime: 'IMAGE/PNG' }), {
        ok: true,
        format: 'png',
        mime: 'image/png',
        errors: [],
    });
    assert.equal(
        detectSupportedImageFormat(PNG_MAGIC, { expectedMime: 'image/jpeg' }).errors[0],
        LOCAL_IO_ERROR_CODES.MIME_SIGNATURE_MISMATCH,
    );
});

test('4.5 detectSupportedImageFormat rejects unknown option keys', () => {
    assert.equal(
        detectSupportedImageFormat(PNG_MAGIC, { unexpectedKey: 123 }).errors[0],
        LOCAL_IO_ERROR_CODES.INVALID_OPTIONS,
    );
});

// ============================================================================
// 5. Blob / File -> Canonical Data URL (`imageBlobToDataUrl`)
// ============================================================================

test('5.1 imageBlobToDataUrl converts valid PNG Blob to canonical data URL', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'image/png' });
    const res = await imageBlobToDataUrl(blob, { readDataUrl: testReader });
    assert.equal(res.ok, true);
    assert.equal(res.format, 'png');
    assert.equal(res.mime, 'image/png');
    assert.equal(res.byteLength, PNG_MAGIC.length);
    assert.equal(res.dataUrl, `data:image/png;base64,${PNG_B64}`);
});

test('5.2 imageBlobToDataUrl canonicalizes MIME when reader returned different type', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'application/octet-stream' });
    // Injected reader returning application/octet-stream data URL
    const octetReader = async (b) => `data:application/octet-stream;base64,${PNG_B64}`;
    const res = await imageBlobToDataUrl(blob, { readDataUrl: octetReader });
    assert.equal(res.ok, true);
    assert.equal(res.dataUrl, `data:image/png;base64,${PNG_B64}`);
});

test('5.3 imageBlobToDataUrl rejects empty Blob and invalid Blob objects', async () => {
    const emptyBlob = new Blob([], { type: 'image/png' });
    assert.equal((await imageBlobToDataUrl(emptyBlob, { readDataUrl: testReader })).errors[0], LOCAL_IO_ERROR_CODES.EMPTY_IMAGE_BLOB);

    assert.equal((await imageBlobToDataUrl(null)).errors[0], LOCAL_IO_ERROR_CODES.INVALID_BLOB_OBJECT);
    assert.equal((await imageBlobToDataUrl({})).errors[0], LOCAL_IO_ERROR_CODES.INVALID_BLOB_OBJECT);
});

test('5.4 imageBlobToDataUrl enforces byte size ceiling without large allocation', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'image/png' });
    // Clamp limit down to 4 bytes for testing (fixture size is 8 bytes)
    const res = await imageBlobToDataUrl(blob, { maxBytes: 4, readDataUrl: testReader });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT);
    assert.equal(res.byteLength, PNG_MAGIC.length);
});

test('5.5 imageBlobToDataUrl clamps caller attempts to raise limit above hard maximum', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'image/png' });
    // Requesting 50 MB gets clamped to 31,457,280 and succeeds for small blob
    const res = await imageBlobToDataUrl(blob, { maxBytes: 50000000, readDataUrl: testReader });
    assert.equal(res.ok, true);
});

test('5.6 imageBlobToDataUrl validates reader output syntax and base64 payload', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'image/png' });

    // Reader returns non-data-URL string
    const badReader1 = async () => 'not-a-data-url';
    assert.equal((await imageBlobToDataUrl(blob, { readDataUrl: badReader1 })).errors[0], LOCAL_IO_ERROR_CODES.MALFORMED_READER_OUTPUT);

    // Reader returns empty payload
    const badReader2 = async () => 'data:image/png;base64,';
    assert.equal((await imageBlobToDataUrl(blob, { readDataUrl: badReader2 })).errors[0], LOCAL_IO_ERROR_CODES.MALFORMED_READER_OUTPUT);

    // Reader returns invalid base64 characters
    const badReader3 = async () => 'data:image/png;base64,***bad***';
    assert.equal((await imageBlobToDataUrl(blob, { readDataUrl: badReader3 })).errors[0], LOCAL_IO_ERROR_CODES.MALFORMED_READER_OUTPUT);
});

test('5.7 imageBlobToDataUrl validates declared Blob type mismatch', async () => {
    // Declared JPEG but binary bytes are PNG
    const blob = new Blob([PNG_MAGIC], { type: 'image/jpeg' });
    const res = await imageBlobToDataUrl(blob, { readDataUrl: testReader });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.MIME_SIGNATURE_MISMATCH);
});

test('5.8 imageBlobToDataUrl handles AbortSignal validation and pre-aborted signal', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'image/png' });

    // Malformed signal object
    const badSignalRes = await imageBlobToDataUrl(blob, { signal: { aborted: true } });
    assert.equal(badSignalRes.errors[0], LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);

    // Pre-aborted signal
    const controller = new AbortController();
    controller.abort();
    let readerCalled = false;
    const trackingReader = async () => {
        readerCalled = true;
        return `data:image/png;base64,${PNG_B64}`;
    };

    const res = await imageBlobToDataUrl(blob, { signal: controller.signal, readDataUrl: trackingReader });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.CANCELLED);
    assert.equal(readerCalled, false, 'Reader must not be called when signal is already aborted');
});

// ============================================================================
// 6. Local User Image Path Fetch (`loadUserImageAsDataUrl`)
// ============================================================================

test('6.1 loadUserImageAsDataUrl loads same-origin image successfully without ST headers', async () => {
    let fetchCalled = false;
    let fetchHeaders = null;
    let fetchRedirect = null;
    let fetchCredentials = null;

    const mockFetch = async (url, opts) => {
        fetchCalled = true;
        fetchHeaders = opts.headers;
        fetchRedirect = opts.redirect;
        fetchCredentials = opts.credentials;
        return {
            status: 200,
            headers: new Headers({
                'content-type': 'image/png',
                'content-length': String(PNG_MAGIC.length),
            }),
            blob: async () => new Blob([PNG_MAGIC], { type: 'image/png' }),
        };
    };

    const res = await loadUserImageAsDataUrl('/user/images/hina.png', {
        fetch: mockFetch,
        readDataUrl: testReader,
    });

    assert.equal(res.ok, true);
    assert.equal(fetchCalled, true);
    assert.equal(fetchRedirect, 'error');
    assert.equal(fetchCredentials, 'same-origin');
    assert.equal(fetchHeaders, undefined, 'Local GET must not attach CSRF request headers');
    assert.equal(res.dataUrl, `data:image/png;base64,${PNG_B64}`);
});

test('6.2 loadUserImageAsDataUrl fails closed on invalid path with 0 fetch calls', async () => {
    let fetchCalls = 0;
    const mockFetch = async () => {
        fetchCalls++;
        return { status: 200 };
    };

    const res = await loadUserImageAsDataUrl('/user/images/../secrets.json', { fetch: mockFetch });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.PATH_TRAVERSAL_DETECTED);
    assert.equal(fetchCalls, 0);
});

test('6.3 loadUserImageAsDataUrl handles non-2xx status preserving HTTP status code', async () => {
    const mockFetch = async () => ({
        status: 404,
        headers: new Headers(),
    });

    const res = await loadUserImageAsDataUrl('/user/images/missing.png', { fetch: mockFetch });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.FETCH_NON_2XX_STATUS);
});

test('6.4 loadUserImageAsDataUrl detects observable redirects', async () => {
    // 1. response.redirected === true
    const mockFetch1 = async () => ({
        status: 200,
        redirected: true,
        headers: new Headers(),
        blob: async () => new Blob([PNG_MAGIC]),
    });
    const res1 = await loadUserImageAsDataUrl('/user/images/hina.png', { fetch: mockFetch1 });
    assert.equal(res1.errors[0], LOCAL_IO_ERROR_CODES.FETCH_REDIRECT_DETECTED);

    // 2. response.url divergence
    const mockFetch2 = async () => ({
        status: 200,
        url: 'http://localhost:8000/different/path.png',
        headers: new Headers(),
        blob: async () => new Blob([PNG_MAGIC]),
    });
    const res2 = await loadUserImageAsDataUrl('/user/images/hina.png', { fetch: mockFetch2 });
    assert.equal(res2.errors[0], LOCAL_IO_ERROR_CODES.FETCH_REDIRECT_DETECTED);
});

test('6.5 loadUserImageAsDataUrl classifies generic fetch rejection as network error', async () => {
    const mockFetch = async () => {
        throw new TypeError('Failed to fetch');
    };
    const res = await loadUserImageAsDataUrl('/user/images/hina.png', { fetch: mockFetch });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.FETCH_NETWORK_ERROR);
});

test('6.6 loadUserImageAsDataUrl handles early Content-Length ceiling check', async () => {
    let blobCalled = false;
    const mockFetch = async () => ({
        status: 200,
        headers: new Headers({
            'content-length': '100', // exceeds test limit of 8 bytes
        }),
        blob: async () => {
            blobCalled = true;
            return new Blob([PNG_MAGIC]);
        },
    });

    const res = await loadUserImageAsDataUrl('/user/images/hina.png', {
        fetch: mockFetch,
        maxBytes: 8,
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT);
    assert.equal(blobCalled, false, 'Blob reading must be avoided when Content-Length exceeds ceiling');
});

test('6.7 loadUserImageAsDataUrl handles cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await loadUserImageAsDataUrl('/user/images/hina.png', {
        signal: controller.signal,
        fetch: async () => assert.fail('Fetch must not be called when pre-aborted'),
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.CANCELLED);
});

// ============================================================================
// 7. Reference Batch Preparation (`prepareImageReferences`)
// ============================================================================

test('7.1 prepareImageReferences returns empty array for 0 references', async () => {
    const res = await prepareImageReferences([]);
    assert.deepEqual(res, {
        ok: true,
        references: [],
        items: [],
        totalByteLength: 0,
        errors: [],
    });
});

test('7.2 prepareImageReferences rejects > 3 references before any processing', async () => {
    const inputs = ['/user/images/1.png', '/user/images/2.png', '/user/images/3.png', '/user/images/4.png'];
    let fetchCalls = 0;
    const mockFetch = async () => {
        fetchCalls++;
        return { status: 200 };
    };

    const res = await prepareImageReferences(inputs, { fetch: mockFetch });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.TOO_MANY_REFERENCES);
    assert.equal(fetchCalls, 0, 'No fetch calls should occur when reference count exceeds limit');
});

test('7.3 prepareImageReferences clamps caller attempts to raise maxReferences', async () => {
    const inputs = ['/user/images/1.png', '/user/images/2.png', '/user/images/3.png', '/user/images/4.png'];
    // Attempting to allow 5 references gets clamped to 3 and rejected
    const res = await prepareImageReferences(inputs, { maxReferences: 5 });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.TOO_MANY_REFERENCES);
});

test('7.4 prepareImageReferences enforces remaining budget BEFORE base64 conversion', async () => {
    // Item 1: 8 bytes, Item 2: 8 bytes
    // Set test aggregate budget to 12 bytes
    const blob1 = new Blob([PNG_MAGIC], { type: 'image/png' });
    const blob2 = new Blob([PNG_MAGIC], { type: 'image/png' });

    let readerInvocations = 0;
    const trackingReader = async (b) => {
        readerInvocations++;
        return `data:image/png;base64,${PNG_B64}`;
    };

    const res = await prepareImageReferences([blob1, blob2], {
        maxAggregateBytes: 12, // Item 1 (8B) fits, Item 2 (8B) needs 8B but only 4B remain
        readDataUrl: trackingReader,
    });

    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.AGGREGATE_SIZE_EXCEEDED);
    assert.equal(readerInvocations, 1, 'Second item must NOT be converted to data URL when budget is exceeded');
});

test('7.5 prepareImageReferences preserves exact source order across mixed inputs', async () => {
    const blob = new Blob([PNG_MAGIC], { type: 'image/png' });
    const path = '/user/images/item2.webp';

    const mockFetch = async () => ({
        status: 200,
        headers: new Headers({ 'content-type': 'image/webp' }),
        blob: async () => new Blob([WEBP_MAGIC], { type: 'image/webp' }),
    });

    const res = await prepareImageReferences([blob, path], {
        fetch: mockFetch,
        readDataUrl: testReader,
    });

    assert.equal(res.ok, true);
    assert.equal(res.references.length, 2);
    assert.equal(res.items[0].format, 'png');
    assert.equal(res.items[1].format, 'webp');
    assert.equal(res.totalByteLength, PNG_MAGIC.length + WEBP_MAGIC.length);
});

test('7.6 prepareImageReferences works for pure Blobs without fetch dependency', async () => {
    const blob1 = new Blob([PNG_MAGIC], { type: 'image/png' });
    const blob2 = new Blob([JPEG_MAGIC], { type: 'image/jpeg' });

    const res = await prepareImageReferences([blob1, blob2], { readDataUrl: testReader });
    assert.equal(res.ok, true);
    assert.equal(res.references.length, 2);
});

// ============================================================================
// 8. Generated Base64 Upload (`uploadGeneratedImageBase64`)
// ============================================================================

test('8.1 uploadGeneratedImageBase64 uploads valid raw base64 and validates returned path', async () => {
    let postBody = null;
    let postHeaders = null;

    const mockFetch = async (url, opts) => {
        postBody = JSON.parse(opts.body);
        postHeaders = opts.headers;
        return {
            status: 200,
            json: async () => ({ path: '/user/images/ci_generated.png' }),
        };
    };

    const mockHeaders = { 'x-csrf-token': 'token-123' };
    const res = await uploadGeneratedImageBase64({
        image: PNG_B64,
        filename: 'custom_output',
        fetch: mockFetch,
        getRequestHeaders: () => mockHeaders,
    });

    assert.equal(res.ok, true);
    assert.equal(res.path, '/user/images/ci_generated.png');
    assert.equal(res.format, 'png');
    assert.equal(res.byteLength, PNG_MAGIC.length);
    assert.equal(postBody.format, 'png');
    assert.equal(postBody.filename, 'custom_output');
    assert.equal(postHeaders['x-csrf-token'], 'token-123');
    assert.equal(postHeaders['Content-Type'], 'application/json');
});

test('8.2 uploadGeneratedImageBase64 rejects data URLs and invalid base64 payloads', async () => {
    const mockHeaders = () => ({});
    // Data URL rejected
    const res1 = await uploadGeneratedImageBase64({
        image: `data:image/png;base64,${PNG_B64}`,
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res1.errors[0], LOCAL_IO_ERROR_CODES.DATA_URL_REJECTED);

    // Malformed base64
    const res2 = await uploadGeneratedImageBase64({
        image: 'bad_characters_!@#$',
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res2.errors[0], LOCAL_IO_ERROR_CODES.INVALID_BASE64_PAYLOAD);
});

test('8.3 uploadGeneratedImageBase64 derives format from binary magic bytes', async () => {
    const mockFetch = async (url, opts) => ({
        status: 200,
        json: async () => ({ path: '/user/images/out.jpeg' }),
    });

    const res = await uploadGeneratedImageBase64({
        image: JPEG_B64,
        fetch: mockFetch,
        getRequestHeaders: () => ({}),
    });
    assert.equal(res.ok, true);
    assert.equal(res.format, 'jpeg');
});

test('8.4 uploadGeneratedImageBase64 enforces safe filename contract and length', async () => {
    const mockHeaders = () => ({});

    // Too long (> 128 code units)
    const longName = 'a'.repeat(129);
    const res1 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        filename: longName,
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res1.errors[0], LOCAL_IO_ERROR_CODES.INVALID_FILENAME);

    // Path traversal in filename
    const res2 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        filename: '../bad_name',
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res2.errors[0], LOCAL_IO_ERROR_CODES.INVALID_FILENAME);

    // Slashes in filename
    const res3 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        filename: 'sub/bad_name',
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res3.errors[0], LOCAL_IO_ERROR_CODES.INVALID_FILENAME);
});

test('8.5 uploadGeneratedImageBase64 enforces getRequestHeaders dependency', async () => {
    // Missing getRequestHeaders
    const res = await uploadGeneratedImageBase64({
        image: PNG_B64,
        fetch: async () => ({ status: 200 }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.DEPENDENCY_MISSING);
});

test('8.6 uploadGeneratedImageBase64 independently validates server returned path', async () => {
    const mockHeaders = () => ({});

    // Server returns traversal path
    const mockFetch1 = async () => ({
        status: 200,
        json: async () => ({ path: '/user/images/../secrets.json' }),
    });
    const res1 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        fetch: mockFetch1,
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res1.ok, false);
    assert.equal(res1.errors[0], LOCAL_IO_ERROR_CODES.UPLOAD_INVALID_RETURNED_PATH);

    // Server returns external path
    const mockFetch2 = async () => ({
        status: 200,
        json: async () => ({ path: 'https://evil.com/out.png' }),
    });
    const res2 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        fetch: mockFetch2,
        getRequestHeaders: mockHeaders,
    });
    assert.equal(res2.ok, false);
    assert.equal(res2.errors[0], LOCAL_IO_ERROR_CODES.UPLOAD_INVALID_RETURNED_PATH);
});

test('8.7 uploadGeneratedImageBase64 enforces defensive upload size ceiling', async () => {
    // Clamp test limit down to 4 bytes (PNG_B64 decodes to 8 bytes)
    const res = await uploadGeneratedImageBase64({
        image: PNG_B64,
        maxBytes: 4,
        getRequestHeaders: () => ({}),
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.IMAGE_SIZE_EXCEEDS_LIMIT);
});

test('8.8 uploadGeneratedImageBase64 handles HTTP errors with zero retries', async () => {
    let attempts = 0;
    const mockFetch = async () => {
        attempts++;
        return { status: 500 };
    };

    const res = await uploadGeneratedImageBase64({
        image: PNG_B64,
        fetch: mockFetch,
        getRequestHeaders: () => ({}),
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.UPLOAD_HTTP_ERROR);
    assert.equal(attempts, 1, 'Upload must never retry on failure');
});

test('8.9 uploadGeneratedImageBase64 handles malformed and aborted signals', async () => {
    // Malformed signal
    const res1 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        signal: { aborted: true },
        getRequestHeaders: () => ({}),
    });
    assert.equal(res1.ok, false);
    assert.equal(res1.errors[0], LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);

    // Pre-aborted signal
    const controller = new AbortController();
    controller.abort();
    let fetchCalled = false;
    const res2 = await uploadGeneratedImageBase64({
        image: PNG_B64,
        signal: controller.signal,
        fetch: async () => { fetchCalled = true; return { status: 200 }; },
        getRequestHeaders: () => ({}),
    });
    assert.equal(res2.ok, false);
    assert.equal(res2.errors[0], LOCAL_IO_ERROR_CODES.CANCELLED);
    assert.equal(fetchCalled, false, 'Fetch must not be called when signal is pre-aborted');
});

test('8.10 uploadGeneratedImageBase64 handles cancellation during response.json()', async () => {
    const controller = new AbortController();
    const mockFetch = async () => ({
        status: 200,
        json: async () => {
            controller.abort();
            const err = new Error('Body parse aborted');
            err.name = 'AbortError';
            throw err;
        },
    });

    const res = await uploadGeneratedImageBase64({
        image: PNG_B64,
        fetch: mockFetch,
        signal: controller.signal,
        getRequestHeaders: () => ({}),
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.CANCELLED);
});

// ============================================================================
// 9. Additional Limit & Cancellation Boundaries
// ============================================================================

test('9.1 loadUserImageAsDataUrl rejects invalid limit options', async () => {
    const res = await loadUserImageAsDataUrl('/user/images/hina.png', {
        maxBytes: -10,
        fetch: async () => ({ status: 200 }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
});

test('9.2 prepareImageReferences rejects invalid limit options', async () => {
    const res1 = await prepareImageReferences(['/user/images/hina.png'], { maxReferences: 0 });
    assert.equal(res1.ok, false);
    assert.equal(res1.errors[0], LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);

    const res2 = await prepareImageReferences(['/user/images/hina.png'], { maxAggregateBytes: -1 });
    assert.equal(res2.ok, false);
    assert.equal(res2.errors[0], LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);

    const res3 = await prepareImageReferences(['/user/images/hina.png'], { maxSingleImageBytes: NaN });
    assert.equal(res3.ok, false);
    assert.equal(res3.errors[0], LOCAL_IO_ERROR_CODES.INVALID_OPTIONS);
});

test('9.3 loadUserImageAsDataUrl handles cancellation during response.blob()', async () => {
    const controller = new AbortController();
    const mockFetch = async () => ({
        status: 200,
        headers: new Headers(),
        blob: async () => {
            controller.abort();
            const err = new Error('Blob read aborted');
            err.name = 'AbortError';
            throw err;
        },
    });

    const res = await loadUserImageAsDataUrl('/user/images/hina.png', {
        fetch: mockFetch,
        signal: controller.signal,
    });
    assert.equal(res.ok, false);
    assert.equal(res.errors[0], LOCAL_IO_ERROR_CODES.CANCELLED);
});

// ============================================================================
// 10. Passive Safety & Privacy
// ============================================================================

test('10.1 error outputs never leak image base64, data URLs, or prompts', async () => {
    const sentinelBase64 = PNG_B64;
    const res = await uploadGeneratedImageBase64({
        image: sentinelBase64,
        maxBytes: 4,
        getRequestHeaders: () => ({}),
    });

    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(sentinelBase64), false, 'Base64 payload must never be echoed in error output');
});

test('10.2 importing module performs zero network operations or unexpected side effects', () => {
    // Assert all exported constants are frozen / static
    assert.ok(Object.isFrozen(SUPPORTED_IMAGE_FORMATS));
    assert.ok(Object.isFrozen(SUPPORTED_IMAGE_MIME_TYPES));
    assert.ok(Object.isFrozen(LOCAL_IO_ERROR_CODES));
});

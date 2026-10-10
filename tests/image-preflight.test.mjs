import assert from 'node:assert/strict';
import test from 'node:test';

import {
    IMAGE_MAX_DIMENSION,
    IMAGE_MIN_DIMENSION,
    PREFLIGHT_ERROR_CODES,
    inspectImageDimensions,
} from '../src/images/image-preflight.js';

function createFakeBlob(size = 1024) {
    return {
        size,
        slice(start, end) {
            return createFakeBlob(Math.max(0, (end ?? size) - (start ?? 0)));
        },
    };
}

test('1. Valid dimensions within range are accepted via primary decoder', async () => {
    let closed = false;
    const fakeBitmap = {
        width: 1024,
        height: 768,
        close() {
            closed = true;
        },
    };

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => fakeBitmap,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.width, 1024);
    assert.strictEqual(res.height, 768);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(closed, true, 'Bitmap must be closed after inspection');
});

test('2. Exactly 8x8 (minimum boundary) is accepted', async () => {
    let closed = false;
    const fakeBitmap = {
        width: IMAGE_MIN_DIMENSION,
        height: IMAGE_MIN_DIMENSION,
        close() {
            closed = true;
        },
    };

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => fakeBitmap,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.width, 8);
    assert.strictEqual(res.height, 8);
    assert.strictEqual(closed, true);
});

test('3. Exactly 16384x16384 (maximum boundary) is accepted', async () => {
    let closed = false;
    const fakeBitmap = {
        width: IMAGE_MAX_DIMENSION,
        height: IMAGE_MAX_DIMENSION,
        close() {
            closed = true;
        },
    };

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => fakeBitmap,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.width, 16384);
    assert.strictEqual(res.height, 16384);
    assert.strictEqual(closed, true);
});

test('4. Dimensions below minimum (7x8 and 8x7) are rejected as out of range', async () => {
    let closed1 = false;
    const res1 = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => ({
            width: 7,
            height: 8,
            close() {
                closed1 = true;
            },
        }),
    });

    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.width, 7);
    assert.strictEqual(res1.height, 8);
    assert.deepStrictEqual(res1.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE]);
    assert.strictEqual(closed1, true);

    let closed2 = false;
    const res2 = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => ({
            width: 8,
            height: 7,
            close() {
                closed2 = true;
            },
        }),
    });

    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.width, 8);
    assert.strictEqual(res2.height, 7);
    assert.deepStrictEqual(res2.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE]);
    assert.strictEqual(closed2, true);
});

test('5. Dimensions above maximum (16385x16384 and 16384x16385) are rejected as out of range', async () => {
    let closed1 = false;
    const res1 = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => ({
            width: 16385,
            height: 16384,
            close() {
                closed1 = true;
            },
        }),
    });

    assert.strictEqual(res1.ok, false);
    assert.strictEqual(res1.width, 16385);
    assert.strictEqual(res1.height, 16384);
    assert.deepStrictEqual(res1.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE]);
    assert.strictEqual(closed1, true);

    let closed2 = false;
    const res2 = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => ({
            width: 16384,
            height: 16385,
            close() {
                closed2 = true;
            },
        }),
    });

    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.width, 16384);
    assert.strictEqual(res2.height, 16385);
    assert.deepStrictEqual(res2.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE]);
    assert.strictEqual(closed2, true);
});

test('6. Zero or unknown dimensions (0x0, negative, NaN) fail closed', async () => {
    for (const [w, h] of [
        [0, 0],
        [0, 100],
        [100, 0],
        [-10, 50],
        [NaN, 100],
        [null, 100],
        [100.5, 200],
    ]) {
        let closed = false;
        const res = await inspectImageDimensions(createFakeBlob(), {
            createImageBitmap: async () => ({
                width: w,
                height: h,
                close() {
                    closed = true;
                },
            }),
        });

        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.width, null);
        assert.strictEqual(res.height, null);
        assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_UNKNOWN]);
        assert.strictEqual(closed, true);
    }
});

test('7. Primary decoder unavailable falls back to Image decoder successfully', async () => {
    let createdUrl = null;
    let revokedUrl = null;
    let fakeImg = null;

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: null, // unavailable
        createObjectURL: (blob) => {
            createdUrl = 'blob:test-image-123';
            return createdUrl;
        },
        revokeObjectURL: (url) => {
            revokedUrl = url;
        },
        createImage: () => {
            fakeImg = {
                naturalWidth: 800,
                naturalHeight: 600,
                onload: null,
                onerror: null,
                set src(val) {
                    setTimeout(() => {
                        if (typeof this.onload === 'function') {
                            this.onload();
                        }
                    }, 0);
                },
            };
            return fakeImg;
        },
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.width, 800);
    assert.strictEqual(res.height, 600);
    assert.strictEqual(createdUrl, 'blob:test-image-123');
    assert.strictEqual(revokedUrl, 'blob:test-image-123', 'Object URL must be revoked on success');
    assert.strictEqual(fakeImg.onload, null, 'Listener cleaned up');
});

test('8. Primary decoder throws falls back to Image decoder', async () => {
    let revokedUrl = null;

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => {
            throw new Error('createImageBitmap failed');
        },
        createObjectURL: () => 'blob:fallback-url',
        revokeObjectURL: (url) => {
            revokedUrl = url;
        },
        createImage: () => ({
            naturalWidth: 512,
            naturalHeight: 512,
            onload: null,
            onerror: null,
            set src(_v) {
                setTimeout(() => this.onload(), 0);
            },
        }),
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.width, 512);
    assert.strictEqual(res.height, 512);
    assert.strictEqual(revokedUrl, 'blob:fallback-url');
});

test('9. Both decoders fail results in decode-failed', async () => {
    let revokedUrl = null;

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: async () => {
            throw new Error('Primary failed');
        },
        createObjectURL: () => 'blob:error-url',
        revokeObjectURL: (url) => {
            revokedUrl = url;
        },
        createImage: () => ({
            onload: null,
            onerror: null,
            set src(_v) {
                setTimeout(() => this.onerror(new Error('Image failed')), 0);
            },
        }),
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.width, null);
    assert.strictEqual(res.height, null);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.DECODE_FAILED]);
    assert.strictEqual(revokedUrl, 'blob:error-url', 'Object URL revoked on error');
});

test('10. Fallback decoder out-of-range dimensions are rejected', async () => {
    let revokedUrl = null;

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: null,
        createObjectURL: () => 'blob:small-url',
        revokeObjectURL: (url) => {
            revokedUrl = url;
        },
        createImage: () => ({
            naturalWidth: 4,
            naturalHeight: 4,
            onload: null,
            onerror: null,
            set src(_v) {
                setTimeout(() => this.onload(), 0);
            },
        }),
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.width, 4);
    assert.strictEqual(res.height, 4);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_OUT_OF_RANGE]);
    assert.strictEqual(revokedUrl, 'blob:small-url');
});

test('11. Fallback decoder (0, 0) dimensions fail closed as dimensions-unknown', async () => {
    let revokedUrl = null;

    const res = await inspectImageDimensions(createFakeBlob(), {
        createImageBitmap: null,
        createObjectURL: () => 'blob:zero-url',
        revokeObjectURL: (url) => {
            revokedUrl = url;
        },
        createImage: () => ({
            naturalWidth: 0,
            naturalHeight: 0,
            onload: null,
            onerror: null,
            set src(_v) {
                setTimeout(() => this.onload(), 0);
            },
        }),
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.width, null);
    assert.strictEqual(res.height, null);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.DIMENSIONS_UNKNOWN]);
    assert.strictEqual(revokedUrl, 'blob:zero-url');
});

test('12. Abort before decode fails immediately with cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    let primaryCalled = false;
    const res = await inspectImageDimensions(createFakeBlob(), {
        signal: controller.signal,
        createImageBitmap: async () => {
            primaryCalled = true;
            return { width: 100, height: 100, close() {} };
        },
    });

    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.CANCELLED]);
    assert.strictEqual(primaryCalled, false);
});

test('13. Abort during primary decode cancels and cleans up resources', async () => {
    const controller = new AbortController();
    let closed = false;

    const res = await inspectImageDimensions(createFakeBlob(), {
        signal: controller.signal,
        createImageBitmap: () => {
            controller.abort();
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve({
                        width: 500,
                        height: 500,
                        close() {
                            closed = true;
                        },
                    });
                }, 10);
            });
        },
    });

    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.CANCELLED]);
    // Allow late settlement timer to fire
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(closed, true, 'Late settled bitmap must be closed');
});

test('14. Abort during fallback decode cancels and revokes object URL', async () => {
    const controller = new AbortController();
    let revokedUrl = null;
    let fakeImg = null;

    const promise = inspectImageDimensions(createFakeBlob(), {
        signal: controller.signal,
        createImageBitmap: null,
        createObjectURL: () => 'blob:abort-url',
        revokeObjectURL: (url) => {
            revokedUrl = url;
        },
        createImage: () => {
            fakeImg = {
                onload: null,
                onerror: null,
                naturalWidth: 800,
                naturalHeight: 600,
                set src(_v) {
                    // Do not resolve yet
                },
            };
            return fakeImg;
        },
    });

    // Abort after creation
    controller.abort();
    const res = await promise;

    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.CANCELLED]);
    assert.strictEqual(revokedUrl, 'blob:abort-url');
    assert.strictEqual(fakeImg.onload, null, 'Listeners cleaned up');
});

test('15. Invalid blob object inputs fail closed', async () => {
    for (const badBlob of [null, undefined, 'not-a-blob', 12345, {}, { size: 100 }]) {
        const res = await inspectImageDimensions(badBlob);
        assert.strictEqual(res.ok, false);
        assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.INVALID_BLOB_OBJECT]);
    }
});

test('16. Empty blob (size 0) fails closed with empty-image-blob', async () => {
    const res = await inspectImageDimensions(createFakeBlob(0));
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(res.errors, [PREFLIGHT_ERROR_CODES.EMPTY_IMAGE_BLOB]);
});

test('17. Invalid options or unknown keys fail closed with invalid-options', async () => {
    assert.deepStrictEqual(
        (await inspectImageDimensions(createFakeBlob(), 'not-an-object')).errors,
        [PREFLIGHT_ERROR_CODES.INVALID_OPTIONS]
    );
    assert.deepStrictEqual(
        (await inspectImageDimensions(createFakeBlob(), { unknownKey: true })).errors,
        [PREFLIGHT_ERROR_CODES.INVALID_OPTIONS]
    );
    assert.deepStrictEqual(
        (await inspectImageDimensions(createFakeBlob(), { signal: 'invalid-signal' })).errors,
        [PREFLIGHT_ERROR_CODES.INVALID_OPTIONS]
    );
});

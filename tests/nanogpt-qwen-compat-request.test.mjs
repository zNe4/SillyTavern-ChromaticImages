import test from 'node:test';
import assert from 'node:assert/strict';

import {
    QWEN_IMAGE_MODEL_ID,
    QWEN_IMAGE_MAX_REFERENCES,
    QWEN_IMAGE_MAX_PROMPT_CODE_UNITS,
    QWEN_IMAGE_DEFAULT_RESOLUTION,
    QWEN_IMAGE_RESOLUTIONS,
    QWEN_IMAGE_REFERENCE_MIME_TYPES,
    buildQwenImageCompatibilityRequest,
} from '../src/providers/nanogpt-qwen-compat-request.js';

const VALID_PNG_REF = 'data:image/png;base64,AAAA';
const VALID_JPEG_REF = 'data:image/jpeg;base64,BBBB';
const VALID_WEBP_REF = 'data:image/webp;base64,CCCC';

test('exported constants have expected types and immutability', () => {
    assert.strictEqual(QWEN_IMAGE_MODEL_ID, 'qwen-image');
    assert.strictEqual(QWEN_IMAGE_MAX_REFERENCES, 3);
    assert.strictEqual(QWEN_IMAGE_MAX_PROMPT_CODE_UNITS, 3000);
    assert.strictEqual(QWEN_IMAGE_DEFAULT_RESOLUTION, 'auto');

    assert.strictEqual(Object.isFrozen(QWEN_IMAGE_RESOLUTIONS), true);
    assert.strictEqual(Object.isFrozen(QWEN_IMAGE_REFERENCE_MIME_TYPES), true);

    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('auto'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('1024x1024'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('512x512'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('768x1024'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('576x1024'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('1024x768'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('1024x576'));
    assert.ok(QWEN_IMAGE_REFERENCE_MIME_TYPES.includes('image/png'));
    assert.ok(QWEN_IMAGE_REFERENCE_MIME_TYPES.includes('image/jpeg'));
    assert.ok(QWEN_IMAGE_REFERENCE_MIME_TYPES.includes('image/webp'));
});

test('rejects non-plain object input options', () => {
    const invalidInputs = [
        null,
        undefined,
        'string',
        123,
        true,
        false,
        [1, 2, 3],
        new Date(),
        /regex/,
        new (class CustomClass {})(),
    ];

    for (const input of invalidInputs) {
        const result = buildQwenImageCompatibilityRequest(input);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.deepEqual(result.errors, ['invalid-options']);
    }
});

test('rejects unknown options', () => {
    const invalidInputs = [
        { model: 'qwen-image', prompt: 'test', extraOption: 'bad' },
        { model: 'qwen-image', prompt: 'test', n: 1 },
        { model: 'qwen-image', prompt: 'test', nImages: 1 },
        { model: 'qwen-image', prompt: 'test', seed: 42 },
        { model: 'qwen-image', prompt: 'test', input_references: [] },
    ];

    for (const input of invalidInputs) {
        const result = buildQwenImageCompatibilityRequest(input);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('unknown-option'));
    }
});

test('validates model identifier', () => {
    const invalidModels = [
        undefined,
        null,
        '',
        'flux-schnell',
        'qwen-image-edit',
        'Qwen-Image',
        123,
    ];

    for (const model of invalidModels) {
        const result = buildQwenImageCompatibilityRequest({
            model,
            prompt: 'a valid prompt',
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-model'));
    }
});

test('validates prompt strings and bounds', () => {
    // Missing or invalid type
    const nonStrings = [undefined, null, 123, true, {}, []];
    for (const badPrompt of nonStrings) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: badPrompt,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-prompt'));
    }

    // Empty or whitespace only
    for (const empty of ['', '   ', '\n\t  ']) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: empty,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-prompt'));
    }

    // Prompt too long
    const tooLong = 'a'.repeat(QWEN_IMAGE_MAX_PROMPT_CODE_UNITS + 1);
    const resultTooLong = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: tooLong,
    });
    assert.strictEqual(resultTooLong.ok, false);
    assert.strictEqual(resultTooLong.request, null);
    assert.ok(resultTooLong.errors.includes('prompt-too-long'));

    // Boundary prompt exactly 3000
    const boundary = 'a'.repeat(QWEN_IMAGE_MAX_PROMPT_CODE_UNITS);
    const resultBoundary = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: boundary,
    });
    assert.strictEqual(resultBoundary.ok, true);
    assert.strictEqual(resultBoundary.request.prompt, boundary);

    // Prompt trimming
    const resultTrim = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: '  a prompt with whitespace  \n',
    });
    assert.strictEqual(resultTrim.ok, true);
    assert.strictEqual(resultTrim.request.prompt, 'a prompt with whitespace');
});

test('validates resolution parameter', () => {
    // Default resolution when omitted
    const defaultRes = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
    });
    assert.strictEqual(defaultRes.ok, true);
    assert.strictEqual(defaultRes.request.resolution, 'auto');

    // All valid resolutions
    for (const res of QWEN_IMAGE_RESOLUTIONS) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: 'test prompt',
            resolution: res,
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.request.resolution, res);
    }

    // Invalid resolutions
    for (const badRes of ['invalid', '2048x2048', '1024', '', 1024, null]) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: 'test prompt',
            resolution: badRes,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-resolution'));
    }
});

test('validates response_format parameter', () => {
    // Omitted response_format defaults to b64_json
    const defaultFmt = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
    });
    assert.strictEqual(defaultFmt.ok, true);
    assert.strictEqual(defaultFmt.request.response_format, 'b64_json');

    // Explicit b64_json accepted
    const explicitFmt = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
        response_format: 'b64_json',
    });
    assert.strictEqual(explicitFmt.ok, true);
    assert.strictEqual(explicitFmt.request.response_format, 'b64_json');

    // Invalid response_format values rejected
    for (const badFmt of ['url', 'json', 'base64', 123, null]) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: 'test prompt',
            response_format: badFmt,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-response-format'));
    }
});

test('maps references according to compatibility specification count', () => {
    // 0 references: neither imageDataUrl nor imageDataUrls present
    const zeroRefs = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
        references: [],
    });
    assert.strictEqual(zeroRefs.ok, true);
    assert.strictEqual(zeroRefs.request.imageDataUrl, undefined);
    assert.strictEqual(zeroRefs.request.imageDataUrls, undefined);
    assert.strictEqual(zeroRefs.request.input_references, undefined);

    // 1 reference: maps to imageDataUrl
    const oneRef = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
        references: [VALID_PNG_REF],
    });
    assert.strictEqual(oneRef.ok, true);
    assert.strictEqual(oneRef.request.imageDataUrl, VALID_PNG_REF);
    assert.strictEqual(oneRef.request.imageDataUrls, undefined);
    assert.strictEqual(oneRef.request.input_references, undefined);

    // 2 references: maps to imageDataUrls
    const twoRefs = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
        references: [VALID_PNG_REF, VALID_JPEG_REF],
    });
    assert.strictEqual(twoRefs.ok, true);
    assert.strictEqual(twoRefs.request.imageDataUrl, undefined);
    assert.deepEqual(twoRefs.request.imageDataUrls, [VALID_PNG_REF, VALID_JPEG_REF]);

    // 3 references: maps to imageDataUrls
    const threeRefs = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
        references: [VALID_PNG_REF, VALID_JPEG_REF, VALID_WEBP_REF],
    });
    assert.strictEqual(threeRefs.ok, true);
    assert.strictEqual(threeRefs.request.imageDataUrl, undefined);
    assert.deepEqual(threeRefs.request.imageDataUrls, [VALID_PNG_REF, VALID_JPEG_REF, VALID_WEBP_REF]);

    // 4 references: rejected with too-many-references
    const fourRefs = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'test prompt',
        references: [VALID_PNG_REF, VALID_JPEG_REF, VALID_WEBP_REF, VALID_PNG_REF],
    });
    assert.strictEqual(fourRefs.ok, false);
    assert.strictEqual(fourRefs.request, null);
    assert.ok(fourRefs.errors.includes('too-many-references'));
});

test('validates reference formats and rejects malformed data URLs', () => {
    const invalidReferences = [
        'https://example.com/photo.png',
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
        'data:image/png;base64,not@base64!',
        'data:image/png;base64,AAA',
        'data:image/png;base64,',
        'data:image/png;base64,A=AA',
        123,
        null,
        {},
    ];

    for (const badRef of invalidReferences) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: 'test prompt',
            references: [badRef],
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-reference'));
    }

    // Non-array references
    const nonArrayRefs = ['data:image/png;base64,AAAA', 123, {}];
    for (const badRefs of nonArrayRefs) {
        const result = buildQwenImageCompatibilityRequest({
            model: 'qwen-image',
            prompt: 'test prompt',
            references: badRefs,
        });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.ok(result.errors.includes('invalid-references'));
    }
});

test('ensures compatibility request fields match server contract exactly', () => {
    const valid = buildQwenImageCompatibilityRequest({
        model: 'qwen-image',
        prompt: 'a scenic landscape',
        resolution: '1024x1024',
        references: [VALID_PNG_REF],
    });

    assert.strictEqual(valid.ok, true);
    assert.deepEqual(valid.request, {
        model: 'qwen-image',
        prompt: 'a scenic landscape',
        nImages: 1,
        resolution: '1024x1024',
        response_format: 'b64_json',
        imageDataUrl: VALID_PNG_REF,
    });

    // Check prohibited keys do not exist
    assert.strictEqual('n' in valid.request, false);
    assert.strictEqual('input_references' in valid.request, false);
    assert.strictEqual('imageDataUrls' in valid.request, false);
});

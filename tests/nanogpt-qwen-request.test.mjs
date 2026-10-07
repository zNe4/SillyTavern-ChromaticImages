import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    QWEN_IMAGE_MODEL_ID,
    QWEN_IMAGE_MAX_REFERENCES,
    QWEN_IMAGE_DEFAULT_RESOLUTION,
    QWEN_IMAGE_RESOLUTIONS,
    QWEN_IMAGE_REFERENCE_MIME_TYPES,
    buildQwenImageRequest,
} from '../src/providers/nanogpt-qwen-request.js';

const VALID_PNG_REF = 'data:image/png;base64,AAAA';
const VALID_JPEG_REF = 'data:image/jpeg;base64,BBBB';
const VALID_WEBP_REF = 'data:image/webp;base64,CCCC';

// -----------------------------------------------------------------------------
// Constants and Metadata Consistency Tests
// -----------------------------------------------------------------------------

test('exported constants have expected types and immutability', () => {
    assert.strictEqual(QWEN_IMAGE_MODEL_ID, 'qwen-image');
    assert.strictEqual(QWEN_IMAGE_MAX_REFERENCES, 3);
    assert.strictEqual(QWEN_IMAGE_DEFAULT_RESOLUTION, 'auto');

    assert.strictEqual(Object.isFrozen(QWEN_IMAGE_RESOLUTIONS), true);
    assert.strictEqual(Object.isFrozen(QWEN_IMAGE_REFERENCE_MIME_TYPES), true);

    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('auto'));
    assert.ok(QWEN_IMAGE_RESOLUTIONS.includes('1024x1024'));
    assert.ok(QWEN_IMAGE_REFERENCE_MIME_TYPES.includes('image/png'));
    assert.ok(QWEN_IMAGE_REFERENCE_MIME_TYPES.includes('image/jpeg'));
    assert.ok(QWEN_IMAGE_REFERENCE_MIME_TYPES.includes('image/webp'));
});

test('exported constants match the committed metadata snapshot', () => {
    const snapshotPath = path.resolve('docs/m03-qwen-image-metadata.json');
    assert.ok(fs.existsSync(snapshotPath), 'Snapshot file must exist');

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

    // Model ID
    assert.strictEqual(QWEN_IMAGE_MODEL_ID, snapshot.model.id);

    // Max references compatibility: provider allows at least 3, project cap is 3
    assert.ok(snapshot.model.supported_parameters.max_input_images >= 3);
    assert.strictEqual(QWEN_IMAGE_MAX_REFERENCES, 3);

    // Resolutions match exactly
    assert.deepEqual(
        [...QWEN_IMAGE_RESOLUTIONS],
        snapshot.model.supported_parameters.resolutions
    );

    // Default resolution is in resolutions list
    assert.ok(snapshot.model.supported_parameters.resolutions.includes(QWEN_IMAGE_DEFAULT_RESOLUTION));

    // Accepted formats match
    const formats = snapshot.endpoint.input_reference_constraints.route.formats;
    assert.ok(formats.includes('png'));
    assert.ok(formats.includes('jpeg'));
    assert.ok(formats.includes('webp'));
    assert.deepEqual(
        [...QWEN_IMAGE_REFERENCE_MIME_TYPES],
        ['image/png', 'image/jpeg', 'image/webp']
    );

    // Endpoint provider name / slug
    assert.strictEqual(snapshot.endpoint.provider_name, 'Qwen');
    assert.strictEqual(snapshot.endpoint.provider_slug, 'qwen');
});

// -----------------------------------------------------------------------------
// Plain Object Validation Tests
// -----------------------------------------------------------------------------

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
        const result = buildQwenImageRequest(input);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.request, null);
        assert.deepEqual(result.errors, ['invalid-options']);
    }
});

test('accepts plain object and null-prototype object', () => {
    const standardObj = {
        model: 'qwen-image',
        prompt: 'Scene description.',
    };
    const nullProtoObj = Object.create(null);
    nullProtoObj.model = 'qwen-image';
    nullProtoObj.prompt = 'Scene description.';

    const res1 = buildQwenImageRequest(standardObj);
    assert.strictEqual(res1.ok, true);

    const res2 = buildQwenImageRequest(nullProtoObj);
    assert.strictEqual(res2.ok, true);
});

// -----------------------------------------------------------------------------
// Valid Basic Requests & Deterministic Output
// -----------------------------------------------------------------------------

test('builds minimal text-only request with defaults', () => {
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'A scenic coastline at dusk.',
    });

    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.request, {
        model: 'qwen-image',
        prompt: 'A scenic coastline at dusk.',
        n: 1,
        resolution: 'auto',
    });
    assert.strictEqual('input_references' in result.request, false);
});

test('omits input_references when references is empty array', () => {
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'A scenic coastline at dusk.',
        references: [],
    });

    assert.strictEqual(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.request, {
        model: 'qwen-image',
        prompt: 'A scenic coastline at dusk.',
        n: 1,
        resolution: 'auto',
    });
    assert.strictEqual('input_references' in result.request, false);
});

test('accepts explicit valid resolution', () => {
    for (const res of QWEN_IMAGE_RESOLUTIONS) {
        const result = buildQwenImageRequest({
            model: 'qwen-image',
            prompt: 'Test prompt.',
            resolution: res,
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.request.resolution, res);
    }
});

test('trims outer prompt whitespace and preserves internal formatting', () => {
    const multilinePrompt = '  Line 1: A figure stands.\nLine 2: Rain falls.   Two  spaces.  \t\n';
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: multilinePrompt,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(
        result.request.prompt,
        'Line 1: A figure stands.\nLine 2: Rain falls.   Two  spaces.'
    );
});

test('accepts exactly 8000 UTF-16 code units in prompt', () => {
    const prompt8000 = 'x'.repeat(8000);
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: '  ' + prompt8000 + '  ',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.request.prompt, prompt8000);
});

// -----------------------------------------------------------------------------
// References Validation
// -----------------------------------------------------------------------------

test('accepts 1, 2, and 3 valid references and clones references array', () => {
    const refs1 = [VALID_PNG_REF];
    const result1 = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        references: refs1,
    });
    assert.strictEqual(result1.ok, true);
    assert.deepEqual(result1.request.input_references, refs1);
    assert.notStrictEqual(result1.request.input_references, refs1);

    const refs2 = [VALID_PNG_REF, VALID_JPEG_REF];
    const result2 = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        references: refs2,
    });
    assert.strictEqual(result2.ok, true);
    assert.deepEqual(result2.request.input_references, refs2);

    const refs3 = [VALID_PNG_REF, VALID_JPEG_REF, VALID_WEBP_REF];
    const result3 = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        references: refs3,
    });
    assert.strictEqual(result3.ok, true);
    assert.deepEqual(result3.request.input_references, refs3);
    assert.notStrictEqual(result3.request.input_references, refs3);
});

test('preserves exact reference array ordering and values', () => {
    const refs = [VALID_WEBP_REF, VALID_PNG_REF, VALID_JPEG_REF];
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        references: refs,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.request.input_references[0], VALID_WEBP_REF);
    assert.strictEqual(result.request.input_references[1], VALID_PNG_REF);
    assert.strictEqual(result.request.input_references[2], VALID_JPEG_REF);
});

test('mutating input references array after build does not mutate request', () => {
    const refs = [VALID_PNG_REF];
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        references: refs,
    });

    assert.strictEqual(result.ok, true);
    refs.push(VALID_JPEG_REF);
    assert.strictEqual(result.request.input_references.length, 1);
});

test('rejects 4 or more references with too-many-references', () => {
    const refs4 = [VALID_PNG_REF, VALID_JPEG_REF, VALID_WEBP_REF, VALID_PNG_REF];
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        references: refs4,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.request, null);
    assert.ok(result.errors.includes('too-many-references'));
});

test('rejects non-array references with invalid-references', () => {
    const invalidRefs = ['string', 123, null, {}, true];

    for (const refs of invalidRefs) {
        const result = buildQwenImageRequest({
            model: 'qwen-image',
            prompt: 'Scene.',
            references: refs,
        });

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.includes('invalid-references'));
    }
});

test('rejects various invalid reference items with invalid-reference', () => {
    const invalidCases = [
        ['empty string', ''],
        ['raw base64', 'AAAA'],
        ['root-relative path', '/user/images/character.png'],
        ['http URL', 'http://example.com/character.png'],
        ['https URL', 'https://example.com/character.png'],
        ['blob URL', 'blob:http://localhost:8000/1234-5678'],
        ['object reference', { image_url: { url: 'data:image/png;base64,AAAA' } }],
        ['unsupported MIME gif', 'data:image/gif;base64,AAAA'],
        ['unsupported MIME svg', 'data:image/svg+xml;base64,AAAA'],
        ['unsupported MIME text', 'data:text/plain;base64,AAAA'],
        ['missing ;base64,', 'data:image/png,AAAA'],
        ['empty payload', 'data:image/png;base64,'],
        ['payload with space', 'data:image/png;base64,AAAA AA=='],
        ['payload with newline', 'data:image/png;base64,AAAA\nAA=='],
        ['payload with crlf', 'data:image/png;base64,AAAA\r\nAA=='],
        ['invalid base64 chars', 'data:image/png;base64,AAAA$AAA'],
        ['base64url dashes', 'data:image/png;base64,AAAA-AAA'],
        ['invalid padding 3 equals', 'data:image/png;base64,A==='],
        ['invalid padding 1 equal after 2 chars', 'data:image/png;base64,AA='],
        ['padding in middle', 'data:image/png;base64,AA==AAAA'],
        ['leading whitespace', ' data:image/png;base64,AAAA'],
        ['trailing whitespace', 'data:image/png;base64,AAAA '],
        ['null item', null],
        ['number item', 12345],
    ];

    for (const [description, badRef] of invalidCases) {
        const result = buildQwenImageRequest({
            model: 'qwen-image',
            prompt: 'Scene.',
            references: [badRef],
        });

        assert.strictEqual(
            result.ok,
            false,
            `Expected rejection for invalid reference case: ${description}`
        );
        assert.ok(
            result.errors.includes('invalid-reference'),
            `Expected invalid-reference error for: ${description}`
        );
    }
});

// -----------------------------------------------------------------------------
// Prompt & Model Validation Tests
// -----------------------------------------------------------------------------

test('rejects invalid or missing model with invalid-model', () => {
    const badModels = [
        undefined,
        null,
        '',
        'qwen-image-2.0',
        'qwen-image-3',
        'qwen-image-3-pro',
        'QWEN-IMAGE',
        ' qwen-image',
        'qwen-image ',
        123,
    ];

    for (const badModel of badModels) {
        const result = buildQwenImageRequest({
            model: badModel,
            prompt: 'Scene.',
        });

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.includes('invalid-model'));
    }
});

test('rejects empty, whitespace-only, or non-string prompt with invalid-prompt', () => {
    const badPrompts = [
        undefined,
        null,
        '',
        '   ',
        '\n\t\r\n',
        123,
        {},
        [],
        true,
    ];

    for (const badPrompt of badPrompts) {
        const result = buildQwenImageRequest({
            model: 'qwen-image',
            prompt: badPrompt,
        });

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.includes('invalid-prompt'));
    }
});

test('rejects prompt exceeding 8000 code units with prompt-too-long', () => {
    const prompt8001 = 'a'.repeat(8001);
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: prompt8001,
    });

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.errors, ['prompt-too-long']);
});

// -----------------------------------------------------------------------------
// Resolution Validation Tests
// -----------------------------------------------------------------------------

test('rejects invalid resolution with invalid-resolution', () => {
    const badResolutions = [
        '2048x2048',
        'AUTO',
        'auto ',
        'custom',
        1024,
        null,
        false,
        {},
    ];

    for (const badRes of badResolutions) {
        const result = buildQwenImageRequest({
            model: 'qwen-image',
            prompt: 'Scene.',
            resolution: badRes,
        });

        assert.strictEqual(result.ok, false);
        assert.ok(result.errors.includes('invalid-resolution'));
    }
});

// -----------------------------------------------------------------------------
// Unknown Options & Parameter Injection Rejection Tests
// -----------------------------------------------------------------------------

test('rejects provider parameter injection attempts with unknown-option', () => {
    const injectedKeys = [
        ['n', 1],
        ['n', 2],
        ['nImages', 1],
        ['outputCount', 1],
        ['input_references', [VALID_PNG_REF]],
        ['imageDataUrl', VALID_PNG_REF],
        ['imageDataUrls', [VALID_PNG_REF]],
        ['image_url', VALID_PNG_REF],
        ['images', [VALID_PNG_REF]],
        ['stream', true],
        ['provider', 'qwen'],
        ['apiKey', 'secret-key'],
        ['authorization', 'Bearer token'],
        ['scale', 2.5],
        ['num_steps', 30],
        ['guidanceScale', 2.5],
        ['guidance_scale', 2.5],
        ['inferenceSteps', 30],
        ['num_inference_steps', 30],
        ['negativePrompt', 'blurry, bad anatomy'],
        ['negative_prompt', 'blurry, bad anatomy'],
        ['seed', 12345],
        ['extraUnknownKey', 'value'],
    ];

    for (const [key, val] of injectedKeys) {
        const result = buildQwenImageRequest({
            model: 'qwen-image',
            prompt: 'Scene.',
            [key]: val,
        });

        assert.strictEqual(result.ok, false, `Expected rejection for option key: ${key}`);
        assert.ok(
            result.errors.includes('unknown-option'),
            `Expected unknown-option for key: ${key}`
        );
        assert.strictEqual(result.request, null);
    }
});

test('deduplicates unknown-option error code when multiple unknown keys are provided', () => {
    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: 'Scene.',
        n: 1,
        seed: 1234,
        guidanceScale: 2.5,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(
        result.errors.filter((code) => code === 'unknown-option').length,
        1
    );
});

// -----------------------------------------------------------------------------
// Multiple Failures Collection Tests
// -----------------------------------------------------------------------------

test('collects multiple distinct error codes deterministically', () => {
    const result = buildQwenImageRequest({
        model: 'wrong-model',
        prompt: '',
        resolution: 'bad-res',
        references: 'not-array',
        unknownKey: 'value',
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.request, null);
    assert.deepEqual(result.errors, [
        'unknown-option',
        'invalid-model',
        'invalid-prompt',
        'invalid-resolution',
        'invalid-references',
    ]);
});

// -----------------------------------------------------------------------------
// Pure Module & Security Tests
// -----------------------------------------------------------------------------

test('production module source contains no network, DOM, or credential access', () => {
    const modulePath = path.resolve('src/providers/nanogpt-qwen-request.js');
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
        'm03-qwen-image-metadata.json',
    ];

    for (const token of forbiddenTokens) {
        assert.strictEqual(
            source.includes(token),
            false,
            `Production source must not contain: ${token}`
        );
    }
});

test('error outputs never leak sensitive reference payloads or prompt content', () => {
    const secretMarker = 'SUPER_SECRET_PAYLOAD_MARKER_98765';
    const secretPrompt = 'TOP_SECRET_PROMPT_CONTENT_12345';

    const result = buildQwenImageRequest({
        model: 'qwen-image',
        prompt: secretPrompt,
        references: [`data:image/png;base64,${secretMarker}`],
    });

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.errors, ['invalid-reference']);

    const serialized = JSON.stringify(result);
    assert.strictEqual(serialized.includes(secretMarker), false);
    assert.strictEqual(serialized.includes(secretPrompt), false);
});

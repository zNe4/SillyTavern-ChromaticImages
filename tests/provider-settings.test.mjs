import assert from 'node:assert/strict';
import test from 'node:test';

import { SETTINGS_KEY } from '../src/constants.js';
import {
    DEFAULT_PROVIDER_SETTINGS,
    readProviderSettings,
    updateProviderResolution,
} from '../src/provider-settings.js';
import {
    QWEN_IMAGE_DEFAULT_RESOLUTION,
    QWEN_IMAGE_RESOLUTIONS,
} from '../src/providers/nanogpt-qwen-request.js';

test('1. readProviderSettings returns default on missing or null root input', () => {
    assert.deepEqual(readProviderSettings(undefined), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings(null), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings('invalid'), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings(123), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings([]), { resolution: 'auto' });
});

test('2. readProviderSettings returns default on missing or malformed namespace', () => {
    assert.deepEqual(readProviderSettings({}), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: null }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: 'string' }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: 42 }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: [] }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: true }), { resolution: 'auto' });
});

test('3. readProviderSettings returns default when resolution is invalid or unknown', () => {
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: { resolution: 'invalid' } }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: { resolution: 1024 } }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: { resolution: null } }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: { resolution: '2048x2048' } }), { resolution: 'auto' });
    assert.deepEqual(readProviderSettings({ [SETTINGS_KEY]: {} }), { resolution: 'auto' });
});

test('4. readProviderSettings accepts every valid resolution in QWEN_IMAGE_RESOLUTIONS', () => {
    for (const res of QWEN_IMAGE_RESOLUTIONS) {
        const snapshot = readProviderSettings({ [SETTINGS_KEY]: { resolution: res } });
        assert.deepEqual(snapshot, { resolution: res });
        assert.ok(Object.isFrozen(snapshot));
    }
});

test('5. readProviderSettings drops unknown fields from snapshot', () => {
    const input = {
        [SETTINGS_KEY]: {
            resolution: '1024x768',
            apiKey: 'sk-should-not-exist',
            prompt: 'secret scene',
            seed: 42,
            negativePrompt: 'blurry',
        },
    };

    const snapshot = readProviderSettings(input);
    assert.deepEqual(snapshot, { resolution: '1024x768' });
    assert.strictEqual(snapshot.apiKey, undefined);
    assert.strictEqual(snapshot.prompt, undefined);
    assert.strictEqual(snapshot.seed, undefined);
    assert.strictEqual(snapshot.negativePrompt, undefined);
});

test('6. readProviderSettings never mutates source settings object (pure read)', () => {
    const input = Object.freeze({
        [SETTINGS_KEY]: Object.freeze({
            resolution: '512x512',
            unwanted: 'foo',
        }),
    });

    const snapshot = readProviderSettings(input);
    assert.deepEqual(snapshot, { resolution: '512x512' });
    assert.strictEqual(input[SETTINGS_KEY].resolution, '512x512');
    assert.strictEqual(input[SETTINGS_KEY].unwanted, 'foo');
});

test('7. updateProviderResolution fails safely on unusable root extensionSettings', () => {
    assert.deepEqual(updateProviderResolution(undefined, '1024x1024'), {
        ok: false,
        changed: false,
        settings: DEFAULT_PROVIDER_SETTINGS,
        error: 'invalid-settings-root',
    });
    assert.deepEqual(updateProviderResolution(null, '1024x1024'), {
        ok: false,
        changed: false,
        settings: DEFAULT_PROVIDER_SETTINGS,
        error: 'invalid-settings-root',
    });
    assert.deepEqual(updateProviderResolution('string', '1024x1024'), {
        ok: false,
        changed: false,
        settings: DEFAULT_PROVIDER_SETTINGS,
        error: 'invalid-settings-root',
    });
    assert.deepEqual(updateProviderResolution([], '1024x1024'), {
        ok: false,
        changed: false,
        settings: DEFAULT_PROVIDER_SETTINGS,
        error: 'invalid-settings-root',
    });
});

test('8. updateProviderResolution fails safely on invalid resolution choices without mutating settings', () => {
    const settings = { [SETTINGS_KEY]: { resolution: 'auto' } };

    const invalidInputs = ['2048x2048', 'invalid', '', null, undefined, 1024, true, {}];
    for (const invalid of invalidInputs) {
        const result = updateProviderResolution(settings, invalid);
        assert.deepEqual(result, {
            ok: false,
            changed: false,
            settings: { resolution: 'auto' },
            error: 'invalid-resolution',
        });
        assert.deepEqual(settings[SETTINGS_KEY], { resolution: 'auto' });
    }
});

test('9. updateProviderResolution performs schema-safe replacement on valid change', () => {
    const settings = {
        [SETTINGS_KEY]: {
            resolution: 'auto',
            apiKey: 'sk-leak',
            prompt: 'roleplay prompt',
            seed: 1234,
            unrelated: 'keep-out',
        },
    };

    const result = updateProviderResolution(settings, '768x1024');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    assert.deepEqual(result.settings, { resolution: '768x1024' });

    // Verifies exact replacement: no spreading of existing namespace keys!
    assert.deepEqual(settings[SETTINGS_KEY], { resolution: '768x1024' });
    assert.strictEqual(settings[SETTINGS_KEY].apiKey, undefined);
    assert.strictEqual(settings[SETTINGS_KEY].prompt, undefined);
    assert.strictEqual(settings[SETTINGS_KEY].seed, undefined);
    assert.strictEqual(settings[SETTINGS_KEY].unrelated, undefined);
});

test('10. updateProviderResolution creates namespace on first install when missing', () => {
    const settings = {};

    const result = updateProviderResolution(settings, '1024x576');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    assert.deepEqual(result.settings, { resolution: '1024x576' });
    assert.deepEqual(settings[SETTINGS_KEY], { resolution: '1024x576' });
});

test('11. updateProviderResolution with already-current resolution returns changed: false without mutation', () => {
    const originalNamespace = { resolution: '512x512' };
    const settings = { [SETTINGS_KEY]: originalNamespace };

    const result = updateProviderResolution(settings, '512x512');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, false);
    assert.deepEqual(result.settings, { resolution: '512x512' });
    // Identity unchanged because no mutation took place
    assert.strictEqual(settings[SETTINGS_KEY], originalNamespace);
});

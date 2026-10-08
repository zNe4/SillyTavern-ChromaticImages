/**
 * @file Provider settings schema, validation, snapshot reading, and controlled mutation.
 *
 * Enforces strict schema hygiene for Chromatic Images provider settings.
 * In M03-F, the only authorized persisted field is 'resolution' under
 * SillyTavern's extensionSettings.chromatic_images namespace.
 *
 * Guarantees:
 * - Read-only snapshot normalization never mutates in-memory settings or calls save functions.
 * - Malformed settings safely fall back to 'auto' in memory.
 * - Controlled mutation validates inputs and replaces the namespace with an exact, clean
 *   object, dropping all legacy or extraneous keys (e.g. apiKey, prompt, seed, negativePrompt).
 * - Selecting an already-current resolution does not trigger changes or saves.
 */

import { SETTINGS_KEY } from './constants.js';
import {
    QWEN_IMAGE_DEFAULT_RESOLUTION,
    QWEN_IMAGE_RESOLUTIONS,
} from './providers/nanogpt-qwen-request.js';

/**
 * Default provider settings for Chromatic Images.
 * @type {Readonly<{ resolution: 'auto' }>}
 */
export const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
    resolution: QWEN_IMAGE_DEFAULT_RESOLUTION,
});

/**
 * Checks whether a value is a plain JavaScript object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Reads and returns a sanitized, immutable provider settings snapshot.
 *
 * Pure read operation: never mutates extensionSettings, never writes to storage,
 * and never triggers debounced saves. Missing, invalid, or malformed values safely
 * fall back to defaults in memory.
 *
 * @param {unknown} extensionSettings SillyTavern extensionSettings root object.
 * @returns {Readonly<{ resolution: string }>} Sanitized settings snapshot.
 */
export function readProviderSettings(extensionSettings) {
    if (!isPlainObject(extensionSettings)) {
        return DEFAULT_PROVIDER_SETTINGS;
    }

    const namespace = extensionSettings[SETTINGS_KEY];
    if (!isPlainObject(namespace)) {
        return DEFAULT_PROVIDER_SETTINGS;
    }

    const rawResolution = namespace.resolution;
    if (
        typeof rawResolution === 'string' &&
        QWEN_IMAGE_RESOLUTIONS.includes(rawResolution)
    ) {
        return Object.freeze({ resolution: rawResolution });
    }

    return DEFAULT_PROVIDER_SETTINGS;
}

/**
 * Controlled state mutator for provider resolution.
 *
 * Validates the selection and root settings object before replacing
 * extensionSettings.chromatic_images with a freshly sanitized object
 * containing only the authorized 'resolution' key.
 *
 * @param {unknown} extensionSettings SillyTavern extensionSettings root object.
 * @param {unknown} newResolution The resolution to set.
 * @returns {{
 *   ok: boolean,
 *   changed: boolean,
 *   settings: Readonly<{ resolution: string }>,
 *   error?: string,
 * }}
 */
export function updateProviderResolution(extensionSettings, newResolution) {
    if (!isPlainObject(extensionSettings)) {
        return {
            ok: false,
            changed: false,
            settings: DEFAULT_PROVIDER_SETTINGS,
            error: 'invalid-settings-root',
        };
    }

    if (
        typeof newResolution !== 'string' ||
        !QWEN_IMAGE_RESOLUTIONS.includes(newResolution)
    ) {
        return {
            ok: false,
            changed: false,
            settings: readProviderSettings(extensionSettings),
            error: 'invalid-resolution',
        };
    }

    const currentSnapshot = readProviderSettings(extensionSettings);
    if (currentSnapshot.resolution === newResolution) {
        return {
            ok: true,
            changed: false,
            settings: currentSnapshot,
        };
    }

    // Controlled mutation: replace namespace with exactly { resolution } (no spreading)
    extensionSettings[SETTINGS_KEY] = {
        resolution: newResolution,
    };

    return {
        ok: true,
        changed: true,
        settings: Object.freeze({ resolution: newResolution }),
    };
}

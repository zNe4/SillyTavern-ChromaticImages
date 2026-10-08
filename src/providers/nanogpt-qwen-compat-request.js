/**
 * @file Pure request validator and builder for NanoGPT qwen-image compatibility requests.
 *
 * Enforces strict validation, parameter normalization, and provider payload construction
 * for the Qwen image model on NanoGPT's subscription-compatible Image API (POST /api/v1/images/generations).
 *
 * This module is completely deterministic and pure: no network transport, no secrets,
 * no DOM access, and no runtime metadata reading.
 */

/**
 * Exact NanoGPT model ID for Qwen Image MVP.
 * @type {'qwen-image'}
 */
export const QWEN_IMAGE_MODEL_ID = 'qwen-image';

/**
 * Maximum reference images supported by project contract and provider route.
 * @type {3}
 */
export const QWEN_IMAGE_MAX_REFERENCES = 3;

/**
 * Maximum prompt length in UTF-16 code units supported by the provider route.
 * @type {3000}
 */
export const QWEN_IMAGE_MAX_PROMPT_CODE_UNITS = 3000;

/**
 * Chromatic Images project-selected default resolution.
 * @type {'auto'}
 */
export const QWEN_IMAGE_DEFAULT_RESOLUTION = 'auto';

/**
 * Supported resolutions per captured provider metadata and direct endpoint specification.
 * @type {readonly string[]}
 */
export const QWEN_IMAGE_RESOLUTIONS = Object.freeze([
    'auto',
    '1024x1024',
    '512x512',
    '768x1024',
    '576x1024',
    '1024x768',
    '1024x576',
]);

/**
 * Allowed reference image MIME types per captured provider metadata.
 * @type {readonly string[]}
 */
export const QWEN_IMAGE_REFERENCE_MIME_TYPES = Object.freeze([
    'image/png',
    'image/jpeg',
    'image/webp',
]);

const ALLOWED_OPTION_KEYS = new Set([
    'model',
    'prompt',
    'references',
    'resolution',
    'response_format',
]);

/**
 * Builds and validates a NanoGPT qwen-image compatibility request object.
 *
 * @param {unknown} options Input options object.
 * @returns {{
 *   ok: true,
 *   request: {
 *     model: 'qwen-image',
 *     prompt: string,
 *     nImages: 1,
 *     resolution: string,
 *     response_format: 'b64_json',
 *     imageDataUrl?: string,
 *     imageDataUrls?: string[],
 *   },
 *   errors: [],
 * } | {
 *   ok: false,
 *   request: null,
 *   errors: string[],
 * }}
 */
export function buildQwenImageCompatibilityRequest(options) {
    if (!isPlainObject(options)) {
        return {
            ok: false,
            request: null,
            errors: ['invalid-options'],
        };
    }

    const errors = [];

    // Reject unknown options
    for (const key of Object.keys(options)) {
        if (!ALLOWED_OPTION_KEYS.has(key)) {
            recordError(errors, 'unknown-option');
            break;
        }
    }

    // Validate model
    if (options.model !== QWEN_IMAGE_MODEL_ID) {
        recordError(errors, 'invalid-model');
    }

    // Validate prompt
    let normalizedPrompt = '';
    if (typeof options.prompt !== 'string') {
        recordError(errors, 'invalid-prompt');
    } else {
        const trimmed = options.prompt.trim();
        if (trimmed.length === 0) {
            recordError(errors, 'invalid-prompt');
        } else if (trimmed.length > QWEN_IMAGE_MAX_PROMPT_CODE_UNITS) {
            recordError(errors, 'prompt-too-long');
        } else {
            normalizedPrompt = trimmed;
        }
    }

    // Validate resolution
    let validatedResolution = QWEN_IMAGE_DEFAULT_RESOLUTION;
    if ('resolution' in options && options.resolution !== undefined) {
        if (
            typeof options.resolution !== 'string' ||
            !QWEN_IMAGE_RESOLUTIONS.includes(options.resolution)
        ) {
            recordError(errors, 'invalid-resolution');
        } else {
            validatedResolution = options.resolution;
        }
    }

    // Validate response_format (if provided, must be 'b64_json')
    if ('response_format' in options && options.response_format !== undefined) {
        if (options.response_format !== 'b64_json') {
            recordError(errors, 'invalid-response-format');
        }
    }

    // Validate references
    let validatedReferences = [];
    if ('references' in options && options.references !== undefined) {
        if (!Array.isArray(options.references)) {
            recordError(errors, 'invalid-references');
        } else {
            if (options.references.length > QWEN_IMAGE_MAX_REFERENCES) {
                recordError(errors, 'too-many-references');
            }
            let hasInvalidRef = false;
            for (const ref of options.references) {
                if (!isValidReferenceDataUrl(ref)) {
                    hasInvalidRef = true;
                    break;
                }
            }
            if (hasInvalidRef) {
                recordError(errors, 'invalid-reference');
            } else {
                validatedReferences = [...options.references];
            }
        }
    }

    if (errors.length > 0) {
        return {
            ok: false,
            request: null,
            errors,
        };
    }

    /** @type {Record<string, any>} */
    const request = {
        model: QWEN_IMAGE_MODEL_ID,
        prompt: normalizedPrompt,
        nImages: 1,
        resolution: validatedResolution,
        response_format: 'b64_json',
    };

    if (validatedReferences.length === 1) {
        request.imageDataUrl = validatedReferences[0];
    } else if (validatedReferences.length >= 2) {
        request.imageDataUrls = [...validatedReferences];
    }

    return {
        ok: true,
        request,
        errors: [],
    };
}

/**
 * Checks whether a value is a plain object.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        return false;
    }

    const proto = Object.getPrototypeOf(value);

    return (
        proto === Object.prototype ||
        proto === null
    );
}

/**
 * Validates a reference image string as a full data URL.
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
function isValidReferenceDataUrl(ref) {
    if (typeof ref !== 'string') {
        return false;
    }
    if (!ref.startsWith('data:')) {
        return false;
    }
    const semicolonIndex = ref.indexOf(';');
    if (semicolonIndex === -1) {
        return false;
    }
    const mime = ref.slice(5, semicolonIndex);
    if (!QWEN_IMAGE_REFERENCE_MIME_TYPES.includes(mime)) {
        return false;
    }
    const prefix = ref.slice(semicolonIndex, semicolonIndex + 8);
    if (prefix !== ';base64,') {
        return false;
    }
    const payload = ref.slice(semicolonIndex + 8);
    if (payload.length === 0 || payload.length % 4 !== 0) {
        return false;
    }
    if (/[^A-Za-z0-9+/=]/.test(payload)) {
        return false;
    }
    const equalIndex = payload.indexOf('=');
    if (equalIndex !== -1) {
        if (equalIndex < payload.length - 2) {
            return false;
        }
        if (equalIndex === payload.length - 2 && payload[payload.length - 1] !== '=') {
            return false;
        }
    }
    return true;
}

/**
 * Records a deterministic, deduplicated error code.
 *
 * @param {string[]} errors
 * @param {string} code
 */
function recordError(errors, code) {
    if (!errors.includes(code)) {
        errors.push(code);
    }
}

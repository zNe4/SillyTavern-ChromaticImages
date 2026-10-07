/**
 * @file Pure response validator and normalizer for NanoGPT image generation responses.
 *
 * Enforces strict validation and deterministic normalization of provider image responses.
 *
 * Supported source contracts:
 * - 'openai-compatible': Authoritative OpenAI-compatible format returning data[i].b64_json
 *   or short-lived signed data[i].url.
 * - 'normalized': Reserved for NanoGPT's normalized Image API (POST /api/v1/images).
 *   Because the normalized route's success response envelope remains unverified in
 *   official vendor references, normalized responses currently fail closed with
 *   'unverified-normalized-response-contract'. A future explicitly authorized diagnostic
 *   must safely inspect the response structure before implementing the normalized adapter.
 *
 * Security and privacy boundaries:
 * - Deterministic and pure: no network transport, no fetch, no credentials, no DOM access,
 *   no image decoding, no storage I/O, and no chat mutation.
 * - URL validation is purely syntactic and conservative (HTTPS only, no credentials,
 *   rejects obvious localhost and private/loopback IP targets). This does not eliminate
 *   DNS-rebinding or SSRF risks; retrieval security belongs to the later network layer.
 * - Remote URLs are marked as untrusted temporary representations, never durable chat paths.
 *   Never persist or log provider credentials, RP prompts, or reference-image base64.
 * - Error outputs return only deterministic machine-readable codes; raw response bodies,
 *   image base64, RP prompts, API keys, and signed URL tokens are never persisted or returned.
 */

/**
 * Identifier for the OpenAI-compatible response contract.
 * @type {'openai-compatible'}
 */
export const RESPONSE_SOURCE_OPENAI_COMPATIBLE = 'openai-compatible';

/**
 * Identifier for the normalized response contract.
 * @type {'normalized'}
 */
export const RESPONSE_SOURCE_NORMALIZED = 'normalized';

/**
 * Supported response source contracts.
 * @type {readonly string[]}
 */
export const SUPPORTED_RESPONSE_SOURCES = Object.freeze([
    RESPONSE_SOURCE_OPENAI_COMPATIBLE,
    RESPONSE_SOURCE_NORMALIZED,
]);

const ALLOWED_OPTION_KEYS = new Set(['source']);

const BASE64_PAYLOAD_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;

/**
 * Normalizes and strictly validates a NanoGPT image generation response.
 *
 * @param {unknown} response Raw provider response object.
 * @param {unknown} options Configuration options containing the source contract identifier.
 * @returns {{
 *   ok: true,
 *   image: {
 *     kind: 'base64',
 *     data: string,
 *   } | {
 *     kind: 'remote-url',
 *     url: string,
 *   },
 *   errors: [],
 * } | {
 *   ok: false,
 *   image: null,
 *   errors: string[],
 * }}
 */
export function normalizeNanoGptImageResponse(response, options) {
    if (!isPlainObject(options)) {
        return {
            ok: false,
            image: null,
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

    // Validate source contract
    if (
        typeof options.source !== 'string' ||
        !SUPPORTED_RESPONSE_SOURCES.includes(options.source)
    ) {
        recordError(errors, 'unsupported-response-source');
    }

    // Fail closed on unverified normalized response contract
    if (options.source === RESPONSE_SOURCE_NORMALIZED) {
        recordError(errors, 'unverified-normalized-response-contract');
    }

    if (errors.length > 0) {
        return {
            ok: false,
            image: null,
            errors,
        };
    }

    // Parse according to OpenAI-compatible response contract
    if (!isPlainObject(response)) {
        return {
            ok: false,
            image: null,
            errors: ['invalid-response-envelope'],
        };
    }

    // Reject provider error envelopes masquerading as responses
    if (isProviderErrorEnvelope(response)) {
        return {
            ok: false,
            image: null,
            errors: ['provider-error-response'],
        };
    }

    // Validate data array
    if (!('data' in response) || !Array.isArray(response.data)) {
        return {
            ok: false,
            image: null,
            errors: ['missing-response-data'],
        };
    }

    if (response.data.length === 0) {
        return {
            ok: false,
            image: null,
            errors: ['empty-response-data'],
        };
    }

    if (response.data.length > 1) {
        return {
            ok: false,
            image: null,
            errors: ['multiple-response-images'],
        };
    }

    const entry = response.data[0];
    if (!isPlainObject(entry)) {
        return {
            ok: false,
            image: null,
            errors: ['invalid-image-entry'],
        };
    }

    const hasB64 = 'b64_json' in entry && entry.b64_json !== undefined && entry.b64_json !== null;
    const hasUrl = 'url' in entry && entry.url !== undefined && entry.url !== null;

    if (hasB64 && hasUrl) {
        return {
            ok: false,
            image: null,
            errors: ['conflicting-image-fields'],
        };
    }

    if (!hasB64 && !hasUrl) {
        return {
            ok: false,
            image: null,
            errors: ['missing-image-fields'],
        };
    }

    if (hasB64) {
        if (!isValidBase64(entry.b64_json)) {
            return {
                ok: false,
                image: null,
                errors: ['invalid-image-base64'],
            };
        }

        return {
            ok: true,
            image: {
                kind: 'base64',
                data: entry.b64_json,
            },
            errors: [],
        };
    }

    // Validate remote URL
    if (typeof entry.url !== 'string' || entry.url.trim().length === 0) {
        return {
            ok: false,
            image: null,
            errors: ['invalid-image-url'],
        };
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(entry.url);
    } catch {
        return {
            ok: false,
            image: null,
            errors: ['invalid-image-url'],
        };
    }

    if (parsedUrl.protocol !== 'https:') {
        return {
            ok: false,
            image: null,
            errors: ['unsafe-image-url-protocol'],
        };
    }

    if (parsedUrl.username !== '' || parsedUrl.password !== '') {
        return {
            ok: false,
            image: null,
            errors: ['unsafe-image-url-credentials'],
        };
    }

    if (isLocalOrPrivateHost(parsedUrl.hostname)) {
        return {
            ok: false,
            image: null,
            errors: ['unsafe-image-url-target'],
        };
    }

    return {
        ok: true,
        image: {
            kind: 'remote-url',
            url: entry.url,
        },
        errors: [],
    };
}

/**
 * Checks whether a value is a plain JavaScript object.
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
 * Checks if a response object represents a known provider error envelope.
 *
 * Does not classify ordinary top-level response metadata (e.g. created, cost,
 * paymentSource, remainingBalance) as errors.
 *
 * @param {Record<string, unknown>} response
 * @returns {boolean}
 */
function isProviderErrorEnvelope(response) {
    if (
        response.error !== undefined &&
        response.error !== null
    ) {
        return true;
    }

    if (
        response.object === 'error' ||
        response.status === 'error' ||
        response.type === 'error'
    ) {
        return true;
    }

    return false;
}

/**
 * Validates base64 string syntax and padding.
 *
 * @param {unknown} data
 * @returns {boolean}
 */
function isValidBase64(data) {
    if (typeof data !== 'string' || data.length === 0) {
        return false;
    }

    if (data.startsWith('data:')) {
        return false;
    }

    return BASE64_PAYLOAD_PATTERN.test(data);
}

/**
 * Checks whether a hostname represents an obvious localhost, loopback,
 * private RFC1918, link-local, or local-network address.
 *
 * @param {string} rawHostname
 * @returns {boolean}
 */
function isLocalOrPrivateHost(rawHostname) {
    if (typeof rawHostname !== 'string') {
        return true;
    }

    let host = rawHostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
    }

    // Local hostnames and domains
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === 'local' ||
        host.endsWith('.local') ||
        host === 'internal' ||
        host.endsWith('.internal') ||
        host === 'lan' ||
        host.endsWith('.lan')
    ) {
        return true;
    }

    // IPv4 address check
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const a = Number(ipv4Match[1]);
        const b = Number(ipv4Match[2]);
        const c = Number(ipv4Match[3]);
        const d = Number(ipv4Match[4]);

        if (a > 255 || b > 255 || c > 255 || d > 255) {
            return true;
        }

        // 0.0.0.0/8 (Current network)
        if (a === 0) return true;
        // 10.0.0.0/8 (Private RFC1918)
        if (a === 10) return true;
        // 100.64.0.0/10 (Shared address / CGNAT)
        if (a === 100 && b >= 64 && b <= 127) return true;
        // 127.0.0.0/8 (Loopback)
        if (a === 127) return true;
        // 169.254.0.0/16 (Link-local)
        if (a === 169 && b === 254) return true;
        // 172.16.0.0/12 (Private RFC1918)
        if (a === 172 && b >= 16 && b <= 31) return true;
        // 192.0.0.0/24 (IETF Protocol Assignments)
        if (a === 192 && b === 0 && c === 0) return true;
        // 192.0.2.0/24 (TEST-NET-1)
        if (a === 192 && b === 0 && c === 2) return true;
        // 192.168.0.0/16 (Private RFC1918)
        if (a === 192 && b === 168) return true;
        // 198.18.0.0/15 (Network benchmark)
        if (a === 198 && b >= 18 && b <= 19) return true;
        // 198.51.100.0/24 (TEST-NET-2)
        if (a === 198 && b === 51 && c === 100) return true;
        // 203.0.113.0/24 (TEST-NET-3)
        if (a === 203 && b === 0 && c === 113) return true;
        // 224.0.0.0/4 (Multicast)
        if (a >= 224 && a <= 239) return true;
        // 240.0.0.0/4 (Reserved) & 255.255.255.255 (Broadcast)
        if (a >= 240) return true;

        return false;
    }

    // IPv6 address check
    if (host.includes(':')) {
        // Loopback ::1 or 0:0:0:0:0:0:0:1
        if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
        // Unspecified :: or 0:0:0:0:0:0:0:0
        if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;
        // Unique Local Address (fc00::/7)
        if (/^f[cd][0-9a-f]{0,2}:/i.test(host)) return true;
        // Link-Local (fe80::/10)
        if (/^fe[89ab][0-9a-f]{0,2}:/i.test(host)) return true;
        // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:X:Y in hex)
        if (host.startsWith('::ffff:')) {
            const remainder = host.slice(7);
            if (remainder.includes('.')) {
                return isLocalOrPrivateHost(remainder);
            }
            const parts = remainder.split(':');
            if (parts.length === 2) {
                const high = parseInt(parts[0], 16);
                const low = parseInt(parts[1], 16);
                if (!Number.isNaN(high) && !Number.isNaN(low)) {
                    const a = (high >> 8) & 0xff;
                    const b = high & 0xff;
                    const c = (low >> 8) & 0xff;
                    const d = low & 0xff;
                    return isLocalOrPrivateHost(`${a}.${b}.${c}.${d}`);
                }
            }
            return true;
        }
        return false;
    }

    return false;
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

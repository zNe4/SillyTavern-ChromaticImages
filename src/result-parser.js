/**
 * @file Pure CI_RESULT and durable image-state parser for Chromatic Images.
 *
 * Reconstructs reviewable and finalized image states directly from assistant message source.
 * Pure protocol parsing only: no DOM, host context, or side databases.
 */

const MAX_PATH_CODE_UNITS = 4096;
const MAX_PROMPT_CODE_UNITS = 8000;
const MAX_CHARACTER_NAME_CODE_UNITS = 200;
const MAX_CHARACTERS_COUNT = 32;

/**
 * Parses an assistant message string for durable generated-image states:
 * - Reviewable: ![ChromaticImages](path) + <!-- CI_RESULT {...} -->
 * - Finalized:  ![ChromaticImages](path)
 *
 * @param {unknown} message
 * @returns {{
 *   ok: boolean,
 *   reviewable: Array<{
 *     v: number,
 *     characters: string[],
 *     prompt: string,
 *     path: string,
 *     markdown: { raw: string, start: number, end: number },
 *     result: { raw: string, start: number, end: number },
 *     blockStart: number,
 *     blockEnd: number,
 *   }>,
 *   finalized: Array<{
 *     path: string,
 *     raw: string,
 *     start: number,
 *     end: number,
 *   }>,
 *   errors: string[],
 * }}
 */
export function parseImageResultStates(message) {
    if (typeof message !== 'string') {
        return {
            ok: false,
            reviewable: [],
            finalized: [],
            errors: ['invalid-message'],
        };
    }

    const errors = [];

    // Step 1: Scan for ChromaticImages Markdown records and malformed attempts
    const markdownRecords = scanMarkdownRecords(message, errors);

    // Step 2: Scan for CI_RESULT HTML comment control records
    const resultRecords = scanResultRecords(message, errors);

    // If any syntax, structure, or semantic validation failed, fail closed
    if (errors.length > 0) {
        return {
            ok: false,
            reviewable: [],
            finalized: [],
            errors,
        };
    }

    // Step 3: Pair CI_RESULT records with preceding unpaired Markdown records
    const reviewable = [];
    const pairedMarkdownIndices = new Set();

    for (const result of resultRecords) {
        // Find nearest preceding unpaired Markdown record
        let candIndex = -1;
        for (let i = markdownRecords.length - 1; i >= 0; i--) {
            if (markdownRecords[i].end <= result.start && !pairedMarkdownIndices.has(i)) {
                candIndex = i;
                break;
            }
        }

        if (candIndex === -1) {
            recordError(errors, 'unpaired-result-record');
            continue;
        }

        const cand = markdownRecords[candIndex];
        const between = message.slice(cand.end, result.start);

        // Must contain only whitespace between markdown.end and result.start
        if (!/^\s*$/.test(between)) {
            recordError(errors, 'unpaired-result-record');
            continue;
        }

        // Paths must match exactly
        if (cand.path !== result.payload.path) {
            recordError(errors, 'result-path-mismatch');
            continue;
        }

        pairedMarkdownIndices.add(candIndex);
        reviewable.push({
            v: result.payload.v,
            characters: result.payload.characters,
            prompt: result.payload.prompt,
            path: result.payload.path,
            markdown: {
                raw: cand.raw,
                start: cand.start,
                end: cand.end,
            },
            result: {
                raw: result.raw,
                start: result.start,
                end: result.end,
            },
            blockStart: cand.start,
            blockEnd: result.end,
        });
    }

    if (errors.length > 0) {
        return {
            ok: false,
            reviewable: [],
            finalized: [],
            errors,
        };
    }

    // Step 4: Any unpaired Markdown records are finalized
    const finalized = [];
    for (let i = 0; i < markdownRecords.length; i++) {
        if (!pairedMarkdownIndices.has(i)) {
            const md = markdownRecords[i];
            finalized.push({
                path: md.path,
                raw: md.raw,
                start: md.start,
                end: md.end,
            });
        }
    }

    return {
        ok: true,
        reviewable,
        finalized,
        errors: [],
    };
}

/**
 * Validates whether a path qualifies as a local root-relative path.
 *
 * Rules:
 * - non-empty string;
 * - begins with `/`;
 * - no protocol/external URL (no `//`, `http:`, `https:`, `data:`, `blob:`, etc.);
 * - no CR/LF;
 * - no literal `)`;
 * - no Markdown title or quotes (`"`, `'`);
 * - trimmed (no outer padding whitespace);
 * - at most 4096 code units.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
function isValidLocalPath(path) {
    if (typeof path !== 'string') {
        return false;
    }
    if (path.length === 0 || path.length > MAX_PATH_CODE_UNITS) {
        return false;
    }
    if (path !== path.trim()) {
        return false;
    }
    if (!path.startsWith('/') || path.startsWith('//')) {
        return false;
    }
    if (path.includes('\r') || path.includes('\n') || path.includes(')')) {
        return false;
    }
    if (path.includes('"') || path.includes("'")) {
        return false;
    }
    if (path.includes('://')) {
        return false;
    }
    return true;
}

/**
 * Scans physical lines for standalone ChromaticImages Markdown records.
 *
 * @param {string} message
 * @param {string[]} errors
 * @returns {Array<{ raw: string, path: string, start: number, end: number }>}
 */
function scanMarkdownRecords(message, errors) {
    const records = [];
    let lineStart = 0;

    while (lineStart <= message.length) {
        let nextNl = message.indexOf('\n', lineStart);
        let nextCr = message.indexOf('\r', lineStart);
        let lineEnd;
        let nextLineStart;

        if (nextNl === -1 && nextCr === -1) {
            lineEnd = message.length;
            nextLineStart = message.length + 1; // Terminate loop
        } else if (nextNl !== -1 && (nextCr === -1 || nextNl < nextCr)) {
            lineEnd = nextNl;
            nextLineStart = nextNl + 1;
        } else if (nextCr !== -1 && (nextNl === -1 || nextCr < nextNl)) {
            lineEnd = nextCr;
            if (nextCr + 1 < message.length && message[nextCr + 1] === '\n') {
                nextLineStart = nextCr + 2;
            } else {
                nextLineStart = nextCr + 1;
            }
        }

        const line = message.slice(lineStart, lineEnd);

        // Check if this line starts as an extension-owned Markdown record
        // Standalone check: optional leading horizontal whitespace [ \t]*
        const leadingWsMatch = line.match(/^[ \t]*/);
        const leadingWsLength = leadingWsMatch ? leadingWsMatch[0].length : 0;
        const lineAfterWs = line.slice(leadingWsLength);

        if (lineAfterWs.startsWith('![ChromaticImages]')) {
            // Check for valid single-line record format: ![ChromaticImages](dest) [ \t]*
            const validMatch = lineAfterWs.match(/^(!\[ChromaticImages\]\(([^)\r\n]*)\))[ \t]*$/);

            if (validMatch) {
                const rawRecord = validMatch[1];
                const dest = validMatch[2];

                if (isValidLocalPath(dest)) {
                    const start = lineStart + leadingWsLength;
                    const end = start + rawRecord.length;
                    records.push({
                        raw: rawRecord,
                        path: dest,
                        start,
                        end,
                    });
                } else {
                    recordError(errors, 'malformed-image-record');
                }
            } else {
                recordError(errors, 'malformed-image-record');
            }
        }

        if (nextLineStart > message.length) {
            break;
        }
        lineStart = nextLineStart;
    }

    return records;
}

/**
 * Scans message for standalone CI_RESULT HTML comment records.
 *
 * @param {string} message
 * @param {string[]} errors
 * @returns {Array<{
 *   raw: string,
 *   start: number,
 *   end: number,
 *   payload: { v: number, characters: string[], prompt: string, path: string }
 * }>}
 */
function scanResultRecords(message, errors) {
    const records = [];
    let searchIndex = 0;

    while (searchIndex < message.length) {
        const commentStart = message.indexOf('<!--', searchIndex);
        if (commentStart === -1) {
            break;
        }

        const afterStart = message.slice(commentStart + 4);

        // Must begin with optional whitespace followed by CI_RESULT word boundary
        if (!/^[ \t\r\n]*CI_RESULT\b/.test(afterStart)) {
            const nextClose = message.indexOf('-->', commentStart + 4);
            searchIndex = nextClose === -1 ? message.length : nextClose + 3;
            continue;
        }

        const closeIndex = message.indexOf('-->', commentStart + 4);

        // 1. Unclosed attempted record
        if (closeIndex === -1) {
            recordError(errors, 'malformed-result-record');
            break;
        }

        const start = commentStart;
        const end = closeIndex + 3;
        const raw = message.slice(start, end);

        // 2. Multiline attempted record
        if (raw.includes('\n') || raw.includes('\r')) {
            recordError(errors, 'malformed-result-record');
            searchIndex = end;
            continue;
        }

        // 3. Standalone positioning check on physical line
        let lineStart = 0;
        const prevNl = message.lastIndexOf('\n', start - 1);
        const prevCr = message.lastIndexOf('\r', start - 1);
        if (prevNl !== -1 || prevCr !== -1) {
            lineStart = Math.max(prevNl, prevCr) + 1;
        }

        let lineEnd = message.length;
        const nextNl = message.indexOf('\n', end);
        const nextCr = message.indexOf('\r', end);
        if (nextNl !== -1 && nextCr !== -1) {
            lineEnd = Math.min(nextNl, nextCr);
        } else if (nextNl !== -1) {
            lineEnd = nextNl;
        } else if (nextCr !== -1) {
            lineEnd = nextCr;
        }

        const prefix = message.slice(lineStart, start);
        const suffix = message.slice(end, lineEnd);

        if (!/^[ \t]*$/.test(prefix) || !/^[ \t]*$/.test(suffix)) {
            recordError(errors, 'misplaced-result-record');
            searchIndex = end;
            continue;
        }

        // 4. Payload extraction and structure check
        const inner = raw.slice(4, -3);
        const payloadMatch = inner.match(/^[ \t]*CI_RESULT([ \t]+([\s\S]*?))?[ \t]*$/);

        if (!payloadMatch || !payloadMatch[1] || payloadMatch[2].trim().length === 0) {
            recordError(errors, 'malformed-result-record');
            searchIndex = end;
            continue;
        }

        const jsonString = payloadMatch[2].trim();

        // 5. JSON parse check
        let payload;
        try {
            payload = JSON.parse(jsonString);
        } catch {
            recordError(errors, 'invalid-result-json');
            searchIndex = end;
            continue;
        }

        // 6. Semantic validation of payload
        if (!isPlainObject(payload)) {
            recordError(errors, 'invalid-result-shape');
            searchIndex = end;
            continue;
        }

        const keys = Object.keys(payload);
        if (
            keys.length !== 4 ||
            !keys.includes('v') ||
            !keys.includes('characters') ||
            !keys.includes('prompt') ||
            !keys.includes('path')
        ) {
            recordError(errors, 'invalid-result-shape');
            searchIndex = end;
            continue;
        }

        // Version check
        if (typeof payload.v !== 'number') {
            recordError(errors, 'invalid-result-shape');
            searchIndex = end;
            continue;
        }
        if (payload.v !== 1 || !Number.isInteger(payload.v)) {
            recordError(errors, 'unsupported-result-version');
            searchIndex = end;
            continue;
        }

        let hasPayloadError = false;

        // Characters validation
        const normalizedCharacters = [];
        if (!Array.isArray(payload.characters)) {
            recordError(errors, 'invalid-result-characters');
            hasPayloadError = true;
        } else if (payload.characters.length > MAX_CHARACTERS_COUNT) {
            recordError(errors, 'too-many-result-characters');
            hasPayloadError = true;
        } else {
            const seenLower = new Set();
            for (const char of payload.characters) {
                if (typeof char !== 'string') {
                    recordError(errors, 'invalid-result-character');
                    hasPayloadError = true;
                    break;
                }
                const trimmed = char.trim();
                if (trimmed.length === 0 || trimmed.length > MAX_CHARACTER_NAME_CODE_UNITS) {
                    recordError(errors, 'invalid-result-character');
                    hasPayloadError = true;
                    break;
                }
                const lower = trimmed.toLowerCase();
                if (seenLower.has(lower)) {
                    recordError(errors, 'duplicate-result-character');
                    hasPayloadError = true;
                    break;
                }
                seenLower.add(lower);
                normalizedCharacters.push(trimmed);
            }
        }

        // Prompt validation
        let trimmedPrompt = '';
        if (typeof payload.prompt !== 'string') {
            recordError(errors, 'invalid-result-prompt');
            hasPayloadError = true;
        } else {
            trimmedPrompt = payload.prompt.trim();
            if (trimmedPrompt.length === 0) {
                recordError(errors, 'invalid-result-prompt');
                hasPayloadError = true;
            } else if (trimmedPrompt.length > MAX_PROMPT_CODE_UNITS) {
                recordError(errors, 'result-prompt-too-long');
                hasPayloadError = true;
            }
        }

        // Path validation
        let validatedPath = '';
        if (typeof payload.path !== 'string' || !isValidLocalPath(payload.path)) {
            recordError(errors, 'invalid-result-path');
            hasPayloadError = true;
        } else {
            validatedPath = payload.path;
        }

        if (!hasPayloadError) {
            records.push({
                raw,
                start,
                end,
                payload: {
                    v: payload.v,
                    characters: normalizedCharacters,
                    prompt: trimmedPrompt,
                    path: validatedPath,
                },
            });
        }

        searchIndex = end;
    }

    return records;
}

/**
 * Checks if a value is a plain object with null or Object.prototype prototype.
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
 * Deterministically records an error code once.
 *
 * @param {string[]} errors
 * @param {string} code
 */
function recordError(errors, code) {
    if (!errors.includes(code)) {
        errors.push(code);
    }
}

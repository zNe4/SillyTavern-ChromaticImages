/**
 * @file Semantic validator and MVP selection policy for Chromatic Images.
 *
 * Validates and normalizes parsed CI_IMAGE proposal records without host
 * environment, character identity resolution, or generation state dependencies.
 */

/**
 * Validates and normalizes an array of parsed proposal records.
 *
 * Semantic schema rules:
 * - `records` must be an array.
 * - Each record must be a valid parsed structure with `raw`, `start`, `end`, and `payload`.
 * - `payload` must be a plain non-null, non-array object with exactly `characters` and `prompt`.
 * - `characters` must be an array of at most 32 strings.
 * - Each character entry must be a string, trimmed of outer whitespace, non-empty, and <= 200 code units.
 * - Duplicate character entries (case-insensitive after outer trimming) are rejected.
 * - Original capitalization/case of characters and internal whitespace are preserved.
 * - `prompt` must be a string, non-empty after trimming outer whitespace, and <= 8000 code units.
 * - Internal whitespace of `prompt` is preserved without rewriting.
 * - Fails closed: if any record is invalid, returns `{ ok: false, proposals: [], errors: [...] }`.
 *
 * @param {unknown} records
 * @returns {{
 *   ok: boolean,
 *   proposals: Array<{
 *     characters: string[],
 *     prompt: string,
 *     raw: string,
 *     start: number,
 *     end: number,
 *   }>,
 *   errors: string[],
 * }}
 */
export function validateImageProposalRecords(records) {
    if (!Array.isArray(records)) {
        return {
            ok: false,
            proposals: [],
            errors: ['invalid-records'],
        };
    }

    const proposals = [];
    const errors = [];

    for (const record of records) {
        if (
            !record ||
            typeof record !== 'object' ||
            typeof record.start !== 'number' ||
            typeof record.end !== 'number' ||
            typeof record.raw !== 'string' ||
            !('payload' in record)
        ) {
            recordError(errors, 'invalid-records');
            continue;
        }

        const payload = record.payload;

        if (!isPlainObject(payload)) {
            recordError(errors, 'invalid-proposal-shape');
            continue;
        }

        const keys = Object.keys(payload);
        if (
            keys.length !== 2 ||
            !keys.includes('characters') ||
            !keys.includes('prompt')
        ) {
            recordError(errors, 'invalid-proposal-shape');
            continue;
        }

        let hasRecordError = false;

        // Validate characters
        let normalizedCharacters = [];
        if (!Array.isArray(payload.characters)) {
            recordError(errors, 'invalid-characters');
            hasRecordError = true;
        } else if (payload.characters.length > 32) {
            recordError(errors, 'too-many-characters');
            hasRecordError = true;
        } else {
            const seenLower = new Set();
            for (const char of payload.characters) {
                if (typeof char !== 'string') {
                    recordError(errors, 'invalid-character');
                    hasRecordError = true;
                    break;
                }
                const trimmed = char.trim();
                if (trimmed.length === 0 || trimmed.length > 200) {
                    recordError(errors, 'invalid-character');
                    hasRecordError = true;
                    break;
                }
                const lower = trimmed.toLowerCase();
                if (seenLower.has(lower)) {
                    recordError(errors, 'duplicate-character');
                    hasRecordError = true;
                    break;
                }
                seenLower.add(lower);
                normalizedCharacters.push(trimmed);
            }
        }

        // Validate prompt
        let trimmedPrompt = '';
        if (typeof payload.prompt !== 'string') {
            recordError(errors, 'invalid-prompt');
            hasRecordError = true;
        } else {
            trimmedPrompt = payload.prompt.trim();
            if (trimmedPrompt.length === 0) {
                recordError(errors, 'invalid-prompt');
                hasRecordError = true;
            } else if (trimmedPrompt.length > 8000) {
                recordError(errors, 'prompt-too-long');
                hasRecordError = true;
            }
        }

        if (!hasRecordError) {
            proposals.push({
                characters: normalizedCharacters,
                prompt: trimmedPrompt,
                raw: record.raw,
                start: record.start,
                end: record.end,
            });
        }
    }

    if (errors.length > 0) {
        return {
            ok: false,
            proposals: [],
            errors,
        };
    }

    return {
        ok: true,
        proposals,
        errors: [],
    };
}

/**
 * Pure MVP policy function to select at most one proposal from validated proposals.
 *
 * Current MVP runtime policy permits at most one image proposal per assistant message.
 * Multiple proposals are valid protocol records but are not yet supported by MVP execution.
 *
 * @param {unknown} proposals
 * @returns {{
 *   status: 'none' | 'ready' | 'multiple-proposals-not-supported' | 'invalid-proposals',
 *   proposal?: {
 *     characters: string[],
 *     prompt: string,
 *     raw: string,
 *     start: number,
 *     end: number,
 *   },
 * }}
 */
export function selectMvpImageProposal(proposals) {
    if (!Array.isArray(proposals)) {
        return {
            status: 'invalid-proposals',
        };
    }

    if (proposals.length === 0) {
        return {
            status: 'none',
        };
    }

    if (proposals.length === 1) {
        return {
            status: 'ready',
            proposal: proposals[0],
        };
    }

    return {
        status: 'multiple-proposals-not-supported',
    };
}

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

function recordError(errors, code) {
    if (!errors.includes(code)) {
        errors.push(code);
    }
}

/**
 * @file Pure CI_IMAGE syntax and source-location parser for Chromatic Images.
 *
 * Scans an assistant message for standalone HTML-comment CI_IMAGE control records,
 * enforcing physical one-line positioning and fail-closed syntax checking.
 */

/**
 * Parses an assistant message string for 0..N standalone CI_IMAGE control records.
 *
 * Grammar rules:
 * - HTML comment starting with `<!--` and ending with `-->`.
 * - Case-sensitive marker `CI_IMAGE` immediately following `<!--` (with optional horizontal whitespace).
 * - Exactly one physical line; multiline comments are rejected.
 * - Standalone on that physical line except for leading/trailing horizontal whitespace ([ \t]*).
 * - Valid JSON payload following `CI_IMAGE` (separated by horizontal whitespace).
 *
 * Deterministic error precedence for an attempted CI_IMAGE record:
 * 1. Unclosed comment (`closeIndex === -1`) -> 'malformed-control-record'
 * 2. Multiline comment (`raw` contains line break) -> 'malformed-control-record'
 * 3. Misplaced comment (non-whitespace before `<!--` or after `-->` on physical line) -> 'misplaced-control-record'
 * 4. Missing or malformed payload structure -> 'malformed-control-record'
 * 5. Invalid JSON payload -> 'invalid-json'
 *
 * @param {unknown} message
 * @returns {{
 *   ok: boolean,
 *   records: Array<{
 *     payload: unknown,
 *     raw: string,
 *     start: number,
 *     end: number,
 *   }>,
 *   errors: string[],
 * }}
 */
export function parseImageProposalRecords(message) {
    if (typeof message !== 'string') {
        return {
            ok: false,
            records: [],
            errors: ['invalid-message'],
        };
    }

    const records = [];
    const errors = [];

    let searchIndex = 0;

    while (searchIndex < message.length) {
        const commentStart = message.indexOf('<!--', searchIndex);
        if (commentStart === -1) {
            break;
        }

        const afterStart = message.slice(commentStart + 4);

        // Check if this comment is an attempted CI_IMAGE control record.
        // It must begin with optional whitespace followed by CI_IMAGE with word boundary.
        // Non-CI_IMAGE HTML comments are ignored as unrelated comments.
        if (!/^[ \t\r\n]*CI_IMAGE\b/.test(afterStart)) {
            const nextClose = message.indexOf('-->', commentStart + 4);
            searchIndex = nextClose === -1 ? message.length : nextClose + 3;
            continue;
        }

        const closeIndex = message.indexOf('-->', commentStart + 4);

        // 1. Unclosed attempted record
        if (closeIndex === -1) {
            recordError(errors, 'malformed-control-record');
            break;
        }

        const start = commentStart;
        const end = closeIndex + 3;
        const raw = message.slice(start, end);

        // 2. Multiline attempted record
        if (raw.includes('\n') || raw.includes('\r')) {
            recordError(errors, 'malformed-control-record');
            searchIndex = end;
            continue;
        }

        // 3. Standalone positioning check on physical line
        const lineStart = message.lastIndexOf('\n', start - 1) + 1;
        let lineEnd = message.indexOf('\n', end);
        if (lineEnd === -1) {
            lineEnd = message.length;
        }

        const prefix = message.slice(lineStart, start);
        let suffix = message.slice(end, lineEnd);
        if (suffix.endsWith('\r')) {
            suffix = suffix.slice(0, -1);
        }

        if (!/^[ \t]*$/.test(prefix) || !/^[ \t]*$/.test(suffix)) {
            recordError(errors, 'misplaced-control-record');
            searchIndex = end;
            continue;
        }

        // 4. Payload extraction and structure check
        // inner is everything between `<!--` and `-->`
        const inner = raw.slice(4, -3);
        const payloadMatch = inner.match(/^[ \t]*CI_IMAGE([ \t]+([\s\S]*?))?[ \t]*$/);

        if (!payloadMatch || !payloadMatch[1] || payloadMatch[2].trim().length === 0) {
            recordError(errors, 'malformed-control-record');
            searchIndex = end;
            continue;
        }

        const jsonString = payloadMatch[2].trim();

        // 5. JSON parse check
        let payload;
        try {
            payload = JSON.parse(jsonString);
        } catch {
            recordError(errors, 'invalid-json');
            searchIndex = end;
            continue;
        }

        records.push({
            payload,
            raw,
            start,
            end,
        });

        searchIndex = end;
    }

    if (errors.length > 0) {
        return {
            ok: false,
            records: [],
            errors,
        };
    }

    return {
        ok: true,
        records,
        errors: [],
    };
}

function recordError(errors, code) {
    if (!errors.includes(code)) {
        errors.push(code);
    }
}

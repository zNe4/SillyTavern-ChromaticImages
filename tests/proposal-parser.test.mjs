import test from 'node:test';
import assert from 'node:assert/strict';

import { parseImageProposalRecords } from '../src/proposal-parser.js';

test('non-string message returns invalid-message error', () => {
    const invalidInputs = [null, undefined, 123, true, {}, []];

    for (const input of invalidInputs) {
        const result = parseImageProposalRecords(input);
        assert.deepEqual(result, {
            ok: false,
            records: [],
            errors: ['invalid-message'],
        });
    }
});

test('message with no CI_IMAGE returns empty records without errors', () => {
    const message = 'The quick brown fox jumps over the lazy dog.\nJust standard narrative prose.';
    const result = parseImageProposalRecords(message);

    assert.deepEqual(result, {
        ok: true,
        records: [],
        errors: [],
    });
});

test('ordinary prose mentioning CI_IMAGE does not count as attempted proposal', () => {
    const message = 'The assistant may emit CI_IMAGE when an illustration is appropriate.\nNot inside a comment.';
    const result = parseImageProposalRecords(message);

    assert.deepEqual(result, {
        ok: true,
        records: [],
        errors: [],
    });
});

test('one valid standalone record parses successfully', () => {
    const message = '<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"Hina and Ako sit together by the window."} -->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.records.length, 1);

    const [record] = result.records;
    assert.deepEqual(record.payload, {
        characters: ['Hina', 'Ako'],
        prompt: 'Hina and Ako sit together by the window.',
    });
    assert.strictEqual(record.raw, message);
    assert.strictEqual(record.start, 0);
    assert.strictEqual(record.end, message.length);
});

test('leading indentation on physical line is accepted and excluded from raw', () => {
    const rawComment = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina stands in the doorway."} -->';
    const message = `    ${rawComment}`;
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);

    const [record] = result.records;
    assert.strictEqual(record.raw, rawComment);
    assert.strictEqual(record.start, 4);
    assert.strictEqual(record.end, 4 + rawComment.length);
    assert.strictEqual(message.slice(record.start, record.end), rawComment);
});

test('trailing horizontal whitespace on physical line is accepted and excluded from raw', () => {
    const rawComment = '<!-- CI_IMAGE {"characters":["Ako"],"prompt":"Ako reads a report."} -->';
    const message = `${rawComment}  \t  \n`;
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);

    const [record] = result.records;
    assert.strictEqual(record.raw, rawComment);
    assert.strictEqual(record.start, 0);
    assert.strictEqual(record.end, rawComment.length);
    assert.strictEqual(message.slice(record.start, record.end), rawComment);
});

test('valid record in middle of normal prose parses cleanly', () => {
    const rawComment = '<!-- CI_IMAGE {"characters":[],"prompt":"A silent corridor at night."} -->';
    const message = `Introductory roleplay prose.\n\n${rawComment}\n\nConsequent narrative prose.`;
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);

    const [record] = result.records;
    assert.strictEqual(record.raw, rawComment);
    assert.strictEqual(message.slice(record.start, record.end), rawComment);
    assert.deepEqual(record.payload, {
        characters: [],
        prompt: 'A silent corridor at night.',
    });
});

test('valid record at very beginning of message succeeds', () => {
    const rawComment = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina enters."} -->';
    const message = `${rawComment}\nFollowing prose.`;
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.records[0].start, 0);
    assert.strictEqual(result.records[0].raw, rawComment);
});

test('valid record at very end of message without trailing newline succeeds', () => {
    const rawComment = '<!-- CI_IMAGE {"characters":["Ako"],"prompt":"Ako leaves."} -->';
    const message = `Leading prose.\n${rawComment}`;
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.records[0].raw, rawComment);
    assert.strictEqual(result.records[0].end, message.length);
});

test('two valid records at separate locations preserve source order and offsets', () => {
    const raw1 = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina smiles."} -->';
    const raw2 = '<!-- CI_IMAGE {"characters":["Ako"],"prompt":"Ako sighs."} -->';
    const message = `Scene one.\n${raw1}\nInterlude.\n${raw2}\nConclusion.`;

    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 2);

    assert.strictEqual(result.records[0].raw, raw1);
    assert.strictEqual(result.records[0].payload.prompt, 'Hina smiles.');
    assert.strictEqual(message.slice(result.records[0].start, result.records[0].end), raw1);

    assert.strictEqual(result.records[1].raw, raw2);
    assert.strictEqual(result.records[1].payload.prompt, 'Ako sighs.');
    assert.strictEqual(message.slice(result.records[1].start, result.records[1].end), raw2);

    assert.ok(result.records[0].end < result.records[1].start);
});

test('exact raw is preserved and start/end coordinates match exactly', () => {
    const message = 'Line 1\n  <!-- CI_IMAGE {"characters":["Hina"],"prompt":"Test"} -->  \nLine 3';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);

    const rec = result.records[0];
    assert.strictEqual(rec.raw, '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Test"} -->');
    assert.strictEqual(message.slice(rec.start, rec.end), rec.raw);
});

test('inline record preceded by prose on the same line is rejected as misplaced', () => {
    const message = 'Hina smiles. <!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina looks over her shoulder."} -->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, ['misplaced-control-record']);
});

test('inline record followed by prose on the same line is rejected as misplaced', () => {
    const message = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina looks over her shoulder."} --> more prose';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, ['misplaced-control-record']);
});

test('multiline attempted record is rejected as malformed-control-record', () => {
    const message = '<!-- CI_IMAGE\n{"characters":["Hina"],"prompt":"Hina speaks."}\n-->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, ['malformed-control-record']);
});

test('unclosed attempted record is rejected as malformed-control-record', () => {
    const message = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina waves."}';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, ['malformed-control-record']);
});

test('empty or missing JSON payload is rejected as malformed-control-record', () => {
    const emptyPayload = '<!-- CI_IMAGE -->';
    const emptyResult = parseImageProposalRecords(emptyPayload);
    assert.strictEqual(emptyResult.ok, false);
    assert.deepEqual(emptyResult.errors, ['malformed-control-record']);

    const whitespacePayload = '<!-- CI_IMAGE    -->';
    const wsResult = parseImageProposalRecords(whitespacePayload);
    assert.strictEqual(wsResult.ok, false);
    assert.deepEqual(wsResult.errors, ['malformed-control-record']);

    const noSpacePayload = '<!-- CI_IMAGE{"characters":[]} -->';
    const noSpaceResult = parseImageProposalRecords(noSpacePayload);
    assert.strictEqual(noSpaceResult.ok, false);
    assert.deepEqual(noSpaceResult.errors, ['malformed-control-record']);
});

test('malformed JSON payload is rejected as invalid-json', () => {
    const message = '<!-- CI_IMAGE {malformed json: true} -->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, ['invalid-json']);
});

test('multiple comment structures on same line are rejected as misplaced-control-record', () => {
    const twoCiImage = '<!-- CI_IMAGE {"characters":["A"],"prompt":"P1"} --> <!-- CI_IMAGE {"characters":["B"],"prompt":"P2"} -->';
    const res1 = parseImageProposalRecords(twoCiImage);
    assert.strictEqual(res1.ok, false);
    assert.deepEqual(res1.records, []);
    assert.deepEqual(res1.errors, ['misplaced-control-record']);

    const otherBeforeCi = '<!-- unrelated --> <!-- CI_IMAGE {"characters":["A"],"prompt":"P1"} -->';
    const res2 = parseImageProposalRecords(otherBeforeCi);
    assert.strictEqual(res2.ok, false);
    assert.deepEqual(res2.records, []);
    assert.deepEqual(res2.errors, ['misplaced-control-record']);

    const ciBeforeOther = '<!-- CI_IMAGE {"characters":["A"],"prompt":"P1"} --> <!-- unrelated -->';
    const res3 = parseImageProposalRecords(ciBeforeOther);
    assert.strictEqual(res3.ok, false);
    assert.deepEqual(res3.records, []);
    assert.deepEqual(res3.errors, ['misplaced-control-record']);
});

test('unrelated HTML comments on separate lines are ignored', () => {
    const message = '<!-- Author note: Chapter 1 -->\n<!-- CI_IMAGE {"characters":[],"prompt":"A lonely moon."} -->\n<!-- Another note -->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.records[0].payload.prompt, 'A lonely moon.');
});

test('lowercase or mis-cased marker is not treated as CI_IMAGE', () => {
    const lowercase = '<!-- ci_image {"characters":["Hina"],"prompt":"Test"} -->';
    const res1 = parseImageProposalRecords(lowercase);
    assert.strictEqual(res1.ok, true);
    assert.deepEqual(res1.records, []);
    assert.deepEqual(res1.errors, []);

    const mixedCase = '<!-- Ci_Image {"characters":["Hina"],"prompt":"Test"} -->';
    const res2 = parseImageProposalRecords(mixedCase);
    assert.strictEqual(res2.ok, true);
    assert.deepEqual(res2.records, []);
    assert.deepEqual(res2.errors, []);
});

test('one valid record plus one malformed attempted record fails closed', () => {
    const message = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Valid record."} -->\n\nSome prose.\n\n<!-- CI_IMAGE {not json} -->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.errors, ['invalid-json']);
});

test('no proposal-count limit exists in parser behavior', () => {
    const lines = [
        '<!-- CI_IMAGE {"characters":["A"],"prompt":"P1"} -->',
        '<!-- CI_IMAGE {"characters":["B"],"prompt":"P2"} -->',
        '<!-- CI_IMAGE {"characters":["C"],"prompt":"P3"} -->',
        '<!-- CI_IMAGE {"characters":["D"],"prompt":"P4"} -->',
    ];
    const message = lines.join('\n\n');
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 4);
    assert.strictEqual(result.errors.length, 0);

    for (let i = 0; i < 4; i++) {
        assert.strictEqual(result.records[i].raw, lines[i]);
    }
});

test('valid non-object JSON parses syntactically and is preserved for validator', () => {
    const message = '<!-- CI_IMAGE ["valid json array"] -->';
    const result = parseImageProposalRecords(message);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.records.length, 1);
    assert.deepEqual(result.records[0].payload, ['valid json array']);
});

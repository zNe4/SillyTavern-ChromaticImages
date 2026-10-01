import test from 'node:test';
import assert from 'node:assert/strict';

import {
    validateImageProposalRecords,
    selectMvpImageProposal,
} from '../src/proposal-validator.js';

function createSampleRecord(payloadOverrides = {}, metaOverrides = {}) {
    return {
        raw: '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"A scene."} -->',
        start: 10,
        end: 72,
        payload: {
            characters: ['Hina'],
            prompt: 'A scene.',
            ...payloadOverrides,
        },
        ...metaOverrides,
    };
}

test('valid empty characters list is accepted', () => {
    const record = createSampleRecord({
        characters: [],
        prompt: 'A scenic establishing shot of a cityscape.',
    });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].characters, []);
    assert.strictEqual(result.proposals[0].prompt, 'A scenic establishing shot of a cityscape.');
});

test('valid one-character proposal is accepted', () => {
    const record = createSampleRecord({
        characters: ['Hina'],
        prompt: 'Hina looks up at the sky.',
    });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].characters, ['Hina']);
});

test('valid multiple-character proposal is accepted', () => {
    const record = createSampleRecord({
        characters: ['Hina', 'Ako', 'Iori'],
        prompt: 'The disciplinary committee gathers at the table.',
    });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].characters, ['Hina', 'Ako', 'Iori']);
});

test('outer character whitespace is trimmed while case and internal whitespace are preserved', () => {
    const record = createSampleRecord({
        characters: ['  Sorasaki Hina  ', '\tAko Amau\t'],
    });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].characters, ['Sorasaki Hina', 'Ako Amau']);
});

test('non-array characters property is rejected', () => {
    const badValues = [null, undefined, 'Hina', 123, {}, true];

    for (const bad of badValues) {
        const record = createSampleRecord({ characters: bad });
        const result = validateImageProposalRecords([record]);

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-characters']);
    }
});

test('non-string character entry is rejected', () => {
    const badEntries = [123, null, undefined, {}, [], true];

    for (const bad of badEntries) {
        const record = createSampleRecord({ characters: ['Hina', bad] });
        const result = validateImageProposalRecords([record]);

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-character']);
    }
});

test('empty or whitespace-only character entry is rejected', () => {
    const emptyValues = ['', '   ', '\t\n'];

    for (const bad of emptyValues) {
        const record = createSampleRecord({ characters: [bad] });
        const result = validateImageProposalRecords([record]);

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-character']);
    }
});

test('character entry over 200 code units after trimming is rejected', () => {
    const exactly200 = 'A'.repeat(200);
    const validRecord = createSampleRecord({ characters: [exactly200] });
    const validResult = validateImageProposalRecords([validRecord]);
    assert.strictEqual(validResult.ok, true);
    assert.strictEqual(validResult.proposals[0].characters[0].length, 200);

    const over200 = 'A'.repeat(201);
    const invalidRecord = createSampleRecord({ characters: [over200] });
    const invalidResult = validateImageProposalRecords([invalidRecord]);
    assert.strictEqual(invalidResult.ok, false);
    assert.deepEqual(invalidResult.errors, ['invalid-character']);
});

test('more than 32 characters rejected while exactly 32 characters accepted', () => {
    const exact32 = Array.from({ length: 32 }, (_, i) => `Character_${i + 1}`);
    const validRecord = createSampleRecord({ characters: exact32 });
    const validResult = validateImageProposalRecords([validRecord]);

    assert.strictEqual(validResult.ok, true);
    assert.strictEqual(validResult.proposals[0].characters.length, 32);

    const over32 = Array.from({ length: 33 }, (_, i) => `Character_${i + 1}`);
    const invalidRecord = createSampleRecord({ characters: over32 });
    const invalidResult = validateImageProposalRecords([invalidRecord]);

    assert.strictEqual(invalidResult.ok, false);
    assert.deepEqual(invalidResult.errors, ['too-many-characters']);
});

test('exact duplicate character after trimming is rejected', () => {
    const record = createSampleRecord({
        characters: ['Hina', '  Hina  '],
    });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['duplicate-character']);
});

test('case-insensitive duplicate character is rejected', () => {
    const record = createSampleRecord({
        characters: ['Hina', 'hina'],
    });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['duplicate-character']);
});

test('prompt outer whitespace is trimmed while internal whitespace is preserved', () => {
    const prompt = '  Line 1 of prompt.\n\n  Line 2 with   spaces.  ';
    const record = createSampleRecord({ prompt });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(
        result.proposals[0].prompt,
        'Line 1 of prompt.\n\n  Line 2 with   spaces.',
    );
});

test('empty or whitespace-only prompt is rejected', () => {
    const emptyPrompts = ['', '   ', '\t\n\r '];

    for (const prompt of emptyPrompts) {
        const record = createSampleRecord({ prompt });
        const result = validateImageProposalRecords([record]);

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-prompt']);
    }
});

test('non-string prompt is rejected', () => {
    const badPrompts = [null, undefined, 123, {}, [], true];

    for (const prompt of badPrompts) {
        const record = createSampleRecord({ prompt });
        const result = validateImageProposalRecords([record]);

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-prompt']);
    }
});

test('prompt exactly 8000 code units is accepted', () => {
    const prompt8000 = 'A'.repeat(8000);
    const record = createSampleRecord({ prompt: `  ${prompt8000}  ` });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals[0].prompt.length, 8000);
});

test('prompt over 8000 code units after trimming is rejected', () => {
    const prompt8001 = 'A'.repeat(8001);
    const record = createSampleRecord({ prompt: prompt8001 });

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['prompt-too-long']);
});

test('missing keys from payload are rejected', () => {
    const missingPrompt = createSampleRecord();
    delete missingPrompt.payload.prompt;

    const result1 = validateImageProposalRecords([missingPrompt]);
    assert.strictEqual(result1.ok, false);
    assert.deepEqual(result1.errors, ['invalid-proposal-shape']);

    const missingCharacters = createSampleRecord();
    delete missingCharacters.payload.characters;

    const result2 = validateImageProposalRecords([missingCharacters]);
    assert.strictEqual(result2.ok, false);
    assert.deepEqual(result2.errors, ['invalid-proposal-shape']);
});

test('extra keys on payload are rejected', () => {
    const extraKeyRecord = createSampleRecord({
        extraKey: 'some-value',
        anotherExtra: 42,
    });

    const result = validateImageProposalRecords([extraKeyRecord]);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['invalid-proposal-shape']);
});

test('array, scalar, or null payload is rejected', () => {
    const badPayloads = [
        [],
        ['Hina'],
        null,
        123,
        'string-payload',
        true,
    ];

    for (const bad of badPayloads) {
        const record = {
            raw: '<!-- CI_IMAGE ... -->',
            start: 0,
            end: 20,
            payload: bad,
        };

        const result = validateImageProposalRecords([record]);

        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-proposal-shape']);
    }
});

test('normal object-literal payload is accepted when otherwise valid', () => {
    const record = {
        raw: '<!-- CI_IMAGE ... -->',
        start: 0,
        end: 50,
        payload: {
            characters: ['Hina'],
            prompt: 'Hina smiles.',
        },
    };

    const result = validateImageProposalRecords([record]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].characters, ['Hina']);
    assert.strictEqual(result.proposals[0].prompt, 'Hina smiles.');
});

test('Date payload is rejected as invalid-proposal-shape', () => {
    const record = {
        raw: '<!-- CI_IMAGE ... -->',
        start: 0,
        end: 50,
        payload: new Date(),
    };

    const result = validateImageProposalRecords([record]);
    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['invalid-proposal-shape']);
});

test('class-instance payload is rejected as invalid-proposal-shape', () => {
    class CustomPayload {
        constructor() {
            this.characters = ['Hina'];
            this.prompt = 'Hina in class.';
        }
    }

    const record = {
        raw: '<!-- CI_IMAGE ... -->',
        start: 0,
        end: 50,
        payload: new CustomPayload(),
    };

    const result = validateImageProposalRecords([record]);
    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['invalid-proposal-shape']);
});

test('object with a custom non-null prototype is rejected as invalid-proposal-shape', () => {
    const customProto = { inherited: true };
    const payload = Object.create(customProto);
    payload.characters = ['Hina'];
    payload.prompt = 'Hina with custom prototype.';

    const record = {
        raw: '<!-- CI_IMAGE ... -->',
        start: 0,
        end: 50,
        payload,
    };

    const result = validateImageProposalRecords([record]);
    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['invalid-proposal-shape']);
});

test('null-prototype plain object with exactly characters and prompt is accepted', () => {
    const payload = Object.create(null);
    payload.characters = ['Hina'];
    payload.prompt = 'Hina with null prototype.';

    const record = {
        raw: '<!-- CI_IMAGE ... -->',
        start: 0,
        end: 50,
        payload,
    };

    const result = validateImageProposalRecords([record]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 1);
    assert.deepEqual(result.proposals[0].characters, ['Hina']);
    assert.strictEqual(result.proposals[0].prompt, 'Hina with null prototype.');
});

test('multiple valid records validate successfully in order', () => {
    const record1 = {
        raw: '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"P1"} -->',
        start: 0,
        end: 55,
        payload: { characters: ['Hina'], prompt: 'P1' },
    };
    const record2 = {
        raw: '<!-- CI_IMAGE {"characters":["Ako"],"prompt":"P2"} -->',
        start: 100,
        end: 154,
        payload: { characters: ['Ako'], prompt: 'P2' },
    };

    const result = validateImageProposalRecords([record1, record2]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals.length, 2);
    assert.strictEqual(result.proposals[0].prompt, 'P1');
    assert.strictEqual(result.proposals[0].raw, record1.raw);
    assert.strictEqual(result.proposals[0].start, 0);
    assert.strictEqual(result.proposals[0].end, 55);

    assert.strictEqual(result.proposals[1].prompt, 'P2');
    assert.strictEqual(result.proposals[1].raw, record2.raw);
    assert.strictEqual(result.proposals[1].start, 100);
    assert.strictEqual(result.proposals[1].end, 154);
});

test('one invalid record causes entire set to fail closed', () => {
    const validRecord = createSampleRecord({ characters: ['Hina'], prompt: 'Valid scene.' });
    const invalidRecord = createSampleRecord({ characters: ['Hina', 'hina'], prompt: 'Bad scene.' });

    const result = validateImageProposalRecords([validRecord, invalidRecord]);

    assert.strictEqual(result.ok, false);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.errors, ['duplicate-character']);
});

test('source raw, start, and end metadata survive validation unchanged', () => {
    const record = {
        raw: '<!-- CI_IMAGE {"characters":[],"prompt":"A street."} -->',
        start: 42,
        end: 98,
        payload: { characters: [], prompt: 'A street.' },
    };

    const result = validateImageProposalRecords([record]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.proposals[0].raw, record.raw);
    assert.strictEqual(result.proposals[0].start, 42);
    assert.strictEqual(result.proposals[0].end, 98);
});

test('input records and payloads are not mutated during validation', () => {
    const originalRecord = {
        raw: '<!-- CI_IMAGE {"characters":["  Hina  "],"prompt":"  Prompt  "} -->',
        start: 5,
        end: 75,
        payload: {
            characters: ['  Hina  '],
            prompt: '  Prompt  ',
        },
    };

    const cloneBefore = JSON.parse(JSON.stringify(originalRecord));

    const result = validateImageProposalRecords([originalRecord]);

    assert.strictEqual(result.ok, true);
    assert.deepEqual(originalRecord, cloneBefore);
    assert.deepEqual(result.proposals[0].characters, ['Hina']);
    assert.strictEqual(result.proposals[0].prompt, 'Prompt');
});

test('non-array records input returns invalid-records error', () => {
    const badInputs = [null, undefined, 'not-an-array', 123, {}];

    for (const bad of badInputs) {
        const result = validateImageProposalRecords(bad);
        assert.deepEqual(result, {
            ok: false,
            proposals: [],
            errors: ['invalid-records'],
        });
    }
});

test('malformed record structure returns invalid-records error', () => {
    const badRecords = [
        null,
        'not-an-object',
        { start: 0, end: 10 }, // missing raw & payload
        { raw: '<!-- -->', start: 'zero', end: 10, payload: {} }, // start not number
        { raw: '<!-- -->', start: 0, end: 'ten', payload: {} }, // end not number
    ];

    for (const bad of badRecords) {
        const result = validateImageProposalRecords([bad]);
        assert.strictEqual(result.ok, false);
        assert.deepEqual(result.proposals, []);
        assert.deepEqual(result.errors, ['invalid-records']);
    }
});

// MVP selection policy tests

test('MVP selection policy: empty proposals returns none', () => {
    const result = selectMvpImageProposal([]);
    assert.deepEqual(result, {
        status: 'none',
    });
});

test('MVP selection policy: exactly one proposal returns ready with proposal', () => {
    const proposal = {
        characters: ['Hina'],
        prompt: 'Hina stands in the doorway.',
        raw: '<!-- CI_IMAGE ... -->',
        start: 10,
        end: 80,
    };

    const result = selectMvpImageProposal([proposal]);

    assert.deepEqual(result, {
        status: 'ready',
        proposal,
    });
    assert.strictEqual(result.proposal, proposal);
});

test('MVP selection policy: two valid proposals return multiple-proposals-not-supported', () => {
    const p1 = { characters: ['Hina'], prompt: 'P1', raw: '<!-- ... -->', start: 0, end: 50 };
    const p2 = { characters: ['Ako'], prompt: 'P2', raw: '<!-- ... -->', start: 60, end: 110 };

    const result = selectMvpImageProposal([p1, p2]);

    assert.deepEqual(result, {
        status: 'multiple-proposals-not-supported',
    });
    assert.strictEqual('proposal' in result, false);
});

test('MVP selection policy: three valid proposals return multiple-proposals-not-supported', () => {
    const p1 = { characters: ['A'], prompt: 'P1', raw: '...', start: 0, end: 10 };
    const p2 = { characters: ['B'], prompt: 'P2', raw: '...', start: 20, end: 30 };
    const p3 = { characters: ['C'], prompt: 'P3', raw: '...', start: 40, end: 50 };

    const result = selectMvpImageProposal([p1, p2, p3]);

    assert.deepEqual(result, {
        status: 'multiple-proposals-not-supported',
    });
});

test('MVP selection policy: multiple proposals are NOT classified as syntax or schema errors', () => {
    const p1 = { characters: ['Hina'], prompt: 'Scene 1', raw: 'r1', start: 0, end: 10 };
    const p2 = { characters: ['Ako'], prompt: 'Scene 2', raw: 'r2', start: 20, end: 30 };

    const result = selectMvpImageProposal([p1, p2]);

    // Explicitly verify this is a policy outcome, not an error
    assert.strictEqual(result.status, 'multiple-proposals-not-supported');
    assert.strictEqual('errors' in result, false);
    assert.strictEqual('ok' in result, false);
});

test('MVP selection policy: invalid non-array input returns invalid-proposals', () => {
    const badInputs = [null, undefined, 'proposals', 123, {}];

    for (const bad of badInputs) {
        const result = selectMvpImageProposal(bad);
        assert.deepEqual(result, {
            status: 'invalid-proposals',
        });
    }
});

test('layered architecture: multiple valid CI_IMAGE records pass parser and validator, restricted only by selectMvpImageProposal', async () => {
    const { parseImageProposalRecords } = await import('../src/proposal-parser.js');

    const message = [
        'Scene begins.',
        '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina looks out the window."} -->',
        'Narrative continues.',
        '<!-- CI_IMAGE {"characters":["Ako"],"prompt":"Ako enters the office."} -->',
        'End of message.',
    ].join('\n\n');

    // 1. Parser accepts both records
    const parseResult = parseImageProposalRecords(message);
    assert.strictEqual(parseResult.ok, true);
    assert.strictEqual(parseResult.records.length, 2);
    assert.deepEqual(parseResult.errors, []);

    // 2. Validator normalizes and validates both proposals
    const validateResult = validateImageProposalRecords(parseResult.records);
    assert.strictEqual(validateResult.ok, true);
    assert.strictEqual(validateResult.proposals.length, 2);
    assert.deepEqual(validateResult.errors, []);

    // 3. Only the MVP policy restricts execution to single-image
    const selection = selectMvpImageProposal(validateResult.proposals);
    assert.deepEqual(selection, {
        status: 'multiple-proposals-not-supported',
    });
});


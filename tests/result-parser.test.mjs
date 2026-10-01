/**
 * @file Unit tests for parseImageResultStates in src/result-parser.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageResultStates } from '../src/result-parser.js';

test('non-string message returns invalid-message error', () => {
    assert.deepEqual(parseImageResultStates(null), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['invalid-message'],
    });

    assert.deepEqual(parseImageResultStates(undefined), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['invalid-message'],
    });

    assert.deepEqual(parseImageResultStates(123), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['invalid-message'],
    });

    assert.deepEqual(parseImageResultStates({}), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['invalid-message'],
    });
});

test('ordinary prose returns success with empty arrays', () => {
    const res = parseImageResultStates('The quick brown fox jumps over the lazy dog.');
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('empty string returns success with empty arrays', () => {
    const res = parseImageResultStates('');
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('unrelated Markdown images are ignored', () => {
    const msg = [
        'Here are some images:',
        '![Landscape](foo.png)',
        '![Hina](/user/images/hina.png)',
        '![chromaticimages](/user/images/ci.png)',
        'Text continues.',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('unrelated HTML comments are ignored', () => {
    const msg = [
        '<!-- Simple comment -->',
        '<!-- CI_IMAGE {"characters":[],"prompt":"foo"} -->',
        '<!-- Some other control record -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('ordinary prose mentioning CI_RESULT is ignored', () => {
    const msg = 'In this system, CI_RESULT represents the durable outcome record.';
    const res = parseImageResultStates(msg);
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('inline prose mentioning ![ChromaticImages] is ignored', () => {
    const msg = 'The extension marker is ![ChromaticImages] when stored in chat.';
    const res = parseImageResultStates(msg);
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('wrong-case alt text is not treated as owned marker', () => {
    const msg = '![chromaticimages](/user/images/ci_123.png)';
    const res = parseImageResultStates(msg);
    assert.deepEqual(res, {
        ok: true,
        reviewable: [],
        finalized: [],
        errors: [],
    });
});

test('valid finalized Markdown image is recognized', () => {
    const msg = '![ChromaticImages](/user/images/ci_123.png)';
    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 0);
    assert.equal(res.finalized.length, 1);
    assert.equal(res.errors.length, 0);

    const fin = res.finalized[0];
    assert.equal(fin.path, '/user/images/ci_123.png');
    assert.equal(fin.raw, '![ChromaticImages](/user/images/ci_123.png)');
    assert.equal(fin.start, 0);
    assert.equal(fin.end, msg.length);
    assert.equal(msg.slice(fin.start, fin.end), fin.raw);
});

test('finalized image with leading and trailing horizontal whitespace preserves exact offsets', () => {
    const prefix = '  \t';
    const raw = '![ChromaticImages](/user/images/subdir/ci_999.png)';
    const suffix = '   \t';
    const msg = `Introduction\n${prefix}${raw}${suffix}\nConclusion`;

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.finalized.length, 1);

    const fin = res.finalized[0];
    assert.equal(fin.path, '/user/images/subdir/ci_999.png');
    assert.equal(fin.raw, raw);
    assert.equal(msg.slice(fin.start, fin.end), raw);
    assert.equal(fin.start, msg.indexOf(raw));
    assert.equal(fin.end, fin.start + raw.length);
});

test('finalized image with spaces inside root-relative path is accepted', () => {
    const msg = '![ChromaticImages](/user/images/my folder/ci 123.png)';
    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.finalized.length, 1);
    assert.equal(res.finalized[0].path, '/user/images/my folder/ci 123.png');
});

test('Markdown record with external http/https path is rejected as malformed-image-record', () => {
    const msg1 = '![ChromaticImages](https://example.com/image.png)';
    assert.deepEqual(parseImageResultStates(msg1), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });

    const msg2 = '![ChromaticImages](http://example.com/image.png)';
    assert.deepEqual(parseImageResultStates(msg2), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });
});

test('Markdown record with data: or blob: path is rejected as malformed-image-record', () => {
    const msg1 = '![ChromaticImages](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)';
    assert.deepEqual(parseImageResultStates(msg1), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });

    const msg2 = '![ChromaticImages](blob:http://example.com/uuid)';
    assert.deepEqual(parseImageResultStates(msg2), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });
});

test('Markdown record with empty path is rejected as malformed-image-record', () => {
    const msg = '![ChromaticImages]()';
    assert.deepEqual(parseImageResultStates(msg), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });
});

test('Markdown record with path over 4096 code units is rejected as malformed-image-record', () => {
    const longPath = '/' + 'a'.repeat(4096);
    const msg = `![ChromaticImages](${longPath})`;
    assert.deepEqual(parseImageResultStates(msg), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });
});

test('Markdown record with path exactly 4096 code units is accepted', () => {
    const exactPath = '/' + 'a'.repeat(4095);
    const msg = `![ChromaticImages](${exactPath})`;
    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.finalized.length, 1);
    assert.equal(res.finalized[0].path, exactPath);
});

test('Markdown record containing Markdown title is rejected as malformed-image-record', () => {
    const msg = '![ChromaticImages](/user/images/ci.png "My Image")';
    assert.deepEqual(parseImageResultStates(msg), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });
});

test('standalone line attempting extension-owned marker with malformed syntax fails closed', () => {
    // Unclosed paren
    assert.deepEqual(parseImageResultStates('![ChromaticImages]('), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });

    // Just bracket
    assert.deepEqual(parseImageResultStates('![ChromaticImages]'), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });

    // Multiline attempt
    const multiline = '![ChromaticImages](\n/user/images/ci_1.png\n)';
    assert.deepEqual(parseImageResultStates(multiline), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });

    // Trailing prose on standalone line
    const trailingProse = '![ChromaticImages](/user/images/ci.png) trailing prose';
    assert.deepEqual(parseImageResultStates(trailingProse), {
        ok: false,
        reviewable: [],
        finalized: [],
        errors: ['malformed-image-record'],
    });
});

test('valid reviewable pair directly adjacent', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Hina looks over her shoulder.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 1);
    assert.equal(res.finalized.length, 0);
    assert.equal(res.errors.length, 0);

    const r = res.reviewable[0];
    assert.equal(r.v, 1);
    assert.deepEqual(r.characters, ['Hina']);
    assert.equal(r.prompt, 'Hina looks over her shoulder.');
    assert.equal(r.path, '/user/images/ci_123.png');

    assert.equal(r.markdown.raw, '![ChromaticImages](/user/images/ci_123.png)');
    assert.equal(r.markdown.start, 0);
    assert.equal(r.markdown.end, 43);
    assert.equal(msg.slice(r.markdown.start, r.markdown.end), r.markdown.raw);

    assert.equal(r.result.start, 44);
    assert.equal(r.result.end, msg.length);
    assert.equal(msg.slice(r.result.start, r.result.end), r.result.raw);

    assert.equal(r.blockStart, 0);
    assert.equal(r.blockEnd, msg.length);
    assert.equal(msg.slice(r.blockStart, r.blockEnd), msg);
});

test('valid reviewable pair with single blank line between', () => {
    const md = '![ChromaticImages](/user/images/ci_123.png)';
    const comment = '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->';
    const msg = `${md}\n\n${comment}`;

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 1);
    assert.equal(res.reviewable[0].blockStart, 0);
    assert.equal(res.reviewable[0].blockEnd, msg.length);
});

test('valid reviewable pair with multiple blank and indented lines between', () => {
    const md = '![ChromaticImages](/user/images/ci_123.png)';
    const comment = '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->';
    const msg = `${md}\n   \n\t\n\n${comment}`;

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 1);
    assert.equal(res.reviewable[0].blockStart, 0);
    assert.equal(res.reviewable[0].blockEnd, msg.length);
});

test('CI_RESULT with "v":"1" (string) is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":"1","characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-shape']);
});

test('CI_RESULT with unsupported numeric version gets unsupported-result-version', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":2,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['unsupported-result-version']);
});

test('CI_RESULT missing required key is rejected as invalid-result-shape', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky."} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-shape']);
});

test('CI_RESULT with extra key is rejected as invalid-result-shape', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png","extra":true} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-shape']);
});

test('CI_RESULT with scalar or array JSON payload is rejected as invalid-result-shape', () => {
    const msg1 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT [1, 2, 3] -->',
    ].join('\n');
    assert.deepEqual(parseImageResultStates(msg1).errors, ['invalid-result-shape']);

    const msg2 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT "hello" -->',
    ].join('\n');
    assert.deepEqual(parseImageResultStates(msg2).errors, ['invalid-result-shape']);

    const msg3 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT null -->',
    ].join('\n');
    assert.deepEqual(parseImageResultStates(msg3).errors, ['invalid-result-shape']);
});

test('CI_RESULT with malformed JSON is rejected as invalid-result-json', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {not valid json} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-json']);
});

test('multiline attempted CI_RESULT is rejected as malformed-result-record', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT',
        '{"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['malformed-result-record']);
});

test('unclosed attempted CI_RESULT is rejected as malformed-result-record', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"}',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['malformed-result-record']);
});

test('inline/misplaced CI_RESULT is rejected as misplaced-result-record', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        'prose before <!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['misplaced-result-record']);
});

test('characters: non-array characters property is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":"Hina","prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-characters']);
});

test('characters: non-string character entry is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[123],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-character']);
});

test('characters: empty or whitespace-only character entry is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":["   "],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-character']);
});

test('characters: character entry over 200 code units after trimming is rejected', () => {
    const longName = 'A'.repeat(201);
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        `<!-- CI_RESULT {"v":1,"characters":["${longName}"],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->`,
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-character']);
});

test('characters: trimming preserves case and internal whitespace', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":["  Princess Hina of Naboo  "],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.deepEqual(res.reviewable[0].characters, ['Princess Hina of Naboo']);
});

test('characters: exactly 32 characters accepted, 33 characters rejected', () => {
    const chars32 = Array.from({ length: 32 }, (_, i) => `Char${i}`);
    const msg32 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        `<!-- CI_RESULT {"v":1,"characters":${JSON.stringify(chars32)},"prompt":"Sky.","path":"/user/images/ci_123.png"} -->`,
    ].join('\n');

    const res32 = parseImageResultStates(msg32);
    assert.equal(res32.ok, true);
    assert.equal(res32.reviewable[0].characters.length, 32);

    const chars33 = Array.from({ length: 33 }, (_, i) => `Char${i}`);
    const msg33 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        `<!-- CI_RESULT {"v":1,"characters":${JSON.stringify(chars33)},"prompt":"Sky.","path":"/user/images/ci_123.png"} -->`,
    ].join('\n');

    const res33 = parseImageResultStates(msg33);
    assert.equal(res33.ok, false);
    assert.deepEqual(res33.errors, ['too-many-result-characters']);
});

test('characters: case-insensitive duplicate character is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":["Hina","  hina  "],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['duplicate-result-character']);
});

test('prompt: outer trim and internal whitespace preservation', () => {
    const rawPrompt = '  Line 1\n  Line 2   ';
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        `<!-- CI_RESULT {"v":1,"characters":[],"prompt":${JSON.stringify(rawPrompt)},"path":"/user/images/ci_123.png"} -->`,
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable[0].prompt, 'Line 1\n  Line 2');
});

test('prompt: empty or whitespace-only prompt is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"   ","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-prompt']);
});

test('prompt: non-string prompt is rejected', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":123,"path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['invalid-result-prompt']);
});

test('prompt: exactly 8000 code units accepted, 8001 rejected', () => {
    const p8000 = 'x'.repeat(8000);
    const msg8000 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        `<!-- CI_RESULT {"v":1,"characters":[],"prompt":"${p8000}","path":"/user/images/ci_123.png"} -->`,
    ].join('\n');

    const res8000 = parseImageResultStates(msg8000);
    assert.equal(res8000.ok, true);
    assert.equal(res8000.reviewable[0].prompt.length, 8000);

    const p8001 = 'x'.repeat(8001);
    const msg8001 = [
        '![ChromaticImages](/user/images/ci_123.png)',
        `<!-- CI_RESULT {"v":1,"characters":[],"prompt":"${p8001}","path":"/user/images/ci_123.png"} -->`,
    ].join('\n');

    const res8001 = parseImageResultStates(msg8001);
    assert.equal(res8001.ok, false);
    assert.deepEqual(res8001.errors, ['result-prompt-too-long']);
});

test('path inside CI_RESULT: invalid path is rejected as invalid-result-path', () => {
    const invalidPaths = [
        'https://example.com/foo.png',
        'data:image/png;base64,abc',
        'foo.png',
        '/has)paren.png',
        '   /untrimmed.png   ',
        '',
    ];

    for (const badPath of invalidPaths) {
        const msg = [
            '![ChromaticImages](/user/images/ci_123.png)',
            `<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":${JSON.stringify(badPath)}} -->`,
        ].join('\n');

        const res = parseImageResultStates(msg);
        assert.equal(res.ok, false);
        assert.ok(res.errors.includes('invalid-result-path'), `Expected invalid-result-path for: ${badPath}`);
    }
});

test('pair consistency: mismatched Markdown and result path fails with result-path-mismatch', () => {
    const msg = [
        '![ChromaticImages](/user/images/a.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/b.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['result-path-mismatch']);
});

test('pair consistency: prose between Markdown and CI_RESULT causes result to be unpaired', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '',
        'Some prose here.',
        '',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['unpaired-result-record']);
});

test('pair consistency: standalone CI_RESULT fails closed with unpaired-result-record', () => {
    const msg = '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->';
    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['unpaired-result-record']);
});

test('pair consistency: CI_RESULT before Markdown fails closed with unpaired-result-record', () => {
    const msg = [
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky.","path":"/user/images/ci_123.png"} -->',
        '![ChromaticImages](/user/images/ci_123.png)',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['unpaired-result-record']);
});

test('pair consistency: two CI_RESULT records cannot consume the same Markdown record', () => {
    const msg = [
        '![ChromaticImages](/user/images/ci_123.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky 1.","path":"/user/images/ci_123.png"} -->',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Sky 2.","path":"/user/images/ci_123.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, false);
    assert.deepEqual(res.errors, ['unpaired-result-record']);
});

test('multiple-state extensibility: two independent reviewable pairs accepted in source order', () => {
    const msg = [
        '![ChromaticImages](/user/images/img1.png)',
        '<!-- CI_RESULT {"v":1,"characters":["A"],"prompt":"Prompt 1.","path":"/user/images/img1.png"} -->',
        '',
        'Prose between pairs.',
        '',
        '![ChromaticImages](/user/images/img2.png)',
        '<!-- CI_RESULT {"v":1,"characters":["B"],"prompt":"Prompt 2.","path":"/user/images/img2.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 2);
    assert.equal(res.finalized.length, 0);

    assert.equal(res.reviewable[0].path, '/user/images/img1.png');
    assert.deepEqual(res.reviewable[0].characters, ['A']);
    assert.equal(res.reviewable[1].path, '/user/images/img2.png');
    assert.deepEqual(res.reviewable[1].characters, ['B']);
    assert.ok(res.reviewable[0].blockStart < res.reviewable[1].blockStart);
});

test('multiple-state extensibility: two independent finalized Markdown records accepted in source order', () => {
    const msg = [
        '![ChromaticImages](/user/images/first.png)',
        '',
        'Prose between finalized images.',
        '',
        '![ChromaticImages](/user/images/second.png)',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 0);
    assert.equal(res.finalized.length, 2);

    assert.equal(res.finalized[0].path, '/user/images/first.png');
    assert.equal(res.finalized[1].path, '/user/images/second.png');
    assert.ok(res.finalized[0].start < res.finalized[1].start);
});

test('multiple-state extensibility: one finalized image plus one reviewable pair accepted in source order', () => {
    const msg = [
        '![ChromaticImages](/user/images/keep_img.png)',
        '',
        'Some story text here.',
        '',
        '![ChromaticImages](/user/images/active_img.png)',
        '<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Hina looks over shoulder.","path":"/user/images/active_img.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.finalized.length, 1);
    assert.equal(res.finalized[0].path, '/user/images/keep_img.png');

    assert.equal(res.reviewable.length, 1);
    assert.equal(res.reviewable[0].path, '/user/images/active_img.png');
});

test('generated pair is not simultaneously returned as finalized', () => {
    const msg = [
        '![ChromaticImages](/user/images/img.png)',
        '<!-- CI_RESULT {"v":1,"characters":[],"prompt":"Prompt.","path":"/user/images/img.png"} -->',
    ].join('\n');

    const res = parseImageResultStates(msg);
    assert.equal(res.ok, true);
    assert.equal(res.reviewable.length, 1);
    assert.equal(res.finalized.length, 0);
});

test('immutability: input string is not mutated and return structure is fresh', () => {
    const input = [
        '![ChromaticImages](/user/images/img.png)',
        '<!-- CI_RESULT {"v":1,"characters":["A"],"prompt":"Prompt.","path":"/user/images/img.png"} -->',
    ].join('\n');
    const inputCopy = input.slice();

    const res1 = parseImageResultStates(input);
    assert.equal(input, inputCopy);

    const res2 = parseImageResultStates(input);
    assert.notEqual(res1, res2);
    assert.notEqual(res1.reviewable, res2.reviewable);
    assert.notEqual(res1.reviewable[0], res2.reviewable[0]);
    assert.notEqual(res1.reviewable[0].characters, res2.reviewable[0].characters);
});

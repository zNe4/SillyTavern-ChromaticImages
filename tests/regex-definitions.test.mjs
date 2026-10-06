import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MANAGED_FIELDS,
    MANAGED_REGEX_SCRIPTS,
} from '../src/regex-definitions.js';

function compileCanonicalRegex(findRegexStr) {
    const match = findRegexStr.match(/^\/(.*)\/([a-z]*)$/s);
    if (!match) {
        throw new Error(`Invalid regex format: ${findRegexStr}`);
    }
    return new RegExp(match[1], match[2]);
}

function applyScript(script, text) {
    const regex = compileCanonicalRegex(script.findRegex);
    return text.replace(regex, script.replaceString);
}

test('1. exactly one canonical definition exists', () => {
    assert.equal(MANAGED_REGEX_SCRIPTS.length, 1);
});

test('2. canonical key is prompt-hygiene', () => {
    assert.equal(MANAGED_REGEX_SCRIPTS[0].key, 'prompt-hygiene');
});

test('3. script name is exact and stable', () => {
    assert.equal(
        MANAGED_REGEX_SCRIPTS[0].scriptName,
        'Chromatic Images - Hide image records from prompt',
    );
});

test('4. canonical script fields match exact expected configuration', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    assert.equal(script.promptOnly, true);
    assert.equal(script.markdownOnly, false);
    assert.equal(script.disabled, false);
    assert.deepEqual(script.placement, [2]);
    assert.equal(script.replaceString, '');
    assert.deepEqual(script.trimStrings, []);
    assert.equal(script.runOnEdit, false);
    assert.equal(script.substituteRegex, 0);
    assert.equal(script.minDepth, null);
    assert.equal(script.maxDepth, null);
    assert.equal(
        script.findRegex,
        '/^[ \\t]*(?:<!--[ \\t]*CI_(?:IMAGE|RESULT)\\b[^\\r\\n]*-->|!\\[ChromaticImages\\]\\([^\\r\\n)]*\\))[ \\t]*(?:\\r?\\n|$)/gm',
    );
});

test('5. MANAGED_FIELDS contains exact 12 fields in canonical order and is frozen', () => {
    assert.ok(Object.isFrozen(MANAGED_FIELDS));
    assert.deepEqual(MANAGED_FIELDS, [
        'scriptName',
        'findRegex',
        'replaceString',
        'trimStrings',
        'placement',
        'disabled',
        'markdownOnly',
        'promptOnly',
        'runOnEdit',
        'substituteRegex',
        'minDepth',
        'maxDepth',
    ]);
});

test('6. definitions and nested structures are deeply immutable', () => {
    assert.ok(Object.isFrozen(MANAGED_REGEX_SCRIPTS));

    for (const definition of MANAGED_REGEX_SCRIPTS) {
        assert.ok(Object.isFrozen(definition));
        assert.ok(Object.isFrozen(definition.trimStrings));
        assert.ok(Object.isFrozen(definition.placement));

        assert.throws(() => {
            definition.scriptName = 'Tampered name';
        }, TypeError);

        assert.throws(() => {
            definition.trimStrings.push('tampered');
        }, TypeError);

        assert.throws(() => {
            definition.placement.push(99);
        }, TypeError);
    }
});

test('7. no unexpected fields leak into canonical script definition', () => {
    const allowedDefinitionKeys = new Set(['key', ...MANAGED_FIELDS]);
    for (const definition of MANAGED_REGEX_SCRIPTS) {
        const actualKeys = Object.keys(definition);
        for (const key of actualKeys) {
            assert.ok(
                allowedDefinitionKeys.has(key),
                `Unexpected key "${key}" found in definition`,
            );
        }
        assert.equal(actualKeys.length, allowedDefinitionKeys.size);
    }
});

test('8. regex removes standalone CI_IMAGE record', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const text = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina by the window."} -->\n';
    assert.equal(applyScript(script, text), '');
});

test('9. regex removes standalone CI_RESULT record', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const text = '<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"...","path":"/user/images/ci_123.png"} -->\n';
    assert.equal(applyScript(script, text), '');
});

test('10. regex removes standalone owned Markdown image record', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const text = '![ChromaticImages](/user/images/ci_123.png)\n';
    assert.equal(applyScript(script, text), '');
});

test('11. regex accepts leading horizontal indentation (spaces and tabs)', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const spaceIndented = '   <!-- CI_IMAGE {"characters":[],"prompt":"x"} -->\n';
    const tabIndented = '\t\t![ChromaticImages](/images/test.png)\n';
    const mixedIndented = ' \t <!-- CI_RESULT {"v":1,"characters":[],"prompt":"x","path":"/p.png"} -->\n';

    assert.equal(applyScript(script, spaceIndented), '');
    assert.equal(applyScript(script, tabIndented), '');
    assert.equal(applyScript(script, mixedIndented), '');
});

test('12. regex accepts trailing horizontal spaces', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const trailingSpaces = '<!-- CI_IMAGE {"characters":[],"prompt":"x"} -->   \t  \n';
    const trailingMarkdown = '![ChromaticImages](/images/test.png)   \n';

    assert.equal(applyScript(script, trailingSpaces), '');
    assert.equal(applyScript(script, trailingMarkdown), '');
});

test('13. regex supports LF and CRLF line breaks', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const lf = '<!-- CI_IMAGE {"characters":[],"prompt":"x"} -->\n';
    const crlf = '<!-- CI_IMAGE {"characters":[],"prompt":"x"} -->\r\n';

    assert.equal(applyScript(script, lf), '');
    assert.equal(applyScript(script, crlf), '');
});

test('14. regex removes standalone record at EOF without trailing newline', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const text = 'Prose before.\n<!-- CI_IMAGE {"characters":[],"prompt":"x"} -->';
    assert.equal(applyScript(script, text), 'Prose before.\n');
});

test('15. proposal-state behavior: removes CI_IMAGE while preserving surrounding prose', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const input = [
        'Some prose.',
        '',
        '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina by the window."} -->',
        '',
        'More prose.',
    ].join('\n');

    const result = applyScript(script, input);
    assert.equal(result.includes('CI_IMAGE'), false);
    assert.ok(result.includes('Some prose.'));
    assert.ok(result.includes('More prose.'));
    assert.equal(result, 'Some prose.\n\n\nMore prose.');
});

test('16. reviewable-state behavior: removes owned Markdown and CI_RESULT while preserving prose', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const input = [
        'Some roleplay prose.',
        '',
        '![ChromaticImages](/user/images/ci_123.png)',
        '',
        '<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"...","path":"/user/images/ci_123.png"} -->',
        '',
        'More prose.',
    ].join('\n');

    const result = applyScript(script, input);
    assert.equal(result.includes('![ChromaticImages]'), false);
    assert.equal(result.includes('CI_RESULT'), false);
    assert.ok(result.includes('Some roleplay prose.'));
    assert.ok(result.includes('More prose.'));
    assert.equal(result, 'Some roleplay prose.\n\n\n\nMore prose.');
});

test('17. finalized-state behavior: removes owned Markdown image while preserving prose', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const input = [
        'Some prose.',
        '',
        '![ChromaticImages](/user/images/final.png)',
        '',
        'More prose.',
    ].join('\n');

    const result = applyScript(script, input);
    assert.equal(result.includes('![ChromaticImages]'), false);
    assert.ok(result.includes('Some prose.'));
    assert.ok(result.includes('More prose.'));
    assert.equal(result, 'Some prose.\n\n\nMore prose.');
});

test('18. multiple owned records across message are all cleanly stripped', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const input = [
        'Introductory prose.',
        '![ChromaticImages](/user/images/pic1.png)',
        '<!-- CI_RESULT {"v":1,"characters":["A"],"prompt":"p1","path":"/user/images/pic1.png"} -->',
        'Interlude prose.',
        '<!-- CI_IMAGE {"characters":["B"],"prompt":"p2"} -->',
        'Concluding prose.',
        '![ChromaticImages](/user/images/pic2.png)',
    ].join('\n');

    const result = applyScript(script, input);
    assert.equal(result.includes('CI_IMAGE'), false);
    assert.equal(result.includes('CI_RESULT'), false);
    assert.equal(result.includes('![ChromaticImages]'), false);
    assert.equal(
        result,
        'Introductory prose.\nInterlude prose.\nConcluding prose.\n',
    );
});

test('19. regex preserves ordinary prose and ordinary markdown images', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const prose = 'Hina looked through the window.\n';
    const image = '![Hina](/images/hina.png)\n';

    assert.equal(applyScript(script, prose), prose);
    assert.equal(applyScript(script, image), image);
});

test('20. regex preserves unrelated Markdown images with prefix-matching alt text', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const backup = '![ChromaticImagesBackup](/images/foo.png)\n';
    const num = '![ChromaticImages2](/images/foo.png)\n';

    assert.equal(applyScript(script, backup), backup);
    assert.equal(applyScript(script, num), num);
});

test('21. regex preserves wrong-case alt text', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const lower = '![chromaticimages](/foo.png)\n';
    const upper = '![CHROMATICIMAGES](/foo.png)\n';

    assert.equal(applyScript(script, lower), lower);
    assert.equal(applyScript(script, upper), upper);
});

test('22. regex preserves unrelated comments such as Chromatic Dialogue records', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const cd = '<!-- CD_NEW {"id":"c1"} -->\n';
    const html = '<!-- Generic HTML comment -->\n';

    assert.equal(applyScript(script, cd), cd);
    assert.equal(applyScript(script, html), html);
});

test('23. regex preserves wrong-case CI markers', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const lower = '<!-- ci_image {...} -->\n';
    const mixed = '<!-- CI_image {...} -->\n';
    const resLower = '<!-- ci_result {...} -->\n';

    assert.equal(applyScript(script, lower), lower);
    assert.equal(applyScript(script, mixed), mixed);
    assert.equal(applyScript(script, resLower), resLower);
});

test('24. regex preserves inline CI_IMAGE and CI_RESULT mentions', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const inlineImage = 'She said <!-- CI_IMAGE {"characters":[],"prompt":"x"} --> as a joke.\n';
    const inlineResult = 'She said <!-- CI_RESULT {"v":1} --> as a joke.\n';
    const inlineMarkdown = 'Look at ![ChromaticImages](/path.png) here.\n';

    assert.equal(applyScript(script, inlineImage), inlineImage);
    assert.equal(applyScript(script, inlineResult), inlineResult);
    assert.equal(applyScript(script, inlineMarkdown), inlineMarkdown);
});

test('25. regex preserves record markers followed by trailing prose on the same line', () => {
    const script = MANAGED_REGEX_SCRIPTS[0];
    const trailingImage = '<!-- CI_IMAGE {"characters":[],"prompt":"x"} --> trailing prose\n';
    const trailingResult = '<!-- CI_RESULT {"v":1} --> trailing prose\n';
    const trailingMarkdown = '![ChromaticImages](/foo.png) trailing prose\n';
    const indentedTrailingImage = '    <!-- CI_IMAGE {"characters":[],"prompt":"x"} --> trailing prose\n';
    const noNewlineTrailing = '<!-- CI_IMAGE {"characters":[],"prompt":"x"} --> trailing prose';

    assert.equal(applyScript(script, trailingImage), trailingImage);
    assert.equal(applyScript(script, trailingResult), trailingResult);
    assert.equal(applyScript(script, trailingMarkdown), trailingMarkdown);
    assert.equal(applyScript(script, indentedTrailingImage), indentedTrailingImage);
    assert.equal(applyScript(script, noNewlineTrailing), noNewlineTrailing);
});


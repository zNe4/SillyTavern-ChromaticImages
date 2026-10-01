import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { inspectActiveImageMessage } from '../src/message-inspector.js';

afterEach(() => {
    delete globalThis.SillyTavern;
});

// Helper to set up a static SillyTavern mock
function mockSillyTavernContext(chatId, chat) {
    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId,
                chat,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// 1. Reader / Ignore behavior
// ---------------------------------------------------------------------------

test('invalid message ID returns ignored with invalid-message-id', () => {
    mockSillyTavernContext('chat-1', [{ mes: 'Assistant message', is_user: false }]);

    assert.deepEqual(inspectActiveImageMessage(-1), {
        status: 'ignored',
        reason: 'invalid-message-id',
    });
    assert.deepEqual(inspectActiveImageMessage('invalid'), {
        status: 'ignored',
        reason: 'invalid-message-id',
    });
    assert.deepEqual(inspectActiveImageMessage(null), {
        status: 'ignored',
        reason: 'invalid-message-id',
    });
    assert.deepEqual(inspectActiveImageMessage(undefined), {
        status: 'ignored',
        reason: 'invalid-message-id',
    });
});

test('missing SillyTavern or no chat returns ignored with no-chat', () => {
    delete globalThis.SillyTavern;
    assert.deepEqual(inspectActiveImageMessage(0), {
        status: 'ignored',
        reason: 'no-chat',
    });

    globalThis.SillyTavern = {
        getContext() {
            return { chatId: null, chat: [] };
        },
    };
    assert.deepEqual(inspectActiveImageMessage(0), {
        status: 'ignored',
        reason: 'no-chat',
    });
});

test('missing message index returns ignored with message-missing', () => {
    mockSillyTavernContext('chat-1', [{ mes: 'Only message', is_user: false }]);

    assert.deepEqual(inspectActiveImageMessage(5), {
        status: 'ignored',
        reason: 'message-missing',
    });
});

test('user message returns ignored with not-assistant-message', () => {
    mockSillyTavernContext('chat-1', [{ mes: 'User message', is_user: true }]);

    assert.deepEqual(inspectActiveImageMessage(0), {
        status: 'ignored',
        reason: 'not-assistant-message',
    });
});

test('system message returns ignored with not-assistant-message', () => {
    mockSillyTavernContext('chat-1', [{ mes: 'System prompt', is_system: true }]);

    assert.deepEqual(inspectActiveImageMessage(0), {
        status: 'ignored',
        reason: 'not-assistant-message',
    });
});

test('invalid mes payload returns ignored with invalid-message', () => {
    mockSillyTavernContext('chat-1', [{ mes: 12345, is_user: false }]);

    assert.deepEqual(inspectActiveImageMessage(0), {
        status: 'ignored',
        reason: 'invalid-message',
    });
});

// ---------------------------------------------------------------------------
// 2. Empty state
// ---------------------------------------------------------------------------

test('normal assistant prose returns empty', () => {
    mockSillyTavernContext('chat-1', [{ mes: 'She smiled gently and waved.', is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'empty',
        chatId: 'chat-1',
        messageId: 0,
    });
});

test('empty assistant string returns empty', () => {
    mockSillyTavernContext('chat-1', [{ mes: '', is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'empty',
        chatId: 'chat-1',
        messageId: 0,
    });
});

test('unrelated HTML comments return empty', () => {
    const raw = 'Prose before\n<!-- unrelated comment {"foo":"bar"} -->\nProse after';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'empty',
        chatId: 'chat-1',
        messageId: 0,
    });
});

test('unrelated Markdown returns empty', () => {
    const raw = 'Here is an image: ![Cat](https://example.com/cat.jpg)\nAnd a link: [Google](https://google.com)';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'empty',
        chatId: 'chat-1',
        messageId: 0,
    });
});

test('CD_NEW only returns empty', () => {
    const raw = 'Roleplay prose.\n\n<!-- CD_NEW {"id":"c1","name":"Hina","color":"#ff0000"} -->\n\nMore dialogue.';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'empty',
        chatId: 'chat-1',
        messageId: 0,
    });
});

// ---------------------------------------------------------------------------
// 3. Proposal state
// ---------------------------------------------------------------------------

test('one valid CI_IMAGE returns proposal with metadata preserved', () => {
    const rawComment = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina looks over her shoulder."} -->';
    const raw = `Prose\n\n${rawComment}\n\nMore prose`;
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'proposal');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.proposal.characters, ['Hina']);
    assert.strictEqual(result.proposal.prompt, 'Hina looks over her shoulder.');
    assert.strictEqual(result.proposal.raw, rawComment);
    assert.strictEqual(result.proposal.start, raw.indexOf(rawComment));
    assert.strictEqual(result.proposal.end, raw.indexOf(rawComment) + rawComment.length);
});

test('valid CI_IMAGE beside unrelated CD_NEW returns proposal', () => {
    const raw = 'Roleplay prose.\n\n<!-- CD_NEW {"id":"c1","name":"Hina","color":"#ff0000"} -->\n\n<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina looks over her shoulder."} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'proposal');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.proposal.characters, ['Hina']);
    assert.strictEqual(result.proposal.prompt, 'Hina looks over her shoulder.');
});

// ---------------------------------------------------------------------------
// 4. Proposal protocol errors
// ---------------------------------------------------------------------------

test('malformed CI_IMAGE JSON returns invalid-protocol', () => {
    const raw = '<!-- CI_IMAGE {not-valid-json} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['invalid-json']);
});

test('invalid proposal schema returns invalid-protocol', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"]} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['invalid-proposal-shape']);
});

test('invalid duplicate character returns invalid-protocol', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina","hina"],"prompt":"Looking back"} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['duplicate-character']);
});

// ---------------------------------------------------------------------------
// 5. Durable states
// ---------------------------------------------------------------------------

test('one Markdown + matching CI_RESULT returns reviewable-result with metadata preserved', () => {
    const mdRaw = '![ChromaticImages](/images/gen1.png)';
    const resultRaw = '<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Looking back","path":"/images/gen1.png"} -->';
    const raw = `Prose\n\n${mdRaw}\n${resultRaw}\n\nTrailing prose`;
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'reviewable-result');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.strictEqual(result.result.v, 1);
    assert.deepEqual(result.result.characters, ['Hina']);
    assert.strictEqual(result.result.prompt, 'Looking back');
    assert.strictEqual(result.result.path, '/images/gen1.png');
    assert.strictEqual(result.result.markdown.raw, mdRaw);
    assert.strictEqual(result.result.result.raw, resultRaw);
    assert.strictEqual(result.result.blockStart, raw.indexOf(mdRaw));
    assert.strictEqual(result.result.blockEnd, raw.indexOf(resultRaw) + resultRaw.length);
});

test('one Markdown-only owned image returns finalized-result without invented metadata', () => {
    const mdRaw = '![ChromaticImages](/images/final.png)';
    const raw = `Prose\n\n${mdRaw}\n\nMore text`;
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'finalized-result');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.strictEqual(result.image.path, '/images/final.png');
    assert.strictEqual(result.image.raw, mdRaw);
    assert.strictEqual(result.image.start, raw.indexOf(mdRaw));
    assert.strictEqual(result.image.end, raw.indexOf(mdRaw) + mdRaw.length);
    assert.strictEqual('prompt' in result.image, false);
    assert.strictEqual('characters' in result.image, false);
});

// ---------------------------------------------------------------------------
// 6. Durable protocol errors
// ---------------------------------------------------------------------------

test('malformed CI_RESULT returns invalid-protocol', () => {
    const raw = '![ChromaticImages](/images/gen1.png)\n<!-- CI_RESULT {not-json} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['invalid-result-json']);
});

test('path mismatch between Markdown and CI_RESULT returns invalid-protocol', () => {
    const raw = '![ChromaticImages](/images/a.png)\n<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Test","path":"/images/b.png"} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['result-path-mismatch']);
});

test('malformed exact ChromaticImages Markdown returns invalid-protocol', () => {
    const raw = '![ChromaticImages](https://external.com/photo.png)';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['malformed-image-record']);
});

test('unpaired CI_RESULT returns invalid-protocol', () => {
    const raw = '<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Test","path":"/images/gen1.png"} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['unpaired-result-record']);
});

// ---------------------------------------------------------------------------
// 7. Fail-closed cross-protocol behavior
// ---------------------------------------------------------------------------

test('valid CI_IMAGE plus malformed CI_RESULT returns invalid-protocol', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Test"} -->\n\n<!-- CI_RESULT {broken} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['invalid-result-json']);
});

test('malformed CI_IMAGE (unclosed) plus valid finalized image returns invalid-protocol', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"}\n\n![ChromaticImages](/images/gen1.png)';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['malformed-control-record']);
});

test('malformed CI_IMAGE (invalid JSON) plus valid finalized image returns invalid-protocol', () => {
    const raw = '<!-- CI_IMAGE {not-valid-json} -->\n\n![ChromaticImages](/images/gen1.png)';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.strictEqual(result.chatId, 'chat-1');
    assert.strictEqual(result.messageId, 0);
    assert.deepEqual(result.errors, ['invalid-json']);
});

test('deterministic error ordering across subsystems with deduplication', () => {
    // proposal parse error (invalid-json) + durable parse error (invalid-result-json)
    const raw = '<!-- CI_IMAGE {not-json} -->\n<!-- CI_RESULT {not-json} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.deepEqual(result.errors, ['invalid-json', 'invalid-result-json']);
});

test('deterministic error ordering: proposal validation error before durable parse error', () => {
    // proposal parsing succeeds, proposal validation fails (duplicate-character), durable parse fails (invalid-result-json)
    const raw = '<!-- CI_IMAGE {"characters":["Hina","hina"],"prompt":"Hello"} -->\n<!-- CI_RESULT {bad-json} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'invalid-protocol');
    assert.deepEqual(result.errors, ['duplicate-character', 'invalid-result-json']);
});

test('mixed states are unsupported-multiple and not invalid-protocol', () => {
    // CI_IMAGE + Markdown (1 proposal + 1 finalized)
    const raw1 = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->\n![ChromaticImages](/images/a.png)';
    mockSillyTavernContext('chat-1', [{ mes: raw1, is_user: false }]);
    const res1 = inspectActiveImageMessage(0);
    assert.strictEqual(res1.status, 'unsupported-multiple');
    assert.notStrictEqual(res1.status, 'invalid-protocol');

    // CI_IMAGE + Markdown + CI_RESULT (1 proposal + 1 reviewable)
    const raw2 = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->\n![ChromaticImages](/images/a.png)\n<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Hello","path":"/images/a.png"} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw2, is_user: false }]);
    const res2 = inspectActiveImageMessage(0);
    assert.strictEqual(res2.status, 'unsupported-multiple');
    assert.notStrictEqual(res2.status, 'invalid-protocol');
});

test('chat ID equality uses direct identity without string normalization', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    chatId: 101, // numeric ID
                    chat: [{ mes: rawProposal, is_user: false }],
                };
            }
            return {
                chatId: '101', // string representation of same number
                chat: [{ mes: rawProposal, is_user: false }],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    // 101 !== '101' in direct identity
    assert.deepEqual(result, {
        status: 'chat-changed',
        chatId: 101,
        messageId: 0,
        currentChatId: '101',
    });
});

// ---------------------------------------------------------------------------
// 8. Unified one-image MVP policy (unsupported-multiple)
// ---------------------------------------------------------------------------

test('2 proposals return unsupported-multiple with exact counts', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"First"} -->\n<!-- CI_IMAGE {"characters":["Yuu"],"prompt":"Second"} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'unsupported-multiple',
        chatId: 'chat-1',
        messageId: 0,
        counts: {
            proposals: 2,
            reviewable: 0,
            finalized: 0,
        },
    });
});

test('1 proposal + 1 finalized return unsupported-multiple with exact counts', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"First"} -->\n\n![ChromaticImages](/images/pic.png)';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'unsupported-multiple',
        chatId: 'chat-1',
        messageId: 0,
        counts: {
            proposals: 1,
            reviewable: 0,
            finalized: 1,
        },
    });
});

test('1 proposal + 1 reviewable return unsupported-multiple with exact counts', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"First"} -->\n\n![ChromaticImages](/images/pic.png)\n<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Done","path":"/images/pic.png"} -->';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'unsupported-multiple',
        chatId: 'chat-1',
        messageId: 0,
        counts: {
            proposals: 1,
            reviewable: 1,
            finalized: 0,
        },
    });
});

test('2 finalized return unsupported-multiple with exact counts', () => {
    const raw = '![ChromaticImages](/images/pic1.png)\n\n![ChromaticImages](/images/pic2.png)';
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'unsupported-multiple',
        chatId: 'chat-1',
        messageId: 0,
        counts: {
            proposals: 0,
            reviewable: 0,
            finalized: 2,
        },
    });
});

test('2 reviewable return unsupported-multiple with exact counts', () => {
    const raw = [
        '![ChromaticImages](/images/pic1.png)',
        '<!-- CI_RESULT {"v":1,"characters":["A"],"prompt":"Prompt A","path":"/images/pic1.png"} -->',
        '',
        '![ChromaticImages](/images/pic2.png)',
        '<!-- CI_RESULT {"v":1,"characters":["B"],"prompt":"Prompt B","path":"/images/pic2.png"} -->',
    ].join('\n');
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'unsupported-multiple',
        chatId: 'chat-1',
        messageId: 0,
        counts: {
            proposals: 0,
            reviewable: 2,
            finalized: 0,
        },
    });
});

test('1 finalized + 1 reviewable return unsupported-multiple with exact counts', () => {
    const raw = [
        '![ChromaticImages](/images/final.png)',
        '',
        '![ChromaticImages](/images/review.png)',
        '<!-- CI_RESULT {"v":1,"characters":["A"],"prompt":"Prompt A","path":"/images/review.png"} -->',
    ].join('\n');
    mockSillyTavernContext('chat-1', [{ mes: raw, is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'unsupported-multiple',
        chatId: 'chat-1',
        messageId: 0,
        counts: {
            proposals: 0,
            reviewable: 1,
            finalized: 1,
        },
    });
});

// ---------------------------------------------------------------------------
// 9. Chat-switch safety tests
// ---------------------------------------------------------------------------

test('chat changes after source read returns chat-changed with new chatId', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    chatId: 'chat-a',
                    chat: [{ mes: rawProposal, is_user: false }],
                };
            }
            return {
                chatId: 'chat-b',
                chat: [{ mes: rawProposal, is_user: false }],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'chat-changed',
        chatId: 'chat-a',
        messageId: 0,
        currentChatId: 'chat-b',
    });
    assert.strictEqual(callCount, 2);
});

test('current chat disappears (chatId becomes null) returns chat-changed with currentChatId null', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    chatId: 'chat-a',
                    chat: [{ mes: rawProposal, is_user: false }],
                };
            }
            return {
                chatId: null,
                chat: [],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'chat-changed',
        chatId: 'chat-a',
        messageId: 0,
        currentChatId: null,
    });
    assert.strictEqual(callCount, 2);
});

test('current chat disappears (chatId becomes undefined) returns chat-changed with currentChatId null', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    chatId: 'chat-a',
                    chat: [{ mes: rawProposal, is_user: false }],
                };
            }
            return {
                chatId: undefined,
                chat: [],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'chat-changed',
        chatId: 'chat-a',
        messageId: 0,
        currentChatId: null,
    });
    assert.strictEqual(callCount, 2);
});

test('second getContext throws returns ignored with context-unavailable without throwing', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    chatId: 'chat-a',
                    chat: [{ mes: rawProposal, is_user: false }],
                };
            }
            throw new Error('Context error during second call');
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'ignored',
        reason: 'context-unavailable',
        chatId: 'chat-a',
        messageId: 0,
    });
    assert.strictEqual(callCount, 2);
});

test('second getContext unavailable (SillyTavern removed) returns ignored with context-unavailable', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            delete globalThis.SillyTavern;
            return {
                chatId: 'chat-a',
                chat: [{ mes: rawProposal, is_user: false }],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'ignored',
        reason: 'context-unavailable',
        chatId: 'chat-a',
        messageId: 0,
    });
});

test('same chat proceeds with normal classification', () => {
    let callCount = 0;
    const rawProposal = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            return {
                chatId: 'chat-same',
                chat: [{ mes: rawProposal, is_user: false }],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'proposal');
    assert.strictEqual(result.chatId, 'chat-same');
    assert.strictEqual(callCount, 2);
});

// ---------------------------------------------------------------------------
// 10. Classification precedence test
// ---------------------------------------------------------------------------

test('classification precedence: chat-changed takes precedence over malformed protocol diagnostics', () => {
    let callCount = 0;
    // Malformed CI_IMAGE JSON
    const malformedRaw = '<!-- CI_IMAGE {not-valid-json} -->';

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            if (callCount === 1) {
                return {
                    chatId: 'chat-original',
                    chat: [{ mes: malformedRaw, is_user: false }],
                };
            }
            return {
                chatId: 'chat-switched',
                chat: [{ mes: 'different message', is_user: false }],
            };
        },
    };

    const result = inspectActiveImageMessage(0);
    assert.deepEqual(result, {
        status: 'chat-changed',
        chatId: 'chat-original',
        messageId: 0,
        currentChatId: 'chat-switched',
    });
});

// ---------------------------------------------------------------------------
// 11. Immutability and sync guarantees
// ---------------------------------------------------------------------------

test('function is synchronous and does not return a Promise', () => {
    mockSillyTavernContext('chat-1', [{ mes: 'Hello', is_user: false }]);

    const result = inspectActiveImageMessage(0);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result instanceof Promise, false);
    assert.strictEqual(typeof result?.then, 'undefined');
    assert.strictEqual(result.status, 'empty');
});

test('source chat array and message object are not mutated', () => {
    const raw = '<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hello"} -->';
    const messageObj = Object.freeze({ mes: raw, is_user: false });
    const chatArray = Object.freeze([messageObj]);

    mockSillyTavernContext('chat-1', chatArray);

    const result = inspectActiveImageMessage(0);
    assert.strictEqual(result.status, 'proposal');
    assert.strictEqual(messageObj.mes, raw);
    assert.strictEqual(chatArray.length, 1);
});

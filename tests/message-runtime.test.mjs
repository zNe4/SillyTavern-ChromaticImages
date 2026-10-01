import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

let testRunIndex = 0;

/**
 * Load a fresh instance of message-runtime.js with independent registration state.
 *
 * @returns {Promise<{
 *     registerMessageRuntime: () => { status: string },
 *     refreshRenderedImageMessages: () => { status: string, inspected?: number, rendered?: number }
 * }>}
 */
async function loadFreshMessageRuntime() {
    testRunIndex += 1;
    const moduleUrl = new URL(
        `../src/message-runtime.js?test=${testRunIndex}_${Date.now()}`,
        import.meta.url,
    );
    return await import(moduleUrl);
}

function createFakeEventSource() {
    const handlers = new Map();

    return {
        on(event, handler) {
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },
        getHandlers(event) {
            return handlers.get(event) ?? [];
        },
    };
}

class FakeNode {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName ? tagName.toUpperCase() : 'DIV';
        this.ownerDocument = ownerDocument;
        this.parentNode = null;
        this.children = [];
        this.attributes = new Map();
        this._textContent = '';
        this.type = tagName && tagName.toLowerCase() === 'button' ? 'button' : '';
    }

    get className() {
        return this.getAttribute('class') || '';
    }

    set className(val) {
        this.setAttribute('class', val);
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    hasAttribute(name) {
        return this.attributes.has(name);
    }

    get nextSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.children.indexOf(this);
        if (idx === -1 || idx >= this.parentNode.children.length - 1) return null;
        return this.parentNode.children[idx + 1];
    }

    appendChild(child) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    insertBefore(newChild, refChild) {
        if (!refChild) {
            return this.appendChild(newChild);
        }
        const idx = this.children.indexOf(refChild);
        if (idx === -1) {
            return this.appendChild(newChild);
        }
        if (newChild.parentNode) {
            newChild.parentNode.removeChild(newChild);
        }
        newChild.parentNode = this;
        this.children.splice(idx, 0, newChild);
        return newChild;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }

    insertAdjacentElement(position, element) {
        if (position === 'afterend') {
            if (!this.parentNode) throw new Error('Cannot insert afterend without parentNode');
            return this.parentNode.insertBefore(element, this.nextSibling);
        }
        if (position === 'beforebegin') {
            if (!this.parentNode) throw new Error('Cannot insert beforebegin without parentNode');
            return this.parentNode.insertBefore(element, this);
        }
        if (position === 'afterbegin') {
            return this.insertBefore(element, this.children[0] || null);
        }
        if (position === 'beforeend') {
            return this.appendChild(element);
        }
        throw new Error(`Unsupported position: ${position}`);
    }

    get textContent() {
        if (this.children.length === 0) {
            return this._textContent;
        }
        return this.children.map((c) => c.textContent).join('');
    }

    set textContent(val) {
        for (const child of [...this.children]) {
            child.parentNode = null;
        }
        this.children = [];
        this._textContent = String(val);
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        return querySelectorAllFrom(this, selector);
    }
}

function matchesCompound(el, compound) {
    if (!el || typeof el.getAttribute !== 'function') return false;

    let remaining = compound;

    const idMatch = remaining.match(/^#([a-zA-Z0-9_-]+)/);
    if (idMatch) {
        if (el.getAttribute('id') !== idMatch[1]) return false;
        remaining = remaining.slice(idMatch[0].length);
    }

    const tagMatch = remaining.match(/^([a-zA-Z0-9]+)/);
    if (tagMatch) {
        if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
        remaining = remaining.slice(tagMatch[0].length);
    }

    while (remaining.startsWith('.')) {
        const classMatch = remaining.match(/^\.([a-zA-Z0-9_-]+)/);
        if (!classMatch) break;
        const classes = (el.className || '').split(/\s+/).filter(Boolean);
        if (!classes.includes(classMatch[1])) return false;
        remaining = remaining.slice(classMatch[0].length);
    }

    while (remaining.startsWith('[')) {
        const attrMatch = remaining.match(/^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/);
        if (!attrMatch) break;
        const attrName = attrMatch[1];
        const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
        if (attrVal === undefined) {
            if (!el.hasAttribute(attrName)) return false;
        } else {
            if (el.getAttribute(attrName) !== attrVal) return false;
        }
        remaining = remaining.slice(attrMatch[0].length);
    }

    return remaining.length === 0;
}

function querySelectorAllFrom(root, selector) {
    const parts = selector.trim().split(/\s+/);
    if (parts.length === 1) {
        const results = [];
        function walk(node) {
            for (const child of node.children) {
                if (matchesCompound(child, parts[0])) {
                    results.push(child);
                }
                walk(child);
            }
        }
        walk(root);
        return results;
    }
    if (parts.length === 2) {
        const [first, second] = parts;
        const firstMatches = [];
        function walkFirst(node) {
            for (const child of node.children) {
                if (matchesCompound(child, first)) {
                    firstMatches.push(child);
                }
                walkFirst(child);
            }
        }

        if (matchesCompound(root, first)) {
            firstMatches.push(root);
        } else {
            walkFirst(root);
        }

        const results = [];
        for (const ancestor of firstMatches) {
            function walkSecond(node) {
                for (const child of node.children) {
                    if (matchesCompound(child, second)) {
                        results.push(child);
                    }
                    walkSecond(child);
                }
            }
            walkSecond(ancestor);
        }
        return results;
    }
    throw new Error(`Unsupported selector in test mock: ${selector}`);
}

class FakeDocument {
    constructor() {
        this.children = [];
    }

    createElement(tagName) {
        return new FakeNode(tagName, this);
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    querySelector(selector) {
        return querySelectorAllFrom(this, selector)[0] || null;
    }

    querySelectorAll(selector) {
        return querySelectorAllFrom(this, selector);
    }
}

function createTestChatDOM(doc, messages) {
    const chatContainer = doc.createElement('div');
    chatContainer.setAttribute('id', 'chat');
    doc.appendChild(chatContainer);

    for (const msg of messages) {
        const mesNode = doc.createElement('div');
        mesNode.className = 'mes';
        mesNode.setAttribute('mesid', String(msg.mesid));

        const textNode = doc.createElement('div');
        textNode.className = 'mes_text';
        textNode.textContent = msg.text || '';
        mesNode.appendChild(textNode);

        chatContainer.appendChild(mesNode);
    }

    return chatContainer;
}

afterEach(() => {
    delete globalThis.SillyTavern;
    delete globalThis.document;
});

// ---------------------------------------------------------------------------
// 1. Registration tests
// ---------------------------------------------------------------------------

test('1. Registration fails safely when SillyTavern is unavailable', async () => {
    delete globalThis.SillyTavern;
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'unavailable' });
});

test('2. Registration fails safely when getContext() throws', async () => {
    globalThis.SillyTavern = {
        getContext() {
            throw new Error('context failure');
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'unavailable' });
});

test('3. Registration fails safely when eventSource is missing', async () => {
    globalThis.SillyTavern = {
        getContext() {
            return { eventTypes: { CHARACTER_MESSAGE_RENDERED: 'cmr' } };
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'unavailable' });
});

test('4. Registration fails safely when CHARACTER_MESSAGE_RENDERED is missing or invalid', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return { eventSource, eventTypes: { CHARACTER_MESSAGE_RENDERED: '' } };
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'unavailable' });
});

test('5. Registration supports eventTypes and event_types and symbols', async () => {
    // 5a. eventTypes
    {
        const eventSource = createFakeEventSource();
        const cmrSymbol = Symbol('CHARACTER_MESSAGE_RENDERED');
        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    eventTypes: { CHARACTER_MESSAGE_RENDERED: cmrSymbol },
                };
            },
        };
        const { registerMessageRuntime } = await loadFreshMessageRuntime();
        assert.deepEqual(registerMessageRuntime(), { status: 'registered' });
        assert.strictEqual(eventSource.getHandlers(cmrSymbol).length, 1);
    }

    // 5b. event_types
    {
        const eventSource = createFakeEventSource();
        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    event_types: { CHARACTER_MESSAGE_RENDERED: 'char_rendered' },
                };
            },
        };
        const { registerMessageRuntime } = await loadFreshMessageRuntime();
        assert.deepEqual(registerMessageRuntime(), { status: 'registered' });
        assert.strictEqual(eventSource.getHandlers('char_rendered').length, 1);
    }
});

test('6. Registration idempotency: repeated calls return already-registered without duplicating handlers', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                    MESSAGE_SWIPED: 'ms',
                    MESSAGE_UPDATED: 'mu',
                },
            };
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'registered' });
    assert.deepEqual(registerMessageRuntime(), { status: 'already-registered' });

    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
    assert.strictEqual(eventSource.getHandlers('ms').length, 1);
    assert.strictEqual(eventSource.getHandlers('mu').length, 1);
});

test('7. Registration never registers MESSAGE_RECEIVED', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                    MESSAGE_RECEIVED: 'msg_recv',
                },
            };
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    registerMessageRuntime();
    assert.strictEqual(eventSource.getHandlers('msg_recv').length, 0);
});

test('8. Absence of optional events still allows registration', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                },
            };
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'registered' });
    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
});

test('9. Duplicate event identifiers do not register duplicate handlers', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'shared_event',
                    MESSAGE_SWIPED: 'shared_event',
                    MESSAGE_UPDATED: 'shared_event',
                },
            };
        },
    };
    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'registered' });
    assert.strictEqual(eventSource.getHandlers('shared_event').length, 1);
});

test('9a. Required event registration throws: returns unavailable, does not throw, remains retryable', async () => {
    let shouldThrow = true;
    const handlers = new Map();
    const eventSource = {
        on(event, handler) {
            if (shouldThrow && event === 'cmr') {
                throw new Error('registration failed');
            }
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },
        getHandlers(event) {
            return handlers.get(event) ?? [];
        },
    };

    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                    MESSAGE_SWIPED: 'ms',
                },
            };
        },
    };

    const { registerMessageRuntime } = await loadFreshMessageRuntime();

    assert.doesNotThrow(() => {
        const res = registerMessageRuntime();
        assert.deepEqual(res, { status: 'unavailable' });
    });

    assert.strictEqual(eventSource.getHandlers('cmr').length, 0);
    assert.strictEqual(eventSource.getHandlers('ms').length, 0);

    // Subsequent call should retry, not return already-registered
    shouldThrow = false;
    const retryRes = registerMessageRuntime();
    assert.deepEqual(retryRes, { status: 'registered' });
    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
    assert.strictEqual(eventSource.getHandlers('ms').length, 1);
});

test('9b. Optional event registration throws (MESSAGE_SWIPED throws): required remains registered, finishes registered and idempotent', async () => {
    const handlers = new Map();
    const eventSource = {
        on(event, handler) {
            if (event === 'ms') {
                throw new Error('swipe listener error');
            }
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },
        getHandlers(event) {
            return handlers.get(event) ?? [];
        },
    };

    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                    MESSAGE_SWIPED: 'ms',
                    MESSAGE_UPDATED: 'mu',
                },
            };
        },
    };

    const { registerMessageRuntime } = await loadFreshMessageRuntime();

    assert.doesNotThrow(() => {
        const res = registerMessageRuntime();
        assert.deepEqual(res, { status: 'registered' });
    });

    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
    assert.strictEqual(eventSource.getHandlers('ms').length, 0);
    assert.strictEqual(eventSource.getHandlers('mu').length, 1);

    // Second call returns already-registered and does not duplicate required handler
    const secondRes = registerMessageRuntime();
    assert.deepEqual(secondRes, { status: 'already-registered' });
    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
});

test('9c. Optional event registration throws (MESSAGE_UPDATED throws): symmetric case', async () => {
    const handlers = new Map();
    const eventSource = {
        on(event, handler) {
            if (event === 'mu') {
                throw new Error('update listener error');
            }
            if (!handlers.has(event)) {
                handlers.set(event, []);
            }
            handlers.get(event).push(handler);
        },
        getHandlers(event) {
            return handlers.get(event) ?? [];
        },
    };

    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                    MESSAGE_SWIPED: 'ms',
                    MESSAGE_UPDATED: 'mu',
                },
            };
        },
    };

    const { registerMessageRuntime } = await loadFreshMessageRuntime();

    assert.doesNotThrow(() => {
        const res = registerMessageRuntime();
        assert.deepEqual(res, { status: 'registered' });
    });

    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
    assert.strictEqual(eventSource.getHandlers('ms').length, 1);
    assert.strictEqual(eventSource.getHandlers('mu').length, 0);

    const secondRes = registerMessageRuntime();
    assert.deepEqual(secondRes, { status: 'already-registered' });
    assert.strictEqual(eventSource.getHandlers('cmr').length, 1);
});

test('9d. Mixed event tables: required in event_types and optionals in eventTypes', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                event_types: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr_legacy',
                },
                eventTypes: {
                    MESSAGE_SWIPED: 'swiped_modern',
                    MESSAGE_UPDATED: 'updated_modern',
                },
            };
        },
    };

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'registered' });

    assert.strictEqual(eventSource.getHandlers('cmr_legacy').length, 1);
    assert.strictEqual(eventSource.getHandlers('swiped_modern').length, 1);
    assert.strictEqual(eventSource.getHandlers('updated_modern').length, 1);
});

test('9e. Mixed event tables inverse: required in eventTypes and optionals in event_types', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr_modern',
                },
                event_types: {
                    MESSAGE_SWIPED: 'swiped_legacy',
                    MESSAGE_UPDATED: 'updated_legacy',
                },
            };
        },
    };

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'registered' });

    assert.strictEqual(eventSource.getHandlers('cmr_modern').length, 1);
    assert.strictEqual(eventSource.getHandlers('swiped_legacy').length, 1);
    assert.strictEqual(eventSource.getHandlers('updated_legacy').length, 1);
});

test('9f. Precedence when both tables contain the same event name: prefers event_types before eventTypes', async () => {
    const eventSource = createFakeEventSource();
    globalThis.SillyTavern = {
        getContext() {
            return {
                eventSource,
                event_types: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr_pref_legacy',
                    MESSAGE_SWIPED: 'ms_pref_legacy',
                    MESSAGE_UPDATED: 'mu_pref_legacy',
                },
                eventTypes: {
                    CHARACTER_MESSAGE_RENDERED: 'cmr_pref_modern',
                    MESSAGE_SWIPED: 'ms_pref_modern',
                    MESSAGE_UPDATED: 'mu_pref_modern',
                },
            };
        },
    };

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    assert.deepEqual(registerMessageRuntime(), { status: 'registered' });

    // Legacy event_types must be preferred
    assert.strictEqual(eventSource.getHandlers('cmr_pref_legacy').length, 1);
    assert.strictEqual(eventSource.getHandlers('cmr_pref_modern').length, 0);

    assert.strictEqual(eventSource.getHandlers('ms_pref_legacy').length, 1);
    assert.strictEqual(eventSource.getHandlers('ms_pref_modern').length, 0);

    assert.strictEqual(eventSource.getHandlers('mu_pref_legacy').length, 1);
    assert.strictEqual(eventSource.getHandlers('mu_pref_modern').length, 0);
});


// ---------------------------------------------------------------------------
// 2. Per-message render event tests
// ---------------------------------------------------------------------------

test('10. CHARACTER_MESSAGE_RENDERED reconciles proposal message into exactly one proposal card', async () => {
    const eventSource = createFakeEventSource();
    const eventTypes = {
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    };

    const chat = [
        {
            mes: 'Hello!\n\n<!-- CI_IMAGE {"characters":["Alice"],"prompt":"a serene forest clearing"} -->',
            is_user: false,
        },
    ];

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'chat-main',
                chat,
                eventSource,
                eventTypes,
            };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    createTestChatDOM(doc, [{ mesid: 0, text: 'Hello!' }]);

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    registerMessageRuntime();

    const [handler] = eventSource.getHandlers(eventTypes.CHARACTER_MESSAGE_RENDERED);
    assert.strictEqual(typeof handler, 'function');

    // First render
    handler(0);

    const mesNode = doc.querySelector('#chat .mes[mesid="0"]');
    const cards = mesNode.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].getAttribute('data-chromatic-images-state'), 'proposal');

    // Repeated render event: remains exactly one
    handler(0);
    const cardsAfter = mesNode.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(cardsAfter.length, 1);
});

test('11. CHARACTER_MESSAGE_RENDERED reconciles reviewable result and cleans up finalized result', async () => {
    const eventSource = createFakeEventSource();
    const eventTypes = {
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    };

    const chat = [
        // Index 0: Reviewable result
        {
            mes: 'Artwork generated.\n\n![ChromaticImages](/user/images/forest.png)\n<!-- CI_RESULT {"v":1,"path":"/user/images/forest.png","characters":["Alice"],"prompt":"a forest"} -->',
            is_user: false,
        },
        // Index 1: Finalized result (Markdown image only, no CI_RESULT)
        {
            mes: 'Final image.\n\n![ChromaticImages](/user/images/final.png)',
            is_user: false,
        },
    ];

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'chat-main',
                chat,
                eventSource,
                eventTypes,
            };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    createTestChatDOM(doc, [
        { mesid: 0, text: 'Artwork generated.' },
        { mesid: 1, text: 'Final image.' },
    ]);

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    registerMessageRuntime();

    const [handler] = eventSource.getHandlers(eventTypes.CHARACTER_MESSAGE_RENDERED);

    // Reconcile message 0 (reviewable)
    handler(0);
    const mes0 = doc.querySelector('#chat .mes[mesid="0"]');
    const cards0 = mes0.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(cards0.length, 1);
    assert.strictEqual(cards0[0].getAttribute('data-chromatic-images-state'), 'reviewable-result');

    // Reconcile message 1 (finalized)
    handler(1);
    const mes1 = doc.querySelector('#chat .mes[mesid="1"]');
    const cards1 = mes1.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(cards1.length, 0);
});

// ---------------------------------------------------------------------------
// 3. Optional event tests
// ---------------------------------------------------------------------------

test('12. MESSAGE_SWIPED and MESSAGE_UPDATED reconcile through the same idempotent path', async () => {
    const eventSource = createFakeEventSource();
    const eventTypes = {
        CHARACTER_MESSAGE_RENDERED: 'cmr',
        MESSAGE_SWIPED: 'ms',
        MESSAGE_UPDATED: 'mu',
    };

    const chat = [
        {
            mes: 'Swipe message\n\n<!-- CI_IMAGE {"characters":["Bob"],"prompt":"a city street"} -->',
            is_user: false,
        },
    ];

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'chat-main',
                chat,
                eventSource,
                eventTypes,
            };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    createTestChatDOM(doc, [{ mesid: 0, text: 'Swipe message' }]);

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    registerMessageRuntime();

    const [swipeHandler] = eventSource.getHandlers(eventTypes.MESSAGE_SWIPED);
    const [updateHandler] = eventSource.getHandlers(eventTypes.MESSAGE_UPDATED);

    swipeHandler(0);
    const mes = doc.querySelector('#chat .mes[mesid="0"]');
    let cards = mes.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].getAttribute('data-chromatic-images-state'), 'proposal');

    updateHandler(0);
    cards = mes.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(cards.length, 1);
});

// ---------------------------------------------------------------------------
// 4. Missing DOM and Stale-chat tests
// ---------------------------------------------------------------------------

test('13. Missing DOM node does not throw, create synthetic elements, or use timers', async () => {
    const eventSource = createFakeEventSource();
    const eventTypes = { CHARACTER_MESSAGE_RENDERED: 'cmr' };

    const chat = [
        {
            mes: 'Proposal\n\n<!-- CI_IMAGE {"characters":["Eve"],"prompt":"portrait"} -->',
            is_user: false,
        },
    ];

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'chat-main',
                chat,
                eventSource,
                eventTypes,
            };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    // Empty #chat without mesid 0
    const chatContainer = doc.createElement('div');
    chatContainer.setAttribute('id', 'chat');
    doc.appendChild(chatContainer);

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    registerMessageRuntime();

    const [handler] = eventSource.getHandlers('cmr');

    assert.doesNotThrow(() => {
        handler(0);
    });

    assert.strictEqual(chatContainer.children.length, 0);
});

test('14. Stale-chat safety: chat change refuses DOM mutation on same numeric mesid in new chat', async () => {
    const eventSource = createFakeEventSource();
    const eventTypes = { CHARACTER_MESSAGE_RENDERED: 'cmr' };

    const chatA = [
        {
            mes: 'Origin chat proposal\n\n<!-- CI_IMAGE {"characters":["Alice"],"prompt":"portrait"} -->',
            is_user: false,
        },
    ];

    const chatB = [
        {
            mes: 'New chat untouched message',
            is_user: false,
        },
    ];

    let contextCalls = 0;
    globalThis.SillyTavern = {
        getContext() {
            contextCalls += 1;
            // First call during readActiveAssistantMessage -> chat-a
            // Second call during Step 5 of inspectActiveImageMessage -> chat-b
            if (contextCalls === 1) {
                return {
                    chatId: 'chat-a',
                    chat: chatA,
                    eventSource,
                    eventTypes,
                };
            }
            return {
                chatId: 'chat-b',
                chat: chatB,
                eventSource,
                eventTypes,
            };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    // DOM has message 0 belonging to chat-b
    createTestChatDOM(doc, [{ mesid: 0, text: 'New chat untouched message' }]);

    const { registerMessageRuntime } = await loadFreshMessageRuntime();
    registerMessageRuntime();

    const [handler] = eventSource.getHandlers('cmr');
    handler(0);

    const mesNode = doc.querySelector('#chat .mes[mesid="0"]');
    const cards = mesNode.querySelectorAll('[data-chromatic-images-ui="true"]');
    // Critical assertion: chat-b node was NOT modified!
    assert.strictEqual(cards.length, 0);
    assert.strictEqual(mesNode.querySelector('.mes_text').textContent, 'New chat untouched message');
});

// ---------------------------------------------------------------------------
// 5. Full visible-message refresh tests
// ---------------------------------------------------------------------------

test('15. refreshRenderedImageMessages reconciles all visible message nodes correctly', async () => {
    const chat = [
        // 0: assistant proposal
        {
            mes: 'Msg 0\n\n<!-- CI_IMAGE {"characters":["Alice"],"prompt":"proposal prompt"} -->',
            is_user: false,
        },
        // 1: normal assistant prose
        {
            mes: 'Msg 1 normal prose',
            is_user: false,
        },
        // 2: reviewable result
        {
            mes: 'Msg 2\n\n![ChromaticImages](/user/images/art.png)\n<!-- CI_RESULT {"v":1,"path":"/user/images/art.png","characters":["Alice"],"prompt":"review prompt"} -->',
            is_user: false,
        },
        // 3: finalized result
        {
            mes: 'Msg 3\n\n![ChromaticImages](/user/images/final.png)',
            is_user: false,
        },
        // 4: user message
        {
            mes: 'Msg 4 from user',
            is_user: true,
        },
    ];

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'chat-main',
                chat,
            };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    createTestChatDOM(doc, [
        { mesid: 0, text: 'Msg 0' },
        { mesid: 1, text: 'Msg 1 normal prose' },
        { mesid: 2, text: 'Msg 2' },
        { mesid: 3, text: 'Msg 3' },
        { mesid: 4, text: 'Msg 4 from user' },
    ]);

    const { refreshRenderedImageMessages } = await loadFreshMessageRuntime();

    const result = refreshRenderedImageMessages();
    assert.strictEqual(result.status, 'refreshed');
    assert.strictEqual(result.inspected, 5);
    assert.strictEqual(result.rendered, 2);

    // Verify DOM states
    const mes0 = doc.querySelector('#chat .mes[mesid="0"]');
    const mes1 = doc.querySelector('#chat .mes[mesid="1"]');
    const mes2 = doc.querySelector('#chat .mes[mesid="2"]');
    const mes3 = doc.querySelector('#chat .mes[mesid="3"]');
    const mes4 = doc.querySelector('#chat .mes[mesid="4"]');

    assert.strictEqual(mes0.querySelectorAll('[data-chromatic-images-ui="true"]').length, 1);
    assert.strictEqual(mes0.querySelector('[data-chromatic-images-ui="true"]').getAttribute('data-chromatic-images-state'), 'proposal');

    assert.strictEqual(mes1.querySelectorAll('[data-chromatic-images-ui="true"]').length, 0);

    assert.strictEqual(mes2.querySelectorAll('[data-chromatic-images-ui="true"]').length, 1);
    assert.strictEqual(mes2.querySelector('[data-chromatic-images-ui="true"]').getAttribute('data-chromatic-images-state'), 'reviewable-result');

    assert.strictEqual(mes3.querySelectorAll('[data-chromatic-images-ui="true"]').length, 0);
    assert.strictEqual(mes4.querySelectorAll('[data-chromatic-images-ui="true"]').length, 0);

    // Repeated refresh is idempotent
    const repeatResult = refreshRenderedImageMessages();
    assert.strictEqual(repeatResult.status, 'refreshed');
    assert.strictEqual(repeatResult.rendered, 2);

    assert.strictEqual(mes0.querySelectorAll('[data-chromatic-images-ui="true"]').length, 1);
    assert.strictEqual(mes2.querySelectorAll('[data-chromatic-images-ui="true"]').length, 1);
});

test('16. refreshRenderedImageMessages handles stale chat without mutating iterated nodes', async () => {
    let callCount = 0;
    const chatA = [
        {
            mes: '<!-- CI_IMAGE {"characters":["Alice"],"prompt":"test"} -->',
            is_user: false,
        },
    ];

    globalThis.SillyTavern = {
        getContext() {
            callCount += 1;
            // Cause chat-changed on fresh check
            if (callCount % 2 === 1) {
                return { chatId: 'chat-a', chat: chatA };
            }
            return { chatId: 'chat-b', chat: [] };
        },
    };

    const doc = new FakeDocument();
    globalThis.document = doc;
    createTestChatDOM(doc, [{ mesid: 0, text: 'Text in chat b' }]);

    const { refreshRenderedImageMessages } = await loadFreshMessageRuntime();
    assert.doesNotThrow(() => {
        refreshRenderedImageMessages();
    });

    const mesNode = doc.querySelector('#chat .mes[mesid="0"]');
    assert.strictEqual(mesNode.querySelectorAll('[data-chromatic-images-ui="true"]').length, 0);
});

test('17. DOM scope restriction: queries remain strictly within #chat', async () => {
    const queries = [];
    const doc = new FakeDocument();
    globalThis.document = doc;

    const chat = [
        {
            mes: '<!-- CI_IMAGE {"characters":["Alice"],"prompt":"test"} -->',
            is_user: false,
        },
    ];

    const eventSource = createFakeEventSource();
    const eventTypes = { CHARACTER_MESSAGE_RENDERED: 'cmr' };

    globalThis.SillyTavern = {
        getContext() {
            return { chatId: 'chat-main', chat, eventSource, eventTypes };
        },
    };

    // Outside chat element
    const otherContainer = doc.createElement('div');
    otherContainer.setAttribute('id', 'other-container');
    const outsideMes = doc.createElement('div');
    outsideMes.className = 'mes';
    outsideMes.setAttribute('mesid', '0');
    const outsideText = doc.createElement('div');
    outsideText.className = 'mes_text';
    outsideMes.appendChild(outsideText);
    otherContainer.appendChild(outsideMes);
    doc.appendChild(otherContainer);

    // Inside chat element
    createTestChatDOM(doc, [{ mesid: 0, text: 'Inside chat' }]);

    const origQS = doc.querySelector.bind(doc);
    doc.querySelector = (sel) => {
        queries.push({ type: 'querySelector', sel });
        return origQS(sel);
    };

    const origQSA = doc.querySelectorAll.bind(doc);
    doc.querySelectorAll = (sel) => {
        queries.push({ type: 'querySelectorAll', sel });
        return origQSA(sel);
    };

    const { registerMessageRuntime, refreshRenderedImageMessages } = await loadFreshMessageRuntime();
    registerMessageRuntime();

    // 1. One-message event
    const [handler] = eventSource.getHandlers('cmr');
    handler(0);

    const qsCalls = queries.filter((q) => q.type === 'querySelector');
    assert.strictEqual(qsCalls.length, 1);
    assert.strictEqual(qsCalls[0].sel, '#chat .mes[mesid="0"]');

    // 2. Full refresh
    refreshRenderedImageMessages();
    const qsaCalls = queries.filter((q) => q.type === 'querySelectorAll');
    assert.strictEqual(qsaCalls.length, 1);
    assert.strictEqual(qsaCalls[0].sel, '#chat .mes[mesid]');

    // Outside element was never touched
    assert.strictEqual(outsideMes.querySelectorAll('[data-chromatic-images-ui="true"]').length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInlineImageState } from '../src/inline-renderer.js';

/**
 * Matches a mock element against a simple CSS selector.
 * Supports classes (.class), tag names (tag), and attribute selectors ([attr="val"] / [attr]).
 *
 * @param {object} el - Fake element.
 * @param {string} selector - Selector string.
 * @returns {boolean}
 */
function matchesSelector(el, selector) {
    if (!el || typeof el.getAttribute !== 'function') {
        return false;
    }

    // Class selector: .className
    if (selector.startsWith('.')) {
        const targetClass = selector.slice(1);
        const classes = (el.className || '').split(/\s+/).filter(Boolean);
        return classes.includes(targetClass);
    }

    // Attribute selector: [attr="value"] or [attr='value'] or [attr]
    const attrMatch = selector.match(/^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/);
    if (attrMatch) {
        const attrName = attrMatch[1];
        const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
        if (attrVal === undefined) {
            return el.hasAttribute(attrName);
        }
        return el.getAttribute(attrName) === attrVal;
    }

    // Tag name selector: section, button, div, etc.
    if (/^[a-zA-Z0-9]+$/.test(selector)) {
        return el.tagName.toLowerCase() === selector.toLowerCase();
    }

    return false;
}

/**
 * Recursively collects matching elements in subtree in document order.
 *
 * @param {object} root - Starting root element.
 * @param {(el: object) => boolean} predicate - Matching predicate.
 * @param {object[]} results - Collector array.
 * @returns {object[]}
 */
function collectElements(root, predicate, results = []) {
    for (const child of root.children) {
        if (predicate(child)) {
            results.push(child);
        }
        collectElements(child, predicate, results);
    }
    return results;
}

/**
 * Minimal fake DOM element conforming to renderer requirements.
 */
class FakeElement {
    constructor(tagName, ownerDoc) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDoc;
        this.parentNode = null;
        this.children = [];
        this.attributes = new Map();
        this._textContent = '';
        this._disabled = false;
        this.type = tagName.toLowerCase() === 'button' ? 'submit' : '';
    }

    get className() {
        return this.getAttribute('class') || '';
    }

    set className(val) {
        this.setAttribute('class', val);
    }

    get disabled() {
        return this._disabled;
    }

    set disabled(val) {
        this._disabled = Boolean(val);
        if (this._disabled) {
            this.setAttribute('disabled', '');
        } else {
            this.removeAttribute('disabled');
        }
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
        if (name === 'disabled') {
            this._disabled = true;
        }
    }

    removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'disabled') {
            this._disabled = false;
        }
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

    get previousSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.children.indexOf(this);
        if (idx <= 0) return null;
        return this.parentNode.children[idx - 1];
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
            throw new Error('refChild not found in parent');
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
        if (idx === -1) {
            throw new Error('child not found in parent');
        }
        this.children.splice(idx, 1);
        child.parentNode = null;
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
        const results = this.querySelectorAll(selector);
        return results[0] || null;
    }

    querySelectorAll(selector) {
        return collectElements(this, (el) => matchesSelector(el, selector));
    }
}

/**
 * Minimal fake Document.
 */
class FakeDocument {
    createElement(tagName) {
        return new FakeElement(tagName, this);
    }
}

/**
 * Creates a standard test message element structure:
 * <div class="mes">
 *   <div class="mes_avatar">Avatar</div>
 *   <div class="mes_text">Rendered text</div>
 *   <div class="mes_footer">Footer</div>
 * </div>
 */
function createTestMessage() {
    const doc = new FakeDocument();
    const messageElement = doc.createElement('div');
    messageElement.className = 'mes';

    const avatar = doc.createElement('div');
    avatar.className = 'mes_avatar';
    avatar.textContent = 'Avatar';
    messageElement.appendChild(avatar);

    const mesText = doc.createElement('div');
    mesText.className = 'mes_text';
    mesText.textContent = 'Rendered text';
    messageElement.appendChild(mesText);

    const footer = doc.createElement('div');
    footer.className = 'mes_footer';
    footer.textContent = 'Footer';
    messageElement.appendChild(footer);

    return { doc, messageElement, mesText, avatar, footer };
}

// =========================================================================
// 1. Invalid Targets
// =========================================================================

test('Invalid targets: null or non-object message element returns unavailable', () => {
    assert.deepStrictEqual(renderInlineImageState(null, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'invalid-message-element',
    });
    assert.deepStrictEqual(renderInlineImageState(undefined, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'invalid-message-element',
    });
    assert.deepStrictEqual(renderInlineImageState(42, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'invalid-message-element',
    });
    assert.deepStrictEqual(renderInlineImageState('element', { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'invalid-message-element',
    });
});

test('Invalid targets: element missing querySelector returns unavailable', () => {
    assert.deepStrictEqual(renderInlineImageState({}, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'invalid-message-element',
    });
});

test('Invalid targets: element missing .mes_text returns message-text-missing', () => {
    const doc = new FakeDocument();
    const emptyContainer = doc.createElement('div');
    assert.deepStrictEqual(renderInlineImageState(emptyContainer, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'message-text-missing',
    });
});

test('Invalid targets: missing usable ownerDocument returns document-unavailable', () => {
    const messageElement = {
        querySelector(sel) {
            if (sel === '.mes_text') return { parentNode: this };
            return null;
        },
        ownerDocument: null,
    };
    assert.deepStrictEqual(renderInlineImageState(messageElement, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'document-unavailable',
    });

    const brokenDocElement = {
        querySelector(sel) {
            if (sel === '.mes_text') return { parentNode: this };
            return null;
        },
        ownerDocument: { createElement: 'not a function' },
    };
    assert.deepStrictEqual(renderInlineImageState(brokenDocElement, { status: 'proposal' }), {
        status: 'unavailable',
        reason: 'document-unavailable',
    });
});

// =========================================================================
// 2. Proposal Rendering
// =========================================================================

test('Proposal rendering: valid proposal creates exactly one owned root inserted after .mes_text', () => {
    const { messageElement, mesText, footer } = createTestMessage();
    const proposalData = {
        characters: ['Hina', 'Ako'],
        prompt: '1girl, outdoors, sunny day',
    };

    const result = renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: proposalData,
    });

    assert.deepStrictEqual(result, {
        status: 'rendered',
        state: 'proposal',
    });

    // Check owned roots
    const roots = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(roots.length, 1);

    const root = roots[0];
    assert.strictEqual(root.getAttribute('data-chromatic-images-ui'), 'true');
    assert.strictEqual(root.getAttribute('data-chromatic-images-state'), 'proposal');
    assert.ok(root.className.includes('chromatic-images-inline-ui'));
    assert.ok(root.className.includes('chromatic-images-proposal-card'));

    // Check insertion point: immediately after .mes_text and before footer
    assert.strictEqual(mesText.nextSibling, root);
    assert.strictEqual(root.nextSibling, footer);

    // Title and badge
    const title = root.querySelector('.chromatic-images-inline-title');
    assert.ok(title);
    assert.strictEqual(title.textContent, 'Suggested illustration');

    const badge = root.querySelector('.chromatic-images-inline-badge');
    assert.ok(badge);
    assert.strictEqual(badge.textContent, 'Proposal');

    // Characters
    const charsEl = root.querySelector('.chromatic-images-inline-characters');
    assert.ok(charsEl);
    assert.strictEqual(charsEl.textContent, 'Characters: Hina, Ako');

    // Prompt label and text
    const labelEl = root.querySelector('.chromatic-images-inline-label');
    assert.ok(labelEl);
    assert.strictEqual(labelEl.textContent, 'Scene description');

    const promptEl = root.querySelector('.chromatic-images-inline-prompt');
    assert.ok(promptEl);
    assert.strictEqual(promptEl.textContent, '1girl, outdoors, sunny day');

    // Generate button
    const generateBtn = root.querySelector('[data-chromatic-images-action="generate"]');
    assert.ok(generateBtn);
    assert.strictEqual(generateBtn.textContent, 'Generate');
    assert.strictEqual(generateBtn.type, 'button');
    assert.strictEqual(generateBtn.disabled, true);
    assert.strictEqual(generateBtn.getAttribute('aria-disabled'), 'true');
    assert.ok(generateBtn.className.includes('menu_button'));
    assert.ok(generateBtn.className.includes('chromatic-images-action-button'));
});

test('Proposal rendering: empty character list displays "Characters: No named characters"', () => {
    const { messageElement } = createTestMessage();
    const result = renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: {
            characters: [],
            prompt: 'scenery, trees, sky',
        },
    });

    assert.strictEqual(result.status, 'rendered');
    const root = messageElement.querySelector('[data-chromatic-images-ui="true"]');
    const charsEl = root.querySelector('.chromatic-images-inline-characters');
    assert.strictEqual(charsEl.textContent, 'Characters: No named characters');
});

test('Proposal rendering: internal prompt line breaks are preserved exactly as text', () => {
    const { messageElement } = createTestMessage();
    const multilinePrompt = 'Line 1: character overview\nLine 2: lighting and background\n\nLine 4: details';
    renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: {
            characters: ['Hina'],
            prompt: multilinePrompt,
        },
    });

    const root = messageElement.querySelector('[data-chromatic-images-ui="true"]');
    const promptEl = root.querySelector('.chromatic-images-inline-prompt');
    assert.strictEqual(promptEl.textContent, multilinePrompt);
});

// =========================================================================
// 3. Safe Text Rendering
// =========================================================================

test('Safe text rendering: hostile markup in prompt and characters remains literal text', () => {
    const { messageElement } = createTestMessage();
    const hostilePrompt = '<img src=x onerror=alert(1)><script>bad()</script>';
    const hostileCharacters = ['<script>evil()</script>', '<b>Bold</b>'];

    renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: {
            characters: hostileCharacters,
            prompt: hostilePrompt,
        },
    });

    const root = messageElement.querySelector('[data-chromatic-images-ui="true"]');

    // Assert no <img> or <script> or <b> elements were created inside the transient UI
    assert.strictEqual(root.querySelectorAll('img').length, 0);
    assert.strictEqual(root.querySelectorAll('script').length, 0);
    assert.strictEqual(root.querySelectorAll('b').length, 0);

    const promptEl = root.querySelector('.chromatic-images-inline-prompt');
    assert.strictEqual(promptEl.textContent, hostilePrompt);

    const charsEl = root.querySelector('.chromatic-images-inline-characters');
    assert.strictEqual(charsEl.textContent, 'Characters: <script>evil()</script>, <b>Bold</b>');
});

// =========================================================================
// 4. Idempotency
// =========================================================================

test('Idempotency: rendering the same proposal multiple times leaves exactly one root', () => {
    const { messageElement } = createTestMessage();
    const proposalInspection = {
        status: 'proposal',
        proposal: {
            characters: ['Hina'],
            prompt: 'outdoors',
        },
    };

    renderInlineImageState(messageElement, proposalInspection);
    renderInlineImageState(messageElement, proposalInspection);
    renderInlineImageState(messageElement, proposalInspection);

    const roots = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(roots.length, 1);
});

// =========================================================================
// 5. State Transitions
// =========================================================================

test('State transitions: proposal -> reviewable-result -> finalized-result reconciles cleanly', () => {
    const { messageElement, mesText } = createTestMessage();

    // 1. Proposal state
    const res1 = renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: { characters: ['Ako'], prompt: 'library' },
    });
    assert.deepStrictEqual(res1, { status: 'rendered', state: 'proposal' });
    let roots = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].getAttribute('data-chromatic-images-state'), 'proposal');

    // 2. Transition to reviewable-result
    const res2 = renderInlineImageState(messageElement, {
        status: 'reviewable-result',
        result: { path: 'images/test.png', prompt: 'library' },
    });
    assert.deepStrictEqual(res2, { status: 'rendered', state: 'reviewable-result' });
    roots = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].getAttribute('data-chromatic-images-state'), 'reviewable-result');
    assert.strictEqual(roots[0].querySelector('[data-chromatic-images-state="proposal"]'), null);

    // 3. Transition to finalized-result
    const res3 = renderInlineImageState(messageElement, {
        status: 'finalized-result',
        image: { path: 'images/test.png' },
    });
    assert.deepStrictEqual(res3, { status: 'cleared' });
    roots = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(roots.length, 0);

    // .mes_text is untouched
    assert.strictEqual(mesText.textContent, 'Rendered text');
});

// =========================================================================
// 6. Reviewable Result UI
// =========================================================================

test('Reviewable result: renders compact control shell with exact disabled buttons and no image', () => {
    const { messageElement, mesText } = createTestMessage();
    const result = renderInlineImageState(messageElement, {
        status: 'reviewable-result',
        result: {
            path: 'images/generated-hina.png',
            prompt: 'hina sitting at desk',
        },
    });

    assert.deepStrictEqual(result, {
        status: 'rendered',
        state: 'reviewable-result',
    });

    const roots = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
    assert.strictEqual(roots.length, 1);

    const root = roots[0];
    assert.strictEqual(root.getAttribute('data-chromatic-images-state'), 'reviewable-result');
    assert.ok(root.className.includes('chromatic-images-reviewable-card'));

    // No image element created by the renderer
    assert.strictEqual(root.querySelectorAll('img').length, 0);

    // Image path is not displayed
    assert.ok(!root.textContent.includes('images/generated-hina.png'));

    // Title and badge
    const title = root.querySelector('.chromatic-images-inline-title');
    assert.ok(title);
    assert.strictEqual(title.textContent, 'Generated illustration');

    const badge = root.querySelector('.chromatic-images-inline-badge');
    assert.ok(badge);
    assert.strictEqual(badge.textContent, 'Reviewable');

    // 3 Action buttons
    const regenBtn = root.querySelector('[data-chromatic-images-action="regenerate"]');
    assert.ok(regenBtn);
    assert.strictEqual(regenBtn.textContent, 'Regenerate');
    assert.strictEqual(regenBtn.type, 'button');
    assert.strictEqual(regenBtn.disabled, true);
    assert.strictEqual(regenBtn.getAttribute('aria-disabled'), 'true');

    const editRegenBtn = root.querySelector('[data-chromatic-images-action="edit-regenerate"]');
    assert.ok(editRegenBtn);
    assert.strictEqual(editRegenBtn.textContent, 'Edit & Regenerate');
    assert.strictEqual(editRegenBtn.type, 'button');
    assert.strictEqual(editRegenBtn.disabled, true);
    assert.strictEqual(editRegenBtn.getAttribute('aria-disabled'), 'true');

    const keepBtn = root.querySelector('[data-chromatic-images-action="keep"]');
    assert.ok(keepBtn);
    assert.strictEqual(keepBtn.textContent, 'Keep');
    assert.strictEqual(keepBtn.type, 'button');
    assert.strictEqual(keepBtn.disabled, true);
    assert.strictEqual(keepBtn.getAttribute('aria-disabled'), 'true');
});

// =========================================================================
// 7. Clearing States
// =========================================================================

test('Clearing states: each non-actionable status clears transient UI and returns cleared', () => {
    const clearingStatuses = [
        'ignored',
        'chat-changed',
        'empty',
        'unsupported-multiple',
        'invalid-protocol',
        'finalized-result',
    ];

    for (const status of clearingStatuses) {
        const { messageElement, mesText } = createTestMessage();

        // Establish initial UI
        renderInlineImageState(messageElement, {
            status: 'proposal',
            proposal: { characters: [], prompt: 'initial' },
        });
        assert.strictEqual(
            messageElement.querySelectorAll('[data-chromatic-images-ui="true"]').length,
            1,
            `Expected 1 root before clearing status ${status}`,
        );

        // Clear via status
        const inspection = { status };
        if (status === 'invalid-protocol') inspection.errors = ['some-error'];
        if (status === 'unsupported-multiple') inspection.counts = { proposals: 2, reviewable: 0, finalized: 0 };
        if (status === 'finalized-result') inspection.image = { path: 'a.png' };

        const res = renderInlineImageState(messageElement, inspection);
        assert.deepStrictEqual(res, { status: 'cleared' }, `Status ${status} should return cleared`);
        assert.strictEqual(
            messageElement.querySelectorAll('[data-chromatic-images-ui="true"]').length,
            0,
            `Status ${status} must remove all transient roots`,
        );
        assert.strictEqual(mesText.textContent, 'Rendered text');
    }
});

// =========================================================================
// 8. Defensive Malformed Inspector Result
// =========================================================================

test('Defensive checks: malformed or unusable inspector result clears stale UI and returns unavailable', () => {
    const malformedInputs = [
        null,
        undefined,
        42,
        'proposal',
        {},
        { status: 123 },
        { status: 'unknown-status' },
        { status: 'proposal' },
        { status: 'proposal', proposal: null },
        { status: 'proposal', proposal: 'not-an-object' },
        { status: 'proposal', proposal: { characters: null, prompt: 'x' } },
        { status: 'proposal', proposal: { characters: ['valid'], prompt: 123 } },
        { status: 'proposal', proposal: { characters: [123], prompt: 'valid' } },
        { status: 'reviewable-result' },
        { status: 'reviewable-result', result: null },
        { status: 'reviewable-result', result: 'not-an-object' },
    ];

    for (const badInput of malformedInputs) {
        const { messageElement } = createTestMessage();

        // Establish initial UI
        renderInlineImageState(messageElement, {
            status: 'proposal',
            proposal: { characters: ['Hina'], prompt: 'valid prompt' },
        });
        assert.strictEqual(messageElement.querySelectorAll('[data-chromatic-images-ui="true"]').length, 1);

        // Call with malformed input
        const res = renderInlineImageState(messageElement, badInput);
        assert.deepStrictEqual(
            res,
            { status: 'unavailable', reason: 'invalid-inspection-result' },
            `Expected unavailable/invalid-inspection-result for ${JSON.stringify(badInput)}`,
        );

        // Stale UI must have been cleared
        assert.strictEqual(
            messageElement.querySelectorAll('[data-chromatic-images-ui="true"]').length,
            0,
            `Expected stale UI cleared for ${JSON.stringify(badInput)}`,
        );
    }
});

// =========================================================================
// 9. Unrelated DOM Preservation
// =========================================================================

test('Unrelated DOM preservation: sibling elements and children remain untouched', () => {
    const { messageElement, avatar, mesText, footer } = createTestMessage();

    // Render proposal
    renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: { characters: ['Hina'], prompt: 'garden' },
    });

    assert.strictEqual(avatar.parentNode, messageElement);
    assert.strictEqual(avatar.textContent, 'Avatar');
    assert.strictEqual(mesText.parentNode, messageElement);
    assert.strictEqual(mesText.textContent, 'Rendered text');
    assert.strictEqual(footer.parentNode, messageElement);
    assert.strictEqual(footer.textContent, 'Footer');

    // Transition to reviewable
    renderInlineImageState(messageElement, {
        status: 'reviewable-result',
        result: { path: 'garden.png', prompt: 'garden' },
    });

    assert.strictEqual(avatar.textContent, 'Avatar');
    assert.strictEqual(mesText.textContent, 'Rendered text');
    assert.strictEqual(footer.textContent, 'Footer');

    // Clear
    renderInlineImageState(messageElement, { status: 'finalized-result' });

    assert.strictEqual(avatar.textContent, 'Avatar');
    assert.strictEqual(mesText.textContent, 'Rendered text');
    assert.strictEqual(footer.textContent, 'Footer');
    assert.strictEqual(messageElement.children.length, 3);
});

// =========================================================================
// 10. Source Content Preservation
// =========================================================================

test('Source content preservation: .mes_text element is never replaced or modified', () => {
    const { messageElement, mesText } = createTestMessage();
    const originalText = mesText.textContent;

    renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: { characters: ['Ako'], prompt: 'prompt content' },
    });

    assert.strictEqual(messageElement.querySelector('.mes_text'), mesText);
    assert.strictEqual(mesText.textContent, originalText);
    assert.strictEqual(mesText.children.length, 0);

    renderInlineImageState(messageElement, {
        status: 'reviewable-result',
        result: { path: 'a.png', prompt: 'prompt content' },
    });

    assert.strictEqual(messageElement.querySelector('.mes_text'), mesText);
    assert.strictEqual(mesText.textContent, originalText);
    assert.strictEqual(mesText.children.length, 0);

    renderInlineImageState(messageElement, { status: 'empty' });

    assert.strictEqual(messageElement.querySelector('.mes_text'), mesText);
    assert.strictEqual(mesText.textContent, originalText);
    assert.strictEqual(mesText.children.length, 0);
});

// =========================================================================
// 11. Fallback when insertAdjacentElement is missing
// =========================================================================

test('Fallback: successfully inserts UI when insertAdjacentElement is not available', () => {
    const { messageElement, mesText, footer } = createTestMessage();
    // Remove insertAdjacentElement to force parentNode.insertBefore fallback
    mesText.insertAdjacentElement = undefined;

    const result = renderInlineImageState(messageElement, {
        status: 'proposal',
        proposal: { characters: ['Hina'], prompt: 'fallback test' },
    });

    assert.deepStrictEqual(result, { status: 'rendered', state: 'proposal' });
    const root = messageElement.querySelector('[data-chromatic-images-ui="true"]');
    assert.ok(root);
    assert.strictEqual(mesText.nextSibling, root);
    assert.strictEqual(root.nextSibling, footer);
});

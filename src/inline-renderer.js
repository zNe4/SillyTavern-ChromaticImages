/**
 * @file Idempotent inline DOM renderer for Chromatic Images.
 *
 * Synchronously reconciles transient Chromatic Images UI for a specific
 * message DOM element given a normalized inspection result from M02-D.
 */

/**
 * Removes any existing extension-owned transient UI roots from the message element.
 *
 * @param {object} messageElement - The message container element.
 */
function removeExistingTransientRoots(messageElement) {
    if (!messageElement || typeof messageElement.querySelectorAll !== 'function') {
        return;
    }

    try {
        const existing = messageElement.querySelectorAll('[data-chromatic-images-ui="true"]');
        if (existing) {
            for (const el of Array.from(existing)) {
                if (el && typeof el.remove === 'function') {
                    el.remove();
                } else if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
                    el.parentNode.removeChild(el);
                }
            }
        }
    } catch {
        // Defensive: ignore query/removal failures in hostile or non-standard mock environments
    }
}

/**
 * Inserts a new node immediately after the reference node within the same parent.
 *
 * @param {object} referenceNode - The node to insert after (e.g. .mes_text).
 * @param {object} newNode - The newly created transient UI root.
 */
function insertAfter(referenceNode, newNode) {
    if (typeof referenceNode.insertAdjacentElement === 'function') {
        referenceNode.insertAdjacentElement('afterend', newNode);
        return;
    }
    if (referenceNode.parentNode && typeof referenceNode.parentNode.insertBefore === 'function') {
        referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
    }
}

/**
 * Creates a disabled button for extension inline actions.
 *
 * @param {Document} doc - Document instance used to create elements.
 * @param {string} label - Visible button text content.
 * @param {string} action - Value for data-chromatic-images-action attribute.
 * @returns {HTMLButtonElement} The created button element.
 */
function createDisabledActionButton(doc, label, action) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('type', 'button');
    button.className = 'menu_button chromatic-images-action-button';
    button.setAttribute('data-chromatic-images-action', action);
    button.disabled = true;
    button.setAttribute('disabled', '');
    button.setAttribute('aria-disabled', 'true');
    button.textContent = label;
    return button;
}

/**
 * Constructs the transient proposal card DOM tree.
 *
 * @param {Document} doc - Document instance used to create elements.
 * @param {{ characters: string[], prompt: string }} proposal - Normalized proposal object.
 * @returns {HTMLElement} The root section element.
 */
function createProposalCard(doc, proposal) {
    const card = doc.createElement('section');
    card.className = 'chromatic-images-inline-ui chromatic-images-proposal-card';
    card.setAttribute('data-chromatic-images-ui', 'true');
    card.setAttribute('data-chromatic-images-state', 'proposal');

    // Header
    const header = doc.createElement('div');
    header.className = 'chromatic-images-inline-header';

    const title = doc.createElement('strong');
    title.className = 'chromatic-images-inline-title';
    title.textContent = 'Suggested illustration';

    const badge = doc.createElement('span');
    badge.className = 'chromatic-images-inline-badge';
    badge.textContent = 'Proposal';

    header.appendChild(title);
    header.appendChild(badge);
    card.appendChild(header);

    // Characters
    const charactersEl = doc.createElement('div');
    charactersEl.className = 'chromatic-images-inline-characters';
    const charText = proposal.characters.length > 0
        ? `Characters: ${proposal.characters.join(', ')}`
        : 'Characters: No named characters';
    charactersEl.textContent = charText;
    card.appendChild(charactersEl);

    // Prompt section
    const promptContainer = doc.createElement('div');
    promptContainer.className = 'chromatic-images-inline-prompt-container';

    const promptLabel = doc.createElement('div');
    promptLabel.className = 'chromatic-images-inline-label';
    promptLabel.textContent = 'Scene description';

    const promptText = doc.createElement('div');
    promptText.className = 'chromatic-images-inline-prompt';
    promptText.textContent = proposal.prompt;

    promptContainer.appendChild(promptLabel);
    promptContainer.appendChild(promptText);
    card.appendChild(promptContainer);

    // Action button
    const actions = doc.createElement('div');
    actions.className = 'chromatic-images-inline-actions';
    const generateBtn = createDisabledActionButton(doc, 'Generate', 'generate');
    actions.appendChild(generateBtn);
    card.appendChild(actions);

    return card;
}

/**
 * Constructs the transient reviewable-result control shell DOM tree.
 *
 * @param {Document} doc - Document instance used to create elements.
 * @returns {HTMLElement} The root section element.
 */
function createReviewableCard(doc) {
    const card = doc.createElement('section');
    card.className = 'chromatic-images-inline-ui chromatic-images-reviewable-card';
    card.setAttribute('data-chromatic-images-ui', 'true');
    card.setAttribute('data-chromatic-images-state', 'reviewable-result');

    // Header
    const header = doc.createElement('div');
    header.className = 'chromatic-images-inline-header';

    const title = doc.createElement('strong');
    title.className = 'chromatic-images-inline-title';
    title.textContent = 'Generated illustration';

    const badge = doc.createElement('span');
    badge.className = 'chromatic-images-inline-badge';
    badge.textContent = 'Reviewable';

    header.appendChild(title);
    header.appendChild(badge);
    card.appendChild(header);

    // Action buttons
    const actions = doc.createElement('div');
    actions.className = 'chromatic-images-inline-actions';
    actions.appendChild(createDisabledActionButton(doc, 'Regenerate', 'regenerate'));
    actions.appendChild(createDisabledActionButton(doc, 'Edit & Regenerate', 'edit-regenerate'));
    actions.appendChild(createDisabledActionButton(doc, 'Keep', 'keep'));
    card.appendChild(actions);

    return card;
}

/**
 * Reconciles transient Chromatic Images UI for a specific message DOM element.
 *
 * Synchronous, idempotent DOM reconciler operating strictly on the supplied messageElement.
 *
 * @param {HTMLElement} messageElement - The outer DOM element for one message.
 * @param {object} inspectionResult - Normalized classification from inspectActiveImageMessage.
 * @returns {{
 *     status: 'rendered' | 'cleared' | 'unavailable',
 *     state?: 'proposal' | 'reviewable-result',
 *     reason?: 'invalid-message-element' | 'message-text-missing' | 'document-unavailable' | 'invalid-inspection-result'
 * }}
 */
export function renderInlineImageState(messageElement, inspectionResult) {
    // 1. Validate target message element
    if (!messageElement || typeof messageElement !== 'object') {
        return {
            status: 'unavailable',
            reason: 'invalid-message-element',
        };
    }

    if (typeof messageElement.querySelector !== 'function') {
        return {
            status: 'unavailable',
            reason: 'invalid-message-element',
        };
    }

    // 2. Locate rendered message text element inside messageElement
    let mesTextElement;
    try {
        mesTextElement = messageElement.querySelector('.mes_text');
    } catch {
        return {
            status: 'unavailable',
            reason: 'message-text-missing',
        };
    }

    if (!mesTextElement || typeof mesTextElement !== 'object') {
        return {
            status: 'unavailable',
            reason: 'message-text-missing',
        };
    }

    // 3. Obtain usable ownerDocument
    const ownerDocument = messageElement.ownerDocument;
    if (!ownerDocument || typeof ownerDocument.createElement !== 'function') {
        return {
            status: 'unavailable',
            reason: 'document-unavailable',
        };
    }

    // 4. Validate inspection result shape
    if (
        !inspectionResult ||
        typeof inspectionResult !== 'object' ||
        typeof inspectionResult.status !== 'string'
    ) {
        removeExistingTransientRoots(messageElement);
        return {
            status: 'unavailable',
            reason: 'invalid-inspection-result',
        };
    }

    const status = inspectionResult.status;

    // 5. Handle actionable and clearing states
    switch (status) {
        case 'proposal': {
            const proposal = inspectionResult.proposal;
            if (
                !proposal ||
                typeof proposal !== 'object' ||
                !Array.isArray(proposal.characters) ||
                !proposal.characters.every((c) => typeof c === 'string') ||
                typeof proposal.prompt !== 'string'
            ) {
                removeExistingTransientRoots(messageElement);
                return {
                    status: 'unavailable',
                    reason: 'invalid-inspection-result',
                };
            }

            removeExistingTransientRoots(messageElement);
            const card = createProposalCard(ownerDocument, proposal);
            insertAfter(mesTextElement, card);

            return {
                status: 'rendered',
                state: 'proposal',
            };
        }

        case 'reviewable-result': {
            const result = inspectionResult.result;
            if (!result || typeof result !== 'object') {
                removeExistingTransientRoots(messageElement);
                return {
                    status: 'unavailable',
                    reason: 'invalid-inspection-result',
                };
            }

            removeExistingTransientRoots(messageElement);
            const card = createReviewableCard(ownerDocument);
            insertAfter(mesTextElement, card);

            return {
                status: 'rendered',
                state: 'reviewable-result',
            };
        }

        case 'finalized-result':
        case 'ignored':
        case 'chat-changed':
        case 'empty':
        case 'unsupported-multiple':
        case 'invalid-protocol': {
            removeExistingTransientRoots(messageElement);
            return {
                status: 'cleared',
            };
        }

        default: {
            removeExistingTransientRoots(messageElement);
            return {
                status: 'unavailable',
                reason: 'invalid-inspection-result',
            };
        }
    }
}

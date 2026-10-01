/**
 * @file Message runtime and lifecycle wiring for Chromatic Images.
 *
 * Connects SillyTavern render and mutation events to message inspection
 * and idempotent inline DOM rendering.
 */

import { inspectActiveImageMessage } from './message-inspector.js';
import { renderInlineImageState } from './inline-renderer.js';

let registered = false;

/**
 * Validate an event identifier.
 *
 * @param {unknown} id - Event identifier candidate.
 * @returns {boolean} True if id is a non-empty string or a symbol.
 */
function isValidEventIdentifier(id) {
    return (typeof id === 'string' && id.length > 0) || typeof id === 'symbol';
}

/**
 * Safely retrieve the SillyTavern context without throwing.
 *
 * @returns {object | null}
 */
function getSillyTavernContext() {
    try {
        if (
            typeof globalThis.SillyTavern === 'undefined' ||
            !globalThis.SillyTavern ||
            typeof globalThis.SillyTavern.getContext !== 'function'
        ) {
            return null;
        }

        const context = globalThis.SillyTavern.getContext();
        return context && typeof context === 'object' ? context : null;
    } catch {
        return null;
    }
}

/**
 * Reconciles the rendered DOM representation of a single message ID.
 *
 * @param {unknown} messageId - The index or ID of the assistant message.
 */
function refreshRenderedImageMessage(messageId) {
    const inspection = inspectActiveImageMessage(messageId);

    // If chat changed or stale inspection detected, do nothing to the DOM.
    if (!inspection || typeof inspection !== 'object') {
        return;
    }

    if (inspection.status === 'chat-changed') {
        return;
    }

    if (inspection.status === 'ignored' && inspection.reason === 'context-unavailable') {
        return;
    }

    // Require normalized numeric messageId from inspector for DOM lookup
    if (
        typeof inspection.messageId !== 'number' ||
        !Number.isInteger(inspection.messageId)
    ) {
        return;
    }

    if (
        typeof document === 'undefined' ||
        !document ||
        typeof document.querySelector !== 'function'
    ) {
        return;
    }

    const messageElement = document.querySelector(
        `#chat .mes[mesid="${inspection.messageId}"]`,
    );

    if (!messageElement) {
        return;
    }

    renderInlineImageState(messageElement, inspection);
}

/**
 * Reconstructs transient Chromatic Images UI for all currently rendered messages under #chat.
 *
 * @returns {{
 *     status: 'refreshed' | 'unavailable',
 *     inspected?: number,
 *     rendered?: number,
 * }}
 */
export function refreshRenderedImageMessages() {
    if (
        typeof document === 'undefined' ||
        !document ||
        typeof document.querySelectorAll !== 'function'
    ) {
        return {
            status: 'unavailable',
        };
    }

    try {
        const messageElements = document.querySelectorAll('#chat .mes[mesid]');
        if (!messageElements) {
            return {
                status: 'refreshed',
                inspected: 0,
                rendered: 0,
            };
        }

        let inspected = 0;
        let rendered = 0;

        for (const element of Array.from(messageElements)) {
            try {
                if (!element || typeof element.getAttribute !== 'function') {
                    continue;
                }

                const mesIdAttr = element.getAttribute('mesid');
                if (mesIdAttr === null || mesIdAttr === undefined) {
                    continue;
                }

                inspected += 1;

                const inspection = inspectActiveImageMessage(mesIdAttr);
                if (
                    !inspection ||
                    inspection.status === 'chat-changed' ||
                    (inspection.status === 'ignored' && inspection.reason === 'context-unavailable')
                ) {
                    continue;
                }

                const result = renderInlineImageState(element, inspection);
                if (result && result.status === 'rendered') {
                    rendered += 1;
                }
            } catch {
                // Defensive per-element isolation
            }
        }

        return {
            status: 'refreshed',
            inspected,
            rendered,
        };
    } catch {
        return {
            status: 'unavailable',
        };
    }
}

/**
 * Resolves an event identifier from context, checking legacy event_types first,
 * then modern eventTypes.
 *
 * @param {object} context - SillyTavern context.
 * @param {string} eventName - Name of the event to resolve.
 * @returns {string | symbol | null}
 */
function resolveEventIdentifier(context, eventName) {
    if (!context || typeof context !== 'object') {
        return null;
    }

    const legacy = context.event_types?.[eventName];
    if (isValidEventIdentifier(legacy)) {
        return legacy;
    }

    const modern = context.eventTypes?.[eventName];
    if (isValidEventIdentifier(modern)) {
        return modern;
    }

    return null;
}

/**
 * Register Chromatic Images message runtime handlers with SillyTavern.
 *
 * @returns {{ status: 'registered' | 'already-registered' | 'unavailable' }}
 */
export function registerMessageRuntime() {
    if (registered) {
        return { status: 'already-registered' };
    }

    const context = getSillyTavernContext();
    if (!context || !context.eventSource || typeof context.eventSource.on !== 'function') {
        return { status: 'unavailable' };
    }

    const charRenderedEvent = resolveEventIdentifier(context, 'CHARACTER_MESSAGE_RENDERED');
    if (!isValidEventIdentifier(charRenderedEvent)) {
        return { status: 'unavailable' };
    }

    const handler = (messageId) => {
        try {
            refreshRenderedImageMessage(messageId);
        } catch {
            // Fail safely: event emitter must never be broken
        }
    };

    const registeredEvents = new Set();

    try {
        context.eventSource.on(charRenderedEvent, handler);
        registeredEvents.add(charRenderedEvent);
    } catch {
        return { status: 'unavailable' };
    }

    const swipedEvent = resolveEventIdentifier(context, 'MESSAGE_SWIPED');
    if (isValidEventIdentifier(swipedEvent) && !registeredEvents.has(swipedEvent)) {
        try {
            context.eventSource.on(swipedEvent, handler);
            registeredEvents.add(swipedEvent);
        } catch {
            // Optional registration failure is non-fatal
        }
    }

    const updatedEvent = resolveEventIdentifier(context, 'MESSAGE_UPDATED');
    if (isValidEventIdentifier(updatedEvent) && !registeredEvents.has(updatedEvent)) {
        try {
            context.eventSource.on(updatedEvent, handler);
            registeredEvents.add(updatedEvent);
        } catch {
            // Optional registration failure is non-fatal
        }
    }

    registered = true;
    return { status: 'registered' };
}

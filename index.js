import {
    ensurePanel,
    refreshPanelState,
} from './src/panel.js';

import {
    LOG_PREFIX,
} from './src/constants.js';

import {
    registerMessageRuntime,
    refreshRenderedImageMessages,
} from './src/message-runtime.js';

let lifecycleRegistered = false;
let initialized = false;
let initializationPromise = null;

/**
 * Refresh extension state for the active chat.
 */
function refreshActiveChat() {
    try {
        refreshPanelState();
    } catch {
        // Independent failure safety: panel absence must not prevent runtime scan
    }

    try {
        refreshRenderedImageMessages();
    } catch {
        // Independent failure safety: missing chat DOM must not prevent panel refresh
    }
}

/**
 * Register Chromatic Images with SillyTavern's lifecycle.
 */
export function onActivate() {
    if (lifecycleRegistered) {
        return;
    }

    registerMessageRuntime();

    const { eventSource, eventTypes } = SillyTavern.getContext();

    eventSource.on(
        eventTypes.CHAT_CHANGED,
        refreshActiveChat,
    );
    eventSource.on(
        eventTypes.APP_INITIALIZED,
        initialize,
    );

    lifecycleRegistered = true;
}

/**
 * Initialize exactly once, including concurrent calls.
 *
 * @returns {Promise<void>}
 */
async function initialize() {
    if (initialized) {
        return;
    }

    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = initializeOnce();

    try {
        await initializationPromise;
        initialized = true;
    } catch (error) {
        initializationPromise = null;
        console.error(`${LOG_PREFIX} Failed to initialize.`, error);
    }
}

/**
 * Mount the panel and refresh the active chat state.
 *
 * @returns {Promise<void>}
 */
async function initializeOnce() {
    await ensurePanel();
    refreshActiveChat();
}

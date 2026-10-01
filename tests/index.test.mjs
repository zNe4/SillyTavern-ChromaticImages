import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EXTENSIONS_SETTINGS_CONTAINER_ID,
    LOG_PREFIX,
    PANEL_ID,
} from '../src/constants.js';

let testRunIndex = 0;

/**
 * Load a fresh instance of index.js with independent lifecycle module state.
 *
 * @returns {Promise<{ onActivate: () => void }>}
 */
async function loadFreshIndex() {
    testRunIndex += 1;
    const moduleUrl = new URL(
        `../index.js?test=${testRunIndex}_${Date.now()}`,
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

function createMockPanel() {
    return {
        id: PANEL_ID,
        querySelector() {
            return null;
        },
    };
}

test('A. Repeated activation registers lifecycle once and ignores message events', async () => {
    const origST = globalThis.SillyTavern;

    try {
        const eventSource = createFakeEventSource();
        const eventTypes = {
            APP_INITIALIZED: 'app_initialized',
            CHAT_CHANGED: 'chat_changed',
            MESSAGE_RECEIVED: 'message_received',
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    eventTypes,
                };
            },
        };

        const { onActivate } = await loadFreshIndex();

        onActivate();
        onActivate();

        const appInitHandlers = eventSource.getHandlers(eventTypes.APP_INITIALIZED);
        const chatChangedHandlers = eventSource.getHandlers(eventTypes.CHAT_CHANGED);
        const messageReceivedHandlers = eventSource.getHandlers(eventTypes.MESSAGE_RECEIVED);

        assert.strictEqual(appInitHandlers.length, 1);
        assert.strictEqual(chatChangedHandlers.length, 1);
        assert.strictEqual(messageReceivedHandlers.length, 0);
    } finally {
        globalThis.SillyTavern = origST;
    }
});

test('B. CHAT_CHANGED refreshes safely before initialization without mounting panel', async () => {
    const origST = globalThis.SillyTavern;
    const origDoc = globalThis.document;

    try {
        const eventSource = createFakeEventSource();
        const eventTypes = {
            APP_INITIALIZED: 'app_initialized',
            CHAT_CHANGED: 'chat_changed',
        };

        let templateRenderCalls = 0;
        let panelMounted = false;

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return panelMounted ? createMockPanel() : null;
                }
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    eventTypes,
                    renderExtensionTemplateAsync: async () => {
                        templateRenderCalls += 1;
                        return `<div id="${PANEL_ID}"></div>`;
                    },
                };
            },
        };

        const { onActivate } = await loadFreshIndex();
        onActivate();

        const [chatChangedHandler] = eventSource.getHandlers(eventTypes.CHAT_CHANGED);
        assert.strictEqual(typeof chatChangedHandler, 'function');

        assert.doesNotThrow(() => {
            chatChangedHandler();
        });

        assert.strictEqual(templateRenderCalls, 0);
        assert.strictEqual(panelMounted, false);
    } finally {
        globalThis.SillyTavern = origST;
        globalThis.document = origDoc;
    }
});

test('C. Concurrent initialization mounts panel exactly once', async () => {
    const origST = globalThis.SillyTavern;
    const origDoc = globalThis.document;

    try {
        const eventSource = createFakeEventSource();
        const eventTypes = {
            APP_INITIALIZED: 'app_initialized',
            CHAT_CHANGED: 'chat_changed',
        };

        let templateRenderCount = 0;
        let panelInsertCount = 0;
        let mountedPanel = null;

        const container = {
            id: EXTENSIONS_SETTINGS_CONTAINER_ID,
            insertAdjacentHTML(position, html) {
                panelInsertCount += 1;
                mountedPanel = createMockPanel();
            },
        };

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return mountedPanel;
                }
                if (id === EXTENSIONS_SETTINGS_CONTAINER_ID) {
                    return container;
                }
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    eventTypes,
                    renderExtensionTemplateAsync: async () => {
                        templateRenderCount += 1;
                        // Yield to microtask queue so concurrent callers share the in-flight promise
                        await Promise.resolve();
                        return `<div id="${PANEL_ID}"></div>`;
                    },
                };
            },
        };

        const { onActivate } = await loadFreshIndex();
        onActivate();

        const [initHandler] = eventSource.getHandlers(eventTypes.APP_INITIALIZED);
        assert.strictEqual(typeof initHandler, 'function');

        await Promise.all([
            initHandler(),
            initHandler(),
            initHandler(),
        ]);

        assert.strictEqual(templateRenderCount, 1);
        assert.strictEqual(panelInsertCount, 1);
        assert.ok(mountedPanel);
    } finally {
        globalThis.SillyTavern = origST;
        globalThis.document = origDoc;
    }
});

test('D. Repeated APP_INITIALIZED after success does nothing', async () => {
    const origST = globalThis.SillyTavern;
    const origDoc = globalThis.document;

    try {
        const eventSource = createFakeEventSource();
        const eventTypes = {
            APP_INITIALIZED: 'app_initialized',
            CHAT_CHANGED: 'chat_changed',
        };

        let templateRenderCount = 0;
        let panelInsertCount = 0;
        let mountedPanel = null;

        const container = {
            id: EXTENSIONS_SETTINGS_CONTAINER_ID,
            insertAdjacentHTML(position, html) {
                panelInsertCount += 1;
                mountedPanel = createMockPanel();
            },
        };

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return mountedPanel;
                }
                if (id === EXTENSIONS_SETTINGS_CONTAINER_ID) {
                    return container;
                }
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    eventTypes,
                    renderExtensionTemplateAsync: async () => {
                        templateRenderCount += 1;
                        return `<div id="${PANEL_ID}"></div>`;
                    },
                };
            },
        };

        const { onActivate } = await loadFreshIndex();
        onActivate();

        const [initHandler] = eventSource.getHandlers(eventTypes.APP_INITIALIZED);

        await initHandler();
        assert.strictEqual(templateRenderCount, 1);
        assert.strictEqual(panelInsertCount, 1);

        await initHandler();
        assert.strictEqual(templateRenderCount, 1);
        assert.strictEqual(panelInsertCount, 1);
    } finally {
        globalThis.SillyTavern = origST;
        globalThis.document = origDoc;
    }
});

test('E. Initialization failure can retry upon next APP_INITIALIZED', async () => {
    const origST = globalThis.SillyTavern;
    const origDoc = globalThis.document;
    const origConsoleError = console.error;

    try {
        const loggedErrors = [];
        console.error = (...args) => {
            loggedErrors.push(args);
        };

        const eventSource = createFakeEventSource();
        const eventTypes = {
            APP_INITIALIZED: 'app_initialized',
            CHAT_CHANGED: 'chat_changed',
        };

        let containerAvailable = false;
        let mountedPanel = null;
        let templateRenderCount = 0;

        const container = {
            id: EXTENSIONS_SETTINGS_CONTAINER_ID,
            insertAdjacentHTML() {
                mountedPanel = createMockPanel();
            },
        };

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return mountedPanel;
                }
                if (id === EXTENSIONS_SETTINGS_CONTAINER_ID && containerAvailable) {
                    return container;
                }
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    eventSource,
                    eventTypes,
                    renderExtensionTemplateAsync: async () => {
                        templateRenderCount += 1;
                        return `<div id="${PANEL_ID}"></div>`;
                    },
                };
            },
        };

        const { onActivate } = await loadFreshIndex();
        onActivate();

        const [initHandler] = eventSource.getHandlers(eventTypes.APP_INITIALIZED);

        // Attempt 1: container missing -> should fail safely and log via console.error
        await initHandler();

        assert.strictEqual(mountedPanel, null);
        assert.strictEqual(loggedErrors.length, 1);
        assert.match(loggedErrors[0][0], new RegExp(LOG_PREFIX.replace('[', '\\[').replace(']', '\\]')));

        // Attempt 2: container becomes available -> retry should succeed
        containerAvailable = true;
        await initHandler();

        assert.ok(mountedPanel);
        assert.strictEqual(templateRenderCount, 1);
    } finally {
        console.error = origConsoleError;
        globalThis.SillyTavern = origST;
        globalThis.document = origDoc;
    }
});

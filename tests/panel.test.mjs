import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EXTENSION_FOLDER,
    EXTENSIONS_SETTINGS_CONTAINER_ID,
    PANEL_DRAWER_TOGGLE_ID,
    PANEL_ID,
} from '../src/constants.js';
import {
    ensurePanel,
    refreshPanelState,
} from '../src/panel.js';

function createMockElement(id, tagName = 'div') {
    const attributes = new Map();
    const eventListeners = new Map();
    let innerHTML = '';

    return {
        id,
        tagName: tagName.toUpperCase(),
        get innerHTML() {
            return innerHTML;
        },
        set innerHTML(value) {
            innerHTML = value;
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        addEventListener(event, listener) {
            if (!eventListeners.has(event)) {
                eventListeners.set(event, []);
            }
            eventListeners.get(event).push(listener);
        },
        getListeners(event) {
            return eventListeners.get(event) ?? [];
        },
        querySelector(selector) {
            if (selector === `#${PANEL_DRAWER_TOGGLE_ID}` && this.id === PANEL_ID) {
                return this.drawerToggle ?? null;
            }
            return null;
        },
    };
}

test('A. Existing panel is reused without re-rendering template', async () => {
    const origDoc = globalThis.document;
    const origST = globalThis.SillyTavern;

    try {
        const existingPanel = createMockElement(PANEL_ID);
        let renderCalls = 0;

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return existingPanel;
                }
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    renderExtensionTemplateAsync: async () => {
                        renderCalls += 1;
                        return '<div></div>';
                    },
                };
            },
        };

        const result = await ensurePanel();

        assert.strictEqual(result, existingPanel);
        assert.strictEqual(renderCalls, 0);
    } finally {
        globalThis.document = origDoc;
        globalThis.SillyTavern = origST;
    }
});

test('B. Missing SillyTavern settings container fails clearly', async () => {
    const origDoc = globalThis.document;
    const origST = globalThis.SillyTavern;

    try {
        globalThis.document = {
            getElementById() {
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    renderExtensionTemplateAsync: async () => '<div></div>',
                };
            },
        };

        await assert.rejects(
            async () => {
                await ensurePanel();
            },
            (error) => {
                assert.match(error.message, new RegExp(EXTENSIONS_SETTINGS_CONTAINER_ID));
                return true;
            },
        );
    } finally {
        globalThis.document = origDoc;
        globalThis.SillyTavern = origST;
    }
});

test('C. Template mount succeeds with expected arguments and insertion position', async () => {
    const origDoc = globalThis.document;
    const origST = globalThis.SillyTavern;

    try {
        let mountedPanel = null;
        let receivedFolder = null;
        let receivedTemplate = null;
        let receivedPosition = null;

        const container = {
            id: EXTENSIONS_SETTINGS_CONTAINER_ID,
            insertAdjacentHTML(position, html) {
                receivedPosition = position;
                mountedPanel = createMockElement(PANEL_ID);
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
                    renderExtensionTemplateAsync: async (folder, template) => {
                        receivedFolder = folder;
                        receivedTemplate = template;
                        return `<div id="${PANEL_ID}"></div>`;
                    },
                };
            },
        };

        const result = await ensurePanel();

        assert.strictEqual(result, mountedPanel);
        assert.strictEqual(receivedFolder, EXTENSION_FOLDER);
        assert.strictEqual(receivedTemplate, 'settings');
        assert.strictEqual(receivedPosition, 'beforeend');
    } finally {
        globalThis.document = origDoc;
        globalThis.SillyTavern = origST;
    }
});

test('D. Broken template fails clearly if panel is missing after insertion', async () => {
    const origDoc = globalThis.document;
    const origST = globalThis.SillyTavern;

    try {
        const container = {
            id: EXTENSIONS_SETTINGS_CONTAINER_ID,
            insertAdjacentHTML() {
                // Template insertion failed to create expected PANEL_ID element
            },
        };

        globalThis.document = {
            getElementById(id) {
                if (id === EXTENSIONS_SETTINGS_CONTAINER_ID) {
                    return container;
                }
                return null;
            },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    renderExtensionTemplateAsync: async () => '<div>unexpected</div>',
                };
            },
        };

        await assert.rejects(
            async () => {
                await ensurePanel();
            },
            (error) => {
                assert.match(error.message, new RegExp(PANEL_ID));
                return true;
            },
        );
    } finally {
        globalThis.document = origDoc;
        globalThis.SillyTavern = origST;
    }
});

test('E. refreshPanelState safely does nothing when panel is absent', () => {
    const origDoc = globalThis.document;

    try {
        globalThis.document = {
            getElementById() {
                return null;
            },
        };

        assert.doesNotThrow(() => {
            refreshPanelState();
        });
    } finally {
        globalThis.document = origDoc;
    }
});

test('F. Drawer accessibility listener registers once across repeated refreshes', () => {
    const origDoc = globalThis.document;

    try {
        const panel = createMockElement(PANEL_ID);
        const drawerToggle = createMockElement(PANEL_DRAWER_TOGGLE_ID, 'button');
        drawerToggle.setAttribute('aria-expanded', 'false');
        panel.drawerToggle = drawerToggle;

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return panel;
                }
                return null;
            },
        };

        refreshPanelState();
        refreshPanelState();
        refreshPanelState();

        const clickListeners = drawerToggle.getListeners('click');
        assert.strictEqual(clickListeners.length, 1);
    } finally {
        globalThis.document = origDoc;
    }
});

test('G. Drawer accessibility toggles aria-expanded on activations', () => {
    const origDoc = globalThis.document;

    try {
        const panel = createMockElement(PANEL_ID);
        const drawerToggle = createMockElement(PANEL_DRAWER_TOGGLE_ID, 'button');
        drawerToggle.setAttribute('aria-expanded', 'false');
        panel.drawerToggle = drawerToggle;

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return panel;
                }
                return null;
            },
        };

        refreshPanelState();

        const [clickListener] = drawerToggle.getListeners('click');
        assert.strictEqual(typeof clickListener, 'function');

        clickListener();
        assert.strictEqual(drawerToggle.getAttribute('aria-expanded'), 'true');

        clickListener();
        assert.strictEqual(drawerToggle.getAttribute('aria-expanded'), 'false');
    } finally {
        globalThis.document = origDoc;
    }
});

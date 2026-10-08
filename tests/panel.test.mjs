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
    const childrenMap = new Map();
    let innerHTML = '';
    let textContent = '';

    return {
        id,
        tagName: tagName.toUpperCase(),
        dataset: {},
        disabled: false,
        hidden: false,
        get innerHTML() {
            return innerHTML;
        },
        set innerHTML(value) {
            innerHTML = value;
        },
        get textContent() {
            return textContent;
        },
        set textContent(value) {
            textContent = String(value);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
            if (name.startsWith('data-')) {
                const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                this.dataset[camel] = String(value);
            }
        },
        removeAttribute(name) {
            attributes.delete(name);
            if (name.startsWith('data-')) {
                const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                delete this.dataset[camel];
            }
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
        setChild(selector, element) {
            childrenMap.set(selector, element);
        },
        querySelector(selector) {
            if (selector === `#${PANEL_DRAWER_TOGGLE_ID}` && this.id === PANEL_ID && this.drawerToggle) {
                return this.drawerToggle;
            }
            return childrenMap.get(selector) ?? null;
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

test('H. refreshPanelState refreshes Regex UI when panel contains regex elements without mutating settings', () => {
    const origDoc = globalThis.document;
    const origST = globalThis.SillyTavern;

    try {
        let saveCalls = 0;
        const extensionSettings = { regex: [] };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    extensionSettings,
                    saveSettingsDebounced() {
                        saveCalls += 1;
                    },
                };
            },
        };

        const panel = createMockElement(PANEL_ID);
        const drawerToggle = createMockElement(PANEL_DRAWER_TOGGLE_ID, 'button');
        panel.drawerToggle = drawerToggle;

        const promptHygieneStatus = createMockElement('chromatic-images-regex-prompt-hygiene-status');
        const summary = createMockElement('chromatic-images-regex-summary');
        const repairBtn = createMockElement('chromatic-images-regex-repair', 'button');
        const feedback = createMockElement('chromatic-images-regex-feedback');

        panel.setChild('#chromatic-images-regex-prompt-hygiene-status', promptHygieneStatus);
        panel.setChild('#chromatic-images-regex-summary', summary);
        panel.setChild('#chromatic-images-regex-repair', repairBtn);
        panel.setChild('#chromatic-images-regex-feedback', feedback);

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return panel;
                }
                return null;
            },
        };

        refreshPanelState();

        assert.equal(promptHygieneStatus.textContent, 'Missing');
        assert.equal(summary.textContent, 'Prompt hygiene is missing or outdated.');
        assert.equal(repairBtn.textContent, 'Install / Repair Regex');
        assert.equal(repairBtn.disabled, false);
        assert.equal(extensionSettings.regex.length, 0);
        assert.equal(saveCalls, 0);

        // Repeated refresh should not duplicate click listeners
        refreshPanelState();
        refreshPanelState();

        const clickListeners = repairBtn.getListeners('click');
        assert.equal(clickListeners.length, 1);
        assert.equal(saveCalls, 0);
    } finally {
        globalThis.document = origDoc;
        globalThis.SillyTavern = origST;
    }
});

test('I. refreshPanelState refreshes both Regex and Provider UI sections safely without network or saves', () => {
    const origDoc = globalThis.document;
    const origST = globalThis.SillyTavern;

    try {
        let saveCalls = 0;
        const extensionSettings = {
            regex: [],
            chromatic_images: { resolution: '768x1024' },
        };

        globalThis.SillyTavern = {
            getContext() {
                return {
                    extensionSettings,
                    saveSettingsDebounced() {
                        saveCalls += 1;
                    },
                };
            },
        };

        const panel = createMockElement(PANEL_ID);
        const drawerToggle = createMockElement(PANEL_DRAWER_TOGGLE_ID, 'button');
        panel.drawerToggle = drawerToggle;

        // Regex elements
        panel.setChild('#chromatic-images-regex-prompt-hygiene-status', createMockElement('chromatic-images-regex-prompt-hygiene-status'));
        panel.setChild('#chromatic-images-regex-summary', createMockElement('chromatic-images-regex-summary'));
        panel.setChild('#chromatic-images-regex-repair', createMockElement('chromatic-images-regex-repair', 'button'));
        panel.setChild('#chromatic-images-regex-feedback', createMockElement('chromatic-images-regex-feedback'));

        // Provider elements
        const resolutionSelect = createMockElement('chromatic-images-resolution-select', 'select');
        const diagnosticsBtn = createMockElement('chromatic-images-diagnostics-run', 'button');
        const credStatus = createMockElement('chromatic-images-credential-status');
        credStatus.textContent = 'Not checked';
        const proxyStatus = createMockElement('chromatic-images-proxy-status');
        proxyStatus.textContent = 'Not checked';
        const diagSummary = createMockElement('chromatic-images-diagnostics-summary');
        diagSummary.textContent = 'Diagnostics not run yet.';
        const diagFeedback = createMockElement('chromatic-images-diagnostics-feedback');

        panel.setChild('#chromatic-images-resolution-select', resolutionSelect);
        panel.setChild('#chromatic-images-diagnostics-run', diagnosticsBtn);
        panel.setChild('#chromatic-images-credential-status', credStatus);
        panel.setChild('#chromatic-images-proxy-status', proxyStatus);
        panel.setChild('#chromatic-images-diagnostics-summary', diagSummary);
        panel.setChild('#chromatic-images-diagnostics-feedback', diagFeedback);

        globalThis.document = {
            getElementById(id) {
                if (id === PANEL_ID) {
                    return panel;
                }
                return null;
            },
        };

        refreshPanelState();

        // Verifies provider settings synchronization
        assert.equal(resolutionSelect.value, '768x1024');
        assert.equal(credStatus.textContent, 'Not checked');
        assert.equal(proxyStatus.textContent, 'Not checked');
        assert.equal(diagnosticsBtn.disabled, false);
        assert.equal(saveCalls, 0);

        // Repeated refresh does not duplicate listeners or save
        refreshPanelState();
        refreshPanelState();
        assert.equal(resolutionSelect.getListeners('change').length, 1);
        assert.equal(diagnosticsBtn.getListeners('click').length, 1);
        assert.equal(saveCalls, 0);
    } finally {
        globalThis.document = origDoc;
        globalThis.SillyTavern = origST;
    }
});


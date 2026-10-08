import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    CREDENTIAL_STATUS,
    CREDENTIAL_STATUS_ID,
    DIAGNOSTICS_FEEDBACK_ID,
    DIAGNOSTICS_RUN_BUTTON_ID,
    DIAGNOSTICS_SUMMARY_ID,
    PROXY_STATUS,
    PROXY_STATUS_ID,
    RESOLUTION_SELECT_ID,
    SETTINGS_KEY,
} from '../src/constants.js';
import { refreshProviderPanel } from '../src/provider-panel.js';

function delay() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakePanel(options = {}) {
    const listeners = {
        change: [],
        click: [],
    };

    let resolutionValue = options.initialResolution ?? 'auto';
    const resolutionSelect = options.hasResolutionSelect !== false ? {
        id: RESOLUTION_SELECT_ID,
        get value() {
            return resolutionValue;
        },
        set value(v) {
            resolutionValue = String(v);
        },
        addEventListener(event, handler) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(handler);
        },
        dispatchEvent(event) {
            const handlers = listeners[event.type] || [];
            for (const handler of handlers) {
                handler(event);
            }
        },
        change(newVal) {
            this.value = newVal;
            this.dispatchEvent({ type: 'change' });
        },
        get changeListeners() {
            return listeners.change || [];
        },
    } : null;

    let buttonText = 'Check local setup';
    const runBtn = options.hasRunButton !== false ? {
        id: DIAGNOSTICS_RUN_BUTTON_ID,
        disabled: options.initialButtonDisabled ?? false,
        get textContent() {
            return buttonText;
        },
        set textContent(v) {
            buttonText = String(v);
        },
        get innerHTML() {
            return buttonText;
        },
        set innerHTML(_v) {
            throw new Error('innerHTML must not be used');
        },
        addEventListener(event, handler) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(handler);
        },
        dispatchEvent(event) {
            const handlers = listeners[event.type] || [];
            for (const handler of handlers) {
                handler(event);
            }
        },
        click() {
            this.dispatchEvent({ type: 'click' });
        },
        get clickListeners() {
            return listeners.click || [];
        },
    } : null;

    let credStatusText = 'Not checked';
    const credentialStatus = options.hasCredentialStatus !== false ? {
        id: CREDENTIAL_STATUS_ID,
        dataset: { credentialStatus: 'not-checked' },
        get textContent() {
            return credStatusText;
        },
        set textContent(v) {
            credStatusText = String(v);
        },
        get innerHTML() {
            return credStatusText;
        },
        set innerHTML(_v) {
            throw new Error('innerHTML must not be used');
        },
        setAttribute(attr, val) {
            if (attr === 'data-credential-status') {
                this.dataset.credentialStatus = String(val);
            }
        },
    } : null;

    let proxyStatusText = 'Not checked';
    const proxyStatus = options.hasProxyStatus !== false ? {
        id: PROXY_STATUS_ID,
        dataset: { proxyStatus: 'not-checked' },
        get textContent() {
            return proxyStatusText;
        },
        set textContent(v) {
            proxyStatusText = String(v);
        },
        get innerHTML() {
            return proxyStatusText;
        },
        set innerHTML(_v) {
            throw new Error('innerHTML must not be used');
        },
        setAttribute(attr, val) {
            if (attr === 'data-proxy-status') {
                this.dataset.proxyStatus = String(val);
            }
        },
    } : null;

    let summaryText = 'Diagnostics not run yet.';
    const summary = options.hasSummary !== false ? {
        id: DIAGNOSTICS_SUMMARY_ID,
        get textContent() {
            return summaryText;
        },
        set textContent(v) {
            summaryText = String(v);
        },
        get innerHTML() {
            return summaryText;
        },
        set innerHTML(_v) {
            throw new Error('innerHTML must not be used');
        },
    } : null;

    let feedbackText = '';
    const feedback = options.hasFeedback !== false ? {
        id: DIAGNOSTICS_FEEDBACK_ID,
        dataset: {},
        hidden: true,
        get textContent() {
            return feedbackText;
        },
        set textContent(val) {
            feedbackText = String(val);
        },
        get innerHTML() {
            return feedbackText;
        },
        set innerHTML(_val) {
            throw new Error('innerHTML must not be used');
        },
        setAttribute(attr, val) {
            if (attr === 'data-feedback-kind') {
                this.dataset.feedbackKind = String(val);
            }
        },
        removeAttribute(attr) {
            if (attr === 'data-feedback-kind') {
                delete this.dataset.feedbackKind;
            }
        },
    } : null;

    let isConnected = options.isConnected ?? true;

    return {
        get isConnected() {
            return isConnected;
        },
        set isConnected(val) {
            isConnected = Boolean(val);
        },
        querySelector(selector) {
            if (selector === `#${RESOLUTION_SELECT_ID}`) return resolutionSelect;
            if (selector === `#${DIAGNOSTICS_RUN_BUTTON_ID}`) return runBtn;
            if (selector === `#${CREDENTIAL_STATUS_ID}`) return credentialStatus;
            if (selector === `#${PROXY_STATUS_ID}`) return proxyStatus;
            if (selector === `#${DIAGNOSTICS_SUMMARY_ID}`) return summary;
            if (selector === `#${DIAGNOSTICS_FEEDBACK_ID}`) return feedback;
            return null;
        },
        elements: {
            resolutionSelect,
            runBtn,
            credentialStatus,
            proxyStatus,
            summary,
            feedback,
        },
    };
}

test('1. Missing panel or child elements returns safely without throwing', () => {
    assert.doesNotThrow(() => refreshProviderPanel(null));
    assert.doesNotThrow(() => refreshProviderPanel(undefined));
    assert.doesNotThrow(() => refreshProviderPanel({}));

    for (const key of ['hasResolutionSelect', 'hasRunButton', 'hasCredentialStatus', 'hasProxyStatus', 'hasSummary', 'hasFeedback']) {
        const fake = createFakePanel({ [key]: false });
        assert.doesNotThrow(() => refreshProviderPanel(fake));
    }
});

test('2. Initial mount syncs resolution select and leaves indicators in Not checked state', () => {
    const fake = createFakePanel();
    const extensionSettings = { [SETTINGS_KEY]: { resolution: '768x1024' } };

    refreshProviderPanel(fake, { extensionSettings });

    assert.strictEqual(fake.elements.resolutionSelect.value, '768x1024');
    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Not checked');
    assert.strictEqual(fake.elements.credentialStatus.dataset.credentialStatus, 'not-checked');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Not checked');
    assert.strictEqual(fake.elements.proxyStatus.dataset.proxyStatus, 'not-checked');
    assert.strictEqual(fake.elements.runBtn.disabled, false);
    assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');
});

test('3. Changing resolution select updates settings and calls saveSettingsDebounced', () => {
    const fake = createFakePanel();
    let saveCalls = 0;
    const extensionSettings = { [SETTINGS_KEY]: { resolution: 'auto' } };

    refreshProviderPanel(fake, {
        extensionSettings,
        saveSettingsDebounced: () => { saveCalls += 1; },
    });

    fake.elements.resolutionSelect.change('1024x1024');

    assert.strictEqual(extensionSettings[SETTINGS_KEY].resolution, '1024x1024');
    assert.strictEqual(saveCalls, 1);
});

test('4. Selecting already-current resolution does not call saveSettingsDebounced', () => {
    const fake = createFakePanel({ initialResolution: '512x512' });
    let saveCalls = 0;
    const extensionSettings = { [SETTINGS_KEY]: { resolution: '512x512' } };

    refreshProviderPanel(fake, {
        extensionSettings,
        saveSettingsDebounced: () => { saveCalls += 1; },
    });

    fake.elements.resolutionSelect.change('512x512');

    assert.strictEqual(saveCalls, 0);
});

test('5. Invalid resolution selection does not save and reverts select control', () => {
    const fake = createFakePanel();
    let saveCalls = 0;
    const extensionSettings = { [SETTINGS_KEY]: { resolution: 'auto' } };

    refreshProviderPanel(fake, {
        extensionSettings,
        saveSettingsDebounced: () => { saveCalls += 1; },
    });

    fake.elements.resolutionSelect.change('invalid-choice');

    assert.strictEqual(saveCalls, 0);
    assert.strictEqual(fake.elements.resolutionSelect.value, 'auto');
    assert.strictEqual(extensionSettings[SETTINGS_KEY].resolution, 'auto');
});

test('6. Repeated refreshProviderPanel calls do not duplicate event listeners or trigger saves', () => {
    const fake = createFakePanel();
    let saveCalls = 0;
    const extensionSettings = { [SETTINGS_KEY]: { resolution: 'auto' } };

    refreshProviderPanel(fake, { extensionSettings, saveSettingsDebounced: () => { saveCalls += 1; } });
    refreshProviderPanel(fake, { extensionSettings, saveSettingsDebounced: () => { saveCalls += 1; } });
    refreshProviderPanel(fake, { extensionSettings, saveSettingsDebounced: () => { saveCalls += 1; } });

    assert.strictEqual(fake.elements.resolutionSelect.changeListeners.length, 1);
    assert.strictEqual(fake.elements.runBtn.clickListeners.length, 1);
    assert.strictEqual(saveCalls, 0);
});

test('7. Successful diagnostic check renders Configured and Available with correct copy', async () => {
    const fake = createFakePanel();
    let credCalls = 0;
    let proxyCalls = 0;

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => {
            credCalls += 1;
            return { status: CREDENTIAL_STATUS.CONFIGURED, error: null };
        },
        checkNanoGptImagesCapability: async () => {
            proxyCalls += 1;
            return { supported: true, cached: false, status: 200, error: null };
        },
    });

    fake.elements.runBtn.click();
    await delay();

    assert.strictEqual(credCalls, 1);
    assert.strictEqual(proxyCalls, 1);
    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Configured');
    assert.strictEqual(fake.elements.credentialStatus.dataset.credentialStatus, 'configured');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Available');
    assert.strictEqual(fake.elements.proxyStatus.dataset.proxyStatus, 'available');
    assert.match(fake.elements.summary.textContent, /Local readiness checks passed/);
    assert.match(fake.elements.summary.textContent, /does not verify the API key or provider balance/);
    assert.strictEqual(fake.elements.feedback.hidden, true);
    assert.strictEqual(fake.elements.runBtn.disabled, false);
    assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');
});

test('8. Missing proxy check renders Update required with actionable warning feedback', async () => {
    const fake = createFakePanel();

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => ({ status: CREDENTIAL_STATUS.CONFIGURED, error: null }),
        checkNanoGptImagesCapability: async () => ({
            supported: false,
            cached: false,
            status: 404,
            error: { kind: 'sillytavern-update-required', message: 'Update required' },
        }),
    });

    fake.elements.runBtn.click();
    await delay();

    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Configured');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Update required');
    assert.strictEqual(fake.elements.proxyStatus.dataset.proxyStatus, 'update-required');
    assert.strictEqual(fake.elements.feedback.hidden, false);
    assert.strictEqual(fake.elements.feedback.dataset.feedbackKind, 'warning');
    assert.match(fake.elements.feedback.textContent, /normalized NanoGPT image support/);
});

test('9. Missing credential check renders Not configured with actionable warning feedback', async () => {
    const fake = createFakePanel();

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => ({ status: CREDENTIAL_STATUS.NOT_CONFIGURED, error: null }),
        checkNanoGptImagesCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
    });

    fake.elements.runBtn.click();
    await delay();

    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Not configured');
    assert.strictEqual(fake.elements.credentialStatus.dataset.credentialStatus, 'not-configured');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Available');
    assert.strictEqual(fake.elements.feedback.hidden, false);
    assert.strictEqual(fake.elements.feedback.dataset.feedbackKind, 'warning');
    assert.match(fake.elements.feedback.textContent, /API Connections \(Secrets\)/);
});

test('10. Both credential missing and proxy update required renders dual error status', async () => {
    const fake = createFakePanel();

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => ({ status: CREDENTIAL_STATUS.NOT_CONFIGURED, error: null }),
        checkNanoGptImagesCapability: async () => ({
            supported: false,
            cached: false,
            status: 404,
            error: { kind: 'sillytavern-update-required', message: 'Update required' },
        }),
    });

    fake.elements.runBtn.click();
    await delay();

    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Not configured');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Update required');
    assert.strictEqual(fake.elements.feedback.hidden, false);
    assert.strictEqual(fake.elements.feedback.dataset.feedbackKind, 'error');
    assert.match(fake.elements.feedback.textContent, /configure your NanoGPT key/i);
});

test('11. Unavailable probe renders Unavailable with error feedback', async () => {
    const fake = createFakePanel();

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => ({
            status: CREDENTIAL_STATUS.UNAVAILABLE,
            error: { kind: 'network-error', message: 'Failed' },
        }),
        checkNanoGptImagesCapability: async () => ({
            supported: false,
            cached: false,
            status: null,
            error: { kind: 'capability-network-error', message: 'Failed' },
        }),
    });

    fake.elements.runBtn.click();
    await delay();

    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Unavailable');
    assert.strictEqual(fake.elements.credentialStatus.dataset.credentialStatus, 'unavailable');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Unavailable');
    assert.strictEqual(fake.elements.proxyStatus.dataset.proxyStatus, 'unavailable');
    assert.strictEqual(fake.elements.feedback.hidden, false);
    assert.strictEqual(fake.elements.feedback.dataset.feedbackKind, 'error');
    assert.match(fake.elements.feedback.textContent, /communication error/i);
});

test('12. Single-flight lock ignores repeated clicks while check is running', async () => {
    const fake = createFakePanel();
    let credCalls = 0;
    let finishCred;
    const credPromise = new Promise((resolve) => { finishCred = resolve; });

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => {
            credCalls += 1;
            await credPromise;
            return { status: CREDENTIAL_STATUS.CONFIGURED, error: null };
        },
        checkNanoGptImagesCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
    });

    fake.elements.runBtn.click();
    assert.strictEqual(fake.elements.runBtn.disabled, true);
    assert.strictEqual(fake.elements.runBtn.textContent, 'Checking setup…');

    // Repeated clicks while in flight
    fake.elements.runBtn.click();
    fake.elements.runBtn.click();

    finishCred();
    await delay();

    assert.strictEqual(credCalls, 1);
    assert.strictEqual(fake.elements.runBtn.disabled, false);
    assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');
});

test('13. Probe exception resilience: unexpected throw in probe fails safely without logging secrets or freezing UI', async () => {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origDebug = console.debug;
    const loggedMessages = [];

    const intercept = (...args) => {
        loggedMessages.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    try {
        console.log = intercept;
        console.warn = intercept;
        console.error = intercept;
        console.debug = intercept;

        const SENTINEL_SECRET = 'SENTINEL_PANEL_SECRET_TOKEN_445566';
        const fake = createFakePanel();

        // Sub-test A: Credential probe throws with sensitive sentinel, proxy probe succeeds
        refreshProviderPanel(fake, {
            checkNanoGptCredentialReadiness: async () => {
                const err = new Error(`Secret crash: ${SENTINEL_SECRET}`);
                err.secretKey = SENTINEL_SECRET;
                throw err;
            },
            checkNanoGptImagesCapability: async () => ({
                supported: true,
                cached: false,
                status: 200,
                error: null,
            }),
        });

        fake.elements.runBtn.click();
        await delay();

        // Credential safely fails to Unavailable, proxy succeeds independently
        assert.strictEqual(fake.elements.credentialStatus.textContent, 'Unavailable');
        assert.strictEqual(fake.elements.proxyStatus.textContent, 'Available');
        assert.strictEqual(fake.elements.runBtn.disabled, false);
        assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');

        // Sub-test B: Proxy probe throws with sensitive sentinel, credential probe succeeds
        refreshProviderPanel(fake, {
            checkNanoGptCredentialReadiness: async () => ({
                status: CREDENTIAL_STATUS.CONFIGURED,
                error: null,
            }),
            checkNanoGptImagesCapability: async () => {
                const err = new Error(`Proxy crash: ${SENTINEL_SECRET}`);
                err.secretKey = SENTINEL_SECRET;
                throw err;
            },
        });

        fake.elements.runBtn.click();
        await delay();

        assert.strictEqual(fake.elements.credentialStatus.textContent, 'Configured');
        assert.strictEqual(fake.elements.proxyStatus.textContent, 'Unavailable');
        assert.strictEqual(fake.elements.runBtn.disabled, false);

        // Verify zero console logs captured the sentinel string
        for (const msg of loggedMessages) {
            assert.doesNotMatch(msg, new RegExp(SENTINEL_SECRET));
        }

        // Verify DOM elements never received the sentinel string
        assert.doesNotMatch(fake.elements.summary.textContent, new RegExp(SENTINEL_SECRET));
        assert.doesNotMatch(fake.elements.feedback.textContent, new RegExp(SENTINEL_SECRET));
    } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
        console.debug = origDebug;
    }
});

test('14. Neutral cancellation outcome: restores UI to Not checked and re-enables button', async () => {
    const fake = createFakePanel();

    refreshProviderPanel(fake, {
        checkNanoGptCredentialReadiness: async () => ({ status: CREDENTIAL_STATUS.CANCELLED, error: null }),
        checkNanoGptImagesCapability: async () => ({
            supported: false,
            cached: false,
            status: null,
            error: { kind: 'cancelled', message: 'Cancelled' },
        }),
    });

    fake.elements.runBtn.click();
    await delay();

    assert.strictEqual(fake.elements.credentialStatus.textContent, 'Not checked');
    assert.strictEqual(fake.elements.credentialStatus.dataset.credentialStatus, 'not-checked');
    assert.strictEqual(fake.elements.proxyStatus.textContent, 'Not checked');
    assert.strictEqual(fake.elements.proxyStatus.dataset.proxyStatus, 'not-checked');
    assert.strictEqual(fake.elements.summary.textContent, 'Readiness check cancelled.');
    assert.strictEqual(fake.elements.runBtn.disabled, false);
    assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');
});

test('15. Lifecycle invalidation & detachment cleanup: handles detachment, aborts signal, cleans observer, and allows reattached recovery', async () => {
    const origMutationObserver = globalThis.MutationObserver;
    const origDocument = globalThis.document;

    class MockMutationObserver {
        static instances = [];
        constructor(callback) {
            this.callback = callback;
            this.observedTargets = [];
            this.disconnected = false;
            MockMutationObserver.instances.push(this);
        }
        observe(target, options) {
            this.observedTargets.push({ target, options });
        }
        disconnect() {
            this.disconnected = true;
        }
        trigger(records = [{ type: 'childList' }]) {
            if (!this.disconnected) {
                this.callback(records, this);
            }
        }
    }

    try {
        globalThis.MutationObserver = MockMutationObserver;
        globalThis.document = { body: {} };

        const fake = createFakePanel();
        fake.isConnected = true;

        let finishOldCred;
        const oldCredPromise = new Promise((resolve) => { finishOldCred = resolve; });
        let capturedSignal1 = null;

        refreshProviderPanel(fake, {
            checkNanoGptCredentialReadiness: async ({ signal }) => {
                capturedSignal1 = signal;
                await oldCredPromise;
                return { status: CREDENTIAL_STATUS.CONFIGURED, error: null };
            },
            checkNanoGptImagesCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        });

        // 1. Diagnostic click starts check
        fake.elements.runBtn.click();
        assert.strictEqual(fake.elements.runBtn.disabled, true);
        assert.strictEqual(fake.elements.runBtn.textContent, 'Checking setup…');
        assert.strictEqual(fake.elements.credentialStatus.textContent, 'Checking…');
        assert.strictEqual(capturedSignal1?.aborted, false);
        assert.strictEqual(MockMutationObserver.instances.length, 1);
        const observer = MockMutationObserver.instances[0];

        // 2. Panel detaches during pending diagnostic; MutationObserver triggers
        fake.isConnected = false;
        observer.trigger();

        // Active AbortSignal becomes aborted
        assert.strictEqual(capturedSignal1.aborted, true);
        // Observer cleanup occurs
        assert.strictEqual(observer.disconnected, true);

        // 3. Late results from old check settle
        finishOldCred();
        await delay();

        // Late results do not mutate detached elements
        assert.strictEqual(fake.elements.credentialStatus.textContent, 'Checking…');
        assert.strictEqual(fake.elements.proxyStatus.textContent, 'Checking…');

        // 4. Same panel is reattached and refreshed
        fake.isConnected = true;
        let capturedSignal2 = null;
        let finishNewCred;
        const newCredPromise = new Promise((resolve) => { finishNewCred = resolve; });

        refreshProviderPanel(fake, {
            checkNanoGptCredentialReadiness: async ({ signal }) => {
                capturedSignal2 = signal;
                await newCredPromise;
                return { status: CREDENTIAL_STATUS.CONFIGURED, error: null };
            },
            checkNanoGptImagesCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        });

        // Button does not remain permanently disabled; neutral state restored
        assert.strictEqual(fake.elements.runBtn.disabled, false);
        assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');
        assert.strictEqual(fake.elements.credentialStatus.textContent, 'Not checked');
        assert.strictEqual(fake.elements.proxyStatus.textContent, 'Not checked');

        // 5. New diagnostic click successfully starts a new check
        fake.elements.runBtn.click();
        assert.strictEqual(fake.elements.runBtn.disabled, true);
        assert.strictEqual(fake.elements.runBtn.textContent, 'Checking setup…');
        assert.strictEqual(capturedSignal2?.aborted, false);

        // 6. Complete new check
        finishNewCred();
        await delay();

        // Results of new check rendered successfully
        assert.strictEqual(fake.elements.credentialStatus.textContent, 'Configured');
        assert.strictEqual(fake.elements.proxyStatus.textContent, 'Available');
        assert.strictEqual(fake.elements.runBtn.disabled, false);
        assert.strictEqual(fake.elements.runBtn.textContent, 'Check local setup');
    } finally {
        globalThis.MutationObserver = origMutationObserver;
        globalThis.document = origDocument;
    }
});

test('16. settings.html template contains all required provider and diagnostic elements', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf-8');

    assert.match(html, new RegExp(`id="${RESOLUTION_SELECT_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTICS_RUN_BUTTON_ID}"`));
    assert.match(html, new RegExp(`id="${CREDENTIAL_STATUS_ID}"`));
    assert.match(html, new RegExp(`id="${PROXY_STATUS_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTICS_SUMMARY_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTICS_FEEDBACK_ID}"`));
    assert.match(html, /id="chromatic-images-provider-section"/);
    assert.match(html, /id="chromatic-images-diagnostics-section"/);
    assert.match(html, /role="list"/);
    assert.match(html, /aria-live="polite"/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    REGEX_INTEGRATION_STATUS,
    REGEX_SCRIPT_STATUS,
} from '../src/regex-integration.js';
import { refreshRegexIntegrationControl } from '../src/regex-panel.js';

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function delay() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakePanel(options = {}) {
    const listeners = { click: [] };

    let promptText = 'Checking…';
    const promptHygieneStatus = options.hasPromptHygiene !== false ? {
        id: 'chromatic-images-regex-prompt-hygiene-status',
        dataset: { regexStatus: 'unavailable' },
        get textContent() {
            return promptText;
        },
        set textContent(v) {
            promptText = String(v);
        },
        get innerHTML() {
            return promptText;
        },
        set innerHTML(_v) {
            throw new Error('innerHTML must not be used');
        },
        setAttribute(attr, val) {
            if (attr === 'data-regex-status') {
                this.dataset.regexStatus = String(val);
            }
        },
    } : null;

    let summaryText = 'Checking prompt-hygiene Regex…';
    const summary = options.hasSummary !== false ? {
        id: 'chromatic-images-regex-summary',
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

    let buttonText = 'Check Regex';
    const button = options.hasButton !== false ? {
        id: 'chromatic-images-regex-repair',
        disabled: options.initialButtonDisabled ?? true,
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

    let currentFeedbackText = '';
    const feedback = options.hasFeedback !== false ? {
        id: 'chromatic-images-regex-feedback',
        dataset: {},
        hidden: true,
        get textContent() {
            return currentFeedbackText;
        },
        set textContent(val) {
            currentFeedbackText = String(val);
        },
        get innerHTML() {
            return currentFeedbackText;
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

    const elements = {
        '#chromatic-images-regex-prompt-hygiene-status': promptHygieneStatus,
        '#chromatic-images-regex-summary': summary,
        '#chromatic-images-regex-repair': button,
        '#chromatic-images-regex-feedback': feedback,
    };

    const panel = {
        querySelector(selector) {
            return elements[selector] ?? null;
        },
    };

    return {
        panel,
        promptHygieneStatus,
        summary,
        button,
        feedback,
    };
}

function makeCurrentInspection() {
    return {
        status: REGEX_INTEGRATION_STATUS.CURRENT,
        regexExtensionDisabled: false,
        scripts: [
            {
                key: 'prompt-hygiene',
                scriptName: 'Chromatic Images - Hide image records from prompt',
                status: REGEX_SCRIPT_STATUS.CURRENT,
                matchCount: 1,
                differingFields: [],
            },
        ],
    };
}

function makeNeedsRepairInspection(scriptStatus = REGEX_SCRIPT_STATUS.MISSING) {
    return {
        status: REGEX_INTEGRATION_STATUS.NEEDS_REPAIR,
        regexExtensionDisabled: false,
        scripts: [
            {
                key: 'prompt-hygiene',
                scriptName: 'Chromatic Images - Hide image records from prompt',
                status: scriptStatus,
                matchCount: scriptStatus === REGEX_SCRIPT_STATUS.MISSING ? 0 : 1,
                differingFields: scriptStatus === REGEX_SCRIPT_STATUS.OUTDATED ? ['findRegex'] : [],
            },
        ],
    };
}

test('1: missing panel returns safely without throwing', () => {
    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(null);
        refreshRegexIntegrationControl(undefined);
        refreshRegexIntegrationControl({});
    });
});

test('2: missing prompt hygiene status element returns safely', () => {
    const { panel } = createFakePanel({ hasPromptHygiene: false });
    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(panel);
    });
});

test('3: missing summary element returns safely', () => {
    const { panel } = createFakePanel({ hasSummary: false });
    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(panel);
    });
});

test('4: missing button element returns safely', () => {
    const { panel } = createFakePanel({ hasButton: false });
    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(panel);
    });
});

test('5: missing feedback element returns safely', () => {
    const { panel } = createFakePanel({ hasFeedback: false });
    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(panel);
    });
});

test('6: refresh calls readRegexIntegrationStatus but never repairRegexIntegration automatically', () => {
    const { panel } = createFakePanel();
    let readCalls = 0;
    let repairCalls = 0;
    const deps = {
        readRegexIntegrationStatus: () => {
            readCalls++;
            return makeCurrentInspection();
        },
        repairRegexIntegration: async () => {
            repairCalls++;
            return { status: 'updated' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(readCalls, 1);
    assert.equal(repairCalls, 0);
});

test('7: CURRENT: prompt hygiene status renders Current with data-regex-status="current"', () => {
    const { panel, promptHygieneStatus } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => makeCurrentInspection(),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(promptHygieneStatus.textContent, 'Current');
    assert.equal(promptHygieneStatus.dataset.regexStatus, 'current');
});

test('8: CURRENT: summary text is correct', () => {
    const { panel, summary } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => makeCurrentInspection(),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(summary.textContent, 'Prompt hygiene is installed and up to date.');
});

test('9: CURRENT: button reads "Regex up to date" and is disabled', () => {
    const { panel, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => makeCurrentInspection(),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(button.textContent, 'Regex up to date');
    assert.equal(button.disabled, true);
});

test('10: NEEDS_REPAIR: missing Prompt Hygiene renders Missing with enabled button', () => {
    const { panel, promptHygieneStatus, summary, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => makeNeedsRepairInspection(REGEX_SCRIPT_STATUS.MISSING),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(promptHygieneStatus.textContent, 'Missing');
    assert.equal(promptHygieneStatus.dataset.regexStatus, 'missing');
    assert.equal(summary.textContent, 'Prompt hygiene is missing or outdated.');
    assert.equal(button.textContent, 'Install / Repair Regex');
    assert.equal(button.disabled, false);
});

test('11: NEEDS_REPAIR: outdated Prompt Hygiene renders Update available with enabled button', () => {
    const { panel, promptHygieneStatus, summary, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => makeNeedsRepairInspection(REGEX_SCRIPT_STATUS.OUTDATED),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(promptHygieneStatus.textContent, 'Update available');
    assert.equal(promptHygieneStatus.dataset.regexStatus, 'outdated');
    assert.equal(summary.textContent, 'Prompt hygiene is missing or outdated.');
    assert.equal(button.textContent, 'Install / Repair Regex');
    assert.equal(button.disabled, false);
});

test('12: CONFLICT: conflict status renders Conflict, disabled button, and warning summary', () => {
    const { panel, promptHygieneStatus, summary, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => ({
            status: REGEX_INTEGRATION_STATUS.CONFLICT,
            regexExtensionDisabled: false,
            scripts: [
                {
                    key: 'prompt-hygiene',
                    scriptName: 'Chromatic Images - Hide image records from prompt',
                    status: REGEX_SCRIPT_STATUS.CONFLICT,
                    matchCount: 2,
                    differingFields: [],
                },
            ],
        }),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(promptHygieneStatus.textContent, 'Conflict');
    assert.equal(promptHygieneStatus.dataset.regexStatus, 'conflict');
    assert.equal(
        summary.textContent,
        'Multiple matching Chromatic Images Regex scripts were found. Resolve duplicates in SillyTavern Regex settings before continuing.',
    );
    assert.equal(button.textContent, 'Resolve duplicates first');
    assert.equal(button.disabled, true);
});

test('13: REGEX_DISABLED: renders disabled state with "Enable Regex first"', () => {
    const { panel, summary, button } = createFakePanel();
    let repairCalled = false;
    const deps = {
        readRegexIntegrationStatus: () => ({
            status: REGEX_INTEGRATION_STATUS.REGEX_DISABLED,
            regexExtensionDisabled: true,
            scripts: [
                {
                    key: 'prompt-hygiene',
                    scriptName: 'Chromatic Images - Hide image records from prompt',
                    status: REGEX_SCRIPT_STATUS.CURRENT,
                    matchCount: 1,
                    differingFields: [],
                },
            ],
        }),
        repairRegexIntegration: async () => {
            repairCalled = true;
            return { status: 'regex-disabled' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(
        summary.textContent,
        "SillyTavern's Regex extension is disabled. Enable it before managing Chromatic Images prompt hygiene.",
    );
    assert.equal(button.textContent, 'Enable Regex first');
    assert.equal(button.disabled, true);
    assert.equal(repairCalled, false);
});

test('14: UNAVAILABLE: renders Unavailable with "Regex unavailable" button disabled', () => {
    const { panel, promptHygieneStatus, summary, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => ({
            status: REGEX_INTEGRATION_STATUS.UNAVAILABLE,
            regexExtensionDisabled: false,
            scripts: [],
        }),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(promptHygieneStatus.textContent, 'Unavailable');
    assert.equal(promptHygieneStatus.dataset.regexStatus, 'unavailable');
    assert.equal(summary.textContent, 'Regex integration is unavailable in this SillyTavern session.');
    assert.equal(button.textContent, 'Regex unavailable');
    assert.equal(button.disabled, true);
});

test('15: exactly one click listener registered and repeated refreshes do not duplicate it', () => {
    const { panel, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => makeCurrentInspection(),
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(button.clickListeners.length, 1);

    refreshRegexIntegrationControl(panel, deps);
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(button.clickListeners.length, 1);
});

test('16: refreshed dependency injection updates active deps used by listener', async () => {
    const { panel, button } = createFakePanel();
    let initialRepairCalled = false;
    let updatedRepairCalled = false;

    const initialDeps = {
        readRegexIntegrationStatus: () => makeNeedsRepairInspection(),
        repairRegexIntegration: async () => {
            initialRepairCalled = true;
            return { status: 'updated' };
        },
    };
    refreshRegexIntegrationControl(panel, initialDeps);

    const updatedDeps = {
        readRegexIntegrationStatus: () => makeNeedsRepairInspection(),
        repairRegexIntegration: async () => {
            updatedRepairCalled = true;
            return { status: 'updated' };
        },
    };
    refreshRegexIntegrationControl(panel, updatedDeps);

    button.click();
    await delay();

    assert.equal(initialRepairCalled, false);
    assert.equal(updatedRepairCalled, true);
});

test('17: button becomes disabled / "Repairing Regex…" while repair is in progress', async () => {
    const { panel, button } = createFakePanel();
    const deferred = createDeferred();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: () => deferred.promise,
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(button.disabled, false);

    button.click();
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Repairing Regex…');

    inspection = makeCurrentInspection();
    deferred.resolve({ status: 'updated' });
    await delay();

    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'Regex up to date');
});

test('18: repeated click while repairing does not invoke repair twice', async () => {
    const { panel, button } = createFakePanel();
    const deferred = createDeferred();
    let repairCalls = 0;
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: () => {
            repairCalls++;
            return deferred.promise;
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    assert.equal(repairCalls, 1);

    button.click();
    button.click();
    assert.equal(repairCalls, 1);

    deferred.resolve({ status: 'updated' });
    await delay();
});

test('19: after repair completes, a fresh status read is performed and rendered', async () => {
    const { panel, button, promptHygieneStatus, summary } = createFakePanel();
    let reads = 0;
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => {
            reads++;
            return inspection;
        },
        repairRegexIntegration: async () => {
            inspection = makeCurrentInspection();
            return { status: 'updated' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    assert.equal(reads, 1);
    assert.equal(promptHygieneStatus.textContent, 'Missing');

    button.click();
    await delay();

    assert.ok(reads >= 2);
    assert.equal(promptHygieneStatus.textContent, 'Current');
    assert.equal(summary.textContent, 'Prompt hygiene is installed and up to date.');
    assert.equal(button.textContent, 'Regex up to date');
    assert.equal(button.disabled, true);
});

test('20: repair result feedback: updated produces valid success feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => {
            inspection = makeCurrentInspection();
            return { status: 'updated' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'valid');
    assert.equal(
        feedback.textContent,
        'Prompt hygiene was installed or repaired successfully.',
    );
    assert.equal(feedback.hidden, false);
});

test('21: repair result feedback: already-current produces valid feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => {
            inspection = makeCurrentInspection();
            return { status: 'already-current' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'valid');
    assert.equal(
        feedback.textContent,
        'Prompt hygiene is already up to date.',
    );
    assert.equal(feedback.hidden, false);
});

test('22: repair result feedback: save-error produces error feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    const inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => ({ status: 'save-error' }),
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'error');
    assert.equal(
        feedback.textContent,
        'Prompt hygiene could not be saved. No changes were kept.',
    );
    assert.equal(feedback.hidden, false);
});

test('23: repair result feedback: conflict produces warning feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => {
            inspection = {
                status: REGEX_INTEGRATION_STATUS.CONFLICT,
                regexExtensionDisabled: false,
                scripts: [],
            };
            return { status: 'conflict' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'warning');
    assert.match(feedback.textContent, /Multiple matching Chromatic Images Regex scripts/);
    assert.equal(feedback.hidden, false);
});

test('24: repair result feedback: regex-disabled produces warning feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => {
            inspection = {
                status: REGEX_INTEGRATION_STATUS.REGEX_DISABLED,
                regexExtensionDisabled: true,
                scripts: [],
            };
            return { status: 'regex-disabled' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'warning');
    assert.match(feedback.textContent, /SillyTavern's Regex extension is disabled/);
    assert.equal(feedback.hidden, false);
});

test('25: repair result feedback: unavailable produces error feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => {
            inspection = {
                status: REGEX_INTEGRATION_STATUS.UNAVAILABLE,
                regexExtensionDisabled: false,
                scripts: [],
            };
            return { status: 'unavailable' };
        },
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'error');
    assert.equal(
        feedback.textContent,
        'Regex integration is unavailable in this SillyTavern session.',
    );
    assert.equal(feedback.hidden, false);
});

test('26: repair result feedback: unknown result produces generic error feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    const inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => ({ status: 'weird-status' }),
    };
    refreshRegexIntegrationControl(panel, deps);
    button.click();
    await delay();

    assert.equal(feedback.dataset.feedbackKind, 'error');
    assert.equal(
        feedback.textContent,
        'The Regex integration operation failed. Check the browser console for details.',
    );
    assert.equal(feedback.hidden, false);
});

test('27: thrown repair error is caught, logged with [Chromatic Images], and shows error feedback', async () => {
    const { panel, button, feedback } = createFakePanel();
    const originalConsoleError = console.error;
    const errorLogs = [];
    console.error = (...args) => errorLogs.push(args);

    try {
        let reads = 0;
        const deps = {
            readRegexIntegrationStatus: () => {
                reads++;
                return makeNeedsRepairInspection();
            },
            repairRegexIntegration: async () => {
                throw new Error('Disk error');
            },
        };
        refreshRegexIntegrationControl(panel, deps);
        button.click();
        await delay();

        assert.equal(errorLogs.length, 1);
        assert.match(String(errorLogs[0][0]), /\[Chromatic Images\]/);
        assert.ok(reads >= 2);
        assert.equal(feedback.dataset.feedbackKind, 'error');
        assert.equal(
            feedback.textContent,
            'The Regex integration operation failed. Check the browser console for details.',
        );
        assert.equal(feedback.hidden, false);
        assert.equal(button.disabled, false);
    } finally {
        console.error = originalConsoleError;
    }
});

test('28: normal refresh clears prior feedback', () => {
    const { panel, feedback } = createFakePanel();
    feedback.textContent = 'Prior status';
    feedback.dataset.feedbackKind = 'valid';
    feedback.hidden = false;

    const deps = {
        readRegexIntegrationStatus: () => makeCurrentInspection(),
    };
    refreshRegexIntegrationControl(panel, deps);

    assert.equal(feedback.textContent, '');
    assert.equal(feedback.dataset.feedbackKind, undefined);
    assert.equal(feedback.hidden, true);
});

test('29: safe rendering uses textContent, never innerHTML', async () => {
    const { panel, button, promptHygieneStatus, summary, feedback } = createFakePanel();
    let inspection = makeNeedsRepairInspection();

    const deps = {
        readRegexIntegrationStatus: () => inspection,
        repairRegexIntegration: async () => {
            inspection = makeCurrentInspection();
            return { status: 'updated' };
        },
    };

    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(panel, deps);
        button.click();
    });
    await delay();

    assert.equal(promptHygieneStatus.textContent, 'Current');
    assert.equal(summary.textContent, 'Prompt hygiene is installed and up to date.');
    assert.equal(
        feedback.textContent,
        'Prompt hygiene was installed or repaired successfully.',
    );
});

test('30: safe read handles throwing readFn without failing panel refresh', () => {
    const { panel, promptHygieneStatus, summary, button } = createFakePanel();
    const deps = {
        readRegexIntegrationStatus: () => {
            throw new Error('Explosion');
        },
    };

    assert.doesNotThrow(() => {
        refreshRegexIntegrationControl(panel, deps);
    });

    assert.equal(promptHygieneStatus.textContent, 'Unavailable');
    assert.equal(summary.textContent, 'Regex integration is unavailable in this SillyTavern session.');
    assert.equal(button.textContent, 'Regex unavailable');
    assert.equal(button.disabled, true);
});

test('31: no direct SillyTavern metadata or context access in regex-panel.js', () => {
    const source = readFileSync(
        new URL('../src/regex-panel.js', import.meta.url),
        'utf8',
    );
    assert.doesNotMatch(source, /\bgetContext\b/);
    assert.doesNotMatch(source, /\bglobalThis\.SillyTavern\b/);
    assert.doesNotMatch(source, /\bextensionSettings\b/);
    assert.doesNotMatch(source, /\bsaveSettingsDebounced\b/);
    assert.doesNotMatch(source, /\buuidv4\b/);
});

test('32: settings.html template contains all required Regex IDs and expected attributes', () => {
    const html = readFileSync(
        new URL('../settings.html', import.meta.url),
        'utf8',
    );

    assert.match(html, /id="chromatic-images-regex-section"/);
    assert.match(html, /id="chromatic-images-regex-prompt-hygiene-status"/);
    assert.match(html, /id="chromatic-images-regex-summary"/);
    assert.match(html, /id="chromatic-images-regex-repair"/);
    assert.match(html, /id="chromatic-images-regex-feedback"/);

    // Verify repair button attributes
    assert.match(html, /<button[^>]+id="chromatic-images-regex-repair"[^>]+type="button"/);
    assert.match(html, /<button[^>]+id="chromatic-images-regex-repair"[^>]+disabled/);

    // Verify feedback attributes
    assert.match(html, /<p[^>]+id="chromatic-images-regex-feedback"[^>]+role="status"/);
    assert.match(html, /<p[^>]+id="chromatic-images-regex-feedback"[^>]+aria-live="polite"/);
    assert.match(html, /<p[^>]+id="chromatic-images-regex-feedback"[^>]+hidden/);
});

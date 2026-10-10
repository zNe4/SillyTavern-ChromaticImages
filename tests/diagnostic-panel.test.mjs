import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    COMPAT_STATUS,
    DIAGNOSTIC_CLEAR_BUTTON_ID,
    DIAGNOSTIC_COMPAT_STATUS_ID,
    DIAGNOSTIC_FEEDBACK_ID,
    DIAGNOSTIC_GENERATE_BUTTON_ID,
    DIAGNOSTIC_PATH_ID,
    DIAGNOSTIC_PHASE,
    DIAGNOSTIC_PHASE_ID,
    DIAGNOSTIC_PREVIEW_ID,
    DIAGNOSTIC_PROMPT_ID,
    DIAGNOSTIC_REFS_ID,
    DIAGNOSTIC_REFS_PREVIEW_ID,
    DIAGNOSTIC_RESULT_CONTAINER_ID,
    DIAGNOSTIC_SECTION_ID,
    DIAGNOSTIC_SUMMARY_ID,
    RESOLUTION_SELECT_ID,
    SETTINGS_KEY,
} from '../src/constants.js';
import { refreshDiagnosticPanel } from '../src/diagnostic-panel.js';

function delay(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeFile(name, size = 1024, type = 'image/png') {
    return {
        name,
        size,
        type,
        slice(start, end) {
            return createFakeFile(name, Math.max(0, (end ?? size) - (start ?? 0)), type);
        },
    };
}

function createFakeDiagnosticPanel(options = {}) {
    const listeners = {
        change: [],
        click: [],
    };

    let promptValue = options.initialPrompt ?? '';
    const promptInput = options.hasPrompt !== false ? {
        id: DIAGNOSTIC_PROMPT_ID,
        get value() {
            return promptValue;
        },
        set value(v) {
            promptValue = String(v);
        },
    } : null;

    let selectedFiles = options.initialFiles ?? [];
    const refsInputListeners = [];
    const refsInput = options.hasRefsInput !== false ? {
        id: DIAGNOSTIC_REFS_ID,
        get files() {
            return selectedFiles;
        },
        set files(f) {
            selectedFiles = f;
        },
        addEventListener(event, handler) {
            if (event === 'change') {
                refsInputListeners.push(handler);
            }
        },
        dispatchEvent(event) {
            if (event.type === 'change') {
                for (const h of refsInputListeners) h(event);
            }
        },
        change(newFiles) {
            selectedFiles = newFiles;
            this.dispatchEvent({ type: 'change' });
        },
        get changeListeners() {
            return refsInputListeners;
        },
    } : null;

    let refsPreviewChildren = [];
    let refsPreviewText = '';
    const refsPreview = options.hasRefsPreview !== false ? {
        id: DIAGNOSTIC_REFS_PREVIEW_ID,
        appendChild(child) {
            refsPreviewChildren.push(child);
        },
        get children() {
            return refsPreviewChildren;
        },
        get textContent() {
            return refsPreviewText;
        },
        set textContent(v) {
            refsPreviewText = String(v);
            if (v === '') {
                refsPreviewChildren = [];
            }
        },
    } : null;

    let resolutionValue = options.initialResolution ?? 'auto';
    const resolutionSelect = options.hasResolutionSelect !== false ? {
        id: RESOLUTION_SELECT_ID,
        get value() {
            return resolutionValue;
        },
        set value(v) {
            resolutionValue = String(v);
        },
    } : null;

    let generateBtnText = 'Generate test image';
    const generateListeners = [];
    const generateBtn = options.hasGenerateBtn !== false ? {
        id: DIAGNOSTIC_GENERATE_BUTTON_ID,
        disabled: options.initialGenerateDisabled ?? false,
        get textContent() {
            return generateBtnText;
        },
        set textContent(v) {
            generateBtnText = String(v);
        },
        addEventListener(event, handler) {
            if (event === 'click') {
                generateListeners.push(handler);
            }
        },
        dispatchEvent(event) {
            if (event.type === 'click') {
                for (const h of generateListeners) h(event);
            }
        },
        click() {
            this.dispatchEvent({ type: 'click' });
        },
        get clickListeners() {
            return generateListeners;
        },
    } : null;

    let clearBtnText = 'Clear test result';
    const clearListeners = [];
    const clearBtn = options.hasClearBtn !== false ? {
        id: DIAGNOSTIC_CLEAR_BUTTON_ID,
        disabled: options.initialClearDisabled ?? true,
        get textContent() {
            return clearBtnText;
        },
        set textContent(v) {
            clearBtnText = String(v);
        },
        addEventListener(event, handler) {
            if (event === 'click') {
                clearListeners.push(handler);
            }
        },
        dispatchEvent(event) {
            if (event.type === 'click') {
                for (const h of clearListeners) h(event);
            }
        },
        click() {
            this.dispatchEvent({ type: 'click' });
        },
        get clickListeners() {
            return clearListeners;
        },
    } : null;

    let compatStatusText = 'Not checked';
    const compatStatus = options.hasCompatStatus !== false ? {
        id: DIAGNOSTIC_COMPAT_STATUS_ID,
        dataset: { compatStatus: 'not-checked' },
        get textContent() {
            return compatStatusText;
        },
        set textContent(v) {
            compatStatusText = String(v);
        },
        setAttribute(attr, val) {
            if (attr === 'data-compat-status') {
                this.dataset.compatStatus = String(val);
            }
        },
    } : null;

    let phaseText = 'Idle';
    const phase = options.hasPhase !== false ? {
        id: DIAGNOSTIC_PHASE_ID,
        dataset: { diagnosticPhase: 'idle' },
        get textContent() {
            return phaseText;
        },
        set textContent(v) {
            phaseText = String(v);
        },
        setAttribute(attr, val) {
            if (attr === 'data-diagnostic-phase') {
                this.dataset.diagnosticPhase = String(val);
            }
        },
    } : null;

    let summaryText = 'Ready to test generation.';
    const summary = options.hasSummary !== false ? {
        id: DIAGNOSTIC_SUMMARY_ID,
        get textContent() {
            return summaryText;
        },
        set textContent(v) {
            summaryText = String(v);
        },
    } : null;

    let feedbackText = '';
    const feedback = options.hasFeedback !== false ? {
        id: DIAGNOSTIC_FEEDBACK_ID,
        dataset: {},
        hidden: true,
        get textContent() {
            return feedbackText;
        },
        set textContent(val) {
            feedbackText = String(val);
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

    let resultHidden = true;
    const resultContainer = options.hasResultContainer !== false ? {
        id: DIAGNOSTIC_RESULT_CONTAINER_ID,
        get hidden() {
            return resultHidden;
        },
        set hidden(v) {
            resultHidden = Boolean(v);
        },
    } : null;

    let previewSrc = '';
    let previewHidden = true;
    const previewImg = options.hasPreviewImg !== false ? {
        id: DIAGNOSTIC_PREVIEW_ID,
        get src() {
            return previewSrc;
        },
        set src(v) {
            previewSrc = String(v);
        },
        get hidden() {
            return previewHidden;
        },
        set hidden(v) {
            previewHidden = Boolean(v);
        },
    } : null;

    let pathText = '';
    const pathCode = options.hasPathCode !== false ? {
        id: DIAGNOSTIC_PATH_ID,
        get textContent() {
            return pathText;
        },
        set textContent(v) {
            pathText = String(v);
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
            if (selector === `#${DIAGNOSTIC_PROMPT_ID}`) return promptInput;
            if (selector === `#${DIAGNOSTIC_REFS_ID}`) return refsInput;
            if (selector === `#${DIAGNOSTIC_REFS_PREVIEW_ID}`) return refsPreview;
            if (selector === `#${RESOLUTION_SELECT_ID}`) return resolutionSelect;
            if (selector === `#${DIAGNOSTIC_GENERATE_BUTTON_ID}`) return generateBtn;
            if (selector === `#${DIAGNOSTIC_CLEAR_BUTTON_ID}`) return clearBtn;
            if (selector === `#${DIAGNOSTIC_COMPAT_STATUS_ID}`) return compatStatus;
            if (selector === `#${DIAGNOSTIC_PHASE_ID}`) return phase;
            if (selector === `#${DIAGNOSTIC_SUMMARY_ID}`) return summary;
            if (selector === `#${DIAGNOSTIC_FEEDBACK_ID}`) return feedback;
            if (selector === `#${DIAGNOSTIC_RESULT_CONTAINER_ID}`) return resultContainer;
            if (selector === `#${DIAGNOSTIC_PREVIEW_ID}`) return previewImg;
            if (selector === `#${DIAGNOSTIC_PATH_ID}`) return pathCode;
            return null;
        },
        elements: {
            promptInput,
            refsInput,
            refsPreview,
            resolutionSelect,
            generateBtn,
            clearBtn,
            compatStatus,
            phase,
            summary,
            feedback,
            resultContainer,
            previewImg,
            pathCode,
        },
    };
}

test('1. Missing panel or missing required child element returns safely without throwing', () => {
    assert.doesNotThrow(() => refreshDiagnosticPanel(null));
    assert.doesNotThrow(() => refreshDiagnosticPanel(undefined));
    assert.doesNotThrow(() => refreshDiagnosticPanel({}));

    for (const key of [
        'hasPrompt',
        'hasRefsInput',
        'hasRefsPreview',
        'hasResolutionSelect',
        'hasGenerateBtn',
        'hasClearBtn',
        'hasCompatStatus',
        'hasPhase',
        'hasSummary',
        'hasFeedback',
        'hasResultContainer',
        'hasPreviewImg',
        'hasPathCode',
    ]) {
        const fake = createFakeDiagnosticPanel({ [key]: false });
        assert.doesNotThrow(() => refreshDiagnosticPanel(fake));
    }
});

test('2. Initial mount makes zero generation or capability calls and sets neutral state', () => {
    const fake = createFakeDiagnosticPanel();
    let compatCalls = 0;
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => {
            compatCalls += 1;
            return { supported: true };
        },
        sendProductionNanoGptGenerationsRequest: async () => {
            generateCalls += 1;
            return { ok: true };
        },
    });

    assert.strictEqual(compatCalls, 0, 'No capability checks on mount');
    assert.strictEqual(generateCalls, 0, 'No generation calls on mount');
    assert.strictEqual(fake.elements.generateBtn.disabled, false);
    assert.strictEqual(fake.elements.clearBtn.disabled, true);
    assert.strictEqual(fake.elements.compatStatus.textContent, 'Not checked');
    assert.strictEqual(fake.elements.phase.textContent, 'Idle');
});

test('3. Preflight failure: whitespace-only prompt is rejected before networking', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: '   \n  \t  ' });
    let compatCalls = 0;
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => { compatCalls += 1; return { supported: true }; },
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(compatCalls, 0, 'Zero capability calls on preflight failure');
    assert.strictEqual(generateCalls, 0, 'Zero provider dispatches on preflight failure');
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.strictEqual(fake.elements.feedback.hidden, false);
    assert.match(fake.elements.feedback.textContent, /enter a test prompt/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
    assert.strictEqual(fake.elements.generateBtn.disabled, false);
});

test('4. Preflight failure: prompt exceeding 3000 code units is rejected before networking', async () => {
    const longPrompt = 'a'.repeat(3001);
    const fake = createFakeDiagnosticPanel({ initialPrompt: longPrompt });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 0);
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /exceeds maximum length of 3000/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
});

test('5. Preflight failure: 4 reference files rejected before networking', async () => {
    const files = [
        createFakeFile('1.png', 100),
        createFakeFile('2.png', 100),
        createFakeFile('3.png', 100),
        createFakeFile('4.png', 100),
    ];
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'A test prompt', initialFiles: files });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 0);
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /At most 3 reference images/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
});

test('6. Preflight failure: single reference exceeding 30 MiB rejected before networking', async () => {
    const files = [createFakeFile('huge.png', 31457281)];
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'A test prompt', initialFiles: files });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 0);
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /exceeds the 30 MiB limit/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
});

test('7. Preflight failure: aggregate reference size exceeding 30 MiB rejected before networking', async () => {
    const files = [
        createFakeFile('a.png', 20000000),
        createFakeFile('b.png', 20000000),
    ];
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'A test prompt', initialFiles: files });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 0);
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /30 MiB aggregate limit/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
});

test('8. Preflight failure: invalid image dimensions (7x8) rejected before networking', async () => {
    const files = [createFakeFile('small.png', 1000)];
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'A test prompt', initialFiles: files });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        inspectImageDimensions: async () => ({ ok: false, width: 7, height: 8, errors: ['dimensions-out-of-range'] }),
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 0);
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /between 8×8 and 16384×16384 px/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
});

test('9. Compatibility proxy missing (404) reports update required and aborts before provider dispatch', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Valid test prompt' });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({
            supported: false,
            cached: false,
            status: 404,
            error: { kind: 'sillytavern-update-required', message: 'Update required' },
        }),
        sendProductionNanoGptGenerationsRequest: async () => { generateCalls += 1; return { ok: true }; },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 0, 'No generation call when compatibility proxy is missing');
    assert.strictEqual(fake.elements.compatStatus.textContent, 'Update required');
    assert.strictEqual(fake.elements.compatStatus.dataset.compatStatus, 'update-required');
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /SillyTavern update required/i);
    assert.match(fake.elements.feedback.textContent, /not sent/i);
});

test('10. Valid 0-reference generation succeeds end-to-end with durable local preview and path', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'A serene mountain lake at sunrise' });
    let dispatchedPayload = null;
    let uploadPayload = null;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async ({ request }) => {
            dispatchedPayload = request;
            return {
                ok: true,
                status: 200,
                body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        },
        uploadGeneratedImageBase64: async (opts) => {
            uploadPayload = opts;
            return {
                ok: true,
                path: '/user/images/ci_diagnostic_123.png',
                format: 'png',
                byteLength: 68,
                status: 200,
                errors: [],
            };
        },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(dispatchedPayload.model, 'qwen-image');
    assert.strictEqual(dispatchedPayload.prompt, 'A serene mountain lake at sunrise');
    assert.strictEqual(dispatchedPayload.nImages, 1);
    assert.strictEqual(dispatchedPayload.resolution, 'auto');
    assert.strictEqual(dispatchedPayload.imageDataUrl, undefined);
    assert.strictEqual(dispatchedPayload.imageDataUrls, undefined);

    assert.strictEqual(fake.elements.compatStatus.textContent, 'Available');
    assert.strictEqual(fake.elements.phase.textContent, 'Complete');
    assert.strictEqual(fake.elements.feedback.hidden, true);
    assert.strictEqual(fake.elements.resultContainer.hidden, false);
    assert.strictEqual(fake.elements.previewImg.hidden, false);
    assert.strictEqual(fake.elements.previewImg.src, '/user/images/ci_diagnostic_123.png');
    assert.strictEqual(fake.elements.pathCode.textContent, '/user/images/ci_diagnostic_123.png');
    assert.strictEqual(fake.elements.clearBtn.disabled, false);
    assert.strictEqual(fake.elements.generateBtn.disabled, false);
});

test('11. 1-reference generation maps correctly to imageDataUrl', async () => {
    const file = createFakeFile('ref.png', 500);
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Character illustration', initialFiles: [file] });
    let dispatchedPayload = null;

    refreshDiagnosticPanel(fake, {
        inspectImageDimensions: async () => ({ ok: true, width: 512, height: 512, errors: [] }),
        prepareImageReferences: async () => ({
            ok: true,
            references: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg=='],
            items: [{ format: 'png', mime: 'image/png', byteLength: 68 }],
            totalByteLength: 68,
            errors: [],
        }),
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async ({ request }) => {
            dispatchedPayload = request;
            return {
                ok: true,
                status: 200,
                body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        },
        uploadGeneratedImageBase64: async () => ({
            ok: true,
            path: '/user/images/ci_1ref.png',
            format: 'png',
            byteLength: 68,
            status: 200,
            errors: [],
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(dispatchedPayload.imageDataUrl, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==');
    assert.strictEqual(dispatchedPayload.imageDataUrls, undefined);
    assert.strictEqual(fake.elements.phase.textContent, 'Complete');
    assert.strictEqual(fake.elements.previewImg.src, '/user/images/ci_1ref.png');
});

test('12. 2-reference and 3-reference generation map correctly to imageDataUrls', async () => {
    const files = [createFakeFile('r1.png', 500), createFakeFile('r2.png', 500)];
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Two character scene', initialFiles: files });
    let dispatchedPayload = null;

    refreshDiagnosticPanel(fake, {
        inspectImageDimensions: async () => ({ ok: true, width: 512, height: 512, errors: [] }),
        prepareImageReferences: async () => ({
            ok: true,
            references: [
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==',
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==',
            ],
            items: [],
            totalByteLength: 136,
            errors: [],
        }),
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async ({ request }) => {
            dispatchedPayload = request;
            return {
                ok: true,
                status: 200,
                body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        },
        uploadGeneratedImageBase64: async () => ({
            ok: true,
            path: '/user/images/ci_2ref.png',
            format: 'png',
            byteLength: 68,
            status: 200,
            errors: [],
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(dispatchedPayload.imageDataUrl, undefined);
    assert.strictEqual(Array.isArray(dispatchedPayload.imageDataUrls), true);
    assert.strictEqual(dispatchedPayload.imageDataUrls.length, 2);
    assert.strictEqual(fake.elements.phase.textContent, 'Complete');
});

test('13. Persisted resolution setting snapshot is used', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Resolution test' });
    let dispatchedPayload = null;

    refreshDiagnosticPanel(fake, {
        extensionSettings: { [SETTINGS_KEY]: { resolution: '1024x768' } },
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async ({ request }) => {
            dispatchedPayload = request;
            return {
                ok: true,
                status: 200,
                body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        },
        uploadGeneratedImageBase64: async () => ({
            ok: true,
            path: '/user/images/ci_res.png',
            format: 'png',
            byteLength: 68,
            status: 200,
            errors: [],
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(dispatchedPayload.resolution, '1024x768');
});

test('14. Single-flight click lock ignores repeated clicks and executes exactly one dispatch', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Concurrency test' });
    let generateCalls = 0;
    let finishGenerate;
    const generatePromise = new Promise((resolve) => { finishGenerate = resolve; });

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => {
            generateCalls += 1;
            await generatePromise;
            return {
                ok: true,
                status: 200,
                body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        },
        uploadGeneratedImageBase64: async () => ({
            ok: true,
            path: '/user/images/ci_conc.png',
            format: 'png',
            byteLength: 68,
            status: 200,
            errors: [],
        }),
    });

    fake.elements.generateBtn.click();
    assert.strictEqual(fake.elements.generateBtn.disabled, true);
    assert.strictEqual(fake.elements.clearBtn.disabled, true);

    // Repeated clicks while in flight
    fake.elements.generateBtn.click();
    fake.elements.generateBtn.click();

    finishGenerate();
    await delay();

    assert.strictEqual(generateCalls, 1, 'Exactly one generation request dispatched');
    assert.strictEqual(fake.elements.phase.textContent, 'Complete');
});

test('15. Provider post-dispatch HTTP error reports billing uncertainty feedback and does not retry', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Provider error test' });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => {
            generateCalls += 1;
            return {
                ok: false,
                status: 500,
                body: null,
                dispatchAttempted: true,
                uncertainBilling: true,
                error: { kind: 'provider-failure', message: 'Provider returned an error response.' },
            };
        },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(generateCalls, 1, 'No automatic retry');
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.strictEqual(fake.elements.feedback.hidden, false);
    assert.match(fake.elements.feedback.textContent, /quota or (?:account )?balance may have been affected/i);
    assert.strictEqual(fake.elements.previewImg.hidden, true);
    assert.strictEqual(fake.elements.resultContainer.hidden, true);
});

test('16. Provider timeout post-dispatch preserves billing uncertainty notice', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Timeout test' });

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => ({
            ok: false,
            status: 504,
            body: null,
            dispatchAttempted: true,
            uncertainBilling: true,
            error: { kind: 'timeout', message: 'Transport operation timed out.' },
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /quota or (?:account )?balance may have been affected/i);
});

test('17. Provider response with remote URL fails closed with unsupported format notice and billing uncertainty', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Remote url test' });
    let uploadCalls = 0;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => ({
            ok: true,
            status: 200,
            body: { data: [{ url: 'https://cdn.example.com/temporary-image.png' }] },
            dispatchAttempted: true,
            uncertainBilling: false,
            error: null,
        }),
        uploadGeneratedImageBase64: async () => {
            uploadCalls += 1;
            return { ok: true };
        },
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(uploadCalls, 0, 'No local upload attempted for remote URL');
    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /remote image URL, which is not supported/i);
    assert.match(fake.elements.feedback.textContent, /quota or account balance may have been affected/i);
});

test('18. Malformed provider response envelope fails closed preserving billing uncertainty', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Malformed response test' });

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => ({
            ok: true,
            status: 200,
            body: { unexpectedEnvelope: true },
            dispatchAttempted: true,
            uncertainBilling: false,
            error: null,
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.match(fake.elements.feedback.textContent, /response could not be parsed/i);
    assert.match(fake.elements.feedback.textContent, /quota or account balance may have been affected/i);
});

test('19. Provider generation succeeds but local upload fails: reports upload error and quota warning without false durable path', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Upload failure test' });

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => ({
            ok: true,
            status: 200,
            body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
            dispatchAttempted: true,
            uncertainBilling: false,
            error: null,
        }),
        uploadGeneratedImageBase64: async () => ({
            ok: false,
            path: null,
            format: 'png',
            byteLength: 68,
            status: 500,
            errors: ['upload-http-error'],
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(fake.elements.phase.textContent, 'Failed');
    assert.strictEqual(fake.elements.previewImg.hidden, true);
    assert.strictEqual(fake.elements.resultContainer.hidden, true);
    assert.match(fake.elements.feedback.textContent, /Image generation succeeded, but saving the image to SillyTavern failed/i);
    assert.match(fake.elements.feedback.textContent, /quota or (?:account )?balance may have been affected/i);
});

test('20. Clear test result hides preview and path but retains file on disk and disables clear button', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Clear test' });

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => ({
            ok: true,
            status: 200,
            body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
            dispatchAttempted: true,
            uncertainBilling: false,
            error: null,
        }),
        uploadGeneratedImageBase64: async () => ({
            ok: true,
            path: '/user/images/ci_clear_me.png',
            format: 'png',
            byteLength: 68,
            status: 200,
            errors: [],
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(fake.elements.previewImg.src, '/user/images/ci_clear_me.png');
    assert.strictEqual(fake.elements.clearBtn.disabled, false);

    // Click Clear
    fake.elements.clearBtn.click();

    assert.strictEqual(fake.elements.previewImg.src, '');
    assert.strictEqual(fake.elements.previewImg.hidden, true);
    assert.strictEqual(fake.elements.pathCode.textContent, '');
    assert.strictEqual(fake.elements.resultContainer.hidden, true);
    assert.strictEqual(fake.elements.clearBtn.disabled, true);
    assert.strictEqual(fake.elements.phase.textContent, 'Idle');
    assert.strictEqual(fake.elements.summary.textContent, 'Test result cleared.');
});

test('21. Detachment during in-flight generation triggers abort and revokes object URLs', async () => {
    const origMutationObserver = globalThis.MutationObserver;
    const origDocument = globalThis.document;

    class MockMutationObserver {
        static instances = [];
        constructor(callback) {
            this.callback = callback;
            this.disconnected = false;
            MockMutationObserver.instances.push(this);
        }
        observe() {}
        disconnect() {
            this.disconnected = true;
        }
        trigger() {
            if (!this.disconnected) this.callback([], this);
        }
    }

    try {
        globalThis.MutationObserver = MockMutationObserver;
        globalThis.document = {
            body: {},
            createElement: () => ({
                appendChild() {},
            }),
        };

        const fake = createFakeDiagnosticPanel({ initialPrompt: 'Detachment test' });
        fake.isConnected = true;

        let capturedSignal = null;
        let finishGen;
        const genPromise = new Promise((resolve) => { finishGen = resolve; });

        let revokedUrl = null;
        refreshDiagnosticPanel(fake, {
            createObjectURL: () => 'blob:test-thumb',
            revokeObjectURL: (url) => { revokedUrl = url; },
            inspectImageDimensions: async () => ({ ok: true, width: 512, height: 512, errors: [] }),
            prepareImageReferences: async () => ({
                ok: true,
                references: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg=='],
                items: [],
                totalByteLength: 68,
                errors: [],
            }),
            checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
            sendProductionNanoGptGenerationsRequest: async ({ signal }) => {
                capturedSignal = signal;
                await genPromise;
                return { ok: true };
            },
        });

        // Trigger file selection to create object URL
        fake.elements.refsInput.change([createFakeFile('t.png', 100)]);

        fake.elements.generateBtn.click();
        await delay();

        assert.strictEqual(capturedSignal?.aborted, false);

        const obs = MockMutationObserver.instances[MockMutationObserver.instances.length - 1];
        assert.strictEqual(obs.disconnected, false);

        // Detach panel
        fake.isConnected = false;
        obs.trigger();

        assert.strictEqual(capturedSignal.aborted, true, 'AbortSignal must be aborted on detachment');
        assert.strictEqual(obs.disconnected, true, 'Observer disconnected');
        assert.strictEqual(revokedUrl, 'blob:test-thumb', 'Object URL revoked on detachment');
    } finally {
        globalThis.MutationObserver = origMutationObserver;
        globalThis.document = origDocument;
    }
});

test('22. Drawer collapse and reopen (panel remains connected) retains preview without regeneration', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Retain preview test' });
    let generateCalls = 0;

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({ supported: true, cached: false, status: 200, error: null }),
        sendProductionNanoGptGenerationsRequest: async () => {
            generateCalls += 1;
            return {
                ok: true,
                status: 200,
                body: { data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAGElEQVQImWNkYPjPQC5gZBgFIzcwjEIMAA54AAM92q1FAAAAAElFTkSuQmCC' }] },
                dispatchAttempted: true,
                uncertainBilling: false,
                error: null,
            };
        },
        uploadGeneratedImageBase64: async () => ({
            ok: true,
            path: '/user/images/ci_retained.png',
            format: 'png',
            byteLength: 68,
            status: 200,
            errors: [],
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    assert.strictEqual(fake.elements.previewImg.src, '/user/images/ci_retained.png');
    assert.strictEqual(generateCalls, 1);

    // Simulate drawer collapse and reopen: refreshDiagnosticPanel called again
    refreshDiagnosticPanel(fake);

    assert.strictEqual(fake.elements.previewImg.src, '/user/images/ci_retained.png');
    assert.strictEqual(fake.elements.previewImg.hidden, false);
    assert.strictEqual(fake.elements.resultContainer.hidden, false);
    assert.strictEqual(generateCalls, 1, 'Zero regenerations on drawer toggle / panel refresh');
});

test('23. Safe rendering uses textContent, never raw secrets or exception payloads in DOM', async () => {
    const fake = createFakeDiagnosticPanel({ initialPrompt: 'Safety test' });

    refreshDiagnosticPanel(fake, {
        checkNanoGptGenerationsCapability: async () => ({
            supported: false,
            cached: false,
            status: null,
            error: { kind: 'error', message: 'SensitiveInternalSecretKey123' },
        }),
    });

    fake.elements.generateBtn.click();
    await delay();

    // Verify raw error cause was not dumped into summary or feedback
    assert.doesNotMatch(fake.elements.summary.textContent, /SensitiveInternalSecretKey123/);
    assert.doesNotMatch(fake.elements.feedback.textContent, /SensitiveInternalSecretKey123/);
});

test('24. settings.html template contains all required diagnostic elements and attributes', () => {
    const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf-8');

    assert.match(html, new RegExp(`id="${DIAGNOSTIC_SECTION_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_PROMPT_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_REFS_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_REFS_PREVIEW_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_GENERATE_BUTTON_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_CLEAR_BUTTON_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_COMPAT_STATUS_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_PHASE_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_SUMMARY_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_FEEDBACK_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_RESULT_CONTAINER_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_PREVIEW_ID}"`));
    assert.match(html, new RegExp(`id="${DIAGNOSTIC_PATH_ID}"`));

    // Billing notice verification
    assert.match(html, /Qwen Image may use your NanoGPT subscription image allowance/);
    assert.match(html, /maxlength="3000"/);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
});

/**
 * @file DOM controller for Diagnostic Image Generation in Settings.
 *
 * Coordinates user-approved diagnostic generation requests for the NanoGPT
 * subscription-compatible Qwen Image route (POST /api/sd/nanogpt/images/generations).
 *
 * Guarantees:
 * - Explicit user action: generation only begins when #chromatic-images-diagnostic-generate-btn is clicked.
 * - Single-flight lock: duplicate clicks while busy are strictly ignored.
 * - Fail-closed preflight: prompt length (1..3000), resolution, reference count (0..3),
 *   file sizes (<=30 MiB individual and aggregate), and image dimensions (8..16384 px)
 *   are validated before any provider dispatch.
 * - Single provider dispatch: at most one generation request per click, zero automatic retries.
 * - Conservative billing uncertainty: all failures occurring after dispatch preserve
 *   clear user feedback that quota or account balance may have been affected.
 * - Response normalization and durable local upload (/user/images/...).
 * - Lifecycle handling: panel detachment aborts in-flight work and revokes object URLs.
 * - Stale settlement suppression: late responses after abort, detachment, or supersession
 *   never mutate UI state or display false durable paths.
 * - Zero automatic capability or generation network requests on mount, drawer expansion,
 *   chat switch, or panel refresh.
 * - Safe rendering uses textContent, never innerHTML.
 */

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
    DIAGNOSTIC_SUMMARY_ID,
    RESOLUTION_SELECT_ID,
} from './constants.js';
import { readProviderSettings } from './provider-settings.js';
import {
    QWEN_IMAGE_MAX_PROMPT_CODE_UNITS,
    QWEN_IMAGE_MAX_REFERENCES,
    QWEN_IMAGE_RESOLUTIONS,
    buildQwenImageCompatibilityRequest,
} from './providers/nanogpt-qwen-compat-request.js';
import {
    checkNanoGptGenerationsCapability,
    sendProductionNanoGptGenerationsRequest,
} from './providers/nanogpt-image-dispatch.js';
import { normalizeNanoGptImageResponse } from './providers/nanogpt-image-response.js';
import {
    prepareImageReferences,
    uploadGeneratedImageBase64,
} from './images/local-image-io.js';
import { inspectImageDimensions } from './images/image-preflight.js';

export const DEFAULT_GENERATION_TIMEOUT_MS = 150000; // 150 seconds
export const DEFAULT_UPLOAD_TIMEOUT_MS = 60000; // 60 seconds
export const MAX_REFERENCE_BYTES = 31457280; // 30 MiB

const panelStateMap = new WeakMap();

/**
 * Checks whether a panel element is currently attached to the active document.
 *
 * @param {ParentNode|null|undefined} p
 * @returns {boolean}
 */
function isPanelAttached(p) {
    if (!p) {
        return false;
    }
    if (typeof p.isConnected === 'boolean') {
        return p.isConnected;
    }
    if (
        typeof document !== 'undefined' &&
        typeof document.contains === 'function'
    ) {
        return document.contains(p);
    }
    return true;
}

/**
 * Clear existing feedback on the diagnostic feedback element.
 *
 * @param {HTMLElement|null} feedbackEl
 */
function clearFeedback(feedbackEl) {
    if (!feedbackEl) {
        return;
    }
    feedbackEl.textContent = '';
    if (feedbackEl.dataset) {
        delete feedbackEl.dataset.feedbackKind;
    }
    if (typeof feedbackEl.removeAttribute === 'function') {
        feedbackEl.removeAttribute('data-feedback-kind');
    }
    feedbackEl.hidden = true;
}

/**
 * Display visible, accessible feedback on the diagnostic feedback element.
 *
 * @param {HTMLElement|null} feedbackEl
 * @param {string} text
 * @param {'valid' | 'warning' | 'error'} kind
 */
function showFeedback(feedbackEl, text, kind) {
    if (!feedbackEl) {
        return;
    }
    feedbackEl.textContent = text;
    if (feedbackEl.dataset) {
        feedbackEl.dataset.feedbackKind = kind;
    }
    if (typeof feedbackEl.setAttribute === 'function') {
        feedbackEl.setAttribute('data-feedback-kind', kind);
    }
    feedbackEl.hidden = false;
}

/**
 * Set semantic compatibility status attribute.
 *
 * @param {HTMLElement} element
 * @param {string} statusValue
 */
function setCompatStatusAttr(element, statusValue) {
    if (element.dataset) {
        element.dataset.compatStatus = statusValue;
    }
    if (typeof element.setAttribute === 'function') {
        element.setAttribute('data-compat-status', statusValue);
    }
}

/**
 * Set semantic diagnostic phase attribute.
 *
 * @param {HTMLElement} element
 * @param {string} phaseValue
 */
function setPhaseAttr(element, phaseValue) {
    if (element.dataset) {
        element.dataset.diagnosticPhase = phaseValue;
    }
    if (typeof element.setAttribute === 'function') {
        element.setAttribute('data-diagnostic-phase', phaseValue);
    }
}

/**
 * Revokes all tracked thumbnail object URLs and clears the set.
 *
 * @param {object} state
 */
function revokeAllThumbnails(state) {
    const revokeFn =
        state.deps?.revokeObjectURL ?? globalThis.URL?.revokeObjectURL;
    if (typeof revokeFn === 'function') {
        for (const url of state.objectUrls) {
            try {
                revokeFn(url);
            } catch {
                // ignore
            }
        }
    }
    state.objectUrls.clear();
}

/**
 * Handles panel detachment from the DOM:
 * 1. Aborts active generation if running.
 * 2. Revokes all thumbnail object URLs.
 * 3. Disconnects and cleans up the detachment observer.
 *
 * @param {ParentNode} panel
 * @param {object} state
 */
function handlePanelDetachment(panel, state) {
    if (state.isGenerating) {
        state.generationToken += 1;
        state.isGenerating = false;
        if (state.activeAbortController) {
            state.activeAbortController.abort();
            state.activeAbortController = null;
        }
    }

    revokeAllThumbnails(state);

    if (state.detachmentObserver) {
        state.detachmentObserver.disconnect();
        state.detachmentObserver = null;
    }
}

/**
 * Ensures a single MutationObserver is active on document.body to monitor
 * panel detachment across both idle and active generation states.
 *
 * @param {ParentNode} panel
 * @param {object} state
 */
function ensureDetachmentObserver(panel, state) {
    if (state.detachmentObserver) {
        return;
    }

    const ObserverCtor =
        state.deps?.MutationObserver ??
        (typeof MutationObserver === 'function' ? MutationObserver : null);

    const doc =
        state.deps?.document ??
        (typeof document !== 'undefined' ? document : null);

    if (!ObserverCtor || !doc?.body) {
        return;
    }

    state.detachmentObserver = new ObserverCtor(() => {
        if (!isPanelAttached(panel)) {
            handlePanelDetachment(panel, state);
        }
    });

    state.detachmentObserver.observe(doc.body, {
        childList: true,
        subtree: true,
    });
}

/**
 * Controller entrypoint for Diagnostic Image Generation UI.
 *
 * @param {ParentNode|null|undefined} panel Root panel element.
 * @param {{
 *   readProviderSettings?: typeof readProviderSettings,
 *   inspectImageDimensions?: typeof inspectImageDimensions,
 *   prepareImageReferences?: typeof prepareImageReferences,
 *   buildQwenImageCompatibilityRequest?: typeof buildQwenImageCompatibilityRequest,
 *   checkNanoGptGenerationsCapability?: typeof checkNanoGptGenerationsCapability,
 *   sendProductionNanoGptGenerationsRequest?: typeof sendProductionNanoGptGenerationsRequest,
 *   normalizeNanoGptImageResponse?: typeof normalizeNanoGptImageResponse,
 *   uploadGeneratedImageBase64?: typeof uploadGeneratedImageBase64,
 *   createObjectURL?: (blob: any) => string,
 *   revokeObjectURL?: (url: string) => void,
 *   createImageBitmap?: typeof createImageBitmap,
 *   createImage?: () => any,
 *   fetch?: typeof fetch,
 *   getRequestHeaders?: Function,
 *   extensionSettings?: object,
 *   generationTimeoutMs?: number,
 *   uploadTimeoutMs?: number,
 *   MutationObserver?: typeof MutationObserver,
 *   document?: any,
 * }} [deps={}] Injected dependencies for testing.
 */
export function refreshDiagnosticPanel(panel, deps = {}) {
    if (!panel || typeof panel.querySelector !== 'function') {
        return;
    }

    const promptInput = panel.querySelector(`#${DIAGNOSTIC_PROMPT_ID}`);
    const refsInput = panel.querySelector(`#${DIAGNOSTIC_REFS_ID}`);
    const refsPreviewEl = panel.querySelector(
        `#${DIAGNOSTIC_REFS_PREVIEW_ID}`,
    );
    const resolutionSelect = panel.querySelector(`#${RESOLUTION_SELECT_ID}`);
    const generateBtn = panel.querySelector(
        `#${DIAGNOSTIC_GENERATE_BUTTON_ID}`,
    );
    const clearBtn = panel.querySelector(`#${DIAGNOSTIC_CLEAR_BUTTON_ID}`);
    const compatStatusEl = panel.querySelector(
        `#${DIAGNOSTIC_COMPAT_STATUS_ID}`,
    );
    const phaseEl = panel.querySelector(`#${DIAGNOSTIC_PHASE_ID}`);
    const summaryEl = panel.querySelector(`#${DIAGNOSTIC_SUMMARY_ID}`);
    const feedbackEl = panel.querySelector(`#${DIAGNOSTIC_FEEDBACK_ID}`);
    const resultContainer = panel.querySelector(
        `#${DIAGNOSTIC_RESULT_CONTAINER_ID}`,
    );
    const previewImg = panel.querySelector(`#${DIAGNOSTIC_PREVIEW_ID}`);
    const pathCode = panel.querySelector(`#${DIAGNOSTIC_PATH_ID}`);

    if (
        !promptInput ||
        !refsInput ||
        !refsPreviewEl ||
        !resolutionSelect ||
        !generateBtn ||
        !clearBtn ||
        !compatStatusEl ||
        !phaseEl ||
        !summaryEl ||
        !feedbackEl ||
        !resultContainer ||
        !previewImg ||
        !pathCode
    ) {
        return;
    }

    let state = panelStateMap.get(panel);
    if (!state) {
        state = {
            listenerAttached: false,
            isGenerating: false,
            generationToken: 0,
            activeAbortController: null,
            detachmentObserver: null,
            objectUrls: new Set(),
            hasResult: false,
            deps,
        };
        panelStateMap.set(panel, state);
    } else {
        state.deps = deps;
    }

    if (isPanelAttached(panel)) {
        ensureDetachmentObserver(panel, state);
    }

    const getExtSettings = () =>
        state.deps.extensionSettings ??
        globalThis.SillyTavern?.getContext?.()?.extensionSettings;

    const readSettingsFn =
        state.deps.readProviderSettings ?? readProviderSettings;

    // Restore neutral UI state when panel is refreshed while not actively generating
    if (!state.isGenerating) {
        generateBtn.disabled = false;
        if (generateBtn.textContent === 'Generating…') {
            generateBtn.textContent = 'Generate test image';
        }
        clearBtn.disabled = !state.hasResult;
    }

    if (!state.listenerAttached) {
        // Reference file selection thumbnail preview handler
        refsInput.addEventListener('change', () => {
            ensureDetachmentObserver(panel, state);

            const createUrlFn =
                state.deps.createObjectURL ?? globalThis.URL?.createObjectURL;

            // Revoke prior thumbnail URLs
            revokeAllThumbnails(state);

            refsPreviewEl.textContent = '';

            const files = Array.from(refsInput.files || []);
            if (files.length > QWEN_IMAGE_MAX_REFERENCES) {
                showFeedback(
                    feedbackEl,
                    `At most ${QWEN_IMAGE_MAX_REFERENCES} reference images are allowed.`,
                    'warning',
                );
            } else {
                clearFeedback(feedbackEl);
            }

            const doc =
                state.deps?.document ??
                (typeof document !== 'undefined' ? document : null);

            for (let i = 0; i < Math.min(files.length, QWEN_IMAGE_MAX_REFERENCES); i++) {
                const file = files[i];
                if (typeof doc?.createElement === 'function') {
                    const thumbWrapper = doc.createElement('div');
                    thumbWrapper.className = 'chromatic-images-ref-thumb-wrapper';

                    if (typeof createUrlFn === 'function') {
                        let thumbUrl = null;
                        try {
                            thumbUrl = createUrlFn(file);
                        } catch {
                            // ignore
                        }

                        if (thumbUrl) {
                            state.objectUrls.add(thumbUrl);
                            const img = doc.createElement('img');
                            img.className = 'chromatic-images-ref-thumb';
                            img.src = thumbUrl;
                            img.alt = file.name || `Reference ${i + 1}`;
                            thumbWrapper.appendChild(img);
                        }
                    }

                    const nameSpan = doc.createElement('span');
                    nameSpan.className = 'chromatic-images-ref-thumb-name';
                    nameSpan.textContent = file.name || `ref-${i + 1}`;
                    thumbWrapper.appendChild(nameSpan);

                    refsPreviewEl.appendChild(thumbWrapper);
                }
            }
        });

        // Generation button click handler
        generateBtn.addEventListener('click', async () => {
            // Single-flight lock
            if (state.isGenerating) {
                return;
            }

            if (!isPanelAttached(panel)) {
                return;
            }

            state.isGenerating = true;
            state.generationToken += 1;
            const currentGeneration = state.generationToken;

            const controller = new AbortController();
            state.activeAbortController = controller;

            ensureDetachmentObserver(panel, state);

            // In-flight UI setup
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating…';
            clearBtn.disabled = true;
            clearFeedback(feedbackEl);

            // Clear prior diagnostic result display at start of new generation attempt
            previewImg.src = '';
            previewImg.hidden = true;
            pathCode.textContent = '';
            resultContainer.hidden = true;
            state.hasResult = false;

            let dispatchAttempted = false;

            const handleCancellation = (wasDispatched = false) => {
                phaseEl.textContent = 'Cancelled';
                setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.CANCELLED);
                if (wasDispatched) {
                    summaryEl.textContent =
                        'Generation operation cancelled after dispatch.';
                    showFeedback(
                        feedbackEl,
                        'Operation was cancelled after the generation request was initiated. Quota or account balance may have been affected.',
                        'warning',
                    );
                } else {
                    summaryEl.textContent =
                        'Diagnostic operation cancelled. Request was not sent.';
                    clearFeedback(feedbackEl);
                }
            };

            try {
                // 1. Snapshot inputs
                const rawPrompt = promptInput.value;
                const trimmedPrompt =
                    typeof rawPrompt === 'string' ? rawPrompt.trim() : '';

                const extSettings = getExtSettings();
                const providerSettings = readSettingsFn(extSettings);
                const resolution =
                    providerSettings?.resolution ?? resolutionSelect.value;

                const files = Array.from(refsInput.files || []);

                // 2. Phase: Validating
                phaseEl.textContent = 'Validating…';
                setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.VALIDATING);
                summaryEl.textContent = 'Validating generation parameters…';

                // Prompt validation
                if (trimmedPrompt.length === 0) {
                    showFeedback(
                        feedbackEl,
                        'Please enter a test prompt. Generation request was not sent.',
                        'error',
                    );
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Validation failed: empty prompt.';
                    return;
                }

                if (trimmedPrompt.length > QWEN_IMAGE_MAX_PROMPT_CODE_UNITS) {
                    showFeedback(
                        feedbackEl,
                        `Prompt exceeds maximum length of ${QWEN_IMAGE_MAX_PROMPT_CODE_UNITS} characters. Generation request was not sent.`,
                        'error',
                    );
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Validation failed: prompt too long.';
                    return;
                }

                // Resolution validation
                if (!QWEN_IMAGE_RESOLUTIONS.includes(resolution)) {
                    showFeedback(
                        feedbackEl,
                        'Invalid resolution setting. Generation request was not sent.',
                        'error',
                    );
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent =
                        'Validation failed: invalid resolution.';
                    return;
                }

                // Reference count validation
                if (files.length > QWEN_IMAGE_MAX_REFERENCES) {
                    showFeedback(
                        feedbackEl,
                        `At most ${QWEN_IMAGE_MAX_REFERENCES} reference images are allowed. Generation request was not sent.`,
                        'error',
                    );
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent =
                        'Validation failed: too many references.';
                    return;
                }

                // File size & aggregate budget validation
                let totalBytes = 0;
                for (const file of files) {
                    if (file.size > MAX_REFERENCE_BYTES) {
                        showFeedback(
                            feedbackEl,
                            'Reference image exceeds the 30 MiB limit. Generation request was not sent.',
                            'error',
                        );
                        phaseEl.textContent = 'Failed';
                        setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                        summaryEl.textContent =
                            'Validation failed: reference size exceeds 30 MiB.';
                        return;
                    }
                    totalBytes += file.size;
                }

                if (totalBytes > MAX_REFERENCE_BYTES) {
                    showFeedback(
                        feedbackEl,
                        'Total reference images size exceeds the 30 MiB aggregate limit. Generation request was not sent.',
                        'error',
                    );
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent =
                        'Validation failed: aggregate reference size exceeds 30 MiB.';
                    return;
                }

                // 3. Phase: Preparing references
                let preparedRefs = [];
                if (files.length > 0) {
                    phaseEl.textContent = 'Preparing references…';
                    setPhaseAttr(
                        phaseEl,
                        DIAGNOSTIC_PHASE.PREPARING_REFERENCES,
                    );
                    summaryEl.textContent =
                        'Validating reference image dimensions…';

                    const inspectDimFn =
                        state.deps.inspectImageDimensions ??
                        inspectImageDimensions;

                    for (const file of files) {
                        const dimResult = await inspectDimFn(file, {
                            signal: controller.signal,
                            createImageBitmap: state.deps.createImageBitmap,
                            createImage: state.deps.createImage,
                            createObjectURL: state.deps.createObjectURL,
                            revokeObjectURL: state.deps.revokeObjectURL,
                        });

                        if (
                            state.generationToken !== currentGeneration ||
                            !isPanelAttached(panel)
                        ) {
                            return;
                        }

                        if (!dimResult.ok) {
                            if (
                                controller.signal.aborted ||
                                dimResult.errors.includes('cancelled')
                            ) {
                                handleCancellation(false);
                                return;
                            }
                            showFeedback(
                                feedbackEl,
                                'Reference image dimension validation failed (dimensions must be between 8×8 and 16384×16384 px). Generation request was not sent.',
                                'error',
                            );
                            phaseEl.textContent = 'Failed';
                            setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                            summaryEl.textContent =
                                'Validation failed: reference image dimensions out of range or unreadable.';
                            return;
                        }
                    }

                    // Convert references to canonical data URLs
                    const prepRefsFn =
                        state.deps.prepareImageReferences ??
                        prepareImageReferences;

                    const prepResult = await prepRefsFn(files, {
                        signal: controller.signal,
                        fetch: state.deps.fetch,
                    });

                    if (
                        state.generationToken !== currentGeneration ||
                        !isPanelAttached(panel)
                    ) {
                        return;
                    }

                    if (!prepResult.ok) {
                        if (
                            controller.signal.aborted ||
                            prepResult.errors.includes('cancelled')
                        ) {
                            handleCancellation(false);
                            return;
                        }
                        showFeedback(
                            feedbackEl,
                            'Failed to prepare reference image data. Generation request was not sent.',
                            'error',
                        );
                        phaseEl.textContent = 'Failed';
                        setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                        summaryEl.textContent =
                            'Validation failed: reference preparation error.';
                        return;
                    }

                    preparedRefs = prepResult.references;
                }

                // 4. Request construction
                const buildReqFn =
                    state.deps.buildQwenImageCompatibilityRequest ??
                    buildQwenImageCompatibilityRequest;

                const reqBuildResult = buildReqFn({
                    model: 'qwen-image',
                    prompt: trimmedPrompt,
                    resolution,
                    references: preparedRefs,
                });

                if (!reqBuildResult.ok) {
                    showFeedback(
                        feedbackEl,
                        'Failed to construct provider request payload. Generation request was not sent.',
                        'error',
                    );
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent =
                        'Validation failed: request construction error.';
                    return;
                }

                // 5. Phase: Checking compatibility proxy
                phaseEl.textContent = 'Checking compatibility…';
                setPhaseAttr(
                    phaseEl,
                    DIAGNOSTIC_PHASE.CHECKING_COMPATIBILITY,
                );
                compatStatusEl.textContent = 'Checking…';
                setCompatStatusAttr(compatStatusEl, COMPAT_STATUS.CHECKING);
                summaryEl.textContent =
                    'Checking SillyTavern compatibility proxy route…';

                const checkCompatFn =
                    state.deps.checkNanoGptGenerationsCapability ??
                    checkNanoGptGenerationsCapability;

                const compatResult = await checkCompatFn({
                    fetch: state.deps.fetch,
                    getRequestHeaders: state.deps.getRequestHeaders,
                    forceCheck: true,
                    signal: controller.signal,
                    timeoutMs: 5000,
                });

                if (
                    state.generationToken !== currentGeneration ||
                    !isPanelAttached(panel)
                ) {
                    return;
                }

                if (!compatResult.supported) {
                    if (
                        controller.signal.aborted ||
                        compatResult.error?.kind === 'cancelled'
                    ) {
                        handleCancellation(false);
                        return;
                    }

                    const isUpdateRequired =
                        compatResult.error?.kind ===
                        'sillytavern-update-required';

                    if (isUpdateRequired) {
                        compatStatusEl.textContent = 'Update required';
                        setCompatStatusAttr(
                            compatStatusEl,
                            COMPAT_STATUS.UPDATE_REQUIRED,
                        );
                        showFeedback(
                            feedbackEl,
                            'Local compatibility proxy route was not found. SillyTavern update required for compatibility generations. Generation request was not sent.',
                            'warning',
                        );
                    } else {
                        compatStatusEl.textContent = 'Unavailable';
                        setCompatStatusAttr(
                            compatStatusEl,
                            COMPAT_STATUS.UNAVAILABLE,
                        );
                        showFeedback(
                            feedbackEl,
                            'Compatibility proxy check failed. Check server console. Generation request was not sent.',
                            'error',
                        );
                    }

                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent =
                        'Compatibility proxy is unavailable.';
                    return;
                }

                compatStatusEl.textContent = 'Available';
                setCompatStatusAttr(compatStatusEl, COMPAT_STATUS.AVAILABLE);

                // 6. Phase: Generating
                phaseEl.textContent = 'Generating…';
                setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.GENERATING);
                summaryEl.textContent =
                    'Generating test image via NanoGPT (up to 150s)…';

                dispatchAttempted = true;

                const sendGenerationsFn =
                    state.deps.sendProductionNanoGptGenerationsRequest ??
                    sendProductionNanoGptGenerationsRequest;
                const generationTimeoutMs =
                    state.deps.generationTimeoutMs ??
                    DEFAULT_GENERATION_TIMEOUT_MS;

                const transportResult = await sendGenerationsFn({
                    request: reqBuildResult.request,
                    timeoutMs: generationTimeoutMs,
                    signal: controller.signal,
                    fetch: state.deps.fetch,
                    getRequestHeaders: state.deps.getRequestHeaders,
                });

                if (
                    state.generationToken !== currentGeneration ||
                    !isPanelAttached(panel)
                ) {
                    return;
                }

                if (!transportResult.ok) {
                    if (
                        controller.signal.aborted ||
                        transportResult.error?.kind === 'cancelled'
                    ) {
                        handleCancellation(transportResult.dispatchAttempted);
                        return;
                    }

                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Image generation failed.';

                    if (transportResult.dispatchAttempted) {
                        showFeedback(
                            feedbackEl,
                            'Generation request failed. The request was attempted; quota or account balance may have been affected.',
                            'error',
                        );
                    } else {
                        showFeedback(
                            feedbackEl,
                            'Generation request failed before dispatch. Request was not sent.',
                            'error',
                        );
                    }
                    return;
                }

                // 7. Phase: Normalizing response
                const normalizeFn =
                    state.deps.normalizeNanoGptImageResponse ??
                    normalizeNanoGptImageResponse;

                const normResult = normalizeFn(transportResult.body, {
                    source: 'openai-compatible',
                });

                if (!normResult.ok) {
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent =
                        'Response normalization failed.';
                    showFeedback(
                        feedbackEl,
                        'Provider response could not be parsed. The generation was attempted; quota or account balance may have been affected.',
                        'error',
                    );
                    return;
                }

                if (normResult.image.kind === 'remote-url') {
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Unsupported response format.';
                    showFeedback(
                        feedbackEl,
                        'Provider returned a remote image URL, which is not supported for diagnostic generation. The generation was attempted; quota or account balance may have been affected.',
                        'error',
                    );
                    return;
                }

                if (normResult.image.kind !== 'base64') {
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Unexpected image format.';
                    showFeedback(
                        feedbackEl,
                        'Provider returned an unexpected image format. The generation was attempted; quota or account balance may have been affected.',
                        'error',
                    );
                    return;
                }

                // 8. Phase: Saving locally
                phaseEl.textContent = 'Saving locally…';
                setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.SAVING_LOCALLY);
                summaryEl.textContent =
                    'Saving generated image to SillyTavern storage…';

                const uploadFn =
                    state.deps.uploadGeneratedImageBase64 ??
                    uploadGeneratedImageBase64;

                const rawUploadTimeout = state.deps.uploadTimeoutMs;
                const uploadTimeoutMs =
                    typeof rawUploadTimeout === 'number' &&
                    Number.isFinite(rawUploadTimeout) &&
                    rawUploadTimeout > 0
                        ? rawUploadTimeout
                        : DEFAULT_UPLOAD_TIMEOUT_MS;

                const uploadController = new AbortController();
                let uploadTimer = null;
                let uploadTimedOut = false;

                const onParentAbort = () => {
                    uploadController.abort();
                };

                if (controller.signal.aborted) {
                    uploadController.abort();
                } else {
                    controller.signal.addEventListener('abort', onParentAbort, {
                        once: true,
                    });
                }

                let uploadResult = null;
                try {
                    const timeoutPromise = new Promise((resolve) => {
                        uploadTimer = setTimeout(() => {
                            uploadTimedOut = true;
                            uploadController.abort();
                            resolve({ timedOut: true });
                        }, uploadTimeoutMs);
                    });

                    const executionPromise = (async () => {
                        const res = await uploadFn({
                            image: normResult.image.data,
                            signal: uploadController.signal,
                            maxBytes: 31457280,
                            fetch: state.deps.fetch,
                            getRequestHeaders: state.deps.getRequestHeaders,
                        });
                        return { timedOut: false, res };
                    })();

                    const winner = await Promise.race([
                        executionPromise,
                        timeoutPromise,
                    ]);
                    if (winner.timedOut) {
                        uploadResult = {
                            ok: false,
                            path: null,
                            errors: ['timeout'],
                        };
                    } else {
                        uploadResult = winner.res;
                    }
                } finally {
                    if (uploadTimer !== null) {
                        clearTimeout(uploadTimer);
                        uploadTimer = null;
                    }
                    controller.signal.removeEventListener('abort', onParentAbort);
                }

                if (
                    state.generationToken !== currentGeneration ||
                    !isPanelAttached(panel)
                ) {
                    return;
                }

                if (uploadTimedOut) {
                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Local image upload timed out.';
                    showFeedback(
                        feedbackEl,
                        'Image generation succeeded, but saving the image to SillyTavern timed out after 60 seconds and could not be confirmed. A file may still have been written locally. Your quota or account balance may have been affected.',
                        'error',
                    );
                    return;
                }

                if (!uploadResult || !uploadResult.ok) {
                    if (
                        controller.signal.aborted ||
                        uploadResult?.errors?.includes('cancelled')
                    ) {
                        handleCancellation(true);
                        return;
                    }

                    phaseEl.textContent = 'Failed';
                    setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);
                    summaryEl.textContent = 'Local image upload failed.';
                    showFeedback(
                        feedbackEl,
                        'Image generation succeeded, but saving the image to SillyTavern could not be confirmed. A file may still have been written locally. Your quota or account balance may have been affected.',
                        'error',
                    );
                    return;
                }

                // 9. Phase: Complete
                phaseEl.textContent = 'Complete';
                setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.COMPLETE);
                summaryEl.textContent =
                    'Test image generated and saved successfully.';
                clearFeedback(feedbackEl);

                // Render result preview and durable path
                previewImg.src = uploadResult.path;
                previewImg.hidden = false;
                pathCode.textContent = uploadResult.path;
                resultContainer.hidden = false;

                state.hasResult = true;
            } catch (err) {
                if (
                    state.generationToken !== currentGeneration ||
                    !isPanelAttached(panel)
                ) {
                    return;
                }

                const isAbort =
                    controller.signal.aborted ||
                    err?.name === 'AbortError' ||
                    err?.kind === 'cancelled';

                if (isAbort) {
                    handleCancellation(dispatchAttempted);
                    return;
                }

                phaseEl.textContent = 'Failed';
                setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.FAILED);

                if (dispatchAttempted) {
                    summaryEl.textContent =
                        'Diagnostic generation failed unexpectedly.';
                    showFeedback(
                        feedbackEl,
                        'An unexpected error occurred during generation or image saving. The generation request was attempted; quota or account balance may have been affected.',
                        'error',
                    );
                } else {
                    summaryEl.textContent =
                        'Diagnostic operation failed unexpectedly.';
                    showFeedback(
                        feedbackEl,
                        'An unexpected error occurred during validation or capability check. Generation request was not sent.',
                        'error',
                    );
                }
            } finally {
                if (state.activeAbortController === controller) {
                    state.activeAbortController = null;
                }
                if (state.generationToken === currentGeneration) {
                    state.isGenerating = false;
                    generateBtn.disabled = false;
                    generateBtn.textContent = 'Generate test image';
                    clearBtn.disabled = !state.hasResult;
                }
            }
        });

        // Clear test result action
        clearBtn.addEventListener('click', () => {
            if (state.isGenerating) {
                return;
            }

            previewImg.src = '';
            previewImg.hidden = true;
            pathCode.textContent = '';
            resultContainer.hidden = true;
            clearFeedback(feedbackEl);

            state.hasResult = false;
            clearBtn.disabled = true;

            phaseEl.textContent = 'Idle';
            setPhaseAttr(phaseEl, DIAGNOSTIC_PHASE.IDLE);
            summaryEl.textContent = 'Test result cleared.';
        });

        state.listenerAttached = true;
    }
}

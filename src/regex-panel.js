import {
    REGEX_INTEGRATION_STATUS,
    REGEX_SCRIPT_STATUS,
    readRegexIntegrationStatus,
    repairRegexIntegration,
} from './regex-integration.js';
import { LOG_PREFIX } from './constants.js';

const panelStateMap = new WeakMap();

/**
 * Clear existing feedback on the Regex section feedback element.
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
 * Display visible, accessible status feedback on the Regex section.
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
 * Set semantic data attribute on a per-script status element.
 *
 * @param {HTMLElement} element
 * @param {string} statusValue
 */
function setRegexStatusAttr(element, statusValue) {
    if (element.dataset) {
        element.dataset.regexStatus = statusValue;
    }
    if (typeof element.setAttribute === 'function') {
        element.setAttribute('data-regex-status', statusValue);
    }
}

/**
 * Render a single Regex script status row.
 *
 * @param {HTMLElement} element
 * @param {{ status?: string } | null | undefined} script
 */
function renderScriptStatus(element, script) {
    const status = script?.status;
    if (status === REGEX_SCRIPT_STATUS.CURRENT) {
        element.textContent = 'Current';
        setRegexStatusAttr(element, 'current');
    } else if (status === REGEX_SCRIPT_STATUS.MISSING) {
        element.textContent = 'Missing';
        setRegexStatusAttr(element, 'missing');
    } else if (status === REGEX_SCRIPT_STATUS.OUTDATED) {
        element.textContent = 'Update available';
        setRegexStatusAttr(element, 'outdated');
    } else if (status === REGEX_SCRIPT_STATUS.CONFLICT) {
        element.textContent = 'Conflict';
        setRegexStatusAttr(element, 'conflict');
    } else {
        element.textContent = 'Unavailable';
        setRegexStatusAttr(element, 'unavailable');
    }
}

/**
 * Safely read integration status, defending against unexpected exceptions in readFn.
 *
 * @param {() => ReturnType<typeof readRegexIntegrationStatus>} readFn
 * @returns {ReturnType<typeof readRegexIntegrationStatus>}
 */
function safeReadStatus(readFn) {
    try {
        return readFn();
    } catch {
        return {
            status: REGEX_INTEGRATION_STATUS.UNAVAILABLE,
            regexExtensionDisabled: false,
            scripts: [],
        };
    }
}

/**
 * Render the overall Regex inspection state to DOM elements.
 *
 * @param {ReturnType<typeof readRegexIntegrationStatus>} inspection
 * @param {HTMLElement} promptHygieneStatusEl
 * @param {HTMLElement} summaryEl
 * @param {HTMLButtonElement} repairBtn
 * @param {boolean} [isRepairing=false]
 */
function renderInspectionState(
    inspection,
    promptHygieneStatusEl,
    summaryEl,
    repairBtn,
    isRepairing = false,
) {
    const promptScript = Array.isArray(inspection?.scripts)
        ? inspection.scripts.find((s) => s?.key === 'prompt-hygiene')
        : null;

    renderScriptStatus(promptHygieneStatusEl, promptScript);

    const overallStatus = inspection?.status;

    if (overallStatus === REGEX_INTEGRATION_STATUS.CURRENT) {
        summaryEl.textContent = 'Prompt hygiene is installed and up to date.';
        repairBtn.textContent = 'Regex up to date';
        repairBtn.disabled = true;
    } else if (overallStatus === REGEX_INTEGRATION_STATUS.NEEDS_REPAIR) {
        summaryEl.textContent = 'Prompt hygiene is missing or outdated.';
        repairBtn.textContent = 'Install / Repair Regex';
        repairBtn.disabled = false;
    } else if (overallStatus === REGEX_INTEGRATION_STATUS.CONFLICT) {
        summaryEl.textContent =
            'Multiple matching Chromatic Images Regex scripts were found. Resolve duplicates in SillyTavern Regex settings before continuing.';
        repairBtn.textContent = 'Resolve duplicates first';
        repairBtn.disabled = true;
    } else if (overallStatus === REGEX_INTEGRATION_STATUS.REGEX_DISABLED) {
        summaryEl.textContent =
            "SillyTavern's Regex extension is disabled. Enable it before managing Chromatic Images prompt hygiene.";
        repairBtn.textContent = 'Enable Regex first';
        repairBtn.disabled = true;
    } else {
        summaryEl.textContent =
            'Regex integration is unavailable in this SillyTavern session.';
        repairBtn.textContent = 'Regex unavailable';
        repairBtn.disabled = true;
    }

    if (isRepairing) {
        repairBtn.textContent = 'Repairing Regex…';
        repairBtn.disabled = true;
    }
}

/**
 * Controller entrypoint for the global Regex integration UI component.
 *
 * @param {ParentNode|null|undefined} panel
 * @param {{
 *     readRegexIntegrationStatus?: typeof readRegexIntegrationStatus,
 *     repairRegexIntegration?: typeof repairRegexIntegration,
 * }} [deps={}]
 */
export function refreshRegexIntegrationControl(panel, deps = {}) {
    if (!panel || typeof panel.querySelector !== 'function') {
        return;
    }

    const promptHygieneStatusEl = panel.querySelector(
        '#chromatic-images-regex-prompt-hygiene-status',
    );
    const summaryEl = panel.querySelector('#chromatic-images-regex-summary');
    const repairBtn = panel.querySelector('#chromatic-images-regex-repair');
    const feedbackEl = panel.querySelector(
        '#chromatic-images-regex-feedback',
    );

    if (
        !promptHygieneStatusEl ||
        !summaryEl ||
        !repairBtn ||
        !feedbackEl
    ) {
        return;
    }

    let state = panelStateMap.get(panel);
    if (!state) {
        state = {
            listenerAttached: false,
            isRepairing: false,
            deps,
        };
        panelStateMap.set(panel, state);
    } else {
        state.deps = deps;
    }

    if (!state.listenerAttached) {
        repairBtn.addEventListener('click', async () => {
            if (state.isRepairing) {
                return;
            }

            state.isRepairing = true;
            repairBtn.disabled = true;
            repairBtn.textContent = 'Repairing Regex…';
            clearFeedback(feedbackEl);

            const activeDeps = state.deps || {};
            const repairFn =
                activeDeps.repairRegexIntegration ?? repairRegexIntegration;
            const readFn =
                activeDeps.readRegexIntegrationStatus ??
                readRegexIntegrationStatus;

            let result;
            try {
                result = await repairFn();
            } catch (error) {
                console.error(
                    `${LOG_PREFIX} Failed to repair Regex integration:`,
                    error,
                );
                state.isRepairing = false;
                const freshInspection = safeReadStatus(readFn);
                renderInspectionState(
                    freshInspection,
                    promptHygieneStatusEl,
                    summaryEl,
                    repairBtn,
                    false,
                );
                showFeedback(
                    feedbackEl,
                    'The Regex integration operation failed. Check the browser console for details.',
                    'error',
                );
                return;
            }

            state.isRepairing = false;
            const freshInspection = safeReadStatus(readFn);
            renderInspectionState(
                freshInspection,
                promptHygieneStatusEl,
                summaryEl,
                repairBtn,
                false,
            );

            const status = result?.status;
            if (status === 'updated') {
                showFeedback(
                    feedbackEl,
                    'Prompt hygiene was installed or repaired successfully.',
                    'valid',
                );
            } else if (status === 'already-current') {
                showFeedback(
                    feedbackEl,
                    'Prompt hygiene is already up to date.',
                    'valid',
                );
            } else if (status === 'save-error') {
                showFeedback(
                    feedbackEl,
                    'Prompt hygiene could not be saved. No changes were kept.',
                    'error',
                );
            } else if (status === 'conflict') {
                showFeedback(
                    feedbackEl,
                    'Multiple matching Chromatic Images Regex scripts were found. Resolve duplicates in SillyTavern Regex settings before continuing.',
                    'warning',
                );
            } else if (status === 'regex-disabled') {
                showFeedback(
                    feedbackEl,
                    "SillyTavern's Regex extension is disabled. Enable it before repairing prompt hygiene.",
                    'warning',
                );
            } else if (status === 'unavailable') {
                showFeedback(
                    feedbackEl,
                    'Regex integration is unavailable in this SillyTavern session.',
                    'error',
                );
            } else {
                showFeedback(
                    feedbackEl,
                    'The Regex integration operation failed. Check the browser console for details.',
                    'error',
                );
            }
        });
        state.listenerAttached = true;
    }

    clearFeedback(feedbackEl);
    const readFn =
        state.deps?.readRegexIntegrationStatus ?? readRegexIntegrationStatus;
    const inspection = safeReadStatus(readFn);
    renderInspectionState(
        inspection,
        promptHygieneStatusEl,
        summaryEl,
        repairBtn,
        state.isRepairing,
    );
}

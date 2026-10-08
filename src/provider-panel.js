/**
 * @file DOM controller for Provider Settings and Connection Diagnostics.
 *
 * Coordinates provider settings synchronization and deliberate readiness diagnostics
 * within the Chromatic Images settings drawer.
 *
 * Guarantees:
 * - Single-flight diagnostics lock: repeated clicks while checking are ignored.
 * - Monotonic generation token and scoped detachment observer prevent stale results
 *   or detached panels from mutating DOM nodes.
 * - Resilient Promise.all orchestration: unexpected probe exceptions fail safely to
 *   'unavailable' without hanging the UI or blocking independent probe results.
 * - Neutral cancellation outcome: restores status indicators to 'Not checked' and
 *   re-enables the button without relabeling cancellation as error or readiness.
 * - WeakMap-backed controller state ensures listeners are bound exactly once per panel node.
 * - Zero automatic network checks on mount, refresh, chat switch, or settings change.
 * - Safe rendering uses textContent, never innerHTML.
 */

import {
    CREDENTIAL_STATUS,
    CREDENTIAL_STATUS_ID,
    DIAGNOSTICS_FEEDBACK_ID,
    DIAGNOSTICS_RUN_BUTTON_ID,
    DIAGNOSTICS_SUMMARY_ID,
    LOG_PREFIX,
    PROXY_STATUS,
    PROXY_STATUS_ID,
    RESOLUTION_SELECT_ID,
} from './constants.js';
import {
    readProviderSettings,
    updateProviderResolution,
} from './provider-settings.js';
import { checkNanoGptCredentialReadiness } from './providers/nanogpt-readiness.js';
import { checkNanoGptImagesCapability } from './providers/nanogpt-image-dispatch.js';

const panelStateMap = new WeakMap();

/**
 * Clear existing feedback on the diagnostics feedback element.
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
 * Display visible, accessible feedback on the diagnostics feedback element.
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
 * Set semantic credential status attribute.
 *
 * @param {HTMLElement} element
 * @param {string} statusValue
 */
function setCredentialStatusAttr(element, statusValue) {
    if (element.dataset) {
        element.dataset.credentialStatus = statusValue;
    }
    if (typeof element.setAttribute === 'function') {
        element.setAttribute('data-credential-status', statusValue);
    }
}

/**
 * Set semantic proxy status attribute.
 *
 * @param {HTMLElement} element
 * @param {string} statusValue
 */
function setProxyStatusAttr(element, statusValue) {
    if (element.dataset) {
        element.dataset.proxyStatus = statusValue;
    }
    if (typeof element.setAttribute === 'function') {
        element.setAttribute('data-proxy-status', statusValue);
    }
}

/**
 * Controller entrypoint for Provider Settings and Connection Diagnostics UI.
 *
 * @param {ParentNode|null|undefined} panel Root panel element.
 * @param {{
 *   readProviderSettings?: typeof readProviderSettings,
 *   updateProviderResolution?: typeof updateProviderResolution,
 *   checkNanoGptCredentialReadiness?: typeof checkNanoGptCredentialReadiness,
 *   checkNanoGptImagesCapability?: typeof checkNanoGptImagesCapability,
 *   saveSettingsDebounced?: Function,
 *   extensionSettings?: object,
 *   fetch?: typeof fetch,
 *   getRequestHeaders?: Function,
 * }} [deps={}] Injected dependencies for testing.
 */
export function refreshProviderPanel(panel, deps = {}) {
    if (!panel || typeof panel.querySelector !== 'function') {
        return;
    }

    const resolutionSelect = panel.querySelector(`#${RESOLUTION_SELECT_ID}`);
    const diagnosticsRunBtn = panel.querySelector(
        `#${DIAGNOSTICS_RUN_BUTTON_ID}`,
    );
    const credentialStatusEl = panel.querySelector(`#${CREDENTIAL_STATUS_ID}`);
    const proxyStatusEl = panel.querySelector(`#${PROXY_STATUS_ID}`);
    const summaryEl = panel.querySelector(`#${DIAGNOSTICS_SUMMARY_ID}`);
    const feedbackEl = panel.querySelector(`#${DIAGNOSTICS_FEEDBACK_ID}`);

    if (
        !resolutionSelect ||
        !diagnosticsRunBtn ||
        !credentialStatusEl ||
        !proxyStatusEl ||
        !summaryEl ||
        !feedbackEl
    ) {
        return;
    }

    let state = panelStateMap.get(panel);
    if (!state) {
        state = {
            listenerAttached: false,
            isChecking: false,
            generationToken: 0,
            activeAbortController: null,
            activeDetachmentObserver: null,
            deps,
        };
        panelStateMap.set(panel, state);
    } else {
        state.deps = deps;
    }

    // Resolve context dependencies
    const getExtSettings = () =>
        state.deps.extensionSettings ??
        globalThis.SillyTavern?.getContext?.()?.extensionSettings;

    const getSaveDebounced = () =>
        state.deps.saveSettingsDebounced ??
        globalThis.SillyTavern?.getContext?.()?.saveSettingsDebounced;

    const readSettingsFn =
        state.deps.readProviderSettings ?? readProviderSettings;
    const updateResolutionFn =
        state.deps.updateProviderResolution ?? updateProviderResolution;

    // Synchronize resolution select value with persisted settings
    const currentSettings = readSettingsFn(getExtSettings());
    resolutionSelect.value = currentSettings.resolution;

    // Attach listeners once
    if (!state.listenerAttached) {
        resolutionSelect.addEventListener('change', () => {
            const extSettings = getExtSettings();
            const result = updateResolutionFn(
                extSettings,
                resolutionSelect.value,
            );
            if (result.ok && result.changed) {
                const saveFn = getSaveDebounced();
                if (typeof saveFn === 'function') {
                    saveFn();
                }
            } else if (!result.ok) {
                // Revert invalid selection to current valid value
                const validSettings = readSettingsFn(extSettings);
                resolutionSelect.value = validSettings.resolution;
            }
        });

        diagnosticsRunBtn.addEventListener('click', async () => {
            // Single-flight suppression
            if (state.isChecking) {
                return;
            }

            // Guard against clicking while detached
            if (panel.isConnected === false) {
                return;
            }

            state.isChecking = true;
            state.generationToken += 1;
            const currentGeneration = state.generationToken;

            state.activeAbortController = new AbortController();

            // Set up scoped MutationObserver to detect panel detachment during active check
            let detachmentObserver = null;
            if (
                typeof MutationObserver === 'function' &&
                typeof document !== 'undefined' &&
                document.body
            ) {
                detachmentObserver = new MutationObserver(() => {
                    if (panel.isConnected === false) {
                        state.activeAbortController?.abort();
                        if (detachmentObserver) {
                            detachmentObserver.disconnect();
                            detachmentObserver = null;
                        }
                    }
                });
                detachmentObserver.observe(document.body, {
                    childList: true,
                    subtree: true,
                });
                state.activeDetachmentObserver = detachmentObserver;
            }

            // Set in-flight UI state
            diagnosticsRunBtn.disabled = true;
            diagnosticsRunBtn.textContent = 'Checking setup…';
            credentialStatusEl.textContent = 'Checking…';
            setCredentialStatusAttr(
                credentialStatusEl,
                CREDENTIAL_STATUS.CHECKING,
            );
            proxyStatusEl.textContent = 'Checking…';
            setProxyStatusAttr(proxyStatusEl, PROXY_STATUS.CHECKING);
            summaryEl.textContent = 'Checking local setup…';
            clearFeedback(feedbackEl);

            const activeDeps = state.deps || {};
            const credCheckFn =
                activeDeps.checkNanoGptCredentialReadiness ??
                checkNanoGptCredentialReadiness;
            const proxyCheckFn =
                activeDeps.checkNanoGptImagesCapability ??
                checkNanoGptImagesCapability;

            const credProbe = (async () => {
                try {
                    return await credCheckFn({
                        fetch: activeDeps.fetch,
                        getRequestHeaders: activeDeps.getRequestHeaders,
                        signal: state.activeAbortController.signal,
                        timeoutMs: 5000,
                    });
                } catch (error) {
                    console.error(
                        `${LOG_PREFIX} Credential readiness probe threw unexpectedly:`,
                        error,
                    );
                    return {
                        status: CREDENTIAL_STATUS.UNAVAILABLE,
                        error: {
                            kind: 'unexpected-error',
                            message: 'Credential readiness check failed unexpectedly.',
                        },
                    };
                }
            })();

            const proxyProbe = (async () => {
                try {
                    return await proxyCheckFn({
                        fetch: activeDeps.fetch,
                        getRequestHeaders: activeDeps.getRequestHeaders,
                        forceCheck: true,
                        signal: state.activeAbortController.signal,
                        timeoutMs: 5000,
                    });
                } catch (error) {
                    console.error(
                        `${LOG_PREFIX} Proxy capability probe threw unexpectedly:`,
                        error,
                    );
                    return {
                        supported: false,
                        cached: false,
                        status: null,
                        error: {
                            kind: 'unexpected-error',
                            message: 'Proxy capability check failed unexpectedly.',
                        },
                    };
                }
            })();

            let credResult;
            let proxyResult;
            try {
                [credResult, proxyResult] = await Promise.all([
                    credProbe,
                    proxyProbe,
                ]);
            } finally {
                if (detachmentObserver) {
                    detachmentObserver.disconnect();
                    detachmentObserver = null;
                    state.activeDetachmentObserver = null;
                }
            }

            // Lifecycle invalidation check: discard results if superseded or panel detached
            if (
                state.generationToken !== currentGeneration ||
                panel.isConnected === false
            ) {
                return;
            }

            state.isChecking = false;
            diagnosticsRunBtn.disabled = false;
            diagnosticsRunBtn.textContent = 'Check local setup';

            // Neutral cancellation outcome: reset to 'Not checked'
            if (
                credResult?.status === CREDENTIAL_STATUS.CANCELLED ||
                proxyResult?.error?.kind === 'cancelled' ||
                state.activeAbortController?.signal?.aborted
            ) {
                credentialStatusEl.textContent = 'Not checked';
                setCredentialStatusAttr(
                    credentialStatusEl,
                    CREDENTIAL_STATUS.NOT_CHECKED,
                );
                proxyStatusEl.textContent = 'Not checked';
                setProxyStatusAttr(proxyStatusEl, PROXY_STATUS.NOT_CHECKED);
                summaryEl.textContent = 'Readiness check cancelled.';
                clearFeedback(feedbackEl);
                return;
            }

            // Render credential readiness status
            const credStatus = credResult?.status;
            if (credStatus === CREDENTIAL_STATUS.CONFIGURED) {
                credentialStatusEl.textContent = 'Configured';
                setCredentialStatusAttr(
                    credentialStatusEl,
                    CREDENTIAL_STATUS.CONFIGURED,
                );
            } else if (credStatus === CREDENTIAL_STATUS.NOT_CONFIGURED) {
                credentialStatusEl.textContent = 'Not configured';
                setCredentialStatusAttr(
                    credentialStatusEl,
                    CREDENTIAL_STATUS.NOT_CONFIGURED,
                );
            } else {
                credentialStatusEl.textContent = 'Unavailable';
                setCredentialStatusAttr(
                    credentialStatusEl,
                    CREDENTIAL_STATUS.UNAVAILABLE,
                );
            }

            // Render proxy capability status
            const isProxyAvailable = proxyResult?.supported === true;
            const isUpdateRequired =
                proxyResult?.error?.kind === 'sillytavern-update-required';

            if (isProxyAvailable) {
                proxyStatusEl.textContent = 'Available';
                setProxyStatusAttr(proxyStatusEl, PROXY_STATUS.AVAILABLE);
            } else if (isUpdateRequired) {
                proxyStatusEl.textContent = 'Update required';
                setProxyStatusAttr(proxyStatusEl, PROXY_STATUS.UPDATE_REQUIRED);
            } else {
                proxyStatusEl.textContent = 'Unavailable';
                setProxyStatusAttr(proxyStatusEl, PROXY_STATUS.UNAVAILABLE);
            }

            // User-visible summary and actionable feedback wording
            if (
                credStatus === CREDENTIAL_STATUS.CONFIGURED &&
                isProxyAvailable
            ) {
                summaryEl.textContent =
                    'Local readiness checks passed: a NanoGPT credential is configured and the image proxy is available. This does not verify the API key or provider balance.';
                clearFeedback(feedbackEl);
            } else if (
                credStatus === CREDENTIAL_STATUS.NOT_CONFIGURED &&
                isProxyAvailable
            ) {
                summaryEl.textContent =
                    'NanoGPT credential is not configured.';
                showFeedback(
                    feedbackEl,
                    'NanoGPT API key is not configured. Open SillyTavern API Connections (Secrets) to add your NanoGPT key.',
                    'warning',
                );
            } else if (
                credStatus === CREDENTIAL_STATUS.CONFIGURED &&
                isUpdateRequired
            ) {
                summaryEl.textContent =
                    'Local image proxy update required.';
                showFeedback(
                    feedbackEl,
                    'Local proxy route was not found. SillyTavern update required with normalized NanoGPT image support.',
                    'warning',
                );
            } else if (
                credStatus === CREDENTIAL_STATUS.NOT_CONFIGURED &&
                isUpdateRequired
            ) {
                summaryEl.textContent =
                    'Local setup requires attention.';
                showFeedback(
                    feedbackEl,
                    'Configure your NanoGPT key in SillyTavern Secrets and install the patched image proxy.',
                    'error',
                );
            } else {
                summaryEl.textContent =
                    'Local readiness check failed.';
                showFeedback(
                    feedbackEl,
                    'Failed to complete diagnostics due to a local communication error. Check server console.',
                    'error',
                );
            }
        });

        state.listenerAttached = true;
    }
}

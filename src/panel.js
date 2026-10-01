import {
    EXTENSION_FOLDER,
    EXTENSIONS_SETTINGS_CONTAINER_ID,
    PANEL_ID,
    PANEL_DRAWER_TOGGLE_ID,
} from './constants.js';

const registeredAccessibleDrawers = new WeakSet();

/**
 * Synchronize aria-expanded attribute on drawer button clicks.
 *
 * @param {HTMLElement} panel
 */
function registerDrawerAccessibility(panel) {
    if (registeredAccessibleDrawers.has(panel)) {
        return;
    }

    const drawerToggle = panel.querySelector(
        `#${PANEL_DRAWER_TOGGLE_ID}`,
    );
    if (!drawerToggle) {
        return;
    }

    drawerToggle.addEventListener('click', () => {
        const isExpanded =
            drawerToggle.getAttribute('aria-expanded') === 'true';
        drawerToggle.setAttribute(
            'aria-expanded',
            String(!isExpanded),
        );
    });

    registeredAccessibleDrawers.add(panel);
}

/**
 * Ensure the settings panel is rendered and mounted in the extensions container.
 *
 * @returns {Promise<HTMLElement>}
 */
export async function ensurePanel() {
    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel) {
        return existingPanel;
    }

    const container = document.getElementById(
        EXTENSIONS_SETTINGS_CONTAINER_ID,
    );
    if (!container) {
        throw new Error(
            `Missing SillyTavern settings container #${EXTENSIONS_SETTINGS_CONTAINER_ID}.`,
        );
    }

    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    const panelHtml = await renderExtensionTemplateAsync(
        EXTENSION_FOLDER,
        'settings',
    );

    container.insertAdjacentHTML('beforeend', panelHtml);

    const mountedPanel = document.getElementById(PANEL_ID);
    if (!mountedPanel) {
        throw new Error(`Template did not create #${PANEL_ID}.`);
    }

    return mountedPanel;
}

/**
 * Refresh panel accessibility and transient state.
 */
export function refreshPanelState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    registerDrawerAccessibility(panel);
}

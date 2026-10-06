import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    MANAGED_FIELDS,
    MANAGED_REGEX_SCRIPTS,
} from '../src/regex-definitions.js';
import {
    REGEX_INTEGRATION_STATUS,
    REGEX_SCRIPT_STATUS,
    inspectRegexIntegrationState,
    readRegexIntegrationStatus,
    repairRegexIntegration,
} from '../src/regex-integration.js';

afterEach(() => {
    delete globalThis.SillyTavern;
});

/**
 * Helper to build a valid installed script matching a canonical definition.
 */
function createMockInstalledScript(canonical, id, overrides = {}) {
    const script = { id };
    for (const field of MANAGED_FIELDS) {
        if (Array.isArray(canonical[field])) {
            script[field] = [...canonical[field]];
        } else {
            script[field] = canonical[field];
        }
    }
    return { ...script, ...overrides };
}

test('1. module import has no side effects', () => {
    assert.equal(typeof inspectRegexIntegrationState, 'function');
    assert.equal(typeof readRegexIntegrationStatus, 'function');
    assert.equal(typeof repairRegexIntegration, 'function');
    assert.equal(globalThis.SillyTavern, undefined);
});

test('2. invalid extensionSettings -> unavailable', () => {
    for (const invalid of [null, undefined, 123, 'settings', true, []]) {
        const result = inspectRegexIntegrationState(invalid);
        assert.deepEqual(result, {
            status: REGEX_INTEGRATION_STATUS.UNAVAILABLE,
            regexExtensionDisabled: false,
            scripts: [],
        });
    }
});

test('3. absent regex property -> script missing / needs-repair', () => {
    const result = inspectRegexIntegrationState({});
    assert.equal(result.status, REGEX_INTEGRATION_STATUS.NEEDS_REPAIR);
    assert.equal(result.regexExtensionDisabled, false);
    assert.equal(result.scripts.length, 1);

    const script = result.scripts[0];
    assert.equal(script.key, 'prompt-hygiene');
    assert.equal(script.scriptName, 'Chromatic Images - Hide image records from prompt');
    assert.equal(script.status, REGEX_SCRIPT_STATUS.MISSING);
    assert.equal(script.matchCount, 0);
    assert.deepEqual(script.differingFields, []);
});

test('4. null regex -> treated as empty', () => {
    const result = inspectRegexIntegrationState({ regex: null });
    assert.equal(result.status, REGEX_INTEGRATION_STATUS.NEEDS_REPAIR);
    assert.equal(result.scripts.length, 1);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.MISSING);
});

test('5. malformed non-array regex -> unavailable', () => {
    for (const malformed of ['not an array', 123, true, {}]) {
        const result = inspectRegexIntegrationState({ regex: malformed });
        assert.equal(result.status, REGEX_INTEGRATION_STATUS.UNAVAILABLE);
        assert.deepEqual(result.scripts, []);
    }
});

test('6. exact current script with arbitrary runtime UUID -> current', () => {
    const installed = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'runtime-uuid-ci-1',
    );

    const result = inspectRegexIntegrationState({
        regex: [installed],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.CURRENT);
    assert.equal(result.regexExtensionDisabled, false);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.CURRENT);
    assert.equal(result.scripts[0].matchCount, 1);
    assert.deepEqual(result.scripts[0].differingFields, []);
});

test('7. one managed scalar field differs -> outdated with differingFields', () => {
    const installed = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'uuid-1',
        { promptOnly: false },
    );

    const result = inspectRegexIntegrationState({
        regex: [installed],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.NEEDS_REPAIR);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.OUTDATED);
    assert.deepEqual(result.scripts[0].differingFields, ['promptOnly']);
});

test('8. one managed array field differs -> outdated with differingFields', () => {
    const installed = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'uuid-1',
        { placement: [1, 2] },
    );

    const result = inspectRegexIntegrationState({
        regex: [installed],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.NEEDS_REPAIR);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.OUTDATED);
    assert.deepEqual(result.scripts[0].differingFields, ['placement']);
});

test('9. multiple managed fields differ -> deterministic differingFields', () => {
    const installed = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'uuid-1',
        {
            disabled: true,
            replaceString: '[REMOVED]',
            runOnEdit: true,
        },
    );

    const result = inspectRegexIntegrationState({
        regex: [installed],
    });

    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.OUTDATED);
    assert.deepEqual(result.scripts[0].differingFields, [
        'replaceString',
        'disabled',
        'runOnEdit',
    ]);
});

test('10. missing/invalid installed id -> outdated with id', () => {
    for (const invalidId of ['', '   ', null, undefined, 123]) {
        const installed = createMockInstalledScript(
            MANAGED_REGEX_SCRIPTS[0],
            invalidId,
        );

        const result = inspectRegexIntegrationState({
            regex: [installed],
        });

        assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.OUTDATED);
        assert.ok(
            result.scripts[0].differingFields.includes('id'),
            `Field "id" must be flagged as differing for ID: ${invalidId}`,
        );
    }
});

test('11. unrelated extra fields do not make a script outdated', () => {
    const installed = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'uuid-1',
        {
            userNote: 'custom comment',
            customOrder: 42,
        },
    );

    const result = inspectRegexIntegrationState({
        regex: [installed],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.CURRENT);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.CURRENT);
    assert.deepEqual(result.scripts[0].differingFields, []);
});

test('12. unrelated global scripts are ignored by inspection and preserved', () => {
    const unrelatedScript = {
        id: 'unrelated-1',
        scriptName: 'Some third-party regex',
        findRegex: '/foo/g',
        replaceString: 'bar',
    };
    const installed = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'uuid-1',
    );

    const result = inspectRegexIntegrationState({
        regex: [unrelatedScript, installed],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.CURRENT);
    assert.equal(result.scripts.length, 1);
});

test('13. exact scriptName matching is case-sensitive', () => {
    const lowercaseScript = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'uuid-1',
        { scriptName: 'chromatic images - hide image records from prompt' },
    );

    const result = inspectRegexIntegrationState({
        regex: [lowercaseScript],
    });

    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.MISSING);
});

test('14. duplicate exact scriptName -> conflict', () => {
    const script1 = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1');
    const script2 = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-2');

    const result = inspectRegexIntegrationState({
        regex: [script1, script2],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.CONFLICT);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.CONFLICT);
    assert.equal(result.scripts[0].matchCount, 2);
    assert.deepEqual(result.scripts[0].differingFields, []);
});

test('15. Regex extension disabled -> regex-disabled precedence', () => {
    const installed = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1');

    const result = inspectRegexIntegrationState({
        disabledExtensions: ['regex', 'other-ext'],
        regex: [installed],
    });

    assert.equal(result.status, REGEX_INTEGRATION_STATUS.REGEX_DISABLED);
    assert.equal(result.regexExtensionDisabled, true);
    assert.equal(result.scripts[0].status, REGEX_SCRIPT_STATUS.CURRENT);
});

test('16. precedence: unavailable > regex-disabled > conflict > needs-repair > current', () => {
    // 1. malformed settings -> unavailable
    assert.equal(
        inspectRegexIntegrationState(null).status,
        REGEX_INTEGRATION_STATUS.UNAVAILABLE,
    );

    // 2. malformed regex array -> unavailable (even if regex is disabled)
    assert.equal(
        inspectRegexIntegrationState({
            disabledExtensions: ['regex'],
            regex: 'invalid-regex',
        }).status,
        REGEX_INTEGRATION_STATUS.UNAVAILABLE,
    );

    // 3. regex-disabled beats conflict
    const script1 = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1');
    const script2 = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-2');
    assert.equal(
        inspectRegexIntegrationState({
            disabledExtensions: ['regex'],
            regex: [script1, script2],
        }).status,
        REGEX_INTEGRATION_STATUS.REGEX_DISABLED,
    );

    // 4. conflict beats needs-repair
    assert.equal(
        inspectRegexIntegrationState({
            regex: [script1, script2],
        }).status,
        REGEX_INTEGRATION_STATUS.CONFLICT,
    );

    // 5. missing -> needs-repair
    assert.equal(
        inspectRegexIntegrationState({
            regex: [],
        }).status,
        REGEX_INTEGRATION_STATUS.NEEDS_REPAIR,
    );

    // 6. valid -> current
    assert.equal(
        inspectRegexIntegrationState({
            regex: [script1],
        }).status,
        REGEX_INTEGRATION_STATUS.CURRENT,
    );
});

test('17. readRegexIntegrationStatus safe reading and error handling', () => {
    // SillyTavern undefined
    assert.equal(readRegexIntegrationStatus().status, REGEX_INTEGRATION_STATUS.UNAVAILABLE);

    // getContext undefined
    globalThis.SillyTavern = {};
    assert.equal(readRegexIntegrationStatus().status, REGEX_INTEGRATION_STATUS.UNAVAILABLE);

    // getContext throws
    globalThis.SillyTavern = {
        getContext() {
            throw new Error('Explosion');
        },
    };
    assert.equal(readRegexIntegrationStatus().status, REGEX_INTEGRATION_STATUS.UNAVAILABLE);

    // getContext returns null
    globalThis.SillyTavern = {
        getContext() {
            return null;
        },
    };
    assert.equal(readRegexIntegrationStatus().status, REGEX_INTEGRATION_STATUS.UNAVAILABLE);

    // getContext returns valid context
    const installed = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1');
    globalThis.SillyTavern = {
        getContext() {
            return { extensionSettings: { regex: [installed] } };
        },
    };
    const res = readRegexIntegrationStatus();
    assert.equal(res.status, REGEX_INTEGRATION_STATUS.CURRENT);
});

test('18. repair: missing script installs after existing scripts and calls saveSettingsDebounced once', async () => {
    const unrelated = { id: 'unrelated-1', scriptName: 'Other Script' };
    const extensionSettings = { regex: [unrelated] };
    let uuidCalls = 0;
    let saveCalls = 0;

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {
                    uuidCalls += 1;
                    return `generated-uuid-${uuidCalls}`;
                },
                saveSettingsDebounced() {
                    saveCalls += 1;
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'updated');
    assert.equal(result.inspection.status, REGEX_INTEGRATION_STATUS.CURRENT);
    assert.equal(saveCalls, 1);
    assert.equal(uuidCalls, 1);

    assert.equal(extensionSettings.regex.length, 2);
    assert.strictEqual(extensionSettings.regex[0], unrelated);

    const installed = extensionSettings.regex[1];
    assert.equal(installed.scriptName, MANAGED_REGEX_SCRIPTS[0].scriptName);
    assert.equal(installed.id, 'generated-uuid-1');
    assert.equal(installed.key, undefined);
    assert.equal(installed.promptOnly, true);
    assert.equal(installed.disabled, false);
});

test('19. repair: outdated script repairs managed fields while preserving valid ID, unmanaged fields, position', async () => {
    const unrelated1 = { id: 'u1', scriptName: 'Unrelated 1' };
    const unrelated2 = { id: 'u2', scriptName: 'Unrelated 2' };
    const outdated = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        'preserve-this-id',
        {
            disabled: true,
            markdownOnly: true,
            userCustomField: 'keep-this-custom-value',
        },
    );
    const extensionSettings = {
        regex: [unrelated1, outdated, unrelated2],
    };
    let uuidCalls = 0;
    let saveCalls = 0;

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {
                    uuidCalls += 1;
                    return 'unexpected-uuid';
                },
                saveSettingsDebounced() {
                    saveCalls += 1;
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'updated');
    assert.equal(uuidCalls, 0);
    assert.equal(saveCalls, 1);
    assert.equal(extensionSettings.regex.length, 3);
    assert.strictEqual(extensionSettings.regex[0], unrelated1);
    assert.strictEqual(extensionSettings.regex[2], unrelated2);

    const repaired = extensionSettings.regex[1];
    assert.equal(repaired.id, 'preserve-this-id');
    assert.equal(repaired.disabled, false);
    assert.equal(repaired.markdownOnly, false);
    assert.equal(repaired.promptOnly, true);
    assert.equal(repaired.userCustomField, 'keep-this-custom-value');
    assert.equal(repaired.key, undefined);
});

test('20. repair: missing ID in outdated script generates new UUID via uuidv4', async () => {
    const scriptWithoutId = createMockInstalledScript(
        MANAGED_REGEX_SCRIPTS[0],
        '',
        { disabled: true },
    );
    const extensionSettings = { regex: [scriptWithoutId] };

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {
                    return 'new-uuid-assigned';
                },
                saveSettingsDebounced() {},
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'updated');
    assert.equal(extensionSettings.regex[0].id, 'new-uuid-assigned');
    assert.equal(extensionSettings.regex[0].disabled, false);
});

test('21. repair: already current returns already-current without save or UUID call', async () => {
    const installed = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1');
    const extensionSettings = { regex: [installed] };
    let saveCalls = 0;
    let uuidCalls = 0;

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {
                    uuidCalls += 1;
                },
                saveSettingsDebounced() {
                    saveCalls += 1;
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'already-current');
    assert.equal(saveCalls, 0);
    assert.equal(uuidCalls, 0);
});

test('22. repair: conflict refuses mutation', async () => {
    const s1 = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1');
    const s2 = createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-2');
    const extensionSettings = { regex: [s1, s2] };
    let saveCalls = 0;

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {},
                saveSettingsDebounced() {
                    saveCalls += 1;
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'conflict');
    assert.equal(saveCalls, 0);
    assert.equal(extensionSettings.regex.length, 2);
});

test('23. repair: regex-disabled refuses mutation', async () => {
    const extensionSettings = {
        disabledExtensions: ['regex'],
        regex: [],
    };
    let saveCalls = 0;

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {},
                saveSettingsDebounced() {
                    saveCalls += 1;
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'regex-disabled');
    assert.equal(saveCalls, 0);
    assert.deepEqual(extensionSettings.regex, []);
});

test('24. repair: unavailable context or missing capabilities refuses mutation safely', async () => {
    // 1. SillyTavern undefined
    assert.equal((await repairRegexIntegration()).status, 'unavailable');

    // 2. getContext undefined
    globalThis.SillyTavern = {};
    assert.equal((await repairRegexIntegration()).status, 'unavailable');

    // 3. getContext throws
    globalThis.SillyTavern = {
        getContext() {
            throw new Error('Boom');
        },
    };
    assert.equal((await repairRegexIntegration()).status, 'unavailable');

    // 4. uuidv4 missing
    const extensionSettings = { regex: [] };
    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                saveSettingsDebounced() {},
            };
        },
    };
    assert.equal((await repairRegexIntegration()).status, 'unavailable');

    // 5. saveSettingsDebounced missing
    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() { return 'u'; },
            };
        },
    };
    assert.equal((await repairRegexIntegration()).status, 'unavailable');
});

test('25. repair: saveSettingsDebounced failure rolls back regex list and returns save-error', async () => {
    const originalRegex = [
        createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1', {
            disabled: true,
        }),
    ];
    const extensionSettings = { regex: originalRegex };

    globalThis.SillyTavern = {
        getContext() {
            return {
                extensionSettings,
                uuidv4() {
                    return 'new-uuid';
                },
                saveSettingsDebounced() {
                    throw new Error('Disk full');
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'save-error');
    assert.strictEqual(extensionSettings.regex, originalRegex);
    assert.equal(extensionSettings.regex[0].disabled, true);
});

test('26. NO RELOAD / NO CHAT SAVE: repair does NOT call reloadCurrentChat or saveChat', async () => {
    const extensionSettings = { regex: [] };
    let reloadCalls = 0;
    let saveChatCalls = 0;

    globalThis.SillyTavern = {
        getContext() {
            return {
                chatId: 'active-chat-123',
                extensionSettings,
                uuidv4() {
                    return 'new-uuid';
                },
                saveSettingsDebounced() {},
                async reloadCurrentChat() {
                    reloadCalls += 1;
                },
                saveChat() {
                    saveChatCalls += 1;
                },
            };
        },
    };

    const result = await repairRegexIntegration();

    assert.equal(result.status, 'updated');
    assert.equal(reloadCalls, 0, 'reloadCurrentChat must never be called');
    assert.equal(saveChatCalls, 0, 'saveChat must never be called');
});

test('27. inspectRegexIntegrationState never mutates deeply frozen inputs', () => {
    const deepFrozenSettings = Object.freeze({
        disabledExtensions: Object.freeze(['other-extension']),
        regex: Object.freeze([
            Object.freeze(
                createMockInstalledScript(MANAGED_REGEX_SCRIPTS[0], 'uuid-1', {
                    trimStrings: Object.freeze([]),
                    placement: Object.freeze([2]),
                }),
            ),
        ]),
    });

    assert.doesNotThrow(() => {
        const result = inspectRegexIntegrationState(deepFrozenSettings);
        assert.equal(result.status, REGEX_INTEGRATION_STATUS.CURRENT);
    });
});

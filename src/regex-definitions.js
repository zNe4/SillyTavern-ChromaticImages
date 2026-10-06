export const MANAGED_FIELDS = Object.freeze([
    'scriptName',
    'findRegex',
    'replaceString',
    'trimStrings',
    'placement',
    'disabled',
    'markdownOnly',
    'promptOnly',
    'runOnEdit',
    'substituteRegex',
    'minDepth',
    'maxDepth',
]);

const PROMPT_HYGIENE_SCRIPT = Object.freeze({
    key: 'prompt-hygiene',
    scriptName: 'Chromatic Images - Hide image records from prompt',
    findRegex:
        '/^[ \\t]*(?:<!--[ \\t]*CI_(?:IMAGE|RESULT)\\b[^\\r\\n]*-->|!\\[ChromaticImages\\]\\([^\\r\\n)]*\\))[ \\t]*(?:\\r?\\n)?/gm',
    replaceString: '',
    trimStrings: Object.freeze([]),
    placement: Object.freeze([2]),
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
});

export const MANAGED_REGEX_SCRIPTS = Object.freeze([
    PROMPT_HYGIENE_SCRIPT,
]);

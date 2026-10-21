import fs from 'node:fs';
import path from 'node:path';
import {
  getCiPatchDir,
  validateCiPatchPath,
  ensureCiPatchDir,
  inspectLock,
  getPathLstat,
  validateLease,
} from './lock.js';

export const JOURNAL_SCHEMA_VERSION = '1.0.0';
export const JOURNAL_FILE_NAME = 'journal.json';

export const PERMITTED_PHASES = Object.freeze([
  'LOCKED',
  'ISOLATED_PREPARED',
  'BACKUP_CREATED',
  'READY_TO_SWAP',
  'SWAPPED',
  'COMPLETED',
]);

export const PERMITTED_TRANSITIONS = Object.freeze({
  LOCKED: Object.freeze(['ISOLATED_PREPARED']),
  ISOLATED_PREPARED: Object.freeze(['BACKUP_CREATED']),
  BACKUP_CREATED: Object.freeze(['READY_TO_SWAP']),
  READY_TO_SWAP: Object.freeze(['SWAPPED']),
  SWAPPED: Object.freeze(['COMPLETED']),
  COMPLETED: Object.freeze([]),
});

export const IMMUTABLE_JOURNAL_FIELDS = Object.freeze([
  'schemaVersion',
  'txId',
  'op',
  'phase',
  'targetFile',
  'expectedInitialSha256',
  'expectedResultSha256',
  'createdAt',
]);

export const ALLOWED_AUXILIARY_FIELDS = Object.freeze([
  'isolatedStagedPath',
  'backupPath',
  'targetMode',
  'destinationStagedPath',
  'stagedPath',
]);

export const TARGET_MODE_REGEX = /^0[0-7]{3}$/;

export const FIELD_INTRODUCTION_PHASE = Object.freeze({
  isolatedStagedPath: 'ISOLATED_PREPARED',
  backupPath: 'BACKUP_CREATED',
  targetMode: 'BACKUP_CREATED',
  destinationStagedPath: 'READY_TO_SWAP',
});

export const PHASE_REQUIRED_AUXILIARY_FIELDS = Object.freeze({
  LOCKED: Object.freeze([]),
  ISOLATED_PREPARED: Object.freeze(['isolatedStagedPath']),
  BACKUP_CREATED: Object.freeze(['backupPath', 'targetMode']),
  READY_TO_SWAP: Object.freeze(['destinationStagedPath']),
  SWAPPED: Object.freeze([]),
  COMPLETED: Object.freeze([]),
});

const SHA256_REGEX = /^[0-9a-f]{64}$/i;
const TX_ID_REGEX = /^ci-tx-[0-9]+-[0-9a-f]+$/i;

/**
 * Resolve canonical path to journal file.
 * @param {string} repoRoot
 * @returns {string}
 */
export function getJournalPath(repoRoot) {
  return path.resolve(getCiPatchDir(repoRoot), JOURNAL_FILE_NAME);
}

/**
 * Verify lock ownership and lease capability before allowing any journal mutation.
 * Verifies caller lease capability, active lock presence, validity, txId, op, PID, and repoRoot.
 *
 * @param {string} repoRoot
 * @param {string} txId
 * @param {'apply' | 'remove'} expectedOp
 * @param {import('./lock.js').TransactionLease} [lease]
 * @returns {{ ok: boolean, error?: string, reason?: string, lockOwner?: object, lease?: object }}
 */
export function verifyLockOwnershipForMutation(repoRoot, txId, expectedOp, lease = null) {
  if (lease) {
    const leaseAuth = validateLease(lease, repoRoot, txId, expectedOp);
    if (!leaseAuth.ok) {
      return {
        ok: false,
        error: leaseAuth.error,
        reason: `Journal mutation unauthorized: ${leaseAuth.reason}`,
      };
    }
  }

  const lockInspection = inspectLock(repoRoot);
  if (!lockInspection.hasLock) {
    if (lockInspection.isSymlink) {
      return {
        ok: false,
        error: 'ci-patch-symlink',
        reason: 'Installer directory .ci-patch is a symbolic link',
      };
    }
    return {
      ok: false,
      error: 'no-lock',
      reason: 'Cannot mutate journal without an active exclusive lock',
    };
  }

  if (!lease) {
    return {
      ok: false,
      error: 'lease-required',
      reason: 'Cannot mutate journal without the active acquisition lease',
    };
  }
  if (!lockInspection.isValid || !lockInspection.owner) {
    return {
      ok: false,
      error: 'unverified-lock',
      reason: `Lock is corrupted or invalid: ${lockInspection.errors.join('; ')}`,
    };
  }
  if (lockInspection.owner.txId !== txId.trim()) {
    return {
      ok: false,
      error: 'lock-ownership-mismatch',
      reason: `Lock belongs to transaction "${lockInspection.owner.txId}", not caller "${txId}"`,
    };
  }
  if (lockInspection.owner.op !== expectedOp) {
    return {
      ok: false,
      error: 'lock-op-mismatch',
      reason: `Lock operation "${lockInspection.owner.op}" does not match journal operation "${expectedOp}"`,
    };
  }
  if (path.resolve(lockInspection.owner.repoRoot) !== path.resolve(repoRoot)) {
    return {
      ok: false,
      error: 'lock-repo-mismatch',
      reason: 'Lock repository path mismatch',
    };
  }
  if (lockInspection.owner.pid !== process.pid) {
    return {
      ok: false,
      error: 'ownership-mismatch',
      reason: `Lock owner PID (${lockInspection.owner.pid}) does not match current process (${process.pid})`,
    };
  }

  return { ok: true, lockOwner: lockInspection.owner, lease };
}

/**
 * Validate auxiliary metadata to prevent overriding protected journal fields.
 *
 * @param {object} auxiliary
 * @param {boolean} isCreation
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateAuxiliaryMetadata(auxiliary, isCreation = false) {
  if (!auxiliary || typeof auxiliary !== 'object' || Array.isArray(auxiliary)) {
    return { valid: false, error: 'Auxiliary metadata must be a plain object' };
  }

  for (const key of Object.keys(auxiliary)) {
    if (IMMUTABLE_JOURNAL_FIELDS.includes(key)) {
      const action = isCreation ? 'create with forbidden' : 'overwrite immutable';
      return {
        valid: false,
        error: `Cannot ${action} journal field: "${key}"`,
      };
    }
    if (isCreation) {
      return {
        valid: false,
        error: `Disallowed auxiliary journal field at creation: "${key}" (no auxiliary fields permitted in LOCKED phase)`,
      };
    }
    if (key === 'stagedPath') {
      return {
        valid: false,
        error: 'Disallowed auxiliary journal field: legacy "stagedPath" is rejected for mutation',
      };
    }
    if (!ALLOWED_AUXILIARY_FIELDS.includes(key)) {
      return {
        valid: false,
        error: `Disallowed auxiliary journal field: "${key}" (allowed: ${ALLOWED_AUXILIARY_FIELDS.join(', ')})`,
      };
    }
    if (typeof auxiliary[key] !== 'string') {
      return {
        valid: false,
        error: `Auxiliary journal field "${key}" must be a string`,
      };
    }
    if (key === 'targetMode' && !TARGET_MODE_REGEX.test(auxiliary[key])) {
      return {
        valid: false,
        error: `Invalid targetMode "${auxiliary[key]}": must be a 4-character octal string matching /^0[0-7]{3}$/`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a candidate journal object against strict schema.
 * @param {any} journal
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateJournalStructure(journal) {
  const errors = [];
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    return { valid: false, errors: ['Journal must be a non-null plain object'] };
  }

  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    errors.push(`Invalid schemaVersion: expected "${JOURNAL_SCHEMA_VERSION}", received "${journal.schemaVersion}"`);
  }

  if (typeof journal.txId !== 'string' || !TX_ID_REGEX.test(journal.txId.trim())) {
    errors.push(`Invalid txId format: "${journal.txId}"`);
  }

  if (journal.op !== 'apply' && journal.op !== 'remove') {
    errors.push(`Invalid operation: "${journal.op}" (must be "apply" or "remove")`);
  }

  if (!PERMITTED_PHASES.includes(journal.phase)) {
    errors.push(`Invalid phase: "${journal.phase}" (must be one of ${PERMITTED_PHASES.join(', ')})`);
  }

  if (typeof journal.targetFile !== 'string' || journal.targetFile.trim() === '') {
    errors.push('Missing or empty targetFile');
  }

  if (typeof journal.expectedInitialSha256 !== 'string' || !SHA256_REGEX.test(journal.expectedInitialSha256.trim())) {
    errors.push(`Invalid expectedInitialSha256: "${journal.expectedInitialSha256}"`);
  }

  if (typeof journal.expectedResultSha256 !== 'string' || !SHA256_REGEX.test(journal.expectedResultSha256.trim())) {
    errors.push(`Invalid expectedResultSha256: "${journal.expectedResultSha256}"`);
  }

  if (typeof journal.createdAt !== 'string' || Number.isNaN(Date.parse(journal.createdAt))) {
    errors.push(`Invalid createdAt timestamp: "${journal.createdAt}"`);
  }

  if (typeof journal.updatedAt !== 'string' || Number.isNaN(Date.parse(journal.updatedAt))) {
    errors.push(`Invalid updatedAt timestamp: "${journal.updatedAt}"`);
  }

  // Check auxiliary fields and phase-bound metadata rules
  const isLegacy = typeof journal.stagedPath === 'string';

  for (const [k, v] of Object.entries(journal)) {
    if (IMMUTABLE_JOURNAL_FIELDS.includes(k) || k === 'updatedAt') {
      continue;
    }
    if (!ALLOWED_AUXILIARY_FIELDS.includes(k)) {
      errors.push(`Unexpected journal property: "${k}"`);
    } else if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`Auxiliary property "${k}" must be a non-empty string`);
    } else if (k === 'targetMode' && !TARGET_MODE_REGEX.test(v)) {
      errors.push(`Invalid targetMode "${v}": must be a 4-character octal string matching /^0[0-7]{3}$/`);
    }
  }

  if (isLegacy) {
    if (journal.stagedPath.trim() === '') {
      errors.push('Legacy property "stagedPath" must be a non-empty string');
    }
    if (journal.isolatedStagedPath || journal.backupPath || journal.targetMode || journal.destinationStagedPath) {
      errors.push('Cannot mix legacy "stagedPath" with current transaction auxiliary metadata');
    }
  } else if (PERMITTED_PHASES.includes(journal.phase)) {
    // Current-schema phase-bound resource metadata rules
    const phase = journal.phase;
    const requiredByPhase = {
      LOCKED: [],
      ISOLATED_PREPARED: ['isolatedStagedPath'],
      BACKUP_CREATED: ['isolatedStagedPath', 'backupPath', 'targetMode'],
      READY_TO_SWAP: ['isolatedStagedPath', 'backupPath', 'targetMode', 'destinationStagedPath'],
      SWAPPED: ['isolatedStagedPath', 'backupPath', 'targetMode', 'destinationStagedPath'],
      COMPLETED: ['isolatedStagedPath', 'backupPath', 'targetMode', 'destinationStagedPath'],
    };

    const disallowedByPhase = {
      LOCKED: ['isolatedStagedPath', 'backupPath', 'targetMode', 'destinationStagedPath'],
      ISOLATED_PREPARED: ['backupPath', 'targetMode', 'destinationStagedPath'],
      BACKUP_CREATED: ['destinationStagedPath'],
      READY_TO_SWAP: [],
      SWAPPED: [],
      COMPLETED: [],
    };

    const required = requiredByPhase[phase] || [];
    for (const reqField of required) {
      if (typeof journal[reqField] !== 'string' || journal[reqField].trim() === '') {
        errors.push(`Missing mandatory auxiliary field for phase "${phase}": "${reqField}"`);
      }
    }

    const disallowed = disallowedByPhase[phase] || [];
    for (const disField of disallowed) {
      if (journal[disField] !== undefined) {
        errors.push(`Disallowed premature or extraneous auxiliary field in phase "${phase}": "${disField}"`);
      }
    }

    // Path containment and exact format validation
    if (
      typeof journal.targetFile === 'string' &&
      journal.targetFile.trim() !== '' &&
      typeof journal.txId === 'string' &&
      journal.txId.trim() !== ''
    ) {
      const targetBase = path.basename(journal.targetFile.trim());
      const targetDir = path.dirname(journal.targetFile.trim());
      const txId = journal.txId.trim();

      if (journal.isolatedStagedPath !== undefined) {
        const expected = `.ci-patch/staging/${txId}/${targetBase}`;
        if (journal.isolatedStagedPath !== expected) {
          errors.push(`Invalid isolatedStagedPath "${journal.isolatedStagedPath}": must strictly equal "${expected}"`);
        }
      }

      if (journal.backupPath !== undefined) {
        const expected = `.ci-patch/backup/${txId}/${targetBase}`;
        if (journal.backupPath !== expected) {
          errors.push(`Invalid backupPath "${journal.backupPath}": must strictly equal "${expected}"`);
        }
      }

      if (journal.destinationStagedPath !== undefined) {
        const expected = `${targetDir}/.${targetBase}.ci-staged-${txId}.tmp`;
        if (journal.destinationStagedPath !== expected) {
          errors.push(`Invalid destinationStagedPath "${journal.destinationStagedPath}": must strictly equal "${expected}"`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, isLegacy };
}

/**
 * Validate whether a phase transition is strictly permitted.
 * @param {string} currentPhase
 * @param {string} nextPhase
 * @returns {{ ok: boolean, error?: string }}
 */
export function validatePhaseTransition(currentPhase, nextPhase) {
  if (!PERMITTED_PHASES.includes(currentPhase)) {
    return { ok: false, error: `Invalid current phase "${currentPhase}"` };
  }
  if (!PERMITTED_PHASES.includes(nextPhase)) {
    return { ok: false, error: `Invalid target phase "${nextPhase}"` };
  }

  const allowed = PERMITTED_TRANSITIONS[currentPhase] || [];
  if (!allowed.includes(nextPhase)) {
    return {
      ok: false,
      error: `Illegal phase transition from "${currentPhase}" to "${nextPhase}". Permitted: [${allowed.join(', ')}]`,
    };
  }

  return { ok: true };
}

/**
 * Read-only inspection of installer journal state.
 * Never mutates, deletes, or recreates journals.
 * Detects dangling symlinks and corrupted data.
 *
 * @param {string} repoRoot
 * @returns {{
 *   hasJournal: boolean,
 *   isValid: boolean,
 *   isSymlink: boolean,
 *   journal: object|null,
 *   journalPath: string,
 *   errors: string[]
 * }}
 */
export function inspectJournal(repoRoot) {
  const journalPath = getJournalPath(repoRoot);
  const ciPathCheck = validateCiPatchPath(repoRoot);

  if (!ciPathCheck.ok) {
    return {
      hasJournal: false,
      isValid: false,
      isSymlink: ciPathCheck.isSymlink,
      journal: null,
      journalPath,
      errors: [ciPathCheck.error || 'Invalid .ci-patch directory'],
    };
  }

  if (!ciPathCheck.exists) {
    return { hasJournal: false, isValid: true, isSymlink: false, journal: null, journalPath, errors: [] };
  }

  const jCheck = getPathLstat(journalPath);
  if (jCheck.error) {
    return {
      hasJournal: false,
      isValid: false,
      isSymlink: false,
      journal: null,
      journalPath,
      errors: [`Filesystem error checking journal file: ${jCheck.error.message}`],
    };
  }

  if (!jCheck.exists) {
    return { hasJournal: false, isValid: true, isSymlink: false, journal: null, journalPath, errors: [] };
  }

  if (jCheck.isSymbolicLink) {
    return {
      hasJournal: true,
      isValid: false,
      isSymlink: true,
      journal: null,
      journalPath,
      errors: ['Journal file is a symbolic link'],
    };
  }

  if (!jCheck.isFile) {
    return {
      hasJournal: true,
      isValid: false,
      isSymlink: false,
      journal: null,
      journalPath,
      errors: ['Journal path exists but is not a regular file'],
    };
  }

  try {
    const raw = fs.readFileSync(journalPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return {
        hasJournal: true,
        isValid: false,
        isSymlink: false,
        journal: null,
        journalPath,
        errors: [`Journal file contains invalid JSON: ${parseErr.message}`],
      };
    }

    const val = validateJournalStructure(parsed);
    if (!val.valid) {
      return {
        hasJournal: true,
        isValid: false,
        isSymlink: false,
        isLegacy: Boolean(val.isLegacy),
        journal: parsed,
        journalPath,
        errors: val.errors,
      };
    }

    return {
      hasJournal: true,
      isValid: true,
      isSymlink: false,
      isLegacy: Boolean(val.isLegacy),
      journal: parsed,
      journalPath,
      errors: [],
    };
  } catch (err) {
    return {
      hasJournal: true,
      isValid: false,
      isSymlink: false,
      journal: null,
      journalPath,
      errors: [`Filesystem error reading journal: ${err.message}`],
    };
  }
}

/**
 * Validate device identifier. Must be a finite non-negative integer (Number or BigInt).
 * Rejects null, undefined, NaN, negative numbers, floats, strings, and non-numerics.
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function isValidDeviceIdentifier(val) {
  if (typeof val === 'bigint') {
    return val >= 0n;
  }
  if (typeof val !== 'number') {
    return false;
  }
  return Number.isFinite(val) && !Number.isNaN(val) && Number.isInteger(val) && val >= 0;
}

/**
 * Validate open constant (e.g. O_DIRECTORY, O_NOFOLLOW).
 * Must be a finite non-zero positive integer.
 * Rejects missing, zero, NaN, Infinity, negative, fractional, and non-numeric values.
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function isValidOpenConstant(val) {
  return (
    typeof val === 'number' &&
    Number.isFinite(val) &&
    !Number.isNaN(val) &&
    Number.isInteger(val) &&
    val > 0
  );
}

/**
 * Validate read-only open constant (O_RDONLY). Must be a finite non-negative integer.
 * In POSIX/Linux, O_RDONLY is 0.
 * Rejects missing, NaN, Infinity, negative, fractional, and non-numeric values.
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function isValidReadOnlyConstant(val) {
  return (
    typeof val === 'number' &&
    Number.isFinite(val) &&
    !Number.isNaN(val) &&
    Number.isInteger(val) &&
    val >= 0
  );
}

/**
 * Shared interpretation contract for journal advancement failures across transaction stages.
 * Propagates uncertainty, publication confirmation, directory fsync confirmation,
 * observed disk phase, primary failure code/stage/reason, and descriptor close diagnostics.
 *
 * @param {object} advanceRes
 * @param {string} targetPhase
 * @returns {object}
 */
export function formatJournalAdvancementFailure(advanceRes, targetPhase) {
  const result = {
    ok: false,
    error: `Failed to advance journal to ${targetPhase}: ${advanceRes.error || advanceRes.reason || 'unknown error'}`,
    code: advanceRes.code || 'journal-advancement-failed',
    stage: advanceRes.stage,
    uncertain: Boolean(advanceRes.uncertain),
    publicationAttempted: Boolean(advanceRes.publicationAttempted),
    publicationConfirmed: advanceRes.publicationConfirmed !== undefined ? advanceRes.publicationConfirmed : null,
    directoryFsyncAttempted: Boolean(advanceRes.directoryFsyncAttempted),
    directoryFsyncConfirmed: Boolean(advanceRes.directoryFsyncConfirmed),
    observedJournalPhase: advanceRes.observedJournalPhase !== undefined ? advanceRes.observedJournalPhase : null,
  };

  if (advanceRes.reason) {
    result.reason = advanceRes.reason;
  }
  if (advanceRes.descriptorCloseUncertain) {
    result.descriptorCloseUncertain = true;
  }
  if (advanceRes.closeError) {
    result.closeError = advanceRes.closeError;
  }
  if (advanceRes.journal) {
    result.journal = advanceRes.journal;
  }

  return result;
}

/**
 * Validate inode identifier. Must be a finite positive (nonzero) integer (Number or BigInt).
 * In POSIX/Linux, inode 0 indicates an unused or sentinel inode.
 * Rejects null, undefined, NaN, zero, negative numbers, floats, strings, and non-numerics.
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function isValidInodeIdentifier(val) {
  if (typeof val === 'bigint') {
    return val > 0n;
  }
  if (typeof val !== 'number') {
    return false;
  }
  return Number.isFinite(val) && !Number.isNaN(val) && Number.isInteger(val) && val > 0;
}

/**
 * Safely unlink a temporary file created by the current operation.
 * Positively verifies ownership and identity against the expected dev/ino.
 * Refuses deletion unless:
 * - expectedDev is present and a valid non-negative integer.
 * - expectedIno is present and a valid positive (nonzero) integer.
 * - target exists, is a regular file, and is not a symbolic link.
 * - lstat succeeds without an inspection error.
 * - actual dev and ino match expectedDev and expectedIno.
 * Preserves the file when identity, ownership, or cleanup safety cannot be proven.
 *
 * @param {string} targetPath
 * @param {number|bigint} expectedDev
 * @param {number|bigint} expectedIno
 * @returns {boolean} True if safely unlinked; false if preserved or failed
 */
export function safeUnlinkCreatedFile(targetPath, expectedDev, expectedIno) {
  if (!targetPath || typeof targetPath !== 'string') {
    return false;
  }
  if (!isValidDeviceIdentifier(expectedDev) || !isValidInodeIdentifier(expectedIno)) {
    return false;
  }

  try {
    const check = getPathLstat(targetPath);
    if (check.error || !check.exists || check.isSymbolicLink || !check.isFile || !check.stat) {
      return false;
    }
    if (check.stat.dev !== expectedDev || check.stat.ino !== expectedIno) {
      // Path was replaced or does not match our created file; preserve evidence
      return false;
    }
    fs.unlinkSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically write and flush journal to disk with descriptor-anchored operations,
 * distinct pre-publication and post-publication error handling, and structured publication outcome.
 * Employs atomic no-replace publication via descriptor-anchored hard link (link(2)) for initial creation.
 * Employs atomic replacement via descriptor-anchored rename (rename(2)) for later phase updates.
 * Never unlinks a pre-existing temporary journal upon collision (EEXIST).
 * Positively verifies created file ownership and identity before permitted cleanup.
 *
 * @param {string} repoRoot
 * @param {object} journal
 * @param {boolean} [isCreation=false]
 * @param {object} [options={}]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   code?: string,
 *   stage: string,
 *   reason?: string,
 *   publicationAttempted: boolean,
 *   publicationConfirmed: boolean | null,
 *   directoryFsyncAttempted: boolean,
 *   directoryFsyncConfirmed: boolean,
 *   uncertain: boolean,
 *   observedJournalPhase: string | null,
 *   journal?: object,
 *   descriptorCloseUncertain?: boolean,
 *   closeError?: object
 * }}
 */
function writeJournalDurable(repoRoot, journal, isCreation = false, options = {}) {
  const opts = options.options && typeof options.options === 'object' ? { ...options, ...options.options } : options;
  const constants = opts.constants || fs.constants;
  const procDir = opts.procDir || '/proc/self/fd';
  const runFault = (hookStage, ctx = {}) => {
    if (typeof opts.faultHook === 'function') {
      opts.faultHook(hookStage, ctx);
    }
  };

  const ciPatchDir = getCiPatchDir(repoRoot);
  const journalPath = getJournalPath(repoRoot);
  const tmpJournalBase = `.journal.${journal.txId}.tmp`;
  const journalBase = JOURNAL_FILE_NAME;
  const absTmpJournalPath = path.join(ciPatchDir, tmpJournalBase);
  const absJournalPath = journalPath;

  const getObservedPhase = () => {
    try {
      const insp = inspectJournal(repoRoot);
      if (insp.hasJournal && insp.journal?.phase) {
        return insp.journal.phase;
      }
    } catch {}
    return null;
  };

  const fail = ({
    error,
    code,
    reason,
    stage,
    publicationAttempted = false,
    publicationConfirmed = false,
    directoryFsyncAttempted = false,
    directoryFsyncConfirmed = false,
    uncertain = false,
    observedJournalPhase = undefined,
    descriptorCloseUncertain = false,
    closeError = undefined,
    journal: resJournal = undefined,
  }) => {
    const finalObserved = observedJournalPhase !== undefined ? observedJournalPhase : getObservedPhase();
    const res = {
      ok: false,
      error,
      code: code || 'journal-publication-failed',
      stage: stage || (isCreation ? 'pre-publication' : 'pre-rename'),
      reason: reason || error,
      publicationAttempted,
      publicationConfirmed,
      directoryFsyncAttempted,
      directoryFsyncConfirmed,
      uncertain,
      observedJournalPhase: finalObserved,
    };
    if (descriptorCloseUncertain) {
      res.descriptorCloseUncertain = true;
    }
    if (closeError) {
      res.closeError = closeError;
    }
    if (resJournal) {
      res.journal = resJournal;
    }
    return res;
  };

  // 1. Validate platform open constants: O_RDONLY, O_DIRECTORY, O_NOFOLLOW
  if (
    !constants ||
    !isValidReadOnlyConstant(constants.O_RDONLY) ||
    !isValidOpenConstant(constants.O_DIRECTORY) ||
    !isValidOpenConstant(constants.O_NOFOLLOW)
  ) {
    return fail({
      error: 'Platform capabilities missing or invalid: fs.constants.O_RDONLY, O_DIRECTORY, and O_NOFOLLOW are required for durable journal publication',
      code: 'unsupported-platform',
      reason: 'O_DIRECTORY and O_NOFOLLOW capabilities required',
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: isCreation ? null : undefined,
    });
  }

  // 2. Authenticate .ci-patch directory without symlinks
  const ciPatchCheck = validateCiPatchPath(repoRoot);
  if (!ciPatchCheck.ok || ciPatchCheck.isSymlink) {
    return fail({
      error: ciPatchCheck.error || 'Directory component ".ci-patch" is a symbolic link',
      code: ciPatchCheck.isSymlink ? 'unsafe-symlink' : 'invalid-ci-patch',
      reason: ciPatchCheck.error || 'Directory component ".ci-patch" is a symbolic link',
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    });
  }

  const dirLstat = getPathLstat(ciPatchDir);
  if (dirLstat.error || !dirLstat.exists || !dirLstat.isDirectory || dirLstat.isSymbolicLink || !dirLstat.stat) {
    return fail({
      error: `Directory "${ciPatchDir}" does not exist, is not a directory, or is a symbolic link`,
      code: dirLstat.isSymbolicLink ? 'unsafe-symlink' : 'invalid-ci-patch',
      reason: dirLstat.error ? dirLstat.error.message : 'Directory invalid',
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    });
  }

  if (!isValidDeviceIdentifier(dirLstat.stat.dev) || !isValidInodeIdentifier(dirLstat.stat.ino)) {
    return fail({
      error: `Directory "${ciPatchDir}" has invalid device or inode identity`,
      code: 'directory-invalid',
      reason: 'Invalid device or inode identifier',
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    });
  }

  // 3. Verify procfs availability
  let procAvailable = false;
  try {
    procAvailable = typeof procDir === 'string' && fs.existsSync(procDir);
  } catch {
    procAvailable = false;
  }
  if (!procAvailable) {
    return fail({
      error: `Procfs descriptor directory "${procDir}" is unavailable`,
      code: 'procfs-unavailable',
      reason: 'Procfs descriptor anchoring unavailable',
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: isCreation ? null : undefined,
    });
  }

  // 4. Open and authenticate .ci-patch directory descriptor
  const dirOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let dirFd = null;
  try {
    dirFd = fs.openSync(ciPatchDir, dirOpenFlags);
  } catch (openDirErr) {
    return fail({
      error: `Failed to open .ci-patch directory descriptor: ${openDirErr.message}`,
      code: openDirErr.code || 'directory-open-failed',
      reason: openDirErr.message,
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: isCreation ? null : undefined,
    });
  }

  let tmpFd = null;
  try {
    const procDirPath = path.join(procDir, String(dirFd));
    let dirStat;
    try {
      dirStat = fs.statSync(procDirPath);
    } catch (procErr) {
      return fail({
        error: `Procfs descriptor path "${procDirPath}" cannot be accessed: ${procErr.message}`,
        code: 'procfs-descriptor-unavailable',
        reason: procErr.message,
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: isCreation ? null : undefined,
      });
    }

    if (!dirStat.isDirectory() || (typeof dirStat.isSymbolicLink === 'function' && dirStat.isSymbolicLink())) {
      return fail({
        error: 'Directory descriptor is not a directory or is a symbolic link',
        code: 'directory-invalid',
        reason: 'Descriptor is not a directory',
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: isCreation ? null : undefined,
      });
    }

    if (dirStat.dev !== dirLstat.stat.dev || dirStat.ino !== dirLstat.stat.ino) {
      return fail({
        error: 'Directory descriptor identity does not match preliminary inspection',
        code: 'directory-identity-mismatch',
        reason: 'Device or inode mismatch on directory open',
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: isCreation ? null : undefined,
      });
    }

    let dirCloseError = null;
    let descriptorCloseUncertain = false;
    const closeDirFd = () => {
      if (dirFd !== null) {
        const fd = dirFd;
        dirFd = null; // Relinquish ownership immediately; do not retry close!
        try {
          fs.closeSync(fd);
        } catch (err) {
          descriptorCloseUncertain = true;
          dirCloseError = {
            error: err.message,
            message: err.message,
            code: err.code || 'descriptor-close-error',
            uncertain: true,
            status: 'failed',
          };
        }
      }
    };

    const procTmpJournalPath = path.join(procDirPath, tmpJournalBase);
    const procJournalPath = path.join(procDirPath, journalBase);

    // 5. If this is initial creation, ensure destination doesn't exist before starting
    if (isCreation) {
      const jCheck = getPathLstat(journalPath);
      if (jCheck.exists) {
        closeDirFd();
        return fail({
          error: 'Cannot create journal: a journal already exists on disk',
          code: 'EEXIST',
          stage: 'pre-publication',
          publicationAttempted: false,
          publicationConfirmed: false,
          directoryFsyncAttempted: false,
          directoryFsyncConfirmed: false,
          uncertain: false,
          descriptorCloseUncertain,
          closeError: dirCloseError,
        });
      }
    }

    // 6. Exclusive temporary file creation, complete bounded write, and fsync
    const serialized = JSON.stringify(journal, null, 2) + '\n';
    const serializedBuffer = Buffer.from(serialized, 'utf8');
    const expectedBytes = serializedBuffer.length;

    let createdDev = null;
    let createdIno = null;
    let fileCreatedByUs = false;
    let primaryErr = null;

    try {
      tmpFd = fs.openSync(
        procTmpJournalPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      fileCreatedByUs = true;
      const stat = fs.fstatSync(tmpFd);
      if (!isValidDeviceIdentifier(stat?.dev) || !isValidInodeIdentifier(stat?.ino)) {
        throw new Error(`Failed to establish usable file identity: dev=${stat?.dev}, ino=${stat?.ino}`);
      }
      createdDev = stat.dev;
      createdIno = stat.ino;

      let bytesWrittenTotal = 0;
      while (bytesWrittenTotal < expectedBytes) {
        let bytesWritten;
        if (bytesWrittenTotal === 0) {
          bytesWritten = fs.writeSync(tmpFd, serialized, 0, 'utf8');
        } else {
          bytesWritten = fs.writeSync(
            tmpFd,
            serializedBuffer,
            bytesWrittenTotal,
            expectedBytes - bytesWrittenTotal,
            bytesWrittenTotal
          );
        }

        if (
          typeof bytesWritten !== 'number' ||
          !Number.isInteger(bytesWritten) ||
          bytesWritten <= 0 ||
          bytesWritten > (expectedBytes - bytesWrittenTotal)
        ) {
          const err = new Error(
            `Non-positive or invalid progress writing temporary journal: wrote ${bytesWrittenTotal} of ${expectedBytes} bytes (last write returned ${bytesWritten})`
          );
          err.code = 'short-write';
          throw err;
        }

        bytesWrittenTotal += bytesWritten;
      }

      fs.fsyncSync(tmpFd);
    } catch (writeErr) {
      primaryErr = writeErr;
    }

    // Handle temporary descriptor closure before publication (JH1-B)
    let tmpCloseError = null;
    if (tmpFd !== null) {
      const fdToClose = tmpFd;
      tmpFd = null; // Relinquish ownership immediately; do not retry close!
      try {
        fs.closeSync(fdToClose);
      } catch (closeErr) {
        tmpCloseError = {
          error: closeErr.message,
          message: closeErr.message,
          code: closeErr.code || 'descriptor-close-error',
          uncertain: true,
          status: 'failed',
        };
      }
    }

    if (primaryErr !== null) {
      if (primaryErr.code === 'EEXIST') {
        // PRESERVE PRE-EXISTING ARTIFACT: do NOT unlink!
        closeDirFd();
        return fail({
          stage: isCreation ? 'pre-publication' : 'pre-rename',
          error: `Cannot prepare temporary journal: pre-existing temporary artifact "${tmpJournalBase}" already exists (collision)`,
          code: 'EEXIST',
          publicationAttempted: false,
          publicationConfirmed: false,
          directoryFsyncAttempted: false,
          directoryFsyncConfirmed: false,
          uncertain: false,
          descriptorCloseUncertain,
          closeError: dirCloseError,
        });
      }

      if (tmpCloseError !== null) {
        // Primary error occurred AND secondary close failed!
        // Descriptor cleanup is uncertain: preserve evidence! Do NOT unlink!
        closeDirFd();
        return fail({
          stage: isCreation ? 'pre-publication' : 'pre-rename',
          error: `Failed to prepare journal update before ${isCreation ? 'publication' : 'rename'}: ${primaryErr.message}`,
          code: primaryErr.code || 'write-error',
          publicationAttempted: false,
          publicationConfirmed: false,
          directoryFsyncAttempted: false,
          directoryFsyncConfirmed: false,
          uncertain: false,
          descriptorCloseUncertain: true,
          closeError: tmpCloseError,
        });
      }

      if (fileCreatedByUs) {
        // Safely unlink ONLY if we created it, its identity matches, and close succeeded cleanly.
        // Try descriptor-anchored path first while dirFd is still open, with abs path fallback.
        const unlinked = safeUnlinkCreatedFile(procTmpJournalPath, createdDev, createdIno);
        if (!unlinked) {
          safeUnlinkCreatedFile(absTmpJournalPath, createdDev, createdIno);
        }
      }

      closeDirFd();

      return fail({
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        error: `Failed to prepare journal update before ${isCreation ? 'publication' : 'rename'}: ${primaryErr.message}`,
        code: primaryErr.code || 'write-error',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    if (tmpCloseError !== null) {
      // Write and fsync succeeded, but temporary descriptor close failed before publication!
      // A close error must prevent subsequent linkSync() or renameSync() publication.
      // Descriptor closure was uncertain: preserve temporary artifact evidence! Do NOT unlink!
      closeDirFd();
      return fail({
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        error: `Failed to close temporary journal descriptor before ${isCreation ? 'publication' : 'rename'}: ${tmpCloseError.message}`,
        code: tmpCloseError.code || 'descriptor-close-error',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        descriptorCloseUncertain: true,
        closeError: tmpCloseError,
      });
    }

    // 7. Check directory continuity BEFORE publication
    runFault('before-publication', { isCreation, procTmpJournalPath, procJournalPath });

    let prePubDirCheck;
    try {
      prePubDirCheck = fs.lstatSync(ciPatchDir);
    } catch (err) {
      closeDirFd();
      return fail({
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        error: `Directory "${ciPatchDir}" disappeared before publication: ${err.message}`,
        code: 'directory-continuity-error',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    if (
      prePubDirCheck.isSymbolicLink() ||
      !prePubDirCheck.isDirectory() ||
      prePubDirCheck.dev !== dirStat.dev ||
      prePubDirCheck.ino !== dirStat.ino
    ) {
      closeDirFd();
      return fail({
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        error: `Directory "${ciPatchDir}" identity changed or replaced before publication`,
        code: 'directory-identity-mismatch',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    // 8. ATOMIC PUBLICATION
    let publicationAttempted = true;
    let publicationConfirmed = false;
    let publicationErr = null;

    try {
      if (isCreation) {
        fs.linkSync(procTmpJournalPath, procJournalPath);
      } else {
        fs.renameSync(procTmpJournalPath, procJournalPath);
      }
      publicationConfirmed = true;
    } catch (pubErr) {
      publicationConfirmed = null; // Syscall was attempted but threw!
      publicationErr = pubErr;
    }

    if (publicationConfirmed === null) {
      // Syscall was attempted and threw: outcome is UNCERTAIN!
      // NO SPECULATIVE DELETION OF EVIDENCE: DO NOT UNLINK!
      closeDirFd();
      return fail({
        stage: isCreation ? 'publication-attempted' : 'rename-attempted',
        error: isCreation
          ? `Failed to publish journal atomically: ${publicationErr.message}`
          : `Failed to replace journal atomically: ${publicationErr.message}`,
        code: publicationErr.code || (isCreation ? 'link-error' : 'rename-error'),
        reason: publicationErr.message,
        publicationAttempted: true,
        publicationConfirmed: null,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: true,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    runFault('after-publication', { isCreation, procTmpJournalPath, procJournalPath, journal });

    // 9. Initial Directory Fsync
    let directoryFsyncAttempted = true;
    let directoryFsyncConfirmed = false;
    let dirFsyncErr = null;

    try {
      fs.fsyncSync(dirFd);
      directoryFsyncConfirmed = true;
    } catch (err) {
      dirFsyncErr = err;
    }

    if (dirFsyncErr !== null) {
      closeDirFd();
      return fail({
        stage: isCreation ? 'post-publication' : 'post-rename',
        error: isCreation
          ? `Journal published on disk but initial directory synchronization failed: ${dirFsyncErr.message}`
          : `Journal updated on disk but directory synchronization failed: ${dirFsyncErr.message}`,
        code: dirFsyncErr.code || 'fsync-failed',
        reason: dirFsyncErr.message,
        publicationAttempted: true,
        publicationConfirmed: true,
        directoryFsyncAttempted: true,
        directoryFsyncConfirmed: false,
        uncertain: true,
        journal,
        observedJournalPhase: journal.phase,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    runFault('after-directory-fsync', { isCreation, dirFd, journal });

    // 10. For initial creation: Cleanup temporary link and perform second directory sync
    if (isCreation) {
      runFault('before-link-cleanup', { procTmpJournalPath, createdDev, createdIno });
      let unlinkErr = null;
      try {
        const unlinked = safeUnlinkCreatedFile(procTmpJournalPath, createdDev, createdIno);
        if (!unlinked) {
          const check = getPathLstat(procTmpJournalPath);
          if (check.exists) {
            throw new Error('Temporary link ownership or identity could not be verified for removal');
          }
        }
      } catch (err) {
        unlinkErr = err;
      }

      if (unlinkErr !== null) {
        closeDirFd();
        return fail({
          stage: 'post-publication',
          error: `Journal published on disk but removing temporary link failed: ${unlinkErr.message}`,
          code: unlinkErr.code || 'cleanup-failed',
          reason: unlinkErr.message,
          publicationAttempted: true,
          publicationConfirmed: true,
          directoryFsyncAttempted: true,
          directoryFsyncConfirmed: true,
          uncertain: true,
          journal,
          observedJournalPhase: journal.phase,
          descriptorCloseUncertain,
          closeError: dirCloseError,
        });
      }

      runFault('after-link-cleanup', { dirFd, journal });

      // Second directory sync to flush temporary entry removal
      let postCleanupSyncErr = null;
      try {
        fs.fsyncSync(dirFd);
      } catch (err) {
        postCleanupSyncErr = err;
      }

      if (postCleanupSyncErr !== null) {
        closeDirFd();
        return fail({
          stage: 'post-publication',
          error: `Journal published on disk but post-cleanup directory synchronization failed: ${postCleanupSyncErr.message}`,
          code: postCleanupSyncErr.code || 'fsync-failed',
          reason: postCleanupSyncErr.message,
          publicationAttempted: true,
          publicationConfirmed: true,
          directoryFsyncAttempted: true,
          directoryFsyncConfirmed: true,
          uncertain: true,
          journal,
          observedJournalPhase: journal.phase,
          descriptorCloseUncertain,
          closeError: dirCloseError,
        });
      }
    }

    // 11. Check directory continuity after publication and synchronization
    let postPubDirCheck;
    try {
      postPubDirCheck = fs.lstatSync(ciPatchDir);
    } catch (err) {
      closeDirFd();
      return fail({
        stage: isCreation ? 'post-publication' : 'post-rename',
        error: `Directory "${ciPatchDir}" disappeared after publication: ${err.message}`,
        code: 'directory-continuity-error',
        reason: err.message,
        publicationAttempted: true,
        publicationConfirmed: true,
        directoryFsyncAttempted: true,
        directoryFsyncConfirmed: true,
        uncertain: true,
        journal,
        observedJournalPhase: journal.phase,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    if (
      postPubDirCheck.isSymbolicLink() ||
      !postPubDirCheck.isDirectory() ||
      postPubDirCheck.dev !== dirStat.dev ||
      postPubDirCheck.ino !== dirStat.ino
    ) {
      closeDirFd();
      return fail({
        stage: isCreation ? 'post-publication' : 'post-rename',
        error: `Directory "${ciPatchDir}" identity changed after publication`,
        code: 'directory-identity-mismatch',
        reason: 'Pathname device/inode mismatch after publication',
        publicationAttempted: true,
        publicationConfirmed: true,
        directoryFsyncAttempted: true,
        directoryFsyncConfirmed: true,
        uncertain: true,
        journal,
        observedJournalPhase: journal.phase,
        descriptorCloseUncertain,
        closeError: dirCloseError,
      });
    }

    // 12. Close directory descriptor
    runFault('before-close', { dirFd, journal });
    closeDirFd();

    if (dirCloseError !== null) {
      return fail({
        stage: isCreation ? 'post-publication' : 'post-rename',
        error: `Failed to close directory descriptor after publication: ${dirCloseError.message}`,
        code: dirCloseError.code || 'descriptor-close-error',
        reason: dirCloseError.message,
        publicationAttempted: true,
        publicationConfirmed: true,
        directoryFsyncAttempted: true,
        directoryFsyncConfirmed: true,
        uncertain: true,
        journal,
        observedJournalPhase: journal.phase,
        descriptorCloseUncertain: true,
        closeError: dirCloseError,
      });
    }

    return {
      ok: true,
      stage: isCreation ? 'post-publication' : 'post-rename',
      publicationAttempted: true,
      publicationConfirmed: true,
      directoryFsyncAttempted: true,
      directoryFsyncConfirmed: true,
      uncertain: false,
      observedJournalPhase: journal.phase,
      journal,
    };
  } finally {
    if (dirFd !== null) {
      const fd = dirFd;
      dirFd = null;
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (tmpFd !== null) {
      const fd = tmpFd;
      tmpFd = null;
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Create a new journal under verified exclusive lock ownership and lease capability.
 * Begins strictly in phase 'LOCKED'.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {'apply' | 'remove'} options.op
 * @param {string} options.targetFile
 * @param {string} options.expectedInitialSha256
 * @param {string} options.expectedResultSha256
 * @param {object} [options.extraMetadata]
 * @param {import('./lock.js').TransactionLease} [options.lease]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   code?: string,
 *   stage?: string,
 *   reason?: string,
 *   publicationAttempted?: boolean,
 *   publicationConfirmed?: boolean | null,
 *   directoryFsyncAttempted?: boolean,
 *   directoryFsyncConfirmed?: boolean,
 *   uncertain?: boolean,
 *   observedJournalPhase?: string | null,
 *   journal?: object
 * }}
 */
export function createJournal(options = {}) {
  const {
    repoRoot,
    txId,
    op,
    targetFile,
    expectedInitialSha256,
    expectedResultSha256,
    extraMetadata = {},
    lease = null,
  } = options;

  if (!repoRoot || !txId || !op || !targetFile || !expectedInitialSha256 || !expectedResultSha256) {
    return {
      ok: false,
      error: 'Missing required options to create journal',
      code: 'missing-arguments',
      stage: 'arguments',
      reason: 'Missing required options to create journal',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }

  // 1. POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP AND LEASE CAPABILITY
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, lease);
  if (!lockAuth.ok) {
    return {
      ok: false,
      error: lockAuth.reason || lockAuth.error,
      code: lockAuth.error,
      reason: lockAuth.reason,
      stage: 'lock-authentication',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }

  // 2. Prevent overriding immutable or forbidden fields
  const metaCheck = validateAuxiliaryMetadata(extraMetadata, true);
  if (!metaCheck.valid) {
    return {
      ok: false,
      error: metaCheck.error,
      code: 'invalid-auxiliary-metadata',
      stage: 'arguments',
      reason: metaCheck.error,
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }

  // 3. Ensure no existing journal is present
  const existingInspection = inspectJournal(repoRoot);
  if (existingInspection.hasJournal) {
    return {
      ok: false,
      error: `Cannot create journal: an existing journal is already present (phase: ${existingInspection.journal?.phase || 'unknown'})`,
      code: 'journal-exists',
      stage: 'pre-publication',
      reason: 'Existing journal present on disk',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: existingInspection.journal?.phase || null,
    };
  }

  const now = new Date().toISOString();
  const journal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    txId: txId.trim(),
    op,
    phase: 'LOCKED',
    targetFile: targetFile.trim(),
    expectedInitialSha256: expectedInitialSha256.trim().toLowerCase(),
    expectedResultSha256: expectedResultSha256.trim().toLowerCase(),
    createdAt: now,
    updatedAt: now,
    ...extraMetadata,
  };

  const val = validateJournalStructure(journal);
  if (!val.valid) {
    return {
      ok: false,
      error: val.errors.join('; '),
      code: 'invalid-journal-structure',
      stage: 'arguments',
      reason: val.errors.join('; '),
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }

  return writeJournalDurable(repoRoot, journal, true, options);
}

/**
 * Advance an existing journal to a new permitted phase under exclusive lock ownership verification.
 * Strictly prevents overriding immutable fields or bypassing phase transitions.
 * Strictly requires the acquisition lease capability.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {string} options.nextPhase
 * @param {object} [options.metadataUpdate]
 * @param {import('./lock.js').TransactionLease} [options.lease]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   code?: string,
 *   stage?: string,
 *   reason?: string,
 *   publicationAttempted?: boolean,
 *   publicationConfirmed?: boolean | null,
 *   directoryFsyncAttempted?: boolean,
 *   directoryFsyncConfirmed?: boolean,
 *   uncertain?: boolean,
 *   observedJournalPhase?: string | null,
 *   journal?: object
 * }}
 */
export function advanceJournalPhase(options = {}) {
  const { repoRoot, txId, nextPhase, metadataUpdate = {}, lease = null } = options;

  if (!repoRoot || !txId || !nextPhase) {
    return {
      ok: false,
      error: 'repoRoot, txId, and nextPhase are required',
      code: 'missing-arguments',
      stage: 'arguments',
      reason: 'repoRoot, txId, and nextPhase are required',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }

  const inspection = inspectJournal(repoRoot);
  if (!inspection.hasJournal) {
    return {
      ok: false,
      error: 'No journal exists to advance',
      code: 'no-journal',
      stage: 'journal-inspection',
      reason: 'No journal exists to advance',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }
  if (!inspection.isValid || !inspection.journal) {
    return {
      ok: false,
      error: `Cannot advance corrupted journal: ${inspection.errors.join('; ')}`,
      code: 'corrupt-journal',
      stage: 'journal-inspection',
      reason: inspection.errors.join('; '),
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: null,
    };
  }

  if (inspection.journal.txId !== txId.trim()) {
    return {
      ok: false,
      error: `Cannot advance journal: owned by transaction "${inspection.journal.txId}", not "${txId}"`,
      code: 'txid-mismatch',
      stage: 'journal-inspection',
      reason: `Owned by transaction "${inspection.journal.txId}", not "${txId}"`,
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: inspection.journal.phase,
    };
  }

  // 1. POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP AND LEASE CAPABILITY
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, inspection.journal.op, lease);
  if (!lockAuth.ok) {
    return {
      ok: false,
      error: lockAuth.reason || lockAuth.error,
      code: lockAuth.error,
      reason: lockAuth.reason,
      stage: 'lock-authentication',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: inspection.journal.phase,
    };
  }

  // 2. Refuse phase advancement for legacy journals containing stagedPath
  if (typeof inspection.journal.stagedPath === 'string') {
    return {
      ok: false,
      error: 'Cannot advance journal: legacy journals containing "stagedPath" are refused for automatic phase advancement',
      code: 'legacy-schema',
      stage: 'pre-rename',
      reason: 'Legacy journals containing stagedPath are refused for automatic phase advancement',
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: inspection.journal.phase,
    };
  }

  // 3. Prevent overriding immutable identity or phase fields via metadataUpdate
  const metaCheck = validateAuxiliaryMetadata(metadataUpdate, false);
  if (!metaCheck.valid) {
    return {
      ok: false,
      error: metaCheck.error,
      code: 'invalid-auxiliary-metadata',
      stage: 'arguments',
      reason: metaCheck.error,
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: inspection.journal.phase,
    };
  }

  // 4. Strict phase transition validation
  const transitionCheck = validatePhaseTransition(inspection.journal.phase, nextPhase);
  if (!transitionCheck.ok) {
    return {
      ok: false,
      error: transitionCheck.error,
      code: 'illegal-phase-transition',
      stage: 'pre-rename',
      reason: transitionCheck.error,
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: inspection.journal.phase,
    };
  }

  // 5. Premature metadata enforcement
  for (const key of Object.keys(metadataUpdate)) {
    if (key in FIELD_INTRODUCTION_PHASE) {
      if (!(key in inspection.journal) && nextPhase !== FIELD_INTRODUCTION_PHASE[key]) {
        return {
          ok: false,
          error: `Premature auxiliary metadata: field "${key}" cannot be introduced before phase "${FIELD_INTRODUCTION_PHASE[key]}" (attempted at "${nextPhase}")`,
          code: 'premature-metadata',
          stage: 'pre-rename',
          reason: `Field "${key}" cannot be introduced before phase "${FIELD_INTRODUCTION_PHASE[key]}"`,
          publicationAttempted: false,
          publicationConfirmed: false,
          directoryFsyncAttempted: false,
          directoryFsyncConfirmed: false,
          uncertain: false,
          observedJournalPhase: inspection.journal.phase,
        };
      }
    }
  }

  // 6. Mandatory metadata enforcement for nextPhase
  const requiredFields = PHASE_REQUIRED_AUXILIARY_FIELDS[nextPhase] || [];
  for (const reqField of requiredFields) {
    const val = (reqField in metadataUpdate) ? metadataUpdate[reqField] : inspection.journal[reqField];
    if (typeof val !== 'string' || val.trim() === '') {
      return {
        ok: false,
        error: `Missing mandatory auxiliary metadata for transition to "${nextPhase}": "${reqField}"`,
        code: 'missing-mandatory-metadata',
        stage: 'pre-rename',
        reason: `Missing mandatory auxiliary metadata "${reqField}"`,
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: inspection.journal.phase,
      };
    }
  }

  // 7. Permanent immutability enforcement
  for (const key of ALLOWED_AUXILIARY_FIELDS) {
    if (key in inspection.journal) {
      if (key in metadataUpdate && metadataUpdate[key] !== inspection.journal[key]) {
        return {
          ok: false,
          error: `Immutable auxiliary field conflict: "${key}" cannot be modified once set (current: "${inspection.journal[key]}", update: "${metadataUpdate[key]}")`,
          code: 'immutable-field-conflict',
          stage: 'pre-rename',
          reason: `Immutable field "${key}" cannot be modified`,
          publicationAttempted: false,
          publicationConfirmed: false,
          directoryFsyncAttempted: false,
          directoryFsyncConfirmed: false,
          uncertain: false,
          observedJournalPhase: inspection.journal.phase,
        };
      }
    }
  }

  // 8. Strict resource path containment & format validation
  const targetBase = path.basename(inspection.journal.targetFile.trim());
  const targetDir = path.dirname(inspection.journal.targetFile.trim());

  const effectiveIsolatedPath = metadataUpdate.isolatedStagedPath || inspection.journal.isolatedStagedPath;
  if (effectiveIsolatedPath !== undefined) {
    const expectedIsolated = `.ci-patch/staging/${inspection.journal.txId}/${targetBase}`;
    if (effectiveIsolatedPath !== expectedIsolated) {
      return {
        ok: false,
        error: `Invalid isolatedStagedPath "${effectiveIsolatedPath}": must strictly equal "${expectedIsolated}"`,
        code: 'invalid-resource-path',
        stage: 'pre-rename',
        reason: `Must strictly equal "${expectedIsolated}"`,
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: inspection.journal.phase,
      };
    }
  }

  const effectiveBackupPath = metadataUpdate.backupPath || inspection.journal.backupPath;
  if (effectiveBackupPath !== undefined) {
    const expectedBackup = `.ci-patch/backup/${inspection.journal.txId}/${targetBase}`;
    if (effectiveBackupPath !== expectedBackup) {
      return {
        ok: false,
        error: `Invalid backupPath "${effectiveBackupPath}": must strictly equal "${expectedBackup}"`,
        code: 'invalid-resource-path',
        stage: 'pre-rename',
        reason: `Must strictly equal "${expectedBackup}"`,
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: inspection.journal.phase,
      };
    }
  }

  const effectiveDestPath = metadataUpdate.destinationStagedPath || inspection.journal.destinationStagedPath;
  if (effectiveDestPath !== undefined) {
    const expectedDest = `${targetDir}/.${targetBase}.ci-staged-${inspection.journal.txId}.tmp`;
    if (effectiveDestPath !== expectedDest) {
      return {
        ok: false,
        error: `Invalid destinationStagedPath "${effectiveDestPath}": must strictly equal "${expectedDest}"`,
        code: 'invalid-resource-path',
        stage: 'pre-rename',
        reason: `Must strictly equal "${expectedDest}"`,
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: inspection.journal.phase,
      };
    }
  }

  const effectiveTargetMode = metadataUpdate.targetMode || inspection.journal.targetMode;
  if (effectiveTargetMode !== undefined) {
    if (!TARGET_MODE_REGEX.test(effectiveTargetMode)) {
      return {
        ok: false,
        error: `Invalid targetMode "${effectiveTargetMode}": must be 4-character octal string matching /^0[0-7]{3}$/`,
        code: 'invalid-target-mode',
        stage: 'pre-rename',
        reason: 'Invalid targetMode regex',
        publicationAttempted: false,
        publicationConfirmed: false,
        directoryFsyncAttempted: false,
        directoryFsyncConfirmed: false,
        uncertain: false,
        observedJournalPhase: inspection.journal.phase,
      };
    }
  }

  // 9. Construct updated journal with immutable fields protected
  const updatedJournal = {
    ...inspection.journal,
    ...metadataUpdate,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    txId: inspection.journal.txId,
    op: inspection.journal.op,
    phase: nextPhase, // Authorized next phase unconditionally set
    targetFile: inspection.journal.targetFile,
    expectedInitialSha256: inspection.journal.expectedInitialSha256,
    expectedResultSha256: inspection.journal.expectedResultSha256,
    createdAt: inspection.journal.createdAt,
    updatedAt: new Date().toISOString(),
  };

  const val = validateJournalStructure(updatedJournal);
  if (!val.valid) {
    return {
      ok: false,
      error: `Invalid updated journal: ${val.errors.join('; ')}`,
      code: 'invalid-journal-structure',
      stage: 'pre-rename',
      reason: val.errors.join('; '),
      publicationAttempted: false,
      publicationConfirmed: false,
      directoryFsyncAttempted: false,
      directoryFsyncConfirmed: false,
      uncertain: false,
      observedJournalPhase: inspection.journal.phase,
    };
  }

  return writeJournalDurable(repoRoot, updatedJournal, false, options);
}

/**
 * Remove an existing completed journal under exclusive lock ownership and lease verification.
 * Strictly requires the acquisition lease capability.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {boolean} [options.allowIncomplete=false]
 * @param {import('./lock.js').TransactionLease} [options.lease]
 * @returns {{ ok: boolean, error?: string }}
 */
export function removeJournal(options = {}) {
  const { repoRoot, txId, allowIncomplete = false, lease = null, callerOwner = null } = options;

  if (!repoRoot || !txId) {
    return { ok: false, error: 'repoRoot and txId are required to remove journal' };
  }

  const inspection = inspectJournal(repoRoot);
  if (!inspection.hasJournal) {
    return { ok: false, error: 'No journal exists to remove' };
  }
  if (!inspection.isValid || !inspection.journal) {
    return {
      ok: false,
      error: `Cannot remove corrupted journal: ${inspection.errors.join('; ')}`,
    };
  }

  if (inspection.journal.txId !== txId.trim()) {
    return {
      ok: false,
      error: `Cannot remove journal: owned by transaction "${inspection.journal.txId}", not "${txId}"`,
    };
  }

  // POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP AND LEASE CAPABILITY
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, inspection.journal.op, lease);
  if (!lockAuth.ok) {
    return { ok: false, error: lockAuth.reason || lockAuth.error, code: lockAuth.error, reason: lockAuth.reason };
  }

  if (callerOwner && typeof callerOwner === 'object') {
    if (callerOwner.pid !== undefined && callerOwner.pid !== lockAuth.lockOwner.pid) {
      return {
        ok: false,
        error: `Cannot remove journal: PID mismatch (owned by ${lockAuth.lockOwner.pid}, caller specified ${callerOwner.pid})`,
        code: 'ownership-mismatch',
      };
    }
    if (callerOwner.hostname && callerOwner.hostname !== lockAuth.lockOwner.hostname) {
      return {
        ok: false,
        error: `Cannot remove journal: hostname mismatch (owned by ${lockAuth.lockOwner.hostname}, caller specified ${callerOwner.hostname})`,
        code: 'ownership-mismatch',
      };
    }
  }

  if (inspection.journal.phase !== 'COMPLETED' && !allowIncomplete) {
    return {
      ok: false,
      error: `Refusing to remove incomplete journal in phase "${inspection.journal.phase}" without explicit authorization`,
    };
  }

  const journalPath = getJournalPath(repoRoot);
  const ciPatchDir = getCiPatchDir(repoRoot);

  try {
    fs.unlinkSync(journalPath);

    const dirCheck = getPathLstat(ciPatchDir);
    if (dirCheck.exists && dirCheck.isDirectory && !dirCheck.isSymbolicLink) {
      const dirFd = fs.openSync(ciPatchDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to remove journal: ${err.message}` };
  }
}

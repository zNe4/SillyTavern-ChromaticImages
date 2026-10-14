import fs from 'node:fs';
import path from 'node:path';
import {
  getCiPatchDir,
  validateCiPatchPath,
  ensureCiPatchDir,
  inspectLock,
  getPathLstat,
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
  'stagedPath',
  'backupPath',
]);

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
 * Verify lock ownership before allowing any journal mutation.
 * Verifies active lock presence, validity, txId, op, and repoRoot.
 *
 * @param {string} repoRoot
 * @param {string} txId
 * @param {'apply' | 'remove'} expectedOp
 * @param {object} [callerOwner]
 * @returns {{ ok: boolean, error?: string, reason?: string, lockOwner?: object }}
 */
export function verifyLockOwnershipForMutation(repoRoot, txId, expectedOp, callerOwner = null) {
  const lockInspection = inspectLock(repoRoot);
  if (!lockInspection.hasLock) {
    return {
      ok: false,
      error: 'no-lock',
      reason: 'Cannot mutate journal without an active exclusive lock',
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
  if (callerOwner) {
    if (callerOwner.pid && lockInspection.owner.pid !== callerOwner.pid) {
      return {
        ok: false,
        error: 'lock-ownership-mismatch',
        reason: `PID mismatch with lock owner (${lockInspection.owner.pid} vs ${callerOwner.pid})`,
      };
    }
    if (callerOwner.hostname && lockInspection.owner.hostname !== callerOwner.hostname) {
      return {
        ok: false,
        error: 'lock-ownership-mismatch',
        reason: `Hostname mismatch with lock owner (${lockInspection.owner.hostname})`,
      };
    }
  }

  return { ok: true, lockOwner: lockInspection.owner };
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

  // Check auxiliary fields
  for (const [k, v] of Object.entries(journal)) {
    if (IMMUTABLE_JOURNAL_FIELDS.includes(k) || k === 'updatedAt') {
      continue;
    }
    if (!ALLOWED_AUXILIARY_FIELDS.includes(k)) {
      errors.push(`Unexpected journal property: "${k}"`);
    } else if (typeof v !== 'string') {
      errors.push(`Auxiliary property "${k}" must be a string`);
    }
  }

  return { valid: errors.length === 0, errors };
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
        journal: parsed,
        journalPath,
        errors: val.errors,
      };
    }

    return {
      hasJournal: true,
      isValid: true,
      isSymlink: false,
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
 * Atomically write and flush journal to disk with distinct pre-rename and post-rename error handling.
 *
 * @param {string} repoRoot
 * @param {object} journal
 * @param {boolean} [isCreation=false]
 * @returns {{ ok: boolean, error?: string, stage?: 'pre-rename' | 'post-rename', journal?: object }}
 */
function writeJournalDurable(repoRoot, journal, isCreation = false) {
  const ciPatchDir = getCiPatchDir(repoRoot);
  const journalPath = getJournalPath(repoRoot);
  const tmpJournalPath = path.join(ciPatchDir, `.journal.${journal.txId}.tmp`);

  // If this is initial creation, ensure destination doesn't exist
  if (isCreation) {
    const jCheck = getPathLstat(journalPath);
    if (jCheck.exists) {
      return {
        ok: false,
        stage: 'pre-rename',
        error: 'Cannot create journal: a journal already exists on disk',
      };
    }
  }

  const serialized = JSON.stringify(journal, null, 2) + '\n';

  // 1. Exclusive temporary file creation and fsync
  try {
    fs.writeFileSync(tmpJournalPath, serialized, {
      flag: 'wx',
      mode: 0o600,
    });

    const tmpFd = fs.openSync(tmpJournalPath, 'r');
    try {
      fs.fsyncSync(tmpFd);
    } finally {
      fs.closeSync(tmpFd);
    }
  } catch (writeErr) {
    // Cleanup temporary file if it was created
    try {
      if (getPathLstat(tmpJournalPath).exists) {
        fs.unlinkSync(tmpJournalPath);
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      stage: 'pre-rename',
      error: `Failed to prepare journal update before rename: ${writeErr.message}`,
    };
  }

  // 2. Pre-rename check for concurrent creation
  if (isCreation) {
    const doubleCheck = getPathLstat(journalPath);
    if (doubleCheck.exists) {
      try { fs.unlinkSync(tmpJournalPath); } catch { /* ignore */ }
      return {
        ok: false,
        stage: 'pre-rename',
        error: 'Cannot create journal: a journal was created concurrently',
      };
    }
  }

  // 3. Atomic rename
  try {
    fs.renameSync(tmpJournalPath, journalPath);
  } catch (renameErr) {
    try {
      if (getPathLstat(tmpJournalPath).exists) {
        fs.unlinkSync(tmpJournalPath);
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      stage: 'pre-rename',
      error: `Failed to replace journal atomically: ${renameErr.message}`,
    };
  }

  // 4. Directory fsync (post-rename stage)
  try {
    const dirFd = fs.openSync(ciPatchDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (syncErr) {
    // The journal rename ALREADY succeeded on disk!
    return {
      ok: false,
      stage: 'post-rename',
      error: `Journal updated on disk but directory synchronization failed: ${syncErr.message}`,
      journal,
    };
  }

  return { ok: true, journal };
}

/**
 * Create a new journal under verified exclusive lock ownership.
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
 * @param {object} [options.callerOwner]
 * @returns {{ ok: boolean, error?: string, journal?: object }}
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
    callerOwner = null,
  } = options;

  if (!repoRoot || !txId || !op || !targetFile || !expectedInitialSha256 || !expectedResultSha256) {
    return { ok: false, error: 'Missing required options to create journal' };
  }

  // 1. POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, callerOwner);
  if (!lockAuth.ok) {
    return { ok: false, error: lockAuth.reason || lockAuth.error };
  }

  // 2. Prevent overriding immutable or forbidden fields
  const metaCheck = validateAuxiliaryMetadata(extraMetadata, true);
  if (!metaCheck.valid) {
    return { ok: false, error: metaCheck.error };
  }

  // 3. Ensure no existing journal is present
  const existingInspection = inspectJournal(repoRoot);
  if (existingInspection.hasJournal) {
    return {
      ok: false,
      error: `Cannot create journal: an existing journal is already present (phase: ${existingInspection.journal?.phase || 'unknown'})`,
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
    return { ok: false, error: val.errors.join('; ') };
  }

  return writeJournalDurable(repoRoot, journal, true);
}

/**
 * Advance an existing journal to a new permitted phase under exclusive lock ownership verification.
 * Strictly prevents overriding immutable fields or bypassing phase transitions.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {string} options.nextPhase
 * @param {object} [options.metadataUpdate]
 * @param {object} [options.callerOwner]
 * @returns {{ ok: boolean, error?: string, stage?: string, journal?: object }}
 */
export function advanceJournalPhase(options = {}) {
  const { repoRoot, txId, nextPhase, metadataUpdate = {}, callerOwner = null } = options;

  if (!repoRoot || !txId || !nextPhase) {
    return { ok: false, error: 'repoRoot, txId, and nextPhase are required' };
  }

  const inspection = inspectJournal(repoRoot);
  if (!inspection.hasJournal) {
    return { ok: false, error: 'No journal exists to advance' };
  }
  if (!inspection.isValid || !inspection.journal) {
    return {
      ok: false,
      error: `Cannot advance corrupted journal: ${inspection.errors.join('; ')}`,
    };
  }

  if (inspection.journal.txId !== txId.trim()) {
    return {
      ok: false,
      error: `Cannot advance journal: owned by transaction "${inspection.journal.txId}", not "${txId}"`,
    };
  }

  // 1. POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, inspection.journal.op, callerOwner);
  if (!lockAuth.ok) {
    return { ok: false, error: lockAuth.reason || lockAuth.error };
  }

  // 2. Prevent overriding immutable identity or phase fields via metadataUpdate
  const metaCheck = validateAuxiliaryMetadata(metadataUpdate, false);
  if (!metaCheck.valid) {
    return { ok: false, error: metaCheck.error };
  }

  // 3. Strict phase transition validation
  const transitionCheck = validatePhaseTransition(inspection.journal.phase, nextPhase);
  if (!transitionCheck.ok) {
    return { ok: false, error: transitionCheck.error };
  }

  // 4. Construct updated journal with immutable fields protected
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
    return { ok: false, error: `Invalid updated journal: ${val.errors.join('; ')}` };
  }

  return writeJournalDurable(repoRoot, updatedJournal, false);
}

/**
 * Remove an existing completed journal under exclusive lock ownership verification.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {boolean} [options.allowIncomplete=false]
 * @param {object} [options.callerOwner]
 * @returns {{ ok: boolean, error?: string }}
 */
export function removeJournal(options = {}) {
  const { repoRoot, txId, allowIncomplete = false, callerOwner = null } = options;

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

  // POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, inspection.journal.op, callerOwner);
  if (!lockAuth.ok) {
    return { ok: false, error: lockAuth.reason || lockAuth.error };
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

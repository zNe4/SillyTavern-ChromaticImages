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
 * Atomically write and flush journal to disk with distinct pre-publication and post-publication error handling.
 * Employs atomic no-replace publication via same-directory hard link (link(2)) for initial creation.
 * Employs atomic replacement via rename(2) for later phase updates.
 * Never unlinks a pre-existing temporary journal upon collision (EEXIST).
 * Positively verifies created file ownership and identity before permitted cleanup.
 *
 * @param {string} repoRoot
 * @param {object} journal
 * @param {boolean} [isCreation=false]
 * @returns {{ ok: boolean, error?: string, stage?: 'pre-publication' | 'post-publication' | 'pre-rename' | 'post-rename', journal?: object }}
 */
function writeJournalDurable(repoRoot, journal, isCreation = false) {
  const ciPatchDir = getCiPatchDir(repoRoot);
  const journalPath = getJournalPath(repoRoot);
  const tmpJournalPath = path.join(ciPatchDir, `.journal.${journal.txId}.tmp`);

  // If this is initial creation, ensure destination doesn't exist before starting
  if (isCreation) {
    const jCheck = getPathLstat(journalPath);
    if (jCheck.exists) {
      return {
        ok: false,
        stage: 'pre-publication',
        error: 'Cannot create journal: a journal already exists on disk',
      };
    }
  }

  const serialized = JSON.stringify(journal, null, 2) + '\n';

  // 1. Exclusive temporary file creation and fsync
  let tmpFd = null;
  let createdDev = null;
  let createdIno = null;
  let fileCreatedByUs = false;

  try {
    tmpFd = fs.openSync(
      tmpJournalPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    fileCreatedByUs = true;
    const stat = fs.fstatSync(tmpFd);
    if (!isValidDeviceIdentifier(stat?.dev) || !isValidInodeIdentifier(stat?.ino)) {
      throw new Error(`Failed to establish usable file identity: dev=${stat?.dev}, ino=${stat?.ino}`);
    }
    createdDev = stat.dev;
    createdIno = stat.ino;

    fs.writeSync(tmpFd, serialized, 0, 'utf8');
    fs.fsyncSync(tmpFd);
  } catch (writeErr) {
    if (tmpFd !== null) {
      try {
        fs.closeSync(tmpFd);
      } catch {
        // ignore
      }
      tmpFd = null;
    }

    if (writeErr.code === 'EEXIST') {
      // PRESERVE PRE-EXISTING ARTIFACT: do NOT unlink!
      return {
        ok: false,
        stage: isCreation ? 'pre-publication' : 'pre-rename',
        error: `Cannot prepare temporary journal: pre-existing temporary artifact "${path.basename(tmpJournalPath)}" already exists (collision)`,
      };
    }

    if (fileCreatedByUs) {
      // Safely unlink ONLY if we created it and its identity matches
      safeUnlinkCreatedFile(tmpJournalPath, createdDev, createdIno);
    }

    return {
      ok: false,
      stage: isCreation ? 'pre-publication' : 'pre-rename',
      error: `Failed to prepare journal update before ${isCreation ? 'publication' : 'rename'}: ${writeErr.message}`,
    };
  }

  if (tmpFd !== null) {
    try {
      fs.closeSync(tmpFd);
    } catch {
      // ignore
    }
    tmpFd = null;
  }

  if (isCreation) {
    // ATOMIC NO-REPLACE PUBLICATION VIA HARD LINK (link(2))
    // link(2) is guaranteed by POSIX / Linux to fail with EEXIST if destination already exists.
    try {
      fs.linkSync(tmpJournalPath, journalPath);
    } catch (linkErr) {
      safeUnlinkCreatedFile(tmpJournalPath, createdDev, createdIno);

      if (linkErr.code === 'EEXIST') {
        return {
          ok: false,
          stage: 'pre-publication',
          error: 'Cannot create journal: destination journal.json already exists (atomic publication collision)',
        };
      }

      if (linkErr.code === 'EXDEV' || linkErr.code === 'ENOTSUP' || linkErr.code === 'EPERM') {
        return {
          ok: false,
          stage: 'pre-publication',
          error: `Atomic no-replace journal publication unsupported on this filesystem (${linkErr.code}): ${linkErr.message}`,
        };
      }

      return {
        ok: false,
        stage: 'pre-publication',
        error: `Failed to publish journal atomically: ${linkErr.message}`,
      };
    }

    // --- AT THIS POINT, journalPath IS PUBLISHED AND VISIBLE ON DISK ---

    // 1. Directory sync to flush new directory entry
    try {
      const dirFd = fs.openSync(ciPatchDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (syncErr) {
      return {
        ok: false,
        stage: 'post-publication',
        error: `Journal published on disk but initial directory synchronization failed: ${syncErr.message}`,
        journal,
      };
    }

    // 2. Remove the temporary link name with verified identity
    try {
      const unlinked = safeUnlinkCreatedFile(tmpJournalPath, createdDev, createdIno);
      if (!unlinked && getPathLstat(tmpJournalPath).exists) {
        throw new Error('Temporary link ownership or identity could not be verified for removal');
      }
    } catch (unlinkErr) {
      return {
        ok: false,
        stage: 'post-publication',
        error: `Journal published on disk but removing temporary link failed: ${unlinkErr.message}`,
        journal,
      };
    }

    // 3. Directory sync to flush temporary entry removal
    try {
      const dirFd = fs.openSync(ciPatchDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (syncErr) {
      return {
        ok: false,
        stage: 'post-publication',
        error: `Journal published on disk but post-cleanup directory synchronization failed: ${syncErr.message}`,
        journal,
      };
    }

    return { ok: true, journal };
  } else {
    // PHASE UPDATE: ATOMIC REPLACEMENT VIA rename(2)
    try {
      fs.renameSync(tmpJournalPath, journalPath);
    } catch (renameErr) {
      safeUnlinkCreatedFile(tmpJournalPath, createdDev, createdIno);
      return {
        ok: false,
        stage: 'pre-rename',
        error: `Failed to replace journal atomically: ${renameErr.message}`,
      };
    }

    // Directory sync post-rename
    try {
      const dirFd = fs.openSync(ciPatchDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (syncErr) {
      return {
        ok: false,
        stage: 'post-rename',
        error: `Journal updated on disk but directory synchronization failed: ${syncErr.message}`,
        journal,
      };
    }

    return { ok: true, journal };
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
 * @returns {{ ok: boolean, error?: string, stage?: string, journal?: object }}
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
    return { ok: false, error: 'Missing required options to create journal' };
  }

  // 1. POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP AND LEASE CAPABILITY
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, lease);
  if (!lockAuth.ok) {
    return { ok: false, error: lockAuth.reason || lockAuth.error, code: lockAuth.error, reason: lockAuth.reason };
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
 * Strictly requires the acquisition lease capability.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {string} options.nextPhase
 * @param {object} [options.metadataUpdate]
 * @param {import('./lock.js').TransactionLease} [options.lease]
 * @returns {{ ok: boolean, error?: string, stage?: string, journal?: object }}
 */
export function advanceJournalPhase(options = {}) {
  const { repoRoot, txId, nextPhase, metadataUpdate = {}, lease = null } = options;

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

  // 1. POSITIVE VERIFICATION OF EXCLUSIVE LOCK OWNERSHIP AND LEASE CAPABILITY
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, inspection.journal.op, lease);
  if (!lockAuth.ok) {
    return { ok: false, error: lockAuth.reason || lockAuth.error, code: lockAuth.error, reason: lockAuth.reason };
  }

  // 2. Refuse phase advancement for legacy journals containing stagedPath
  if (typeof inspection.journal.stagedPath === 'string') {
    return {
      ok: false,
      error: 'Cannot advance journal: legacy journals containing "stagedPath" are refused for automatic phase advancement',
      code: 'legacy-schema',
    };
  }

  // 3. Prevent overriding immutable identity or phase fields via metadataUpdate
  const metaCheck = validateAuxiliaryMetadata(metadataUpdate, false);
  if (!metaCheck.valid) {
    return { ok: false, error: metaCheck.error };
  }

  // 4. Strict phase transition validation
  const transitionCheck = validatePhaseTransition(inspection.journal.phase, nextPhase);
  if (!transitionCheck.ok) {
    return { ok: false, error: transitionCheck.error };
  }

  // 5. Premature metadata enforcement
  for (const key of Object.keys(metadataUpdate)) {
    if (key in FIELD_INTRODUCTION_PHASE) {
      if (!(key in inspection.journal) && nextPhase !== FIELD_INTRODUCTION_PHASE[key]) {
        return {
          ok: false,
          error: `Premature auxiliary metadata: field "${key}" cannot be introduced before phase "${FIELD_INTRODUCTION_PHASE[key]}" (attempted at "${nextPhase}")`,
          code: 'premature-metadata',
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
    return { ok: false, error: `Invalid updated journal: ${val.errors.join('; ')}` };
  }

  return writeJournalDurable(repoRoot, updatedJournal, false);
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

import fs from 'node:fs';
import path from 'node:path';
import {
  getCiPatchDir,
  validateCiPatchPath,
  ensureCiPatchDir,
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

  try {
    if (!fs.existsSync(journalPath)) {
      return { hasJournal: false, isValid: true, isSymlink: false, journal: null, journalPath, errors: [] };
    }

    const jStat = fs.lstatSync(journalPath);
    if (jStat.isSymbolicLink()) {
      return {
        hasJournal: true,
        isValid: false,
        isSymlink: true,
        journal: null,
        journalPath,
        errors: ['Journal file is a symbolic link'],
      };
    }
    if (!jStat.isFile()) {
      return {
        hasJournal: true,
        isValid: false,
        isSymlink: false,
        journal: null,
        journalPath,
        errors: ['Journal path exists but is not a regular file'],
      };
    }

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
      hasJournal: false,
      isValid: false,
      isSymlink: false,
      journal: null,
      journalPath,
      errors: [`Filesystem error inspecting journal: ${err.message}`],
    };
  }
}

/**
 * Atomically write and flush journal to disk.
 * Writes to a temporary file, fsyncs data, atomically renames over journal.json,
 * and fsyncs the parent directory descriptor.
 *
 * @param {string} repoRoot
 * @param {object} journal
 * @returns {{ ok: boolean, error?: string, journal?: object }}
 */
function writeJournalDurable(repoRoot, journal) {
  const ciPatchDir = getCiPatchDir(repoRoot);
  const journalPath = getJournalPath(repoRoot);
  const tmpJournalPath = path.join(ciPatchDir, `.journal.${journal.txId}.tmp`);

  const serialized = JSON.stringify(journal, null, 2) + '\n';

  try {
    // 1. Exclusive temporary file creation
    fs.writeFileSync(tmpJournalPath, serialized, {
      flag: 'wx',
      mode: 0o600,
    });

    // 2. Fsync file descriptor
    const tmpFd = fs.openSync(tmpJournalPath, 'r');
    try {
      fs.fsyncSync(tmpFd);
    } finally {
      fs.closeSync(tmpFd);
    }

    // 3. Atomic rename replacement
    fs.renameSync(tmpJournalPath, journalPath);

    // 4. Fsync parent directory descriptor
    const dirFd = fs.openSync(ciPatchDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }

    return { ok: true, journal };
  } catch (err) {
    // Attempt cleanup of temp journal file if it exists
    try {
      if (fs.existsSync(tmpJournalPath)) {
        fs.unlinkSync(tmpJournalPath);
      }
    } catch {
      // ignore
    }

    return {
      ok: false,
      error: `Failed to write journal durably: ${err.message}`,
    };
  }
}

/**
 * Create a new journal under verified transaction ownership.
 * Begins in phase 'LOCKED'.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {'apply' | 'remove'} options.op
 * @param {string} options.targetFile
 * @param {string} options.expectedInitialSha256
 * @param {string} options.expectedResultSha256
 * @param {object} [options.extraMetadata]
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
  } = options;

  if (!repoRoot || !txId || !op || !targetFile || !expectedInitialSha256 || !expectedResultSha256) {
    return { ok: false, error: 'Missing required options to create journal' };
  }

  const patchDirRes = ensureCiPatchDir(repoRoot);
  if (!patchDirRes.ok) {
    return { ok: false, error: patchDirRes.error };
  }

  // Refuse if a journal already exists
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

  return writeJournalDurable(repoRoot, journal);
}

/**
 * Advance an existing journal to a new permitted phase under ownership verification.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {string} options.nextPhase
 * @param {object} [options.metadataUpdate]
 * @returns {{ ok: boolean, error?: string, journal?: object }}
 */
export function advanceJournalPhase(options = {}) {
  const { repoRoot, txId, nextPhase, metadataUpdate = {} } = options;

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

  const transitionCheck = validatePhaseTransition(inspection.journal.phase, nextPhase);
  if (!transitionCheck.ok) {
    return { ok: false, error: transitionCheck.error };
  }

  const updatedJournal = {
    ...inspection.journal,
    phase: nextPhase,
    updatedAt: new Date().toISOString(),
    ...metadataUpdate,
  };

  const val = validateJournalStructure(updatedJournal);
  if (!val.valid) {
    return { ok: false, error: `Invalid updated journal: ${val.errors.join('; ')}` };
  }

  return writeJournalDurable(repoRoot, updatedJournal);
}

/**
 * Remove an existing completed journal under ownership verification.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {boolean} [options.allowIncomplete=false] - Explicit flag for authorized recovery only
 * @returns {{ ok: boolean, error?: string }}
 */
export function removeJournal(options = {}) {
  const { repoRoot, txId, allowIncomplete = false } = options;

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

    const dirFd = fs.openSync(ciPatchDir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to remove journal: ${err.message}` };
  }
}

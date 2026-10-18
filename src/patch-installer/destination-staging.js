import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  getCiPatchDir,
  getPathLstat,
  isPathContained,
} from './lock.js';

import {
  inspectJournal,
  advanceJournalPhase,
  verifyLockOwnershipForMutation,
  isValidDeviceIdentifier,
  isValidInodeIdentifier,
  TARGET_MODE_REGEX,
} from './journal.js';

import {
  computeSha256,
  computeGitBlobSha,
} from './staging.js';

import {
  extractCanonicalTargetMode,
} from './backup.js';

import {
  verifyPatchManifest,
  isSafeRelativePath,
} from '../../scripts/verify-sillytavern-patches.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

export const MAX_DESTINATION_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB
const TX_ID_REGEX = /^ci-tx-[0-9]+-[0-9a-f]+$/i;

/**
 * Synchronize a file or directory descriptor to durable storage.
 *
 * @param {string|number} target - Path string or open file descriptor number
 * @param {string} stage - Identifier for error reporting and fault injection
 * @param {boolean} [isDirectory=false]
 * @param {(stage: string, context?: object) => void} [runFault]
 * @param {object} [constants=fs.constants]
 * @returns {{ ok: boolean, error?: string, code?: string, stage?: string }}
 */
function syncDescriptorDurable(target, stage, isDirectory = false, runFault = null, constants = fs.constants) {
  if (typeof runFault === 'function') {
    runFault(`sync-${stage}`, { target, isDirectory });
  }

  if (typeof target === 'number') {
    try {
      fs.fsyncSync(target);
      return { ok: true };
    } catch (err) {
      if (err?._isFault) throw err;
      return {
        ok: false,
        error: `Descriptor synchronization failed during "${stage}": ${err.message}`,
        code: err.code || 'fsync-failed',
        stage: `sync-${stage}`,
      };
    }
  }

  if (!isDirectory && !constants.O_NOFOLLOW) {
    return {
      ok: false,
      error: 'Unsupported platform: O_NOFOLLOW file open flag is required for safe descriptor access',
      code: 'unsupported-platform',
      stage: `sync-${stage}`,
    };
  }

  let fd = null;
  const openFlags = isDirectory
    ? (constants.O_RDONLY | (constants.O_DIRECTORY || 0))
    : (constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    fd = fs.openSync(target, openFlags);
    fs.fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Filesystem synchronization failed during "${stage}" for "${target}": ${err.message}`,
      code: err.code || 'fsync-failed',
      stage: `sync-${stage}`,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

/**
 * Safely read and verify a bounded file through an open O_NOFOLLOW descriptor.
 * Strictly verifies size bounds prior to buffer allocation, detects unexpected EOF,
 * verifies concurrent expansion, and verifies pre/post descriptor identity.
 *
 * @param {string} absPath
 * @param {object} [options]
 * @param {number} [options.maxBytes=MAX_DESTINATION_FILE_BYTES]
 * @param {object} [options._testConstants]
 * @returns {{
 *   buffer: Buffer,
 *   stat: fs.Stats,
 *   sha256: string,
 *   gitBlobSha: string
 * }}
 */
export function readBoundedFile(absPath, options = {}) {
  const constants = options?._testConstants || fs.constants;
  const maxBytes = options?.maxBytes || MAX_DESTINATION_FILE_BYTES;

  if (!constants.O_NOFOLLOW) {
    const err = new Error('Unsupported platform: O_NOFOLLOW file open flag is required for safe descriptor access');
    err.code = 'unsupported-platform';
    throw err;
  }

  const check = getPathLstat(absPath);
  if (check.error) {
    const err = new Error(`Failed to inspect file "${absPath}": ${check.error.message}`);
    err.code = 'inspection-error';
    throw err;
  }
  if (!check.exists || !check.isFile || check.isSymbolicLink) {
    const err = new Error(`File "${absPath}" does not exist, is not a regular file, or is a symbolic link`);
    err.code = check.isSymbolicLink ? 'unsafe-symlink' : 'file-missing';
    throw err;
  }

  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const fd = fs.openSync(absPath, openFlags);
  try {
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      const err = new Error(`File descriptor for "${absPath}" is not a regular file`);
      err.code = 'invalid-file-descriptor';
      throw err;
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      const err = new Error(`File descriptor for "${absPath}" has invalid device or inode identity`);
      err.code = 'invalid-file-identity';
      throw err;
    }
    if (preStat.size > maxBytes) {
      const err = new Error(`File "${absPath}" size (${preStat.size} bytes) exceeds limit (${maxBytes} bytes)`);
      err.code = 'file-too-large';
      throw err;
    }
    if (preStat.size === 0) {
      const err = new Error(`File "${absPath}" is unexpectedly empty (0 bytes)`);
      err.code = 'unexpected-eof';
      throw err;
    }

    if (check.stat && (check.stat.dev !== preStat.dev || check.stat.ino !== preStat.ino)) {
      const err = new Error(`Pathname inode does not match opened descriptor for "${absPath}"`);
      err.code = 'descriptor-identity-mismatch';
      throw err;
    }

    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let totalRead = 0;

    while (totalRead < expectedSize) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, expectedSize - totalRead, totalRead);
      if (bytesRead === 0) {
        const err = new Error(`Unexpected EOF reading "${absPath}": read ${totalRead} of ${expectedSize} bytes`);
        err.code = 'unexpected-eof';
        throw err;
      }
      totalRead += bytesRead;
    }

    // Check for concurrent expansion
    const extraBuf = Buffer.alloc(1);
    const extraRead = fs.readSync(fd, extraBuf, 0, 1, expectedSize);
    if (extraRead > 0) {
      const err = new Error(`File "${absPath}" expanded concurrently during reading`);
      err.code = 'concurrent-expansion';
      throw err;
    }

    const postStat = fs.fstatSync(fd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== preStat.size
    ) {
      const err = new Error(`File "${absPath}" modified concurrently during reading`);
      err.code = 'concurrent-modification';
      throw err;
    }

    return {
      buffer,
      stat: postStat,
      sha256: computeSha256(buffer).toLowerCase(),
      gitBlobSha: computeGitBlobSha(buffer).toLowerCase(),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reauthenticate the isolated prepared staging output.
 *
 * @param {string} repoRoot
 * @param {string} txId
 * @param {object} journal
 * @param {string} expectedResultSha
 * @param {string} expectedResultBlob
 * @param {number|null} [expectedDev=null]
 * @param {number|null} [expectedIno=null]
 * @returns {{ ok: boolean, error?: string, code?: string, stagedDev?: number, stagedIno?: number, buffer?: Buffer }}
 */
function reauthenticateIsolatedStaging(
  repoRoot,
  txId,
  journal,
  expectedResultSha,
  expectedResultBlob,
  expectedDev = null,
  expectedIno = null
) {
  const targetBase = path.basename(journal.targetFile);
  const expectedRelStaged = `.ci-patch/staging/${txId}/${targetBase}`;

  if (journal.isolatedStagedPath !== expectedRelStaged) {
    return {
      ok: false,
      error: `Journal isolatedStagedPath "${journal.isolatedStagedPath}" does not match canonical expected path "${expectedRelStaged}"`,
      code: 'invalid-resource-path',
    };
  }

  const absStaged = path.resolve(repoRoot, journal.isolatedStagedPath);
  if (!isPathContained(repoRoot, absStaged)) {
    return {
      ok: false,
      error: `Isolated staged path "${absStaged}" escapes repository root`,
      code: 'staging-path-escape',
    };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  const stagingBaseDir = path.join(ciPatchDir, 'staging');
  const stagingTxDir = path.join(stagingBaseDir, txId);

  const pathComponents = [
    { name: '.ci-patch', p: ciPatchDir },
    { name: 'staging parent (.ci-patch/staging)', p: stagingBaseDir },
    { name: `staging transaction directory (staging/${txId})`, p: stagingTxDir },
  ];

  for (const { name, p } of pathComponents) {
    const stat = getPathLstat(p);
    if (stat.error) {
      return { ok: false, error: `Failed to inspect ${name}: ${stat.error.message}`, code: 'inspection-error' };
    }
    if (!stat.exists) {
      return { ok: false, error: `Staging component ${name} does not exist`, code: 'staged-resource-missing' };
    }
    if (stat.isSymbolicLink) {
      return { ok: false, error: `Staging component ${name} is a symbolic link`, code: 'unsafe-symlink' };
    }
    if (!stat.isDirectory) {
      return { ok: false, error: `Staging component ${name} is not a directory`, code: 'invalid-staging-dir' };
    }
  }

  let stagingChildren;
  try {
    stagingChildren = fs.readdirSync(stagingTxDir);
  } catch (err) {
    return { ok: false, error: `Failed to read staging directory contents: ${err.message}`, code: 'inspection-error' };
  }

  if (stagingChildren.length !== 1 || stagingChildren[0] !== targetBase) {
    return {
      ok: false,
      error: `Staging directory contains unexpected artifacts: ${stagingChildren.join(', ')}`,
      code: 'unexpected-staging-artifacts',
    };
  }

  let readRes;
  try {
    readRes = readBoundedFile(absStaged);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read isolated staging file: ${err.message}`,
      code: err.code || 'staging-read-failed',
    };
  }

  if ((readRes.stat.mode & 0o777) !== 0o600) {
    return {
      ok: false,
      error: `Staged file mode mismatch: expected 0o600, observed 0o${(readRes.stat.mode & 0o777).toString(8)}`,
      code: 'staged-mode-mismatch',
    };
  }

  if (expectedDev !== null && expectedIno !== null) {
    if (readRes.stat.dev !== expectedDev || readRes.stat.ino !== expectedIno) {
      return {
        ok: false,
        error: `Staged file descriptor identity changed (dev: ${readRes.stat.dev} vs ${expectedDev}, ino: ${readRes.stat.ino} vs ${expectedIno})`,
        code: 'staged-identity-replaced',
      };
    }
  }

  if (readRes.sha256 !== expectedResultSha) {
    return {
      ok: false,
      error: `Staged file SHA-256 mismatch: got "${readRes.sha256}", expected "${expectedResultSha}"`,
      code: 'staged-sha256-mismatch',
    };
  }

  if (readRes.gitBlobSha !== expectedResultBlob) {
    return {
      ok: false,
      error: `Staged file Git blob SHA mismatch: got "${readRes.gitBlobSha}", expected "${expectedResultBlob}"`,
      code: 'staged-blob-mismatch',
    };
  }

  return {
    ok: true,
    stagedDev: readRes.stat.dev,
    stagedIno: readRes.stat.ino,
    buffer: readRes.buffer,
  };
}

/**
 * Reauthenticate the backup file.
 *
 * @param {string} repoRoot
 * @param {string} txId
 * @param {object} journal
 * @param {string} expectedInitialSha
 * @param {string} expectedInitialBlob
 * @param {number|null} [expectedDev=null]
 * @param {number|null} [expectedIno=null]
 * @returns {{ ok: boolean, error?: string, code?: string, backupDev?: number, backupIno?: number }}
 */
function reauthenticateBackup(
  repoRoot,
  txId,
  journal,
  expectedInitialSha,
  expectedInitialBlob,
  expectedDev = null,
  expectedIno = null
) {
  const targetBase = path.basename(journal.targetFile);
  const expectedRelBackup = `.ci-patch/backup/${txId}/${targetBase}`;

  if (journal.backupPath !== expectedRelBackup) {
    return {
      ok: false,
      error: `Journal backupPath "${journal.backupPath}" does not match canonical expected path "${expectedRelBackup}"`,
      code: 'invalid-resource-path',
    };
  }

  const absBackup = path.resolve(repoRoot, journal.backupPath);
  if (!isPathContained(repoRoot, absBackup)) {
    return {
      ok: false,
      error: `Backup path "${absBackup}" escapes repository root`,
      code: 'backup-path-escape',
    };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  const backupBaseDir = path.join(ciPatchDir, 'backup');
  const backupTxDir = path.join(backupBaseDir, txId);

  const pathComponents = [
    { name: '.ci-patch', p: ciPatchDir },
    { name: 'backup parent (.ci-patch/backup)', p: backupBaseDir },
    { name: `backup transaction directory (backup/${txId})`, p: backupTxDir },
  ];

  for (const { name, p } of pathComponents) {
    const stat = getPathLstat(p);
    if (stat.error) {
      return { ok: false, error: `Failed to inspect ${name}: ${stat.error.message}`, code: 'inspection-error' };
    }
    if (!stat.exists) {
      return { ok: false, error: `Backup component ${name} does not exist`, code: 'backup-resource-missing' };
    }
    if (stat.isSymbolicLink) {
      return { ok: false, error: `Backup component ${name} is a symbolic link`, code: 'unsafe-symlink' };
    }
    if (!stat.isDirectory) {
      return { ok: false, error: `Backup component ${name} is not a directory`, code: 'invalid-backup-dir' };
    }
  }

  let backupChildren;
  try {
    backupChildren = fs.readdirSync(backupTxDir);
  } catch (err) {
    return { ok: false, error: `Failed to read backup directory contents: ${err.message}`, code: 'inspection-error' };
  }

  if (backupChildren.length !== 1 || backupChildren[0] !== targetBase) {
    return {
      ok: false,
      error: `Backup directory contains unexpected artifacts: ${backupChildren.join(', ')}`,
      code: 'unexpected-backup-artifacts',
    };
  }

  let readRes;
  try {
    readRes = readBoundedFile(absBackup);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read backup file: ${err.message}`,
      code: err.code || 'backup-read-failed',
    };
  }

  if ((readRes.stat.mode & 0o777) !== 0o600) {
    return {
      ok: false,
      error: `Backup file mode mismatch: expected 0o600, observed 0o${(readRes.stat.mode & 0o777).toString(8)}`,
      code: 'backup-mode-mismatch',
    };
  }

  if (expectedDev !== null && expectedIno !== null) {
    if (readRes.stat.dev !== expectedDev || readRes.stat.ino !== expectedIno) {
      return {
        ok: false,
        error: `Backup file descriptor identity changed (dev: ${readRes.stat.dev} vs ${expectedDev}, ino: ${readRes.stat.ino} vs ${expectedIno})`,
        code: 'backup-identity-replaced',
      };
    }
  }

  if (readRes.sha256 !== expectedInitialSha) {
    return {
      ok: false,
      error: `Backup file SHA-256 mismatch: got "${readRes.sha256}", expected "${expectedInitialSha}"`,
      code: 'backup-sha256-mismatch',
    };
  }

  if (readRes.gitBlobSha !== expectedInitialBlob) {
    return {
      ok: false,
      error: `Backup file Git blob SHA mismatch: got "${readRes.gitBlobSha}", expected "${expectedInitialBlob}"`,
      code: 'backup-blob-mismatch',
    };
  }

  return {
    ok: true,
    backupDev: readRes.stat.dev,
    backupIno: readRes.stat.ino,
  };
}

/**
 * Reauthenticate the live target file.
 *
 * @param {string} repoRoot
 * @param {object} journal
 * @param {string} expectedInitialSha
 * @param {string} expectedInitialBlob
 * @param {number|null} [expectedDev=null]
 * @param {number|null} [expectedIno=null]
 * @returns {{ ok: boolean, error?: string, code?: string, liveDev?: number, liveIno?: number }}
 */
function reauthenticateLiveTarget(
  repoRoot,
  journal,
  expectedInitialSha,
  expectedInitialBlob,
  expectedDev = null,
  expectedIno = null
) {
  if (!isSafeRelativePath(journal.targetFile)) {
    return {
      ok: false,
      error: `Journal targetFile "${journal.targetFile}" is not a safe relative path`,
      code: 'invalid-target-file',
    };
  }

  const absLiveTarget = path.resolve(repoRoot, journal.targetFile);
  if (!isPathContained(repoRoot, absLiveTarget)) {
    return {
      ok: false,
      error: `Live target file "${absLiveTarget}" escapes repository root`,
      code: 'target-path-escape',
    };
  }

  // Validate intermediate parent directory components
  const targetRelDir = path.dirname(journal.targetFile);
  if (targetRelDir !== '.' && targetRelDir !== '') {
    const segments = targetRelDir.split('/');
    let currentRel = '';
    for (const seg of segments) {
      currentRel = currentRel ? `${currentRel}/${seg}` : seg;
      const absSeg = path.resolve(repoRoot, currentRel);
      const segCheck = getPathLstat(absSeg);
      if (segCheck.error) {
        return {
          ok: false,
          error: `Failed to inspect target parent component "${currentRel}": ${segCheck.error.message}`,
          code: 'inspection-error',
        };
      }
      if (!segCheck.exists) {
        return {
          ok: false,
          error: `Target parent directory "${currentRel}" does not exist`,
          code: 'source-parent-missing',
        };
      }
      if (segCheck.isSymbolicLink) {
        return {
          ok: false,
          error: `Target parent directory "${currentRel}" is a symbolic link`,
          code: 'unsafe-symlink',
        };
      }
      if (!segCheck.isDirectory) {
        return {
          ok: false,
          error: `Target parent path "${currentRel}" is not a directory`,
          code: 'invalid-source-parent',
        };
      }
    }
  }

  let readRes;
  try {
    readRes = readBoundedFile(absLiveTarget);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read live target source: ${err.message}`,
      code: err.code || 'source-read-failed',
    };
  }

  let observedMode;
  try {
    observedMode = extractCanonicalTargetMode(readRes.stat.mode);
  } catch (modeErr) {
    return {
      ok: false,
      error: `Live target mode extraction failed: ${modeErr.message}`,
      code: modeErr.code || 'invalid-target-mode',
    };
  }

  if (observedMode !== journal.targetMode) {
    return {
      ok: false,
      error: `Live target mode mismatch: observed "${observedMode}", expected "${journal.targetMode}"`,
      code: 'target-mode-mismatch',
    };
  }

  if (expectedDev !== null && expectedIno !== null) {
    if (readRes.stat.dev !== expectedDev || readRes.stat.ino !== expectedIno) {
      return {
        ok: false,
        error: `Live target descriptor identity changed (dev: ${readRes.stat.dev} vs ${expectedDev}, ino: ${readRes.stat.ino} vs ${expectedIno})`,
        code: 'source-identity-replaced',
      };
    }
  }

  if (readRes.sha256 !== expectedInitialSha) {
    return {
      ok: false,
      error: `Live target SHA-256 mismatch: got "${readRes.sha256}", expected "${expectedInitialSha}"`,
      code: 'initial-sha256-mismatch',
    };
  }

  if (readRes.gitBlobSha !== expectedInitialBlob) {
    return {
      ok: false,
      error: `Live target Git blob SHA mismatch: got "${readRes.gitBlobSha}", expected "${expectedInitialBlob}"`,
      code: 'initial-blob-mismatch',
    };
  }

  return {
    ok: true,
    liveDev: readRes.stat.dev,
    liveIno: readRes.stat.ino,
  };
}

/**
 * Stage and verify the destination candidate in the live target's parent directory,
 * ensure durability, and advance the journal from BACKUP_CREATED to READY_TO_SWAP.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {'apply' | 'remove'} options.op
 * @param {import('./lock.js').TransactionLease} options.lease
 * @param {object} [options.manifest]
 * @param {(stage: string, context?: object) => void} [options.faultHook]
 * @param {string} [options._testProcDir]
 * @param {object} [options._testConstants]
 * @returns {Promise<{
 *   ok: boolean,
 *   destinationStagedPath?: string,
 *   journal?: object,
 *   sha256?: string,
 *   gitBlobSha?: string,
 *   error?: string,
 *   code?: string,
 *   stage?: string,
 *   uncertain?: boolean
 * }>}
 */
export async function stageDestinationCandidate(options = {}) {
  if (!options || typeof options !== 'object') {
    return {
      ok: false,
      error: 'Missing or invalid options: must be an object',
      code: 'invalid-arguments',
    };
  }
  const {
    repoRoot,
    txId,
    op,
    lease,
    manifest: providedManifest = null,
    faultHook = null,
    _testProcDir,
    _testConstants,
  } = options;

  const constants = _testConstants || fs.constants;

  // 1. Argument validation
  if (!repoRoot || !txId || !op || !lease) {
    return {
      ok: false,
      error: 'Missing required arguments: repoRoot, txId, op, and lease are mandatory',
      code: 'invalid-arguments',
    };
  }

  if (op !== 'apply' && op !== 'remove') {
    return {
      ok: false,
      error: `Invalid operation "${op}": must be "apply" or "remove"`,
      code: 'invalid-operation',
    };
  }

  if (typeof txId !== 'string' || !TX_ID_REGEX.test(txId.trim())) {
    return {
      ok: false,
      error: `Invalid transaction ID format: "${txId}"`,
      code: 'invalid-txid',
    };
  }

  if (!constants.O_NOFOLLOW) {
    return {
      ok: false,
      error: 'Unsupported platform: O_NOFOLLOW file open flag is required for safe descriptor access',
      code: 'unsupported-platform',
    };
  }

  const runFault = (stage, ctx) => {
    if (typeof faultHook === 'function') {
      try {
        faultHook(stage, ctx);
      } catch (err) {
        if (err && typeof err === 'object') {
          err._isFault = true;
        }
        throw err;
      }
    }
  };

  // 2. Authenticate lock ownership & lease capability
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, lease);
  if (!lockAuth.ok) {
    return {
      ok: false,
      error: lockAuth.reason || lockAuth.error,
      code: lockAuth.error,
    };
  }

  // 3. Authenticate journal state
  const journalInspection = inspectJournal(repoRoot);
  if (!journalInspection.hasJournal || !journalInspection.isValid || !journalInspection.journal) {
    return {
      ok: false,
      error: `Cannot stage destination candidate: valid journal required (errors: ${journalInspection.errors.join('; ')})`,
      code: 'invalid-journal',
    };
  }

  const journal = journalInspection.journal;
  if (journal.txId !== txId.trim()) {
    return {
      ok: false,
      error: `Journal txId "${journal.txId}" does not match caller txId "${txId}"`,
      code: 'journal-txid-mismatch',
    };
  }

  if (journal.op !== op) {
    return {
      ok: false,
      error: `Journal op "${journal.op}" does not match caller op "${op}"`,
      code: 'journal-op-mismatch',
    };
  }

  if (journal.phase !== 'BACKUP_CREATED') {
    return {
      ok: false,
      error: `Destination candidate staging requires journal in phase "BACKUP_CREATED", observed "${journal.phase}"`,
      code: 'illegal-phase',
    };
  }

  if (typeof journal.stagedPath === 'string') {
    return {
      ok: false,
      error: 'Cannot advance journal: legacy journals containing "stagedPath" are refused for mutation',
      code: 'legacy-schema',
    };
  }

  if (typeof journal.isolatedStagedPath !== 'string' || journal.isolatedStagedPath.trim() === '') {
    return {
      ok: false,
      error: 'Journal missing mandatory isolatedStagedPath auxiliary metadata in phase "BACKUP_CREATED"',
      code: 'missing-mandatory-metadata',
    };
  }

  if (typeof journal.backupPath !== 'string' || journal.backupPath.trim() === '') {
    return {
      ok: false,
      error: 'Journal missing mandatory backupPath auxiliary metadata in phase "BACKUP_CREATED"',
      code: 'missing-mandatory-metadata',
    };
  }

  if (typeof journal.targetMode !== 'string' || !TARGET_MODE_REGEX.test(journal.targetMode)) {
    return {
      ok: false,
      error: `Journal targetMode "${journal.targetMode}" is missing or invalid in phase "BACKUP_CREATED"`,
      code: 'missing-mandatory-metadata',
    };
  }

  if (journal.destinationStagedPath !== undefined) {
    return {
      ok: false,
      error: 'Disallowed premature metadata: journal already contains destinationStagedPath',
      code: 'premature-metadata',
    };
  }

  runFault('after-preconditions', { journal });

  // 4. Certified Manifest Authentication
  const pkgCheck = await verifyPatchManifest(BUNDLED_MANIFEST_PATH);
  if (!pkgCheck.ok || !pkgCheck.manifest) {
    return {
      ok: false,
      error: `Distribution package manifest verification failed: ${pkgCheck.errors.join('; ')}`,
      code: 'manifest-verification-failed',
    };
  }
  const certifiedManifest = pkgCheck.manifest;
  const patchEntry = certifiedManifest.patches?.runtime;
  if (!patchEntry) {
    return {
      ok: false,
      error: 'Certified manifest missing runtime patch configuration',
      code: 'manifest-invalid',
    };
  }

  if (providedManifest !== null) {
    if (
      providedManifest.releaseCommit !== certifiedManifest.releaseCommit ||
      providedManifest.patches?.runtime?.sha256 !== patchEntry.sha256 ||
      providedManifest.patches?.runtime?.original?.sha256 !== patchEntry.original?.sha256 ||
      providedManifest.patches?.runtime?.expected?.sha256 !== patchEntry.expected?.sha256
    ) {
      return {
        ok: false,
        error: 'Caller-supplied manifest does not match certified distribution package',
        code: 'unauthenticated-manifest-override',
      };
    }
  }

  if (journal.targetFile !== patchEntry.targetFile) {
    return {
      ok: false,
      error: `Journal targetFile "${journal.targetFile}" does not match manifest targetFile "${patchEntry.targetFile}"`,
      code: 'target-file-mismatch',
    };
  }

  const stockSha = (patchEntry.original?.sha256 || '').toLowerCase();
  const stockBlob = (patchEntry.original?.gitBlobSha || '').toLowerCase();
  const patchedSha = (patchEntry.expected?.sha256 || '').toLowerCase();
  const patchedBlob = (patchEntry.expected?.gitBlobSha || '').toLowerCase();

  const expectedInitialSha = op === 'apply' ? stockSha : patchedSha;
  const expectedInitialBlob = op === 'apply' ? stockBlob : patchedBlob;
  const expectedResultSha = op === 'apply' ? patchedSha : stockSha;
  const expectedResultBlob = op === 'apply' ? patchedBlob : stockBlob;

  if (journal.expectedInitialSha256 !== expectedInitialSha || journal.expectedResultSha256 !== expectedResultSha) {
    return {
      ok: false,
      error: `Journal fingerprints do not match authoritative manifest for op "${op}"`,
      code: 'fingerprint-mismatch',
    };
  }

  // 5. Authenticate Existing Resources and Capture Ephemeral Inode Identities
  runFault('before-resource-authentication', { journal });

  // A. Authenticate isolated staging (contains the prepared resulting bytes)
  const stagingAuth = reauthenticateIsolatedStaging(
    repoRoot,
    txId,
    journal,
    expectedResultSha,
    expectedResultBlob
  );
  if (!stagingAuth.ok) {
    return stagingAuth;
  }
  const authenticatedStagedDev = stagingAuth.stagedDev;
  const authenticatedStagedIno = stagingAuth.stagedIno;
  const authenticatedStagedBuffer = stagingAuth.buffer;

  // B. Authenticate backup
  const backupAuth = reauthenticateBackup(
    repoRoot,
    txId,
    journal,
    expectedInitialSha,
    expectedInitialBlob
  );
  if (!backupAuth.ok) {
    return backupAuth;
  }
  const authenticatedBackupDev = backupAuth.backupDev;
  const authenticatedBackupIno = backupAuth.backupIno;

  // C. Authenticate live target
  const liveAuth = reauthenticateLiveTarget(
    repoRoot,
    journal,
    expectedInitialSha,
    expectedInitialBlob
  );
  if (!liveAuth.ok) {
    return liveAuth;
  }
  const authenticatedLiveDev = liveAuth.liveDev;
  const authenticatedLiveIno = liveAuth.liveIno;

  runFault('after-resource-authentication', {
    authenticatedStagedDev,
    authenticatedBackupDev,
    authenticatedLiveDev,
  });

  // 6. Destination Parent Directory Authentication
  const targetRelDir = path.dirname(journal.targetFile);
  const targetBase = path.basename(journal.targetFile);
  const candidateBase = `.${targetBase}.ci-staged-${txId.trim()}.tmp`;
  const relCandidatePath = `${targetRelDir}/${candidateBase}`;
  const absParentDir = path.resolve(repoRoot, targetRelDir);
  const absCandidatePath = path.resolve(repoRoot, relCandidatePath);

  if (!isPathContained(repoRoot, absCandidatePath)) {
    return {
      ok: false,
      error: `Destination candidate path "${absCandidatePath}" escapes repository root`,
      code: 'target-path-escape',
    };
  }

  // Validate intermediate parent components
  const parentSegments = targetRelDir.split('/');
  let currentRel = '';
  for (const seg of parentSegments) {
    currentRel = currentRel ? `${currentRel}/${seg}` : seg;
    const absSeg = path.resolve(repoRoot, currentRel);
    const segCheck = getPathLstat(absSeg);
    if (segCheck.error) {
      return {
        ok: false,
        error: `Failed to inspect parent directory component "${currentRel}": ${segCheck.error.message}`,
        code: 'inspection-error',
      };
    }
    if (!segCheck.exists) {
      return {
        ok: false,
        error: `Destination parent directory component "${currentRel}" does not exist`,
        code: 'parent-dir-missing',
      };
    }
    if (segCheck.isSymbolicLink) {
      return {
        ok: false,
        error: `Destination parent directory component "${currentRel}" is a symbolic link`,
        code: 'unsafe-symlink',
      };
    }
    if (!segCheck.isDirectory) {
      return {
        ok: false,
        error: `Destination parent path component "${currentRel}" is not a directory`,
        code: 'invalid-parent-dir',
      };
    }
  }

  // Check candidate collision before open
  const candidateCheck = getPathLstat(absCandidatePath);
  if (candidateCheck.error && candidateCheck.error.code !== 'ENOENT') {
    return {
      ok: false,
      error: `Failed to inspect destination candidate path: ${candidateCheck.error.message}`,
      code: 'inspection-error',
    };
  }
  if (candidateCheck.exists || candidateCheck.isSymbolicLink) {
    return {
      ok: false,
      error: `Destination candidate already exists: collision refused ("${relCandidatePath}")`,
      code: 'candidate-collision',
    };
  }

  // Open destination parent directory descriptor
  let parentDirFd = null;
  try {
    parentDirFd = fs.openSync(absParentDir, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
  } catch (openDirErr) {
    return {
      ok: false,
      error: `Failed to open destination parent directory: ${openDirErr.message}`,
      code: openDirErr.code || 'parent-open-failed',
    };
  }

  let authenticatedParentDev;
  let authenticatedParentIno;
  try {
    const parentStat = fs.fstatSync(parentDirFd);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      return {
        ok: false,
        error: 'Destination parent descriptor is not a directory',
        code: 'invalid-parent-dir',
      };
    }
    if (!isValidDeviceIdentifier(parentStat.dev) || !isValidInodeIdentifier(parentStat.ino)) {
      return {
        ok: false,
        error: 'Destination parent descriptor has invalid device or inode identity',
        code: 'invalid-file-identity',
      };
    }

    // Same-device validation
    if (parentStat.dev !== authenticatedLiveDev) {
      return {
        ok: false,
        error: `Destination parent directory resides on a different filesystem device (${parentStat.dev}) than live target (${authenticatedLiveDev})`,
        code: 'cross-device-unsupported',
      };
    }

    authenticatedParentDev = parentStat.dev;
    authenticatedParentIno = parentStat.ino;
  } catch (err) {
    try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
    return {
      ok: false,
      error: `Failed to verify parent directory descriptor: ${err.message}`,
      code: err.code || 'parent-stat-failed',
    };
  }

  // 7. Descriptor-Anchored Candidate Allocation
  const procDir = _testProcDir !== undefined ? _testProcDir : '/proc/self/fd';

  // Check procfs availability
  let procAvailable = false;
  try {
    procAvailable = fs.existsSync(procDir);
  } catch {
    procAvailable = false;
  }

  if (!procAvailable) {
    try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
    return {
      ok: false,
      error: `Unsupported platform: procfs descriptor anchoring ("${procDir}") is required for safe destination candidate creation`,
      code: 'unsupported-platform',
      stage: 'procfs-check',
    };
  }

  const procCandidatePath = path.join(procDir, String(parentDirFd), candidateBase);

  // Pre-allocation directory descriptor continuity check
  try {
    const preCheckStat = fs.fstatSync(parentDirFd);
    if (preCheckStat.dev !== authenticatedParentDev || preCheckStat.ino !== authenticatedParentIno) {
      fs.closeSync(parentDirFd);
      return {
        ok: false,
        error: 'Destination parent directory descriptor identity changed before candidate allocation',
        code: 'parent-directory-replaced',
      };
    }

    const preCheckLstat = getPathLstat(absParentDir);
    if (
      !preCheckLstat.exists ||
      preCheckLstat.isSymbolicLink ||
      !preCheckLstat.isDirectory ||
      preCheckLstat.stat.dev !== authenticatedParentDev ||
      preCheckLstat.stat.ino !== authenticatedParentIno
    ) {
      fs.closeSync(parentDirFd);
      return {
        ok: false,
        error: 'Destination parent directory path was substituted before candidate allocation',
        code: 'parent-directory-replaced',
      };
    }
  } catch (preCheckErr) {
    try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
    return {
      ok: false,
      error: `Pre-allocation parent check failed: ${preCheckErr.message}`,
      code: 'parent-directory-replaced',
    };
  }

  runFault('before-candidate-create', { procCandidatePath, absCandidatePath });

  let candidateFd = null;
  let createdCandidateDev = null;
  let createdCandidateIno = null;

  try {
    candidateFd = fs.openSync(
      procCandidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );

    // Immediate post-creation verification BEFORE writing any payload bytes
    const initialStat = fs.fstatSync(candidateFd);
    if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
      throw Object.assign(new Error('Created candidate descriptor is not a regular file'), {
        code: 'invalid-candidate-descriptor',
      });
    }
    if (!isValidDeviceIdentifier(initialStat.dev) || !isValidInodeIdentifier(initialStat.ino)) {
      throw Object.assign(new Error('Failed to establish usable file identity on candidate descriptor'), {
        code: 'invalid-file-identity',
      });
    }
    if (initialStat.dev !== authenticatedParentDev) {
      throw Object.assign(new Error('Candidate was created on unexpected filesystem device'), {
        code: 'cross-device-unsupported',
      });
    }
    if ((initialStat.mode & 0o777) !== 0o600) {
      throw Object.assign(new Error(`Candidate created with unexpected mode: 0o${(initialStat.mode & 0o777).toString(8)}`), {
        code: 'unexpected-initial-mode',
      });
    }
    if (initialStat.size !== 0) {
      throw Object.assign(new Error(`Candidate file is not empty upon creation (size: ${initialStat.size})`), {
        code: 'candidate-not-empty',
      });
    }
    if (initialStat.nlink !== 1) {
      throw Object.assign(new Error(`Candidate descriptor has unexpected link count: ${initialStat.nlink}`), {
        code: 'unexpected-link-count',
      });
    }

    createdCandidateDev = initialStat.dev;
    createdCandidateIno = initialStat.ino;

    // Verify parent directory identity remains consistent immediately after creation
    const postCreateParentStat = fs.fstatSync(parentDirFd);
    if (postCreateParentStat.dev !== authenticatedParentDev || postCreateParentStat.ino !== authenticatedParentIno) {
      throw Object.assign(new Error('Destination parent directory identity changed during candidate allocation'), {
        code: 'parent-directory-replaced',
      });
    }

    const postCreateLstat = getPathLstat(absParentDir);
    if (
      !postCreateLstat.exists ||
      postCreateLstat.isSymbolicLink ||
      !postCreateLstat.isDirectory ||
      postCreateLstat.stat.dev !== authenticatedParentDev ||
      postCreateLstat.stat.ino !== authenticatedParentIno
    ) {
      throw Object.assign(new Error('Destination parent directory path was substituted during candidate allocation'), {
        code: 'parent-directory-replaced',
      });
    }

    runFault('after-candidate-create', { candidateFd, createdCandidateDev, createdCandidateIno });

    // 8. Payload Writing & Data Durability Flush
    let written = 0;
    while (written < authenticatedStagedBuffer.length) {
      const bytesWritten = fs.writeSync(
        candidateFd,
        authenticatedStagedBuffer,
        written,
        authenticatedStagedBuffer.length - written,
        written
      );
      if (bytesWritten === 0) {
        throw Object.assign(new Error('Short write copying prepared staging bytes to candidate file'), {
          code: 'short-write',
        });
      }
      written += bytesWritten;
    }

    // Flush payload data
    const syncDataRes = syncDescriptorDurable(candidateFd, 'candidate-file', false, runFault, constants);
    if (!syncDataRes.ok) {
      return Object.assign(syncDataRes, { uncertain: true });
    }

    // 9. Descriptor Mode Application & Metadata Durability Flush
    const targetModeInt = parseInt(journal.targetMode, 8);
    fs.fchmodSync(candidateFd, targetModeInt);

    const syncModeRes = syncDescriptorDurable(candidateFd, 'candidate-mode', false, runFault, constants);
    if (!syncModeRes.ok) {
      return Object.assign(syncModeRes, { uncertain: true });
    }
  } catch (err) {
    if (candidateFd !== null) {
      try { fs.closeSync(candidateFd); } catch { /* ignore */ }
      candidateFd = null;
    }
    if (parentDirFd !== null) {
      try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
      parentDirFd = null;
    }
    if (err?._isFault) throw err;
    if (err?.code === 'EEXIST') {
      return {
        ok: false,
        error: `Cannot create destination candidate: candidate artifact already exists (collision)`,
        code: 'collision-detected',
        stage: 'candidate-allocation',
      };
    }
    return {
      ok: false,
      error: `Failed during candidate allocation or writing: ${err.message}`,
      code: err.code || 'candidate-write-failed',
      stage: 'candidate-allocation',
      uncertain: true,
    };
  } finally {
    if (candidateFd !== null) {
      try { fs.closeSync(candidateFd); } catch { /* ignore */ }
      candidateFd = null;
    }
  }

  // 10. Bounded Readback & Candidate Verification
  runFault('before-candidate-readback', { absCandidatePath });

  let readRes;
  try {
    readRes = readBoundedFile(absCandidatePath, { _testConstants: constants });
  } catch (err) {
    if (parentDirFd !== null) {
      try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
      parentDirFd = null;
    }
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Candidate readback verification failed: ${err.message}`,
      code: err.code || 'readback-failed',
      stage: 'candidate-readback',
      uncertain: true,
    };
  }

  if (readRes.stat.dev !== createdCandidateDev || readRes.stat.ino !== createdCandidateIno) {
    if (parentDirFd !== null) {
      try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
      parentDirFd = null;
    }
    return {
      ok: false,
      error: 'Candidate descriptor identity changed during readback verification',
      code: 'candidate-identity-replaced',
      stage: 'candidate-readback',
      uncertain: true,
    };
  }

  const targetModeInt = parseInt(journal.targetMode, 8);
  if ((readRes.stat.mode & 0o777) !== targetModeInt) {
    if (parentDirFd !== null) {
      try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
      parentDirFd = null;
    }
    return {
      ok: false,
      error: `Candidate mode mismatch on readback: expected 0o${targetModeInt.toString(8)}, observed 0o${(readRes.stat.mode & 0o777).toString(8)}`,
      code: 'candidate-mode-mismatch',
      stage: 'candidate-readback',
      uncertain: true,
    };
  }

  if (readRes.sha256 !== expectedResultSha) {
    if (parentDirFd !== null) {
      try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
      parentDirFd = null;
    }
    return {
      ok: false,
      error: `Candidate SHA-256 mismatch on readback: got "${readRes.sha256}", expected "${expectedResultSha}"`,
      code: 'candidate-sha256-mismatch',
      stage: 'candidate-readback',
      uncertain: true,
    };
  }

  if (readRes.gitBlobSha !== expectedResultBlob) {
    if (parentDirFd !== null) {
      try { fs.closeSync(parentDirFd); } catch { /* ignore */ }
      parentDirFd = null;
    }
    return {
      ok: false,
      error: `Candidate Git blob SHA mismatch on readback: got "${readRes.gitBlobSha}", expected "${expectedResultBlob}"`,
      code: 'candidate-blob-mismatch',
      stage: 'candidate-readback',
      uncertain: true,
    };
  }

  // 11. Destination Parent Directory Durability Flush
  const parentSyncRes = syncDescriptorDurable(parentDirFd, 'destination-parent', true, runFault, constants);
  try {
    fs.closeSync(parentDirFd);
    parentDirFd = null;
  } catch {
    // ignore
  }
  if (!parentSyncRes.ok) {
    return Object.assign(parentSyncRes, { uncertain: true });
  }

  runFault('after-candidate-durability', { absCandidatePath });

  // 12. Fault Hook Executed BEFORE Final Pre-Publication Integrity Checks
  runFault('before-journal-advancement', { destinationStagedPath: relCandidatePath, relCandidatePath });

  // 13. Uninterrupted Pre-Publication Reauthentication
  // [NO FAULT HOOKS PERMITTED BEYOND THIS POINT]

  // A. Revalidate lock ownership and lease
  const reLockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, lease);
  if (!reLockAuth.ok) {
    return {
      ok: false,
      error: `Pre-publication lock authorization failed: ${reLockAuth.reason || reLockAuth.error}`,
      code: reLockAuth.error,
      stage: 'final-lock-auth',
    };
  }

  // B. Revalidate journal state and transaction consistency
  const currentJournalInspect = inspectJournal(repoRoot);
  if (!currentJournalInspect.isValid || !currentJournalInspect.journal) {
    return {
      ok: false,
      error: 'Journal missing or invalid before journal advancement',
      code: 'invalid-journal',
      stage: 'final-journal-auth',
    };
  }
  const currentJournal = currentJournalInspect.journal;
  if (currentJournal.txId !== txId || currentJournal.op !== op) {
    return {
      ok: false,
      error: `Journal transaction mismatch before advancement: expected txId "${txId}" op "${op}", got txId "${currentJournal.txId}" op "${currentJournal.op}"`,
      code: 'journal-mismatch',
      stage: 'final-journal-auth',
    };
  }
  if (currentJournal.phase !== 'BACKUP_CREATED') {
    return {
      ok: false,
      error: `Journal phase mismatch before advancement: expected "BACKUP_CREATED", got "${currentJournal.phase}"`,
      code: 'invalid-journal-phase',
      stage: 'final-journal-auth',
    };
  }

  // C. Reauthenticate isolated staging
  const finalStagingAuth = reauthenticateIsolatedStaging(
    repoRoot,
    txId,
    journal,
    expectedResultSha,
    expectedResultBlob,
    authenticatedStagedDev,
    authenticatedStagedIno
  );
  if (!finalStagingAuth.ok) {
    return Object.assign(finalStagingAuth, { stage: 'final-staging-reauth' });
  }

  // D. Reauthenticate backup
  const finalBackupAuth = reauthenticateBackup(
    repoRoot,
    txId,
    journal,
    expectedInitialSha,
    expectedInitialBlob,
    authenticatedBackupDev,
    authenticatedBackupIno
  );
  if (!finalBackupAuth.ok) {
    return Object.assign(finalBackupAuth, { stage: 'final-backup-reauth' });
  }

  // E. Reauthenticate live target
  const finalLiveAuth = reauthenticateLiveTarget(
    repoRoot,
    journal,
    expectedInitialSha,
    expectedInitialBlob,
    authenticatedLiveDev,
    authenticatedLiveIno
  );
  if (!finalLiveAuth.ok) {
    return Object.assign(finalLiveAuth, { stage: 'final-source-reauth' });
  }

  // F. Reauthenticate destination candidate file
  let finalCandidateRead;
  try {
    finalCandidateRead = readBoundedFile(absCandidatePath, { _testConstants: constants });
  } catch (err) {
    return {
      ok: false,
      error: `Pre-publication candidate reauthentication failed: ${err.message}`,
      code: err.code || 'candidate-read-failed',
      stage: 'final-candidate-reauth',
    };
  }

  if (
    finalCandidateRead.stat.dev !== createdCandidateDev ||
    finalCandidateRead.stat.ino !== createdCandidateIno
  ) {
    return {
      ok: false,
      error: 'Pre-publication candidate descriptor identity changed',
      code: 'candidate-identity-replaced',
      stage: 'final-candidate-reauth',
    };
  }

  if ((finalCandidateRead.stat.mode & 0o777) !== targetModeInt) {
    return {
      ok: false,
      error: 'Pre-publication candidate mode mismatch',
      code: 'candidate-mode-mismatch',
      stage: 'final-candidate-reauth',
    };
  }

  if (finalCandidateRead.sha256 !== expectedResultSha || finalCandidateRead.gitBlobSha !== expectedResultBlob) {
    return {
      ok: false,
      error: 'Pre-publication candidate fingerprint mismatch',
      code: 'candidate-sha256-mismatch',
      stage: 'final-candidate-reauth',
    };
  }

  // G. Reauthenticate candidate pathname
  const finalCandidatePathLstat = getPathLstat(absCandidatePath);
  if (
    !finalCandidatePathLstat.exists ||
    finalCandidatePathLstat.isSymbolicLink ||
    !finalCandidatePathLstat.isFile ||
    finalCandidatePathLstat.stat.dev !== createdCandidateDev ||
    finalCandidatePathLstat.stat.ino !== createdCandidateIno
  ) {
    return {
      ok: false,
      error: 'Pre-publication candidate pathname identity mismatch or symlink',
      code: 'candidate-identity-replaced',
      stage: 'final-candidate-reauth',
    };
  }

  // H. Reauthenticate destination parent directory
  const finalParentLstat = getPathLstat(absParentDir);
  if (
    !finalParentLstat.exists ||
    finalParentLstat.isSymbolicLink ||
    !finalParentLstat.isDirectory ||
    finalParentLstat.stat.dev !== authenticatedParentDev ||
    finalParentLstat.stat.ino !== authenticatedParentIno
  ) {
    return {
      ok: false,
      error: 'Pre-publication destination parent directory identity changed or became a symlink',
      code: 'parent-directory-replaced',
      stage: 'final-parent-reauth',
    };
  }

  // 14. Atomic Journal Advancement
  const advanceRes = advanceJournalPhase({
    repoRoot,
    txId,
    nextPhase: 'READY_TO_SWAP',
    metadataUpdate: {
      destinationStagedPath: relCandidatePath,
    },
    lease,
  });

  if (!advanceRes.ok) {
    return {
      ok: false,
      error: `Failed to advance journal to READY_TO_SWAP: ${advanceRes.error}`,
      code: advanceRes.code || 'journal-advancement-failed',
      stage: advanceRes.stage,
      uncertain: advanceRes.stage === 'post-rename',
    };
  }

  runFault('after-journal-advancement', { journal: advanceRes.journal });

  return {
    ok: true,
    candidatePath: relCandidatePath,
    destinationStagedPath: relCandidatePath,
    targetMode: journal.targetMode,
    journal: advanceRes.journal,
    sha256: expectedResultSha,
    gitBlobSha: expectedResultBlob,
  };
}

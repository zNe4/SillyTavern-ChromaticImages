import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  getPathLstat,
  isPathContained,
} from './lock.js';

import {
  inspectJournal,
  verifyLockOwnershipForMutation,
  isValidDeviceIdentifier,
  isValidInodeIdentifier,
  TARGET_MODE_REGEX,
  JOURNAL_SCHEMA_VERSION,
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

export const MAX_SWAP_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB bounded read
export const CERTIFIED_TARGET_FILE = 'src/endpoints/stable-diffusion.js';
export const SPECIAL_MODE_MASK = 0o7000;
const TX_ID_REGEX = /^ci-tx-[0-9]+-[0-9a-f]+$/i;

/**
 * Validate open constants: must be finite, non-zero integer.
 * Rejects missing, zero, NaN, Infinity, fractional, and non-numeric values.
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
    val !== 0
  );
}

/**
 * Safely read and verify a bounded file through an open O_NOFOLLOW | O_NONBLOCK descriptor.
 * Strictly verifies size bounds prior to buffer allocation, detects short-reads / unexpected EOF,
 * verifies concurrent expansion, rejects unsupported special permission bits (setuid/setgid/sticky),
 * and verifies pre/post descriptor identity and single-link invariants.
 *
 * Guaranteed fail-closed descriptor closure: failed or uncertain close cannot return success.
 *
 * @param {string} absPath - Absolute path to file to read
 * @param {object} [options]
 * @param {number} [options.maxBytes=MAX_SWAP_FILE_BYTES]
 * @param {object} [options.constants=fs.constants]
 * @param {boolean} [options.requireSingleLink=true]
 * @param {(stage: string, context?: object) => void} [options.runFault=null]
 * @param {(absPath: string) => void} [options.beforeOpenHook=null]
 * @returns {{
 *   buffer: Buffer,
 *   stat: fs.Stats,
 *   dev: number|bigint,
 *   ino: number|bigint,
 *   size: number,
 *   mode: string,
 *   sha256: string,
 *   gitBlobSha: string
 * }}
 */
export function readBoundedNonblockingFile(absPath, options = {}) {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    const err = new Error('Options must be an object if provided');
    err.code = 'invalid-arguments';
    throw err;
  }

  const constants = options.constants || fs.constants;

  // 1. Platform open constants verification: actual platform O_NOFOLLOW and O_NONBLOCK
  if (!constants || !isValidOpenConstant(constants.O_NOFOLLOW) || !isValidOpenConstant(constants.O_NONBLOCK)) {
    const err = new Error('Unsupported platform: O_NOFOLLOW and O_NONBLOCK file open flags are required for safe descriptor access');
    err.code = 'unsupported-platform';
    throw err;
  }

  let maxBytes = MAX_SWAP_FILE_BYTES;
  if (options.maxBytes !== undefined) {
    if (
      typeof options.maxBytes !== 'number' ||
      !Number.isInteger(options.maxBytes) ||
      options.maxBytes <= 0 ||
      options.maxBytes > MAX_SWAP_FILE_BYTES
    ) {
      const err = new Error(`Invalid maxBytes limit: must be a positive integer <= ${MAX_SWAP_FILE_BYTES}`);
      err.code = 'invalid-max-bytes';
      throw err;
    }
    maxBytes = options.maxBytes;
  }

  const requireSingleLink = options.requireSingleLink !== false;
  const runFault = typeof options.runFault === 'function' ? options.runFault : null;
  const beforeOpenHook = typeof options.beforeOpenHook === 'function' ? options.beforeOpenHook : null;

  // 2. Preliminary lstat
  let preCheck;
  try {
    const lstat = fs.lstatSync(absPath);
    preCheck = {
      exists: true,
      isFile: lstat.isFile(),
      isSymbolicLink: lstat.isSymbolicLink(),
      stat: lstat,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error(`File not found: "${absPath}"`);
      e.code = 'file-missing';
      throw e;
    }
    const e = new Error(`Failed to inspect file "${absPath}": ${err.message}`);
    e.code = err.code || 'inspection-error';
    throw e;
  }

  if (preCheck.isSymbolicLink) {
    const err = new Error(`File "${absPath}" is a symbolic link`);
    err.code = 'unsafe-symlink';
    throw err;
  }

  if (!preCheck.isFile) {
    const err = new Error(`File "${absPath}" is not a regular file`);
    err.code = 'unsupported-type';
    throw err;
  }

  // F2-B: Check preliminary link count when requireSingleLink is enabled
  if (requireSingleLink && preCheck.stat.nlink !== 1) {
    const err = new Error(`File "${absPath}" unexpected link count: expected 1, observed ${preCheck.stat.nlink}`);
    err.code = 'unexpected-link-count';
    throw err;
  }

  // F1-C: Reject unsupported setuid, setgid, and sticky permission bits
  if ((preCheck.stat.mode & SPECIAL_MODE_MASK) !== 0) {
    const err = new Error(`File "${absPath}" has unsupported special permission bits (setuid/setgid/sticky): 0o${(preCheck.stat.mode & 0o7777).toString(8)}`);
    err.code = 'unsupported-special-mode';
    throw err;
  }

  // Hook right before opening descriptor (allows testing TOCTOU races such as FIFO substitution)
  if (beforeOpenHook) {
    beforeOpenHook(absPath);
  }

  // 3. Open file descriptor with O_RDONLY | O_NOFOLLOW | O_NONBLOCK
  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd = null;
  let primaryError = null;
  try {
    fd = fs.openSync(absPath, openFlags);
  } catch (err) {
    if (err?.code === 'ELOOP') {
      const e = new Error(`File "${absPath}" is a symbolic link`);
      e.code = 'unsafe-symlink';
      throw e;
    }
    if (err?.code === 'ENOENT') {
      const e = new Error(`File not found when opening: "${absPath}"`);
      e.code = 'file-missing';
      throw e;
    }
    if (err?.code === 'ENXIO') {
      const e = new Error(`File "${absPath}" cannot be opened as a regular nonblocking file (ENXIO)`);
      e.code = 'unsupported-type';
      throw e;
    }
    const e = new Error(`Failed to open descriptor for "${absPath}": ${err.message}`);
    e.code = err.code || 'open-error';
    throw e;
  }

  try {
    // 4. Descriptor verification (preStat)
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      const err = new Error(`File descriptor for "${absPath}" is not a regular file`);
      err.code = 'unsupported-type';
      throw err;
    }

    // F1-C: Reject unsupported setuid, setgid, and sticky permission bits on descriptor
    if ((preStat.mode & SPECIAL_MODE_MASK) !== 0) {
      const err = new Error(`File descriptor for "${absPath}" has unsupported special permission bits (setuid/setgid/sticky): 0o${(preStat.mode & 0o7777).toString(8)}`);
      err.code = 'unsupported-special-mode';
      throw err;
    }

    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      const err = new Error(`File descriptor for "${absPath}" has invalid device or inode identity`);
      err.code = 'invalid-file-identity';
      throw err;
    }

    if (requireSingleLink && preStat.nlink !== 1) {
      const err = new Error(`File "${absPath}" unexpected link count: expected 1, observed ${preStat.nlink}`);
      err.code = 'unexpected-link-count';
      throw err;
    }

    if (preCheck.stat.nlink !== preStat.nlink) {
      const err = new Error(`Pathname link count does not match descriptor for "${absPath}": preliminary ${preCheck.stat.nlink}, descriptor ${preStat.nlink}`);
      err.code = 'descriptor-identity-mismatch';
      throw err;
    }

    if (preStat.size > maxBytes) {
      const err = new Error(`File "${absPath}" size (${preStat.size} bytes) exceeds limit (${maxBytes} bytes)`);
      err.code = 'file-too-large';
      throw err;
    }

    if (preStat.size === 0) {
      const err = new Error(`File "${absPath}" is unexpectedly empty (0 bytes)`);
      err.code = 'empty-file';
      throw err;
    }

    // Continuity between preliminary lstat and opened descriptor
    if (preCheck.stat.dev !== preStat.dev || preCheck.stat.ino !== preStat.ino) {
      const err = new Error(`Pathname device/inode does not match opened descriptor for "${absPath}"`);
      err.code = 'descriptor-identity-mismatch';
      throw err;
    }

    if (preCheck.stat.size !== preStat.size) {
      const err = new Error(`Pathname size does not match opened descriptor for "${absPath}"`);
      err.code = 'descriptor-size-mismatch';
      throw err;
    }

    // F1-C: Compare full permission bits without masking special bits
    if ((preCheck.stat.mode & 0o7777) !== (preStat.mode & 0o7777)) {
      const err = new Error(`Pathname permissions do not match opened descriptor for "${absPath}"`);
      err.code = 'descriptor-mode-mismatch';
      throw err;
    }

    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let totalRead = 0;

    // 5. Short-read detection and bounded reading
    while (totalRead < expectedSize) {
      if (runFault) {
        runFault('read-chunk', { totalRead, expectedSize, fd, absPath });
      }
      const bytesRead = fs.readSync(fd, buffer, totalRead, expectedSize - totalRead, totalRead);
      if (bytesRead === 0) {
        const err = new Error(`Unexpected EOF reading "${absPath}": read ${totalRead} of ${expectedSize} bytes`);
        err.code = 'unexpected-eof';
        throw err;
      }
      totalRead += bytesRead;
    }

    // 6. Concurrent-expansion detection
    const extraBuf = Buffer.alloc(1);
    const extraRead = fs.readSync(fd, extraBuf, 0, 1, expectedSize);
    if (extraRead > 0) {
      const err = new Error(`File "${absPath}" expanded concurrently during reading`);
      err.code = 'concurrent-expansion';
      throw err;
    }

    // 7. Post-read descriptor consistency
    const postStat = fs.fstatSync(fd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== preStat.size ||
      !postStat.isFile()
    ) {
      const err = new Error(`File "${absPath}" identity or size modified concurrently during reading`);
      err.code = 'concurrent-modification';
      throw err;
    }

    // F2-B: Recheck descriptor link count after reading
    if (requireSingleLink && postStat.nlink !== 1) {
      const err = new Error(`File "${absPath}" unexpected link count after reading: expected 1, observed ${postStat.nlink}`);
      err.code = 'unexpected-link-count';
      throw err;
    }

    if (postStat.nlink !== preStat.nlink) {
      const err = new Error(`File "${absPath}" link count modified concurrently during reading: initially ${preStat.nlink}, observed ${postStat.nlink}`);
      err.code = 'concurrent-modification';
      throw err;
    }

    // F1-C: Reject special bits on postStat
    if ((postStat.mode & SPECIAL_MODE_MASK) !== 0) {
      const err = new Error(`File "${absPath}" has unsupported special permission bits after reading: 0o${(postStat.mode & 0o7777).toString(8)}`);
      err.code = 'unsupported-special-mode';
      throw err;
    }

    if ((postStat.mode & 0o7777) !== (preStat.mode & 0o7777)) {
      const err = new Error(`File "${absPath}" permissions modified concurrently during reading`);
      err.code = 'concurrent-modification';
      throw err;
    }

    // 8. Pathname-to-descriptor continuity check
    let postCheck;
    try {
      postCheck = fs.lstatSync(absPath);
    } catch (err) {
      const e = new Error(`Pathname "${absPath}" disappeared or became inaccessible after reading: ${err.message}`);
      e.code = 'pathname-continuity-error';
      throw e;
    }

    if (
      postCheck.isSymbolicLink() ||
      !postCheck.isFile() ||
      postCheck.dev !== preStat.dev ||
      postCheck.ino !== preStat.ino ||
      postCheck.size !== preStat.size
    ) {
      const err = new Error(`Pathname "${absPath}" identity, mode, or type modified concurrently after reading`);
      err.code = 'pathname-continuity-error';
      throw err;
    }

    // F2-B: Check pathname link-count consistency in final validation
    if (requireSingleLink && postCheck.nlink !== 1) {
      const err = new Error(`Pathname "${absPath}" unexpected link count after reading: expected 1, observed ${postCheck.nlink}`);
      err.code = 'unexpected-link-count';
      throw err;
    }

    if (postCheck.nlink !== postStat.nlink) {
      const err = new Error(`Pathname "${absPath}" link count does not match descriptor: pathname ${postCheck.nlink}, descriptor ${postStat.nlink}`);
      err.code = 'pathname-continuity-error';
      throw err;
    }

    // F1-C: Reject special bits on postCheck
    if ((postCheck.mode & SPECIAL_MODE_MASK) !== 0) {
      const err = new Error(`Pathname "${absPath}" has unsupported special permission bits after reading: 0o${(postCheck.mode & 0o7777).toString(8)}`);
      err.code = 'unsupported-special-mode';
      throw err;
    }

    if ((postCheck.mode & 0o7777) !== (preStat.mode & 0o7777)) {
      const err = new Error(`Pathname "${absPath}" identity, mode, or type modified concurrently after reading`);
      err.code = 'pathname-continuity-error';
      throw err;
    }

    // 9. SHA-256 and Git blob digest computation
    const sha256 = computeSha256(buffer).toLowerCase();
    const gitBlobSha = computeGitBlobSha(buffer).toLowerCase();

    return {
      buffer,
      stat: postStat,
      dev: postStat.dev,
      ino: postStat.ino,
      size: postStat.size,
      mode: '0' + (postStat.mode & 0o777).toString(8).padStart(3, '0'),
      sha256,
      gitBlobSha,
    };
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    // F1-D: Fail closed on descriptor-close errors
    if (fd !== null) {
      const fdToClose = fd;
      fd = null; // Do not retry or close again: ownership relinquished immediately
      try {
        fs.closeSync(fdToClose);
      } catch (closeErr) {
        if (!primaryError) {
          const err = new Error(`Failed to close descriptor for "${absPath}": ${closeErr.message}`);
          err.code = closeErr.code || 'descriptor-close-error';
          err.cause = closeErr;
          throw err;
        } else if (typeof primaryError === 'object' && primaryError !== null && !primaryError.closeError) {
          // Preserve primary verification error when cleanup also fails
          primaryError.closeError = {
            error: closeErr.message,
            message: closeErr.message,
            code: closeErr.code || 'descriptor-close-error',
            uncertain: true,
            status: 'failed',
          };
        }
      }
    }
  }
}

/**
 * Internal private core for pre-swap prerequisites authentication.
 *
 * Implements the full Stage B authentication sequence:
 * - In-process lease, lock ownership, and journal phase READY_TO_SWAP validation
 * - Certified package manifest binding and fingerprint verification
 * - Hierarchy sanity checks (no symlinks in intermediate components)
 * - Destination parent directory descriptor opening and procfs anchoring
 * - Bounded nonblocking verification of staging, backup, live target, and destination candidate
 * - Stable permission bits, single-link invariants, device containment, distinct inode identity
 * - Post-verification parent pathname continuity
 *
 * Descriptor Ownership Model:
 * 1. The core initially opens and owns `parentFd`.
 * 2. If `retainParentDescriptor` is false (default):
 *    - `parentFd` is closed unconditionally in `finally` before returning.
 *    - If `fs.closeSync` fails on an otherwise successful authentication, returns ok: false with descriptorCloseUncertain.
 *    - The return object never contains `parentFd`.
 * 3. If `retainParentDescriptor` is true:
 *    - On failure or thrown exception: `parentFd` is closed unconditionally in `finally`; never transferred.
 *    - On success: ownership of `parentFd` is transferred to the caller; `parentFd` is set to null so the core's
 *      `finally` block will NOT close it; the returned object includes `parentFd` and `parentStat`.
 *    - The caller exclusively owns the descriptor and is responsible for an unconditional `try/finally` close.
 *
 * @private
 * @param {object} options - Swap options (repoRoot, txId, op, lease, manifest, constants, etc.)
 * @param {object} [coreOptions]
 * @param {boolean} [coreOptions.retainParentDescriptor=false] - Whether to transfer parentFd ownership on success
 * @returns {Promise<object>}
 */
async function authenticatePrerequisitesCore(options = {}, coreOptions = {}) {
  const retainParentDescriptor = Boolean(coreOptions?.retainParentDescriptor);

  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {
      ok: false,
      verified: false,
      error: 'Options must be a non-null plain object',
      code: 'invalid-arguments',
      stage: 'arguments',
    };
  }

  const {
    repoRoot,
    txId,
    op,
    lease,
    manifest: providedManifest = null,
    procDir = '/proc/self/fd',
    constants = fs.constants,
    maxBytes = MAX_SWAP_FILE_BYTES,
    faultHook = null,
    beforeOpenHook = null,
  } = options;

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

  // 1. Validate mandatory options
  if (!repoRoot || typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    return {
      ok: false,
      verified: false,
      error: 'Missing or invalid mandatory argument: repoRoot must be a non-empty string',
      code: 'invalid-arguments',
      stage: 'arguments',
    };
  }

  if (!txId || typeof txId !== 'string' || !TX_ID_REGEX.test(txId.trim())) {
    return {
      ok: false,
      verified: false,
      error: `Missing or invalid transaction ID format: "${txId}"`,
      code: 'invalid-txid',
      stage: 'arguments',
    };
  }

  if (op !== 'apply' && op !== 'remove') {
    return {
      ok: false,
      verified: false,
      error: `Invalid operation "${op}": must be "apply" or "remove"`,
      code: 'invalid-operation',
      stage: 'arguments',
    };
  }

  if (!lease) {
    return {
      ok: false,
      verified: false,
      error: 'A valid in-process TransactionLease capability is required for swap authentication',
      code: 'lease-required',
      stage: 'arguments',
    };
  }

  // 2. Validate platform open constants: O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY
  if (!constants || !isValidOpenConstant(constants.O_NOFOLLOW)) {
    return {
      ok: false,
      verified: false,
      error: 'fs.constants.O_NOFOLLOW is missing, non-integer, zero, or non-finite',
      code: 'unsupported-platform',
      stage: 'platform-capabilities',
      reason: 'O_NOFOLLOW is required for safe swap authentication',
    };
  }

  if (!isValidOpenConstant(constants.O_NONBLOCK)) {
    return {
      ok: false,
      verified: false,
      error: 'fs.constants.O_NONBLOCK is missing, non-integer, zero, or non-finite',
      code: 'unsupported-platform',
      stage: 'platform-capabilities',
      reason: 'O_NONBLOCK is required for nonblocking live-target descriptor access',
    };
  }

  if (!isValidOpenConstant(constants.O_DIRECTORY)) {
    return {
      ok: false,
      verified: false,
      error: 'fs.constants.O_DIRECTORY is missing, non-integer, zero, or non-finite',
      code: 'unsupported-platform',
      stage: 'platform-capabilities',
      reason: 'O_DIRECTORY is required for safe destination parent directory descriptor access',
    };
  }

  // 3. Repository root path inspection
  const normRepo = path.resolve(repoRoot);
  const repoStat = getPathLstat(normRepo);
  if (repoStat.error || !repoStat.exists || !repoStat.isDirectory || repoStat.isSymbolicLink) {
    return {
      ok: false,
      verified: false,
      error: `Repository root "${normRepo}" does not exist, is not a directory, or is a symbolic link`,
      code: 'invalid-repo-root',
      stage: 'repo-root',
    };
  }

  // Reject symlinked .ci-patch immediately before accessing lock or journal through it
  const ciPatchCheck = getPathLstat(path.resolve(normRepo, '.ci-patch'));
  if (ciPatchCheck.exists && ciPatchCheck.isSymbolicLink) {
    return {
      ok: false,
      verified: false,
      error: 'Directory component ".ci-patch" is a symbolic link',
      code: 'unsafe-symlink',
      stage: 'staging-hierarchy',
    };
  }

  // 4. Authenticate transaction lock ownership and in-process lease
  const lockAuth = verifyLockOwnershipForMutation(normRepo, txId.trim(), op, lease);
  if (!lockAuth.ok) {
    return {
      ok: false,
      verified: false,
      error: lockAuth.reason || lockAuth.error,
      code: lockAuth.error || 'unauthorized-lock',
      stage: 'lock-authentication',
      reason: lockAuth.reason,
    };
  }

  // 5. Inspect transaction journal and verify schema and phase
  const journalInspection = inspectJournal(normRepo);
  if (!journalInspection.hasJournal) {
    return {
      ok: false,
      verified: false,
      error: 'Transaction journal file is missing',
      code: 'journal-missing',
      stage: 'journal-inspection',
    };
  }

  if (!journalInspection.isValid || !journalInspection.journal) {
    return {
      ok: false,
      verified: false,
      error: `Invalid or corrupt journal: ${journalInspection.errors?.join('; ') || 'unknown'}`,
      code: 'journal-invalid',
      stage: 'journal-inspection',
    };
  }

  if (journalInspection.isLegacy) {
    return {
      ok: false,
      verified: false,
      error: 'Legacy journal schema is not supported for live swap operations',
      code: 'journal-legacy',
      stage: 'journal-inspection',
    };
  }

  const journal = journalInspection.journal;

  if (journal.txId !== txId.trim()) {
    return {
      ok: false,
      verified: false,
      error: `Journal txId mismatch: journal belongs to "${journal.txId}", caller specified "${txId.trim()}"`,
      code: 'journal-tx-mismatch',
      stage: 'journal-inspection',
    };
  }

  if (journal.op !== op) {
    return {
      ok: false,
      verified: false,
      error: `Journal operation mismatch: journal is "${journal.op}", caller specified "${op}"`,
      code: 'journal-op-mismatch',
      stage: 'journal-inspection',
    };
  }

  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return {
      ok: false,
      verified: false,
      error: `Journal schemaVersion mismatch: expected "${JOURNAL_SCHEMA_VERSION}", found "${journal.schemaVersion}"`,
      code: 'journal-schema-mismatch',
      stage: 'journal-inspection',
    };
  }

  // Strict phase requirement: must be READY_TO_SWAP
  if (journal.phase !== 'READY_TO_SWAP') {
    return {
      ok: false,
      verified: false,
      error: `Transaction phase must be strictly "READY_TO_SWAP", observed "${journal.phase}"`,
      code: 'phase-mismatch',
      stage: 'journal-phase-verification',
    };
  }

  // Strict target file requirement: must be certified target
  if (journal.targetFile !== CERTIFIED_TARGET_FILE) {
    return {
      ok: false,
      verified: false,
      error: `Uncertified journal target file: expected "${CERTIFIED_TARGET_FILE}", observed "${journal.targetFile}"`,
      code: 'uncertified-target',
      stage: 'journal-metadata',
    };
  }

  // Auxiliary fields containment and exact canonical path validation
  const targetBase = path.basename(journal.targetFile);
  const targetDir = path.dirname(journal.targetFile);
  const expectedIsolated = `.ci-patch/staging/${txId.trim()}/${targetBase}`;
  const expectedBackup = `.ci-patch/backup/${txId.trim()}/${targetBase}`;
  const expectedDest = `${targetDir}/.${targetBase}.ci-staged-${txId.trim()}.tmp`;

  if (journal.isolatedStagedPath !== expectedIsolated) {
    return {
      ok: false,
      verified: false,
      error: `Journal isolatedStagedPath "${journal.isolatedStagedPath}" does not match canonical path "${expectedIsolated}"`,
      code: 'invalid-metadata',
      stage: 'journal-metadata',
    };
  }

  if (journal.backupPath !== expectedBackup) {
    return {
      ok: false,
      verified: false,
      error: `Journal backupPath "${journal.backupPath}" does not match canonical path "${expectedBackup}"`,
      code: 'invalid-metadata',
      stage: 'journal-metadata',
    };
  }

  if (journal.destinationStagedPath !== expectedDest) {
    return {
      ok: false,
      verified: false,
      error: `Journal destinationStagedPath "${journal.destinationStagedPath}" does not match canonical path "${expectedDest}"`,
      code: 'invalid-metadata',
      stage: 'journal-metadata',
    };
  }

  if (!journal.targetMode || typeof journal.targetMode !== 'string' || !TARGET_MODE_REGEX.test(journal.targetMode)) {
    return {
      ok: false,
      verified: false,
      error: `Invalid journal targetMode "${journal.targetMode}": must be 4-character octal matching /^0[0-7]{3}$/`,
      code: 'invalid-metadata',
      stage: 'journal-metadata',
    };
  }

  let canonicalRecordedMode;
  try {
    const targetModeInt = parseInt(journal.targetMode, 8);
    canonicalRecordedMode = extractCanonicalTargetMode(targetModeInt);
  } catch (err) {
    return {
      ok: false,
      verified: false,
      error: `Journal targetMode "${journal.targetMode}" invalid or contains unsupported special bits: ${err.message}`,
      code: err.code || 'invalid-mode',
      stage: 'journal-metadata',
    };
  }

  if (!canonicalRecordedMode || canonicalRecordedMode !== journal.targetMode) {
    return {
      ok: false,
      verified: false,
      error: `Journal targetMode "${journal.targetMode}" contains unsupported special mode bits (setuid/setgid/sticky)`,
      code: 'invalid-mode',
      stage: 'journal-metadata',
    };
  }

  // 6. Bundled patch manifest verification (F1-E: Bind manifest authority to package)
  let pkgCheck;
  try {
    pkgCheck = await verifyPatchManifest(BUNDLED_MANIFEST_PATH);
  } catch (err) {
    return {
      ok: false,
      verified: false,
      error: `Manifest verification failed: ${err.message}`,
      code: 'manifest-verification-failed',
      stage: 'manifest-verification',
    };
  }

  if (!pkgCheck.ok || !pkgCheck.manifest) {
    return {
      ok: false,
      verified: false,
      error: `Bundled patch manifest verification failed: ${pkgCheck.errors?.join('; ') || 'invalid'}`,
      code: 'manifest-invalid',
      stage: 'manifest-verification',
    };
  }

  const certifiedManifest = pkgCheck.manifest;
  const patchEntry = certifiedManifest.patches?.runtime;
  if (
    !patchEntry ||
    !patchEntry.targetFile ||
    !patchEntry.relativePath ||
    !patchEntry.sha256 ||
    !patchEntry.original?.sha256 ||
    !patchEntry.original?.gitBlobSha ||
    !patchEntry.expected?.sha256 ||
    !patchEntry.expected?.gitBlobSha
  ) {
    return {
      ok: false,
      verified: false,
      error: 'Certified manifest missing runtime patch configuration',
      code: 'manifest-invalid',
      stage: 'manifest-verification',
    };
  }

  // F1-E: If caller supplies an optional manifest, require strict consistency with certified package
  if (providedManifest !== null && providedManifest !== undefined) {
    if (typeof providedManifest === 'string') {
      const resolvedNorm = path.resolve(normRepo, providedManifest);
      const resolvedRoot = path.resolve(REPO_ROOT, providedManifest);
      if (resolvedNorm !== BUNDLED_MANIFEST_PATH && resolvedRoot !== BUNDLED_MANIFEST_PATH) {
        return {
          ok: false,
          verified: false,
          error: `Arbitrary manifest path "${providedManifest}" is not permitted to redefine certified package`,
          code: 'untrusted-manifest-path',
          stage: 'manifest-verification',
        };
      }
    } else if (typeof providedManifest === 'object') {
      if (Array.isArray(providedManifest)) {
        return {
          ok: false,
          verified: false,
          error: 'Provided manifest must be a plain object',
          code: 'manifest-invalid',
          stage: 'manifest-verification',
        };
      }
      const provRuntime = providedManifest.patches?.runtime;
      if (
        !providedManifest.releaseCommit ||
        !provRuntime ||
        !provRuntime.targetFile ||
        !provRuntime.relativePath ||
        !provRuntime.sha256 ||
        !provRuntime.original?.sha256 ||
        !provRuntime.original?.gitBlobSha ||
        !provRuntime.expected?.sha256 ||
        !provRuntime.expected?.gitBlobSha
      ) {
        return {
          ok: false,
          verified: false,
          error: 'Provided manifest is malformed or incomplete',
          code: 'manifest-invalid',
          stage: 'manifest-verification',
        };
      }
      if (
        providedManifest.releaseCommit !== certifiedManifest.releaseCommit ||
        provRuntime.targetFile !== patchEntry.targetFile ||
        provRuntime.relativePath !== patchEntry.relativePath ||
        provRuntime.sha256 !== patchEntry.sha256 ||
        provRuntime.original.sha256 !== patchEntry.original.sha256 ||
        provRuntime.original.gitBlobSha !== patchEntry.original.gitBlobSha ||
        provRuntime.expected.sha256 !== patchEntry.expected.sha256 ||
        provRuntime.expected.gitBlobSha !== patchEntry.expected.gitBlobSha
      ) {
        return {
          ok: false,
          verified: false,
          error: 'Provided manifest contradicts certified bundled package manifest',
          code: 'manifest-mismatch',
          stage: 'manifest-verification',
        };
      }
    } else {
      return {
        ok: false,
        verified: false,
        error: 'Provided manifest must be a non-null object or string path',
        code: 'manifest-invalid',
        stage: 'manifest-verification',
      };
    }
  }

  if (patchEntry.targetFile !== journal.targetFile) {
    return {
      ok: false,
      verified: false,
      error: `Manifest targetFile "${patchEntry.targetFile}" does not match journal targetFile "${journal.targetFile}"`,
      code: 'manifest-target-mismatch',
      stage: 'manifest-verification',
    };
  }

  // F1-E: Derive all authoritative SHA-256 and Git blob fingerprints strictly from verified bundled manifest
  let expectedInitialSha;
  let expectedInitialGitBlob;
  let expectedResultSha;
  let expectedResultGitBlob;

  if (op === 'apply') {
    expectedInitialSha = patchEntry.original.sha256.toLowerCase();
    expectedInitialGitBlob = patchEntry.original.gitBlobSha.toLowerCase();
    expectedResultSha = patchEntry.expected.sha256.toLowerCase();
    expectedResultGitBlob = patchEntry.expected.gitBlobSha.toLowerCase();
  } else {
    // op === 'remove'
    expectedInitialSha = patchEntry.expected.sha256.toLowerCase();
    expectedInitialGitBlob = patchEntry.expected.gitBlobSha.toLowerCase();
    expectedResultSha = patchEntry.original.sha256.toLowerCase();
    expectedResultGitBlob = patchEntry.original.gitBlobSha.toLowerCase();
  }

  // Verify journal expected hashes against certified manifest
  if (journal.expectedInitialSha256.toLowerCase() !== expectedInitialSha) {
    return {
      ok: false,
      verified: false,
      error: `Journal expectedInitialSha256 ("${journal.expectedInitialSha256}") does not match certified manifest ("${expectedInitialSha}")`,
      code: 'journal-hash-mismatch',
      stage: 'manifest-verification',
    };
  }

  if (journal.expectedResultSha256.toLowerCase() !== expectedResultSha) {
    return {
      ok: false,
      verified: false,
      error: `Journal expectedResultSha256 ("${journal.expectedResultSha256}") does not match certified manifest ("${expectedResultSha}")`,
      code: 'journal-hash-mismatch',
      stage: 'manifest-verification',
    };
  }

  // 7. Authenticate every parent-directory component (F1-A)
  const requiredDirComponents = [
    {
      rel: 'src',
      name: 'intermediate target directory component (src)',
      stage: 'destination-parent',
      codeMissing: 'parent-dir-invalid',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'parent-dir-invalid',
    },
    {
      rel: targetDir, // 'src/endpoints'
      name: 'destination parent directory (src/endpoints)',
      stage: 'destination-parent',
      codeMissing: 'parent-dir-invalid',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'parent-dir-invalid',
    },
    {
      rel: '.ci-patch',
      name: 'transaction root directory (.ci-patch)',
      stage: 'staging-hierarchy',
      codeMissing: 'staged-resource-missing',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'invalid-staging-dir',
    },
    {
      rel: '.ci-patch/staging',
      name: 'staging parent directory (.ci-patch/staging)',
      stage: 'staging-hierarchy',
      codeMissing: 'staged-resource-missing',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'invalid-staging-dir',
    },
    {
      rel: `.ci-patch/staging/${txId.trim()}`,
      name: `staging transaction directory (.ci-patch/staging/${txId.trim()})`,
      stage: 'staging-hierarchy',
      codeMissing: 'staged-resource-missing',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'invalid-staging-dir',
    },
    {
      rel: '.ci-patch/backup',
      name: 'backup parent directory (.ci-patch/backup)',
      stage: 'backup-hierarchy',
      codeMissing: 'backup-resource-missing',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'invalid-backup-dir',
    },
    {
      rel: `.ci-patch/backup/${txId.trim()}`,
      name: `backup transaction directory (.ci-patch/backup/${txId.trim()})`,
      stage: 'backup-hierarchy',
      codeMissing: 'backup-resource-missing',
      codeSymlink: 'unsafe-symlink',
      codeNotDir: 'invalid-backup-dir',
    },
  ];

  for (const comp of requiredDirComponents) {
    const absComp = path.resolve(normRepo, comp.rel);
    if (!isPathContained(normRepo, absComp)) {
      return {
        ok: false,
        verified: false,
        error: `Directory "${absComp}" escapes repository root`,
        code: 'path-escape',
        stage: comp.stage,
      };
    }
    const st = getPathLstat(absComp);
    if (st.error || !st.exists) {
      return {
        ok: false,
        verified: false,
        error: `Directory component "${comp.rel}" does not exist`,
        code: comp.codeMissing,
        stage: comp.stage,
      };
    }
    if (st.isSymbolicLink) {
      return {
        ok: false,
        verified: false,
        error: `Directory component "${comp.rel}" is a symbolic link`,
        code: comp.codeSymlink,
        stage: comp.stage,
      };
    }
    if (!st.isDirectory) {
      return {
        ok: false,
        verified: false,
        error: `Directory component "${comp.rel}" is not a genuine directory`,
        code: comp.codeNotDir,
        stage: comp.stage,
      };
    }
  }

  // 8. Validate transaction directory contents (F1-A & F1-B)
  const stagingTxDir = path.resolve(normRepo, `.ci-patch/staging/${txId.trim()}`);
  let stagingChildren;
  try {
    stagingChildren = fs.readdirSync(stagingTxDir);
  } catch (err) {
    return {
      ok: false,
      verified: false,
      error: `Failed to inspect staging directory contents: ${err.message}`,
      code: 'inspection-error',
      stage: 'isolated-staging-verification',
    };
  }
  if (stagingChildren.length !== 1 || stagingChildren[0] !== targetBase) {
    return {
      ok: false,
      verified: false,
      error: `Staging directory contains unexpected artifacts: ${stagingChildren.join(', ')}`,
      code: 'unexpected-staging-artifacts',
      stage: 'isolated-staging-verification',
    };
  }

  const backupTxDir = path.resolve(normRepo, `.ci-patch/backup/${txId.trim()}`);
  let backupChildren;
  try {
    backupChildren = fs.readdirSync(backupTxDir);
  } catch (err) {
    return {
      ok: false,
      verified: false,
      error: `Failed to inspect backup directory contents: ${err.message}`,
      code: 'inspection-error',
      stage: 'backup-verification',
    };
  }
  if (backupChildren.length !== 1 || backupChildren[0] !== targetBase) {
    return {
      ok: false,
      verified: false,
      error: `Backup directory contains unexpected artifacts: ${backupChildren.join(', ')}`,
      code: 'unexpected-backup-artifacts',
      stage: 'backup-verification',
    };
  }

  // 9. Destination parent directory descriptor and procfs anchoring
  const absParentDir = path.resolve(normRepo, targetDir);
  const parentLstat = getPathLstat(absParentDir);
  if (parentLstat.error || !parentLstat.exists || !parentLstat.isDirectory || parentLstat.isSymbolicLink) {
    return {
      ok: false,
      verified: false,
      error: `Destination parent directory "${absParentDir}" does not exist, is not a directory, or is a symbolic link`,
      code: parentLstat.isSymbolicLink ? 'unsafe-symlink' : 'parent-dir-invalid',
      stage: 'destination-parent',
    };
  }

  if (!isValidDeviceIdentifier(parentLstat.stat.dev) || !isValidInodeIdentifier(parentLstat.stat.ino)) {
    return {
      ok: false,
      verified: false,
      error: `Destination parent directory "${absParentDir}" has invalid device or inode identity`,
      code: 'parent-dir-invalid',
      stage: 'destination-parent',
    };
  }

  const dirOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parentFd = null;
  try {
    parentFd = fs.openSync(absParentDir, dirOpenFlags);
  } catch (err) {
    return {
      ok: false,
      verified: false,
      error: `Failed to open destination parent directory descriptor: ${err.message}`,
      code: 'parent-dir-open-error',
      stage: 'destination-parent',
    };
  }

  let verificationResult = null;
  let verificationException = null;
  let descriptorTransferred = false;

  const fail = (res) => {
    if (!res.reason && res.error) {
      res.reason = res.error;
    }
    verificationResult = res;
    return res;
  };

  try {
    const parentStat = fs.fstatSync(parentFd);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      return fail({
        ok: false,
        verified: false,
        error: 'Destination parent descriptor is not a directory or is a symbolic link',
        code: 'parent-dir-invalid',
        stage: 'destination-parent',
      });
    }

    if (parentStat.dev !== parentLstat.stat.dev || parentStat.ino !== parentLstat.stat.ino) {
      return fail({
        ok: false,
        verified: false,
        error: 'Destination parent descriptor identity does not match preliminary directory inspection',
        code: 'parent-dir-identity-mismatch',
        stage: 'destination-parent',
      });
    }

    // Procfs descriptor anchoring verification
    let procAvailable = false;
    try {
      procAvailable = typeof procDir === 'string' && fs.existsSync(procDir);
    } catch {
      procAvailable = false;
    }
    if (!procAvailable) {
      return fail({
        ok: false,
        verified: false,
        error: `Procfs descriptor directory "${procDir}" is unavailable`,
        code: 'procfs-unavailable',
        stage: 'procfs-anchoring',
      });
    }

    const parentProcDir = path.join(procDir, String(parentFd));
    let parentProcStat;
    try {
      parentProcStat = fs.statSync(parentProcDir);
    } catch (err) {
      return fail({
        ok: false,
        verified: false,
        error: `Procfs descriptor path "${parentProcDir}" cannot be accessed: ${err.message}`,
        code: 'procfs-descriptor-unavailable',
        stage: 'procfs-anchoring',
      });
    }

    if (!parentProcStat.isDirectory()) {
      return fail({
        ok: false,
        verified: false,
        error: `Procfs descriptor path "${parentProcDir}" is not a directory`,
        code: 'procfs-descriptor-not-directory',
        stage: 'procfs-anchoring',
      });
    }

    if (parentProcStat.dev !== parentStat.dev || parentProcStat.ino !== parentStat.ino) {
      return fail({
        ok: false,
        verified: false,
        error: 'Procfs descriptor path resolves to unexpected directory identity',
        code: 'procfs-descriptor-identity-mismatch',
        stage: 'procfs-anchoring',
      });
    }

    // Intentional fault hook after destination parent is authenticated
    runFault('after-parent-authenticated', { absParentDir, parentFd, parentStat });

    const readerOpts = {
      maxBytes,
      constants,
      requireSingleLink: true,
      runFault,
      beforeOpenHook,
    };

    // 10. Authenticate isolated staging output
    const absStaging = path.resolve(normRepo, journal.isolatedStagedPath);
    if (!isPathContained(normRepo, absStaging)) {
      return fail({
        ok: false,
        verified: false,
        error: `Isolated staged path "${absStaging}" escapes repository root`,
        code: 'staging-path-escape',
        stage: 'isolated-staging-verification',
      });
    }

    let stagingRes;
    try {
      stagingRes = readBoundedNonblockingFile(absStaging, readerOpts);
    } catch (err) {
      if (err?._isFault) throw err;
      return fail({
        ok: false,
        verified: false,
        error: `Isolated staging verification failed: ${err.message}`,
        code: err.code || 'staging-verification-failed',
        stage: 'isolated-staging-verification',
        reason: err.message,
      });
    }

    // F1-B: Staging file must strictly have mode 0600
    if (stagingRes.mode !== '0600') {
      return fail({
        ok: false,
        verified: false,
        error: `Isolated staging file mode mismatch: expected "0600", observed "${stagingRes.mode}"`,
        code: 'staging-mode-mismatch',
        stage: 'isolated-staging-verification',
      });
    }

    if (stagingRes.sha256 !== expectedResultSha) {
      return fail({
        ok: false,
        verified: false,
        error: `Isolated staging SHA-256 mismatch: expected "${expectedResultSha}", observed "${stagingRes.sha256}"`,
        code: 'staging-digest-mismatch',
        stage: 'isolated-staging-verification',
      });
    }

    if (stagingRes.gitBlobSha !== expectedResultGitBlob) {
      return fail({
        ok: false,
        verified: false,
        error: `Isolated staging Git blob mismatch: expected "${expectedResultGitBlob}", observed "${stagingRes.gitBlobSha}"`,
        code: 'staging-digest-mismatch',
        stage: 'isolated-staging-verification',
      });
    }

    // 11. Authenticate verified backup
    const absBackup = path.resolve(normRepo, journal.backupPath);
    if (!isPathContained(normRepo, absBackup)) {
      return fail({
        ok: false,
        verified: false,
        error: `Backup path "${absBackup}" escapes repository root`,
        code: 'backup-path-escape',
        stage: 'backup-verification',
      });
    }

    let backupRes;
    try {
      backupRes = readBoundedNonblockingFile(absBackup, readerOpts);
    } catch (err) {
      if (err?._isFault) throw err;
      return fail({
        ok: false,
        verified: false,
        error: `Backup verification failed: ${err.message}`,
        code: err.code || 'backup-verification-failed',
        stage: 'backup-verification',
        reason: err.message,
      });
    }

    // F1-B: Backup file must strictly have mode 0600
    if (backupRes.mode !== '0600') {
      return fail({
        ok: false,
        verified: false,
        error: `Backup file mode mismatch: expected "0600", observed "${backupRes.mode}"`,
        code: 'backup-mode-mismatch',
        stage: 'backup-verification',
      });
    }

    if (backupRes.sha256 !== expectedInitialSha) {
      return fail({
        ok: false,
        verified: false,
        error: `Backup SHA-256 mismatch: expected "${expectedInitialSha}", observed "${backupRes.sha256}"`,
        code: 'backup-digest-mismatch',
        stage: 'backup-verification',
      });
    }

    if (backupRes.gitBlobSha !== expectedInitialGitBlob) {
      return fail({
        ok: false,
        verified: false,
        error: `Backup Git blob mismatch: expected "${expectedInitialGitBlob}", observed "${backupRes.gitBlobSha}"`,
        code: 'backup-digest-mismatch',
        stage: 'backup-verification',
      });
    }

    // 12. Authenticate live target
    const absLiveTarget = path.resolve(normRepo, journal.targetFile);
    if (!isPathContained(normRepo, absLiveTarget)) {
      return fail({
        ok: false,
        verified: false,
        error: `Live target path "${absLiveTarget}" escapes repository root`,
        code: 'target-path-escape',
        stage: 'live-target-verification',
      });
    }

    let liveTargetRes;
    try {
      liveTargetRes = readBoundedNonblockingFile(absLiveTarget, readerOpts);
    } catch (err) {
      if (err?._isFault) throw err;
      return fail({
        ok: false,
        verified: false,
        error: `Live target verification failed: ${err.message}`,
        code: err.code || 'live-target-verification-failed',
        stage: 'live-target-verification',
        reason: err.message,
      });
    }

    // Live target must reside on the same filesystem device as destination parent directory
    if (liveTargetRes.dev !== parentStat.dev) {
      return fail({
        ok: false,
        verified: false,
        error: 'Live target resides on a different filesystem device than destination parent directory',
        code: 'target-cross-device',
        stage: 'live-target-verification',
      });
    }

    // Live target mode must match journal recorded targetMode
    if (liveTargetRes.mode !== journal.targetMode) {
      return fail({
        ok: false,
        verified: false,
        error: `Live target mode mismatch: expected "${journal.targetMode}", observed "${liveTargetRes.mode}"`,
        code: 'target-mode-mismatch',
        stage: 'live-target-verification',
      });
    }

    // Live target must still contain initial bytes and Git blob
    if (liveTargetRes.sha256 !== expectedInitialSha) {
      return fail({
        ok: false,
        verified: false,
        error: `Live target SHA-256 mismatch: expected initial "${expectedInitialSha}", observed "${liveTargetRes.sha256}"`,
        code: 'target-digest-mismatch',
        stage: 'live-target-verification',
      });
    }

    if (liveTargetRes.gitBlobSha !== expectedInitialGitBlob) {
      return fail({
        ok: false,
        verified: false,
        error: `Live target Git blob mismatch: expected initial "${expectedInitialGitBlob}", observed "${liveTargetRes.gitBlobSha}"`,
        code: 'target-digest-mismatch',
        stage: 'live-target-verification',
      });
    }

    // 13. Authenticate destination candidate
    const absCandidate = path.resolve(normRepo, journal.destinationStagedPath);
    if (!isPathContained(normRepo, absCandidate)) {
      return fail({
        ok: false,
        verified: false,
        error: `Destination candidate path "${absCandidate}" escapes repository root`,
        code: 'candidate-path-escape',
        stage: 'candidate-verification',
      });
    }

    let candidateRes;
    try {
      candidateRes = readBoundedNonblockingFile(absCandidate, readerOpts);
    } catch (err) {
      if (err?._isFault) throw err;
      return fail({
        ok: false,
        verified: false,
        error: `Destination candidate verification failed: ${err.message}`,
        code: err.code || 'candidate-verification-failed',
        stage: 'candidate-verification',
        reason: err.message,
      });
    }

    // Destination candidate must reside on same device as destination parent directory and live target
    if (candidateRes.dev !== parentStat.dev || candidateRes.dev !== liveTargetRes.dev) {
      return fail({
        ok: false,
        verified: false,
        error: 'Destination candidate resides on a different filesystem device than live target or parent directory',
        code: 'candidate-cross-device',
        stage: 'candidate-verification',
      });
    }

    // Destination candidate inode must be distinct from live target inode
    if (candidateRes.ino === liveTargetRes.ino) {
      return fail({
        ok: false,
        verified: false,
        error: 'Destination candidate unexpectedly shares inode identity with live target',
        code: 'candidate-inode-collision',
        stage: 'candidate-verification',
      });
    }

    // Destination candidate mode must match recorded targetMode
    if (candidateRes.mode !== journal.targetMode) {
      return fail({
        ok: false,
        verified: false,
        error: `Destination candidate mode mismatch: expected "${journal.targetMode}", observed "${candidateRes.mode}"`,
        code: 'candidate-mode-mismatch',
        stage: 'candidate-verification',
      });
    }

    // Destination candidate must contain expected result bytes and Git blob
    if (candidateRes.sha256 !== expectedResultSha) {
      return fail({
        ok: false,
        verified: false,
        error: `Destination candidate SHA-256 mismatch: expected result "${expectedResultSha}", observed "${candidateRes.sha256}"`,
        code: 'candidate-digest-mismatch',
        stage: 'candidate-verification',
      });
    }

    if (candidateRes.gitBlobSha !== expectedResultGitBlob) {
      return fail({
        ok: false,
        verified: false,
        error: `Destination candidate Git blob mismatch: expected result "${expectedResultGitBlob}", observed "${candidateRes.gitBlobSha}"`,
        code: 'candidate-digest-mismatch',
        stage: 'candidate-verification',
      });
    }

    // 14. Check pathname continuity against the authenticated descriptor after resource verification (F1-A)
    let postParentCheck;
    try {
      postParentCheck = fs.lstatSync(absParentDir);
    } catch (err) {
      return fail({
        ok: false,
        verified: false,
        error: `Destination parent directory "${absParentDir}" disappeared or became inaccessible after resource verification: ${err.message}`,
        code: 'parent-dir-continuity-error',
        stage: 'destination-parent',
      });
    }

    if (
      postParentCheck.isSymbolicLink() ||
      !postParentCheck.isDirectory() ||
      postParentCheck.dev !== parentStat.dev ||
      postParentCheck.ino !== parentStat.ino
    ) {
      return fail({
        ok: false,
        verified: false,
        error: `Destination parent directory "${absParentDir}" identity or type modified concurrently after resource verification`,
        code: 'parent-dir-continuity-error',
        stage: 'destination-parent',
      });
    }

    // Inode continuity was verified within the invocation for candidate, target, backup, staging, parent.
    // Return read-only informational verification result.
    // DOES NOT advance journal phase or produce a reusable authorization capability token.
    verificationResult = {
      ok: true,
      verified: true,
      txId: txId.trim(),
      op,
      repoRoot: normRepo,
      targetFile: journal.targetFile,
      targetMode: journal.targetMode,
      isolatedStagedPath: journal.isolatedStagedPath,
      backupPath: journal.backupPath,
      destinationStagedPath: journal.destinationStagedPath,
      initialSha256: expectedInitialSha,
      resultSha256: expectedResultSha,
      targetDev: liveTargetRes.dev,
      targetIno: liveTargetRes.ino,
      candidateDev: candidateRes.dev,
      candidateIno: candidateRes.ino,
      backupDev: backupRes.dev,
      backupIno: backupRes.ino,
      stagingDev: stagingRes.dev,
      stagingIno: stagingRes.ino,
      parentDev: parentStat.dev,
      parentIno: parentStat.ino,
    };

    if (retainParentDescriptor) {
      const transferredFd = parentFd;
      parentFd = null; // Ownership transferred: core will not close in finally
      descriptorTransferred = true;
      return {
        ...verificationResult,
        parentFd: transferredFd,
        parentStat,
      };
    }

    return verificationResult;
  } catch (err) {
    verificationException = err;
    throw err;
  } finally {
    // F1-D / C1: Fail closed on destination parent descriptor closure errors when not transferred
    if (parentFd !== null && !descriptorTransferred) {
      const fdToClose = parentFd;
      parentFd = null; // Relinquish ownership immediately; do not retry close
      let closeErr = null;
      try {
        fs.closeSync(fdToClose);
      } catch (err) {
        closeErr = err;
      }

      if (closeErr) {
        const secondaryDiagnostic = {
          error: closeErr.message,
          message: closeErr.message,
          code: closeErr.code || 'parent-dir-close-error',
          uncertain: true,
          status: 'failed',
        };

        if (verificationException) {
          // Preserve primary verification exception when cleanup also fails
          if (typeof verificationException === 'object' && verificationException !== null && !verificationException.closeError) {
            verificationException.closeError = secondaryDiagnostic;
          }
        } else if (verificationResult && verificationResult.ok === true) {
          // A failed descriptor close cannot return verified: true
          return {
            ok: false,
            verified: false,
            error: `Failed to close destination parent directory descriptor: ${closeErr.message}`,
            code: closeErr.code || 'parent-dir-close-error',
            stage: 'destination-parent',
            reason: closeErr.message,
            closeError: secondaryDiagnostic,
            descriptorCloseUncertain: true,
          };
        } else if (verificationResult && verificationResult.ok === false) {
          // F2-A: When authentication has already produced a structured { ok: false } result,
          // preserve primary code, stage, reason, and attach secondary close error in diagnostic field.
          verificationResult.closeError = secondaryDiagnostic;
          verificationResult.descriptorCloseUncertain = true;
        }
      }
    }
  }
}

/**
 * Public Stage B read-only pre-swap authentication entry point.
 * Asynchronous function returning a Promise, strictly read-only:
 * never mutates, renames, writes, unlinks, or chmods any file.
 *
 * Always runs with descriptor retention disabled: all opened descriptors are
 * closed before returning. Never exposes raw file descriptors.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function authenticateSwapPrerequisites(options = {}) {
  return authenticatePrerequisitesCore(options, { retainParentDescriptor: false });
}

/**
 * Aliases for authenticateSwapPrerequisites.
 */
export const authenticatePreSwap = authenticateSwapPrerequisites;

/**
 * Reserved placeholder for future Stage C live-target swap.
 * Intentionally unimplemented in Stage B and Stage C1; fails closed.
 */
export async function swapVerifiedTarget() {
  const err = new Error('Live target swap is not implemented: reserved for Stage C (D01-P3B-2D-2-C)');
  err.code = 'unimplemented-stage-c';
  throw err;
}

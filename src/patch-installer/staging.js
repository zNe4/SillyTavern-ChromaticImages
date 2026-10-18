import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getCiPatchDir,
  getPathLstat,
  validateCiPatchPath,
} from './lock.js';

const TX_ID_REGEX = /^ci-tx-[0-9]+-[0-9a-f]+$/i;

import {
  inspectJournal,
  advanceJournalPhase,
  verifyLockOwnershipForMutation,
  isValidDeviceIdentifier,
  isValidInodeIdentifier,
} from './journal.js';

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

const MAX_SOURCE_FILE_BYTES = 50 * 1024 * 1024; // 50 MiB

let bundledManifestPath = BUNDLED_MANIFEST_PATH;

/**
 * Test-only seam to redirect manifest location to a disposable directory.
 * @internal
 * @param {string|null} customPath
 */
export function _setBundledManifestPathForTest(customPath) {
  bundledManifestPath = customPath || BUNDLED_MANIFEST_PATH;
}

/**
 * Compute SHA-256 lowercase hex digest.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute Git blob SHA-1 lowercase hex digest.
 * Format: "blob <size>\0<bytes>"
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeGitBlobSha(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto
    .createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

/**
 * Synchronize a file or directory entry to durable storage.
 * Explicitly returns identifiable failure rather than ignoring or discarding sync errors.
 *
 * @param {string} targetPath
 * @param {string} stage
 * @param {boolean} [isDirectory=false]
 * @param {(stage: string, context?: object) => void} [runFault]
 * @returns {{ ok: boolean, error?: string, code?: string, stage?: string }}
 */
function syncPathDurable(targetPath, stage, isDirectory = false, runFault = null, constants = fs.constants) {
  if (typeof runFault === 'function') {
    runFault(`sync-${stage}`, { targetPath, isDirectory });
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
    fd = fs.openSync(targetPath, openFlags);
    fs.fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    if (err?._isFault) {
      throw err;
    }
    return {
      ok: false,
      error: `Filesystem synchronization failed during "${stage}" for "${targetPath}": ${err.message}`,
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
 * Read a file through a bounded descriptor-level loop with pre/post stat verification.
 * Guarantees bounded reads, unexpected EOF detection, concurrent expansion detection,
 * and immutable descriptor inode identity with strict O_NOFOLLOW protection.
 *
 * @param {string} absPath
 * @param {object} [options]
 * @param {object} [options._testConstants]
 * @returns {{
 *   buffer: Buffer,
 *   stat: fs.Stats,
 *   sha256: string,
 *   gitBlobSha: string
 * }}
 */
export function readLiveSourceFile(absPath, options = {}) {
  const constants = options?._testConstants || fs.constants;
  if (!constants.O_NOFOLLOW) {
    throw new Error('Unsupported platform: O_NOFOLLOW file open flag is required for safe descriptor access');
  }

  const check = getPathLstat(absPath);
  if (check.error) {
    throw new Error(`Failed to inspect source file: ${check.error.message}`);
  }
  if (!check.exists || !check.isFile || check.isSymbolicLink) {
    throw new Error(`Source file "${absPath}" does not exist, is not a regular file, or is a symbolic link`);
  }

  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const fd = fs.openSync(absPath, openFlags);
  try {
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      throw new Error(`Source descriptor for "${absPath}" is not a regular file`);
    }

    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let totalRead = 0;

    while (totalRead < expectedSize) {
      const bytesRead = fs.readSync(fd, buffer, totalRead, expectedSize - totalRead, totalRead);
      if (bytesRead === 0) {
        throw new Error(`Unexpected EOF reading source: read ${totalRead} of ${expectedSize} bytes`);
      }
      totalRead += bytesRead;
    }

    // Check for concurrent expansion
    const extraBuf = Buffer.alloc(1);
    const extraRead = fs.readSync(fd, extraBuf, 0, 1, expectedSize);
    if (extraRead > 0) {
      throw new Error(`Source file expanded concurrently during reading: "${absPath}"`);
    }

    const postStat = fs.fstatSync(fd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== preStat.size ||
      postStat.mtimeMs !== preStat.mtimeMs
    ) {
      throw new Error(`Source file modified concurrently during reading: "${absPath}"`);
    }

    return {
      buffer,
      stat: postStat,
      sha256: computeSha256(buffer),
      gitBlobSha: computeGitBlobSha(buffer),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Apply patch bytes to an isolated staging worktree using Git over standard input.
 * Strictly consumes authenticated patch bytes from memory without reading from a patch pathname.
 *
 * @param {string} stagingTxDir
 * @param {Buffer} patchBytes
 * @param {'apply' | 'remove'} [op='apply']
 * @returns {{ ok: boolean, error?: string, code?: string }}
 */
export function applyPatchToIsolatedWorktree(stagingTxDir, patchBytes, op = 'apply') {
  if (!Buffer.isBuffer(patchBytes) || patchBytes.length === 0) {
    return {
      ok: false,
      error: 'Cannot apply patch: patchBytes must be a non-empty Buffer',
      code: 'invalid-patch-bytes',
    };
  }

  const gitArgs = ['--no-optional-locks', '-C', stagingTxDir, 'apply', '-p3'];
  if (op === 'remove') {
    gitArgs.push('-R');
  }

  const scrubbedEnv = {
    PATH: process.env.PATH,
    GIT_DIR: '/dev/null',
    GIT_WORK_TREE: stagingTxDir,
    GIT_INDEX_FILE: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: stagingTxDir,
  };

  let gitRes;
  try {
    gitRes = child_process.spawnSync('git', gitArgs, {
      env: scrubbedEnv,
      input: patchBytes,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (spawnErr) {
    return {
      ok: false,
      error: `Failed to spawn Git executable: ${spawnErr.message}`,
      code: spawnErr.code || 'git-spawn-failed',
    };
  }

  if (gitRes.error) {
    return {
      ok: false,
      error: `Git process spawn error: ${gitRes.error.message}`,
      code: gitRes.error.code || 'git-spawn-failed',
    };
  }

  if (gitRes.signal) {
    return {
      ok: false,
      error: `Git patch execution terminated by signal: ${gitRes.signal}`,
      code: 'git-process-terminated',
    };
  }

  if (gitRes.status !== 0) {
    const stderrStr = gitRes.stderr ? gitRes.stderr.toString('utf8').trim() : '';
    return {
      ok: false,
      error: `Git patch execution failed (exit ${gitRes.status}): ${stderrStr}`,
      code: 'git-apply-failed',
    };
  }

  return { ok: true };
}

/**
 * Prepare and verify patched or unpatched content in an isolated transaction staging directory.
 * Never mutates or replaces the live SillyTavern checkout.
 * Executes native Git apply with a scrubbed environment and rigorous output verification.
 * Advances the journal from LOCKED to ISOLATED_PREPARED registering isolatedStagedPath.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {'apply' | 'remove'} options.op
 * @param {import('./lock.js').TransactionLease} options.lease
 * @param {object} [options.manifest]
 * @param {string} [options.patchPath]
 * @param {(stage: string, context?: object) => void} [options.faultHook]
 * @returns {Promise<{
 *   ok: boolean,
 *   isolatedStagedPath?: string,
 *   journal?: object,
 *   sha256?: string,
 *   gitBlobSha?: string,
 *   error?: string,
 *   code?: string,
 *   stage?: string
 * }>}
 */
export async function prepareIsolatedPatch(options = {}) {
  const {
    repoRoot,
    txId,
    op,
    lease,
    manifest: providedManifest = null,
    patchPath: providedPatchPath = null,
    faultHook = null,
  } = options;

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

  if (!fs.constants.O_NOFOLLOW) {
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

  // 1. Authenticate lock ownership & lease capability
  const lockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, lease);
  if (!lockAuth.ok) {
    return {
      ok: false,
      error: lockAuth.reason || lockAuth.error,
      code: lockAuth.error,
    };
  }

  // 2. Authenticate journal state
  const journalInspection = inspectJournal(repoRoot);
  if (!journalInspection.hasJournal || !journalInspection.isValid || !journalInspection.journal) {
    return {
      ok: false,
      error: `Cannot prepare isolated staging: valid journal required (errors: ${journalInspection.errors.join('; ')})`,
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

  if (journal.phase !== 'LOCKED') {
    return {
      ok: false,
      error: `Isolated patch preparation requires journal in phase "LOCKED", observed "${journal.phase}"`,
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

  runFault('after-preconditions', { journal });

  // 3. Certified Manifest and Patch Authentication (Finding B)
  const pkgCheck = await verifyPatchManifest(bundledManifestPath);
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

  // Caller override policy: reject unauthenticated overrides before executing any patch
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

  const certifiedPatchPath = path.resolve(path.dirname(bundledManifestPath), patchEntry.patchFile);

  if (providedPatchPath !== null) {
    const normProvided = path.resolve(providedPatchPath);
    if (normProvided !== certifiedPatchPath) {
      return {
        ok: false,
        error: `Caller-supplied patchPath "${providedPatchPath}" does not match certified patch "${certifiedPatchPath}"`,
        code: 'unauthenticated-patch-override',
      };
    }
  }

  // Safe descriptor read and verification of certified packaged patch
  const patchLstat = getPathLstat(certifiedPatchPath);
  if (patchLstat.error) {
    return {
      ok: false,
      error: `Failed to inspect certified patch file: ${patchLstat.error.message}`,
      code: 'tampered-patch-file',
    };
  }
  if (!patchLstat.exists || !patchLstat.isFile || patchLstat.isSymbolicLink) {
    return {
      ok: false,
      error: `Certified patch file "${certifiedPatchPath}" is missing, not a regular file, or is a symbolic link`,
      code: 'tampered-patch-file',
    };
  }

  let patchBytes;
  try {
    const patchFd = fs.openSync(certifiedPatchPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const pStat = fs.fstatSync(patchFd);
      if (!pStat.isFile() || pStat.isSymbolicLink()) {
        return {
          ok: false,
          error: 'Certified patch descriptor is not a regular file',
          code: 'tampered-patch-file',
        };
      }
      if (pStat.size !== patchEntry.sizeBytes) {
        return {
          ok: false,
          error: `Certified patch file size mismatch: got ${pStat.size}, expected ${patchEntry.sizeBytes}`,
          code: 'tampered-patch-file',
        };
      }
      patchBytes = Buffer.alloc(pStat.size);
      let readBytes = 0;
      while (readBytes < pStat.size) {
        const n = fs.readSync(patchFd, patchBytes, readBytes, pStat.size - readBytes, readBytes);
        if (n === 0) break;
        readBytes += n;
      }
      if (readBytes !== pStat.size) {
        return {
          ok: false,
          error: 'Unexpected short read from certified patch file',
          code: 'tampered-patch-file',
        };
      }
    } finally {
      fs.closeSync(patchFd);
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read certified patch file: ${err.message}`,
      code: 'tampered-patch-file',
    };
  }

  if (computeSha256(patchBytes) !== patchEntry.sha256.toLowerCase()) {
    return {
      ok: false,
      error: `Certified patch SHA-256 digest mismatch: expected "${patchEntry.sha256}"`,
      code: 'tampered-patch-file',
    };
  }

  runFault('after-patch-read', { certifiedPatchPath });

  if (journal.targetFile !== patchEntry.targetFile) {
    return {
      ok: false,
      error: `Journal targetFile "${journal.targetFile}" does not match manifest targetFile "${patchEntry.targetFile}"`,
      code: 'target-file-mismatch',
    };
  }

  const stockSha = (patchEntry.original?.sha256 || patchEntry.stockSha256 || '').toLowerCase();
  const stockBlob = (patchEntry.original?.gitBlobSha || patchEntry.stockGitBlobSha || '').toLowerCase();
  const patchedSha = (patchEntry.expected?.sha256 || patchEntry.patchedSha256 || '').toLowerCase();
  const patchedBlob = (patchEntry.expected?.gitBlobSha || patchEntry.patchedGitBlobSha || '').toLowerCase();

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

  // 4. Staging Directories Setup and Strict Path Safety (Finding C)
  if (!isSafeRelativePath(journal.targetFile)) {
    return {
      ok: false,
      error: `Journal targetFile "${journal.targetFile}" is not a safe relative path`,
      code: 'invalid-target-file',
    };
  }

  const absLiveTarget = path.resolve(repoRoot, journal.targetFile);
  if (!absLiveTarget.startsWith(path.resolve(repoRoot) + path.sep)) {
    return {
      ok: false,
      error: `Live target file "${absLiveTarget}" escapes repository root`,
      code: 'target-path-escape',
    };
  }

  // Validate all parent directory components of targetFile relative to repoRoot
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

  const ciPatchCheck = validateCiPatchPath(repoRoot);
  if (!ciPatchCheck.ok || !ciPatchCheck.exists || !ciPatchCheck.isDirectory || ciPatchCheck.isSymlink) {
    return {
      ok: false,
      error: ciPatchCheck.error || 'Installer directory (.ci-patch) is invalid, missing, or is a symbolic link',
      code: ciPatchCheck.isSymlink ? 'unsafe-symlink' : 'invalid-installer-dir',
    };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  const stagingBaseDir = path.join(ciPatchDir, 'staging');
  const stagingTxDir = path.join(stagingBaseDir, txId);
  const targetBase = path.basename(journal.targetFile);
  const isolatedStagedFile = path.join(stagingTxDir, targetBase);

  // Validate .ci-patch/staging
  const stagingBaseCheck = getPathLstat(stagingBaseDir);
  if (stagingBaseCheck.error && stagingBaseCheck.error.code !== 'ENOENT') {
    return {
      ok: false,
      error: `Failed to inspect staging parent directory (.ci-patch/staging): ${stagingBaseCheck.error.message}`,
      code: 'inspection-error',
    };
  }
  if (stagingBaseCheck.isSymbolicLink) {
    return {
      ok: false,
      error: 'Staging directory (.ci-patch/staging) is a symbolic link',
      code: 'unsafe-symlink',
    };
  }
  if (stagingBaseCheck.exists && !stagingBaseCheck.isDirectory) {
    return {
      ok: false,
      error: 'Staging path (.ci-patch/staging) exists but is not a directory',
      code: 'invalid-staging-dir',
    };
  }

  if (!stagingBaseCheck.exists) {
    try {
      fs.mkdirSync(stagingBaseDir, { mode: 0o700 });
    } catch (mkdirErr) {
      return {
        ok: false,
        error: `Failed to create staging parent directory: ${mkdirErr.message}`,
        code: mkdirErr.code || 'staging-dir-failed',
      };
    }
    const verifyBase = getPathLstat(stagingBaseDir);
    if (!verifyBase.exists || !verifyBase.isDirectory || verifyBase.isSymbolicLink) {
      return {
        ok: false,
        error: 'Staging parent directory verification failed after creation',
        code: 'staging-dir-failed',
      };
    }
    const syncRes = syncPathDurable(ciPatchDir, 'staging-parent', true, runFault);
    if (!syncRes.ok) {
      return syncRes;
    }
  }

  // Validate .ci-patch/staging/<txId>
  const txDirCheck = getPathLstat(stagingTxDir);
  if (txDirCheck.error && txDirCheck.error.code !== 'ENOENT') {
    return {
      ok: false,
      error: `Failed to inspect staging transaction directory: ${txDirCheck.error.message}`,
      code: 'inspection-error',
    };
  }
  if (txDirCheck.exists || txDirCheck.isSymbolicLink) {
    return {
      ok: false,
      error: `Staging directory already exists for transaction "${txId}" (collision)`,
      code: 'staging-collision',
    };
  }

  runFault('before-dir-allocation', { stagingTxDir });

  try {
    fs.mkdirSync(stagingTxDir, { mode: 0o700 });
  } catch (mkdirErr) {
    return {
      ok: false,
      error: `Failed to create isolated transaction staging directory: ${mkdirErr.message}`,
      code: mkdirErr.code || 'staging-dir-failed',
    };
  }

  const verifyTxDir = getPathLstat(stagingTxDir);
  if (!verifyTxDir.exists || !verifyTxDir.isDirectory || verifyTxDir.isSymbolicLink) {
    return {
      ok: false,
      error: 'Transaction staging directory verification failed after creation',
      code: 'staging-dir-failed',
    };
  }

  const txDirSync = syncPathDurable(stagingBaseDir, 'staging-txdir-parent', true, runFault);
  if (!txDirSync.ok) {
    return txDirSync;
  }

  runFault('after-dir-allocation', { stagingTxDir });

  // 5. Source acquisition via bounded descriptor reader
  runFault('before-source-read', { absLiveTarget });

  let liveSource;
  try {
    liveSource = readLiveSourceFile(absLiveTarget);
  } catch (readErr) {
    return {
      ok: false,
      error: `Failed to read and authenticate live target source: ${readErr.message}`,
      code: 'source-read-failed',
    };
  }

  if (liveSource.sha256.toLowerCase() !== expectedInitialSha) {
    return {
      ok: false,
      error: `Live target SHA-256 mismatch for "${op}": got "${liveSource.sha256}", expected "${expectedInitialSha}"`,
      code: 'initial-sha256-mismatch',
    };
  }

  if (liveSource.gitBlobSha.toLowerCase() !== expectedInitialBlob) {
    return {
      ok: false,
      error: `Live target Git blob SHA mismatch for "${op}": got "${liveSource.gitBlobSha}", expected "${expectedInitialBlob}"`,
      code: 'initial-blob-mismatch',
    };
  }

  runFault('after-source-read', { liveSource });

  // 6. Isolated source file creation & initial synchronization (Finding A & C)
  runFault('before-file-create', { isolatedStagedFile });

  let initialFd = null;
  try {
    initialFd = fs.openSync(
      isolatedStagedFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );

    runFault('during-source-write', { stagedFd: initialFd });

    let written = 0;
    while (written < liveSource.buffer.length) {
      const bytesWritten = fs.writeSync(
        initialFd,
        liveSource.buffer,
        written,
        liveSource.buffer.length - written,
        written
      );
      if (bytesWritten === 0) {
        throw new Error('Short write writing source buffer to isolated staging');
      }
      written += bytesWritten;
    }

    try {
      fs.fsyncSync(initialFd);
    } catch (syncErr) {
      if (syncErr?._isFault) throw syncErr;
      return {
        ok: false,
        error: `Failed to synchronize staged source file: ${syncErr.message}`,
        code: syncErr.code || 'fsync-failed',
        stage: 'sync-initial-staged-file',
      };
    }
  } catch (writeErr) {
    if (writeErr?._isFault) {
      throw writeErr;
    }
    return {
      ok: false,
      error: `Failed to create isolated staged file: ${writeErr.message}`,
      code: writeErr.code || 'staged-file-write-failed',
    };
  } finally {
    if (initialFd !== null) {
      try {
        fs.closeSync(initialFd);
      } catch {
        // ignore
      }
      initialFd = null;
    }
  }

  const stagedPostStat = getPathLstat(isolatedStagedFile);
  if (!stagedPostStat.exists || !stagedPostStat.isFile || stagedPostStat.isSymbolicLink) {
    return {
      ok: false,
      error: 'Staged source file verification failed after write',
      code: 'invalid-staged-result',
    };
  }

  const initialTxSync = syncPathDurable(stagingTxDir, 'initial-staged-txdir', true, runFault);
  if (!initialTxSync.ok) {
    return initialTxSync;
  }

  runFault('after-file-create', { isolatedStagedFile });

  // 7. Native Git patch application via authenticated standard input (Finding A)
  runFault('before-git-apply', { isolatedStagedFile });

  const gitRes = applyPatchToIsolatedWorktree(stagingTxDir, patchBytes, op);
  if (!gitRes.ok) {
    return gitRes;
  }

  runFault('after-git-apply', { stagingTxDir });

  // 8. Descriptor-bound finalization protocol (Finding B)
  // Step 1: The staging directory contains exactly the expected regular file.
  let childrenAfter;
  try {
    childrenAfter = fs.readdirSync(stagingTxDir);
  } catch (dirErr) {
    return {
      ok: false,
      error: `Failed to inspect staging directory after patch application: ${dirErr.message}`,
      code: 'post-apply-inspection-failed',
    };
  }

  if (childrenAfter.length !== 1 || childrenAfter[0] !== targetBase) {
    return {
      ok: false,
      error: `Staging directory contains unexpected artifacts after patch application: ${childrenAfter.join(', ')}`,
      code: 'unexpected-staging-artifacts',
    };
  }

  // Steps 2 - 10: Retain verified open descriptor across content verification, permissions, sync, and identity check
  let stagedFd = null;
  let stagedResult = null;
  try {
    // Step 2: The staged file is opened with appropriate no-follow protection.
    const openFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    try {
      stagedFd = fs.openSync(isolatedStagedFile, openFlags);
    } catch (openErr) {
      if (openErr?._isFault) throw openErr;
      return {
        ok: false,
        error: `Failed to open staged file descriptor: ${openErr.message}`,
        code: openErr.code === 'ELOOP' ? 'unsafe-symlink' : 'staged-open-failed',
      };
    }

    // Step 3: The open descriptor is verified using fstatSync().
    const preStat = fs.fstatSync(stagedFd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return {
        ok: false,
        error: 'Staged file descriptor is not a regular file',
        code: 'invalid-staged-result',
      };
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      return {
        ok: false,
        error: 'Staged file descriptor has invalid device or inode identity',
        code: 'invalid-file-identity',
      };
    }
    if (preStat.size > MAX_SOURCE_FILE_BYTES) {
      return {
        ok: false,
        error: `Staged file size (${preStat.size} bytes) exceeds maximum allowable size (${MAX_SOURCE_FILE_BYTES} bytes)`,
        code: 'file-too-large',
      };
    }

    // Step 4: The file contents are read from that descriptor.
    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let readBytes = 0;
    while (readBytes < expectedSize) {
      const chunk = fs.readSync(stagedFd, buffer, readBytes, expectedSize - readBytes, readBytes);
      if (chunk === 0) {
        return {
          ok: false,
          error: `Unexpected EOF reading staged file descriptor: read ${readBytes} of ${expectedSize} bytes`,
          code: 'unexpected-eof',
        };
      }
      readBytes += chunk;
    }

    const extraCheck = Buffer.alloc(1);
    const extra = fs.readSync(stagedFd, extraCheck, 0, 1, expectedSize);
    if (extra !== 0) {
      return {
        ok: false,
        error: 'Staged file expanded concurrently during descriptor read',
        code: 'concurrent-expansion',
      };
    }

    // Step 5: SHA-256 and Git blob fingerprints are verified.
    const actualSha256 = computeSha256(buffer);
    const actualGitBlobSha = computeGitBlobSha(buffer);

    if (actualSha256.toLowerCase() !== expectedResultSha) {
      return {
        ok: false,
        error: `Patched result SHA-256 mismatch: got "${actualSha256}", expected "${expectedResultSha}"`,
        code: 'result-sha256-mismatch',
      };
    }

    if (actualGitBlobSha.toLowerCase() !== expectedResultBlob) {
      return {
        ok: false,
        error: `Patched result Git blob SHA mismatch: got "${actualGitBlobSha}", expected "${expectedResultBlob}"`,
        code: 'result-blob-mismatch',
      };
    }

    stagedResult = {
      buffer,
      stat: preStat,
      sha256: actualSha256,
      gitBlobSha: actualGitBlobSha,
    };

    // Step 6: Required permissions are established through fchmodSync() on the authenticated descriptor.
    try {
      fs.fchmodSync(stagedFd, 0o600);
    } catch (chmodErr) {
      if (chmodErr?._isFault) throw chmodErr;
      return {
        ok: false,
        error: `Failed to set permissions on staged file descriptor: ${chmodErr.message}`,
        code: chmodErr.code || 'chmod-failed',
        stage: 'sync-output-file',
      };
    }

    // Step 7: File data and metadata are synchronized using the authenticated descriptor.
    runFault('sync-output-file', { isolatedStagedFile, stagedFd });
    try {
      fs.fsyncSync(stagedFd);
    } catch (syncErr) {
      if (syncErr?._isFault) throw syncErr;
      return {
        ok: false,
        error: `Failed to synchronize staged file descriptor: ${syncErr.message}`,
        code: syncErr.code || 'fsync-failed',
        stage: 'sync-output-file',
      };
    }

    // Step 8: Descriptor identity is checked again after synchronization.
    const postStat = fs.fstatSync(stagedFd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== expectedSize ||
      !postStat.isFile()
    ) {
      return {
        ok: false,
        error: 'Staged file descriptor identity changed during synchronization',
        code: 'staged-identity-changed',
      };
    }
    if ((postStat.mode & 0o777) !== 0o600) {
      return {
        ok: false,
        error: `Staged file descriptor mode mismatch after chmod/fsync: got 0o${(postStat.mode & 0o777).toString(8)}, expected 0o600`,
        code: 'staged-mode-mismatch',
      };
    }

    // Step 9 & 10: The expected staged pathname is checked using lstatSync().
    // The pathname must still resolve to the authenticated device/inode identity.
    runFault('before-pathname-identity-check', { isolatedStagedFile, stagedFd, preStat });

    let pathStat;
    try {
      pathStat = fs.lstatSync(isolatedStagedFile);
    } catch (lstatErr) {
      if (lstatErr?._isFault) throw lstatErr;
      return {
        ok: false,
        error: `Staged pathname missing or unreadable before journal advancement: ${lstatErr.message}`,
        code: 'staged-pathname-missing',
      };
    }

    if (pathStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Staged pathname "${isolatedStagedFile}" was replaced by a symbolic link`,
        code: 'unsafe-symlink',
      };
    }

    if (!pathStat.isFile()) {
      return {
        ok: false,
        error: `Staged pathname "${isolatedStagedFile}" is not a regular file`,
        code: 'invalid-staged-result',
      };
    }

    if (pathStat.dev !== preStat.dev || pathStat.ino !== preStat.ino) {
      return {
        ok: false,
        error: `Staged pathname "${isolatedStagedFile}" inode identity changed before journal advancement (dev: ${pathStat.dev} vs ${preStat.dev}, ino: ${pathStat.ino} vs ${preStat.ino})`,
        code: 'staged-identity-replaced',
      };
    }
  } finally {
    if (stagedFd !== null) {
      try {
        fs.closeSync(stagedFd);
      } catch {
        // ignore close error
      }
    }
  }

  // Step 11: Required containing directories are synchronized.
  const syncTxDir = syncPathDurable(stagingTxDir, 'output-txdir', true, runFault);
  if (!syncTxDir.ok) {
    return syncTxDir;
  }

  const syncStagingParent = syncPathDurable(stagingBaseDir, 'output-staging-parent', true, runFault);
  if (!syncStagingParent.ok) {
    return syncStagingParent;
  }

  const syncCiPatch = syncPathDurable(ciPatchDir, 'output-ci-patch', true, runFault);
  if (!syncCiPatch.ok) {
    return syncCiPatch;
  }

  runFault('after-output-verification', { stagedResult });

  // 9. Journal Advancement
  const relIsolatedStagedPath = `.ci-patch/staging/${txId}/${targetBase}`;

  runFault('before-journal-advancement', { relIsolatedStagedPath });

  const advanceRes = advanceJournalPhase({
    repoRoot,
    txId,
    nextPhase: 'ISOLATED_PREPARED',
    metadataUpdate: {
      isolatedStagedPath: relIsolatedStagedPath,
    },
    lease,
  });

  if (!advanceRes.ok) {
    return {
      ok: false,
      error: `Failed to advance journal to ISOLATED_PREPARED: ${advanceRes.error}`,
      code: advanceRes.code || 'journal-advancement-failed',
      stage: advanceRes.stage,
    };
  }

  runFault('after-journal-advancement', { journal: advanceRes.journal });

  return {
    ok: true,
    isolatedStagedPath: relIsolatedStagedPath,
    journal: advanceRes.journal,
    sha256: stagedResult.sha256,
    gitBlobSha: stagedResult.gitBlobSha,
  };
}

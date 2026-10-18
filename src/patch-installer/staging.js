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
 * @param {string} [options._testCorruptPatchPath]
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
    _testCorruptPatchPath = null,
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

  const certifiedPatchPath = path.resolve(path.dirname(BUNDLED_MANIFEST_PATH), patchEntry.patchFile);

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

  let stagedFd = null;
  try {
    stagedFd = fs.openSync(
      isolatedStagedFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );

    runFault('during-source-write', { stagedFd });

    let written = 0;
    while (written < liveSource.buffer.length) {
      const bytesWritten = fs.writeSync(
        stagedFd,
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
      fs.fsyncSync(stagedFd);
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
    if (stagedFd !== null) {
      try {
        fs.closeSync(stagedFd);
      } catch {
        // ignore
      }
      stagedFd = null;
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

  // 7. Native Git patch application
  const patchPathForGit = _testCorruptPatchPath || certifiedPatchPath;

  runFault('before-git-apply', { isolatedStagedFile, resolvedPatchPath: patchPathForGit });

  const gitArgs = ['--no-optional-locks', '-C', stagingTxDir, 'apply', '-p3'];
  if (op === 'remove') {
    gitArgs.push('-R');
  }
  gitArgs.push(patchPathForGit);

  const scrubbedEnv = {
    PATH: process.env.PATH,
    GIT_DIR: '/dev/null',
    GIT_WORK_TREE: stagingTxDir,
    GIT_INDEX_FILE: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: stagingTxDir,
  };

  const gitRes = child_process.spawnSync('git', gitArgs, {
    env: scrubbedEnv,
    stdio: 'pipe',
  });

  if (gitRes.status !== 0) {
    const stderrStr = gitRes.stderr ? gitRes.stderr.toString('utf8').trim() : '';
    return {
      ok: false,
      error: `Git patch execution failed (exit ${gitRes.status}): ${stderrStr}`,
      code: 'git-apply-failed',
    };
  }

  runFault('after-git-apply', { stagingTxDir });

  // 8. Prepared output verification, permissions, and synchronization (Finding A & C)
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

  let postFd = null;
  try {
    postFd = fs.openSync(isolatedStagedFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const postStat = fs.fstatSync(postFd);
    if (!postStat.isFile() || postStat.isSymbolicLink()) {
      return {
        ok: false,
        error: 'Staged result descriptor is missing, not a regular file, or is a symbolic link',
        code: 'invalid-staged-result',
      };
    }
    fs.fchmodSync(postFd, 0o600);
    fs.fsyncSync(postFd);
  } catch (permErr) {
    if (permErr?._isFault) throw permErr;
    return {
      ok: false,
      error: `Failed to establish permissions and synchronize staged result descriptor: ${permErr.message}`,
      code: permErr.code || 'fsync-failed',
      stage: 'sync-output-file',
    };
  } finally {
    if (postFd !== null) {
      try {
        fs.closeSync(postFd);
      } catch {
        // ignore
      }
    }
  }

  let stagedResult;
  try {
    stagedResult = readLiveSourceFile(isolatedStagedFile);
  } catch (readErr) {
    return {
      ok: false,
      error: `Failed to read and verify patched result: ${readErr.message}`,
      code: 'result-read-failed',
    };
  }

  if (stagedResult.sha256.toLowerCase() !== expectedResultSha) {
    return {
      ok: false,
      error: `Patched result SHA-256 mismatch: got "${stagedResult.sha256}", expected "${expectedResultSha}"`,
      code: 'result-sha256-mismatch',
    };
  }

  if (stagedResult.gitBlobSha.toLowerCase() !== expectedResultBlob) {
    return {
      ok: false,
      error: `Patched result Git blob SHA mismatch: got "${stagedResult.gitBlobSha}", expected "${expectedResultBlob}"`,
      code: 'result-blob-mismatch',
    };
  }

  // Synchronize file and directory entries strictly (Finding A)
  const syncFile = syncPathDurable(isolatedStagedFile, 'output-file', false, runFault);
  if (!syncFile.ok) {
    return syncFile;
  }

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

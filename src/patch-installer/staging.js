import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  getCiPatchDir,
  getPathLstat,
} from './lock.js';

import {
  inspectJournal,
  advanceJournalPhase,
  verifyLockOwnershipForMutation,
} from './journal.js';

import { verifyPatchManifest } from '../../scripts/verify-sillytavern-patches.mjs';

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
 * Read a file through a bounded descriptor-level loop with pre/post stat verification.
 * Guarantees bounded reads, unexpected EOF detection, concurrent expansion detection,
 * and immutable descriptor inode identity.
 *
 * @param {string} absPath
 * @returns {{
 *   buffer: Buffer,
 *   stat: fs.Stats,
 *   sha256: string,
 *   gitBlobSha: string
 * }}
 */
export function readLiveSourceFile(absPath) {
  const check = getPathLstat(absPath);
  if (check.error) {
    throw new Error(`Failed to inspect source file: ${check.error.message}`);
  }
  if (!check.exists || !check.isFile || check.isSymbolicLink) {
    throw new Error(`Source file "${absPath}" does not exist, is not a regular file, or is a symbolic link`);
  }

  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
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

  // 3. Manifest verification & fingerprint assertion
  let manifest = providedManifest;
  let resolvedPatchPath = providedPatchPath;
  if (!manifest) {
    const pkgCheck = await verifyPatchManifest(BUNDLED_MANIFEST_PATH);
    if (!pkgCheck.ok || !pkgCheck.manifest) {
      return {
        ok: false,
        error: `Distribution package manifest verification failed: ${pkgCheck.errors.join('; ')}`,
        code: 'manifest-verification-failed',
      };
    }
    manifest = pkgCheck.manifest;
    if (!resolvedPatchPath) {
      resolvedPatchPath = path.resolve(path.dirname(BUNDLED_MANIFEST_PATH), manifest.patches.runtime.patchFile);
    }
  } else if (!resolvedPatchPath) {
    resolvedPatchPath = path.resolve(path.dirname(BUNDLED_MANIFEST_PATH), manifest.patches.runtime.patchFile);
  }

  const patchEntry = manifest.patches?.runtime;
  if (!patchEntry) {
    return {
      ok: false,
      error: 'Manifest missing runtime patch configuration',
      code: 'manifest-invalid',
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

  // 4. Staging directories setup and exclusive allocation
  const ciPatchDir = getCiPatchDir(repoRoot);
  const stagingBaseDir = path.join(ciPatchDir, 'staging');
  const stagingTxDir = path.join(stagingBaseDir, txId);
  const targetBase = path.basename(journal.targetFile);
  const isolatedStagedFile = path.join(stagingTxDir, targetBase);

  const txDirCheck = getPathLstat(stagingTxDir);
  if (txDirCheck.exists) {
    return {
      ok: false,
      error: `Staging directory already exists for transaction "${txId}" (collision)`,
      code: 'staging-collision',
    };
  }

  runFault('before-dir-allocation', { stagingTxDir });

  if (!fs.existsSync(stagingBaseDir)) {
    fs.mkdirSync(stagingBaseDir, { mode: 0o700, recursive: true });
  }

  try {
    fs.mkdirSync(stagingTxDir, { mode: 0o700 });
  } catch (mkdirErr) {
    return {
      ok: false,
      error: `Failed to create isolated transaction staging directory: ${mkdirErr.message}`,
      code: mkdirErr.code || 'staging-dir-failed',
    };
  }

  // Flush stagingBaseDir directory entry
  try {
    const baseFd = fs.openSync(stagingBaseDir, 'r');
    try {
      fs.fsyncSync(baseFd);
    } finally {
      fs.closeSync(baseFd);
    }
  } catch {
    // ignore
  }

  runFault('after-dir-allocation', { stagingTxDir });

  // 5. Source acquisition via bounded descriptor reader
  const absLiveTarget = path.resolve(repoRoot, journal.targetFile);
  if (!absLiveTarget.startsWith(path.resolve(repoRoot) + path.sep)) {
    return {
      ok: false,
      error: `Live target file "${absLiveTarget}" escapes repository root`,
      code: 'target-path-escape',
    };
  }

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

  // 6. Isolated source file creation
  runFault('before-file-create', { isolatedStagedFile });

  let stagedFd = null;
  try {
    stagedFd = fs.openSync(
      isolatedStagedFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
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
    fs.fsyncSync(stagedFd);
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

  // Flush stagingTxDir directory entry
  try {
    const txDirFd = fs.openSync(stagingTxDir, 'r');
    try {
      fs.fsyncSync(txDirFd);
    } finally {
      fs.closeSync(txDirFd);
    }
  } catch {
    // ignore
  }

  runFault('after-file-create', { isolatedStagedFile });

  // 7. Native Git patch application
  if (!fs.existsSync(resolvedPatchPath)) {
    return {
      ok: false,
      error: `Patch file not found: "${resolvedPatchPath}"`,
      code: 'patch-file-not-found',
    };
  }

  runFault('before-git-apply', { isolatedStagedFile, resolvedPatchPath });

  const gitArgs = ['--no-optional-locks', '-C', stagingTxDir, 'apply', '-p3'];
  if (op === 'remove') {
    gitArgs.push('-R');
  }
  gitArgs.push(resolvedPatchPath);

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

  // 8. Prepared output verification
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

  const postStatCheck = getPathLstat(isolatedStagedFile);
  if (!postStatCheck.exists || !postStatCheck.isFile || postStatCheck.isSymbolicLink) {
    return {
      ok: false,
      error: 'Staged result file is missing, not a regular file, or is a symbolic link',
      code: 'invalid-staged-result',
    };
  }

  try {
    fs.chmodSync(isolatedStagedFile, 0o600);
  } catch (chmodErr) {
    return {
      ok: false,
      error: `Failed to establish 0600 permissions on staged file: ${chmodErr.message}`,
      code: 'chmod-failed',
    };
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

  // Synchronize file and directory entries
  try {
    const fileFd = fs.openSync(isolatedStagedFile, 'r');
    try {
      fs.fsyncSync(fileFd);
    } finally {
      fs.closeSync(fileFd);
    }

    const txDirFd = fs.openSync(stagingTxDir, 'r');
    try {
      fs.fsyncSync(txDirFd);
    } finally {
      fs.closeSync(txDirFd);
    }

    const baseFd = fs.openSync(stagingBaseDir, 'r');
    try {
      fs.fsyncSync(baseFd);
    } finally {
      fs.closeSync(baseFd);
    }
  } catch {
    // ignore
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

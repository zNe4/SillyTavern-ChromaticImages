import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCiPatchDir,
  getPathLstat,
  validateCiPatchPath,
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
  readLiveSourceFile,
} from './staging.js';

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
const TX_ID_REGEX = /^ci-tx-[0-9]+-[0-9a-f]+$/i;

/**
 * Synchronize a file or directory entry to durable storage.
 * Explicitly returns identifiable failure rather than ignoring or discarding sync errors.
 *
 * @param {string} targetPath
 * @param {string} stage
 * @param {boolean} [isDirectory=false]
 * @param {(stage: string, context?: object) => void} [runFault]
 * @param {object} [constants=fs.constants]
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
 * Extract canonical target mode string from numeric stat mode.
 * Distinguishes permission bits (0o777) from special bits and file type bits.
 * Strictly rejects unsupported setuid (0o4000), setgid (0o2000), or sticky (0o1000) bits.
 * Returns a 4-character octal string matching /^0[0-7]{3}$/ (e.g. "0644").
 *
 * @param {number} mode - Numeric mode from fs.Stats or fstatSync
 * @returns {string} 4-character octal string
 */
export function extractCanonicalTargetMode(mode) {
  if (typeof mode !== 'number' || !Number.isInteger(mode)) {
    throw new Error(`Invalid mode: expected integer, received ${typeof mode}`);
  }

  // Reject unsupported special bits (setuid 0o4000, setgid 0o2000, sticky 0o1000)
  if ((mode & 0o7000) !== 0) {
    const err = new Error(
      `Target file has unsupported special permission bits: 0o${(mode & 0o7777).toString(8)} (setuid/setgid/sticky not permitted)`
    );
    err.code = 'special-permission-bits-unsupported';
    throw err;
  }

  const permBits = mode & 0o777;
  const octalStr = '0' + permBits.toString(8).padStart(3, '0');
  if (!TARGET_MODE_REGEX.test(octalStr)) {
    const err = new Error(`Formatted target mode "${octalStr}" failed TARGET_MODE_REGEX validation`);
    err.code = 'invalid-target-mode';
    throw err;
  }

  return octalStr;
}

/**
 * Reauthenticate the existing isolated staged artifact against journal and manifest.
 *
 * @param {string} repoRoot
 * @param {string} txId
 * @param {object} journal
 * @param {object} patchEntry
 * @param {string} expectedResultSha
 * @param {string} expectedResultBlob
 * @returns {{ ok: boolean, error?: string, code?: string, stagedDev?: number, stagedIno?: number }}
 */
function reauthenticatePreparedStaging(
  repoRoot,
  txId,
  journal,
  patchEntry,
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
  if (!absStaged.startsWith(path.resolve(repoRoot) + path.sep)) {
    return {
      ok: false,
      error: `Isolated staged path "${absStaged}" escapes repository root`,
      code: 'staging-path-escape',
    };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  const stagingBaseDir = path.join(ciPatchDir, 'staging');
  const stagingTxDir = path.join(stagingBaseDir, txId);

  // Check parent path components for symlinks
  const pathComponents = [
    { name: '.ci-patch', p: ciPatchDir },
    { name: 'staging parent (.ci-patch/staging)', p: stagingBaseDir },
    { name: `staging transaction directory (staging/${txId})`, p: stagingTxDir },
  ];

  for (const { name, p } of pathComponents) {
    const stat = getPathLstat(p);
    if (stat.error) {
      return {
        ok: false,
        error: `Failed to inspect ${name}: ${stat.error.message}`,
        code: 'inspection-error',
      };
    }
    if (!stat.exists) {
      return {
        ok: false,
        error: `Staging component ${name} does not exist`,
        code: 'staged-resource-missing',
      };
    }
    if (stat.isSymbolicLink) {
      return {
        ok: false,
        error: `Staging component ${name} is a symbolic link`,
        code: 'unsafe-symlink',
      };
    }
    if (!stat.isDirectory) {
      return {
        ok: false,
        error: `Staging component ${name} is not a directory`,
        code: 'invalid-staging-dir',
      };
    }
  }

  // Exactly permitted contents in stagingTxDir
  let stagingChildren;
  try {
    stagingChildren = fs.readdirSync(stagingTxDir);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read staging directory contents: ${err.message}`,
      code: 'inspection-error',
    };
  }

  if (stagingChildren.length !== 1 || stagingChildren[0] !== targetBase) {
    return {
      ok: false,
      error: `Staging directory contains unexpected artifacts: ${stagingChildren.join(', ')}`,
      code: 'unexpected-staging-artifacts',
    };
  }

  // Check staged file lstat
  const fileLstat = getPathLstat(absStaged);
  if (fileLstat.error) {
    return {
      ok: false,
      error: `Failed to inspect staged file: ${fileLstat.error.message}`,
      code: 'inspection-error',
    };
  }
  if (!fileLstat.exists) {
    return {
      ok: false,
      error: `Staged file "${absStaged}" does not exist`,
      code: 'staged-file-missing',
    };
  }
  if (fileLstat.isSymbolicLink) {
    return {
      ok: false,
      error: `Staged file "${absStaged}" is a symbolic link`,
      code: 'unsafe-symlink',
    };
  }
  if (!fileLstat.isFile) {
    return {
      ok: false,
      error: `Staged file "${absStaged}" is not a regular file`,
      code: 'invalid-staged-result',
    };
  }

  // Safe descriptor-based open and verification
  let stagedFd = null;
  try {
    stagedFd = fs.openSync(absStaged, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
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
    if (expectedDev !== null && expectedIno !== null) {
      if (preStat.dev !== expectedDev || preStat.ino !== expectedIno) {
        return {
          ok: false,
          error: `Staged file descriptor identity changed before journal advancement (dev: ${preStat.dev} vs ${expectedDev}, ino: ${preStat.ino} vs ${expectedIno})`,
          code: 'staged-identity-replaced',
        };
      }
    }
    if ((preStat.mode & 0o777) !== 0o600) {
      return {
        ok: false,
        error: `Staged file mode mismatch: expected 0o600, observed 0o${(preStat.mode & 0o777).toString(8)}`,
        code: 'staged-mode-mismatch',
      };
    }
    if (preStat.size > MAX_SOURCE_FILE_BYTES) {
      return {
        ok: false,
        error: `Staged file size (${preStat.size} bytes) exceeds limit (${MAX_SOURCE_FILE_BYTES} bytes)`,
        code: 'file-too-large',
      };
    }

    // Bounded read loop
    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let readBytes = 0;
    while (readBytes < expectedSize) {
      const chunk = fs.readSync(stagedFd, buffer, readBytes, expectedSize - readBytes, readBytes);
      if (chunk === 0) {
        return {
          ok: false,
          error: `Unexpected EOF reading staged file: read ${readBytes} of ${expectedSize} bytes`,
          code: 'unexpected-eof',
        };
      }
      readBytes += chunk;
    }

    // Concurrent expansion check
    const extraCheck = Buffer.alloc(1);
    const extra = fs.readSync(stagedFd, extraCheck, 0, 1, expectedSize);
    if (extra !== 0) {
      return {
        ok: false,
        error: 'Staged file expanded concurrently during reading',
        code: 'concurrent-expansion',
      };
    }

    const postStat = fs.fstatSync(stagedFd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== expectedSize
    ) {
      return {
        ok: false,
        error: 'Staged file identity or size changed concurrently during reading',
        code: 'staged-identity-changed',
      };
    }

    // Fingerprints check
    const actualSha = computeSha256(buffer);
    const actualBlob = computeGitBlobSha(buffer);

    if (actualSha.toLowerCase() !== expectedResultSha.toLowerCase()) {
      return {
        ok: false,
        error: `Staged file SHA-256 mismatch: got "${actualSha}", expected "${expectedResultSha}"`,
        code: 'result-sha256-mismatch',
      };
    }

    if (actualBlob.toLowerCase() !== expectedResultBlob.toLowerCase()) {
      return {
        ok: false,
        error: `Staged file Git blob mismatch: got "${actualBlob}", expected "${expectedResultBlob}"`,
        code: 'result-blob-mismatch',
      };
    }

    // Pathname identity check
    const pathStat = fs.lstatSync(absStaged);
    if (pathStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Staged pathname "${absStaged}" was replaced by a symbolic link`,
        code: 'unsafe-symlink',
      };
    }
    if (!pathStat.isFile()) {
      return {
        ok: false,
        error: `Staged pathname "${absStaged}" is not a regular file`,
        code: 'invalid-staged-result',
      };
    }
    if (pathStat.dev !== preStat.dev || pathStat.ino !== preStat.ino) {
      return {
        ok: false,
        error: `Staged pathname "${absStaged}" inode identity changed before backup creation`,
        code: 'staged-identity-replaced',
      };
    }

    return {
      ok: true,
      stagedDev: preStat.dev,
      stagedIno: preStat.ino,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reauthenticate staged file descriptor: ${err.message}`,
      code: err.code === 'ELOOP' ? 'unsafe-symlink' : (err.code || 'staged-auth-failed'),
    };
  } finally {
    if (stagedFd !== null) {
      try {
        fs.closeSync(stagedFd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Reauthenticate live target source descriptor, mode, content, and pathname identity
 * immediately before journal advancement.
 * Strictly read-only; bounded reading with O_NOFOLLOW.
 *
 * @param {object} params
 * @param {string} params.absLiveTarget
 * @param {number} params.expectedDev
 * @param {number} params.expectedIno
 * @param {string} params.expectedInitialSha
 * @param {string} params.expectedInitialBlob
 * @param {string} params.originalMode
 * @param {Buffer} params.authenticatedBuffer
 * @returns {{ ok: boolean, error?: string, code?: string }}
 */
function reauthenticateLiveSource({
  absLiveTarget,
  expectedDev,
  expectedIno,
  expectedInitialSha,
  expectedInitialBlob,
  originalMode,
  authenticatedBuffer,
}) {
  const stage = 'final-source-reauth';

  let lstatCheck;
  try {
    lstatCheck = getPathLstat(absLiveTarget);
  } catch (err) {
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Live target inspection error before journal advancement: ${err.message}`,
      code: err.code || 'source-fs-error',
      stage,
    };
  }

  if (lstatCheck.error) {
    if (lstatCheck.error?._isFault) throw lstatCheck.error;
    const isMissing = lstatCheck.error.code === 'ENOENT';
    return {
      ok: false,
      error: `Live target missing or inaccessible before journal advancement: ${lstatCheck.error.message}`,
      code: isMissing ? 'source-missing-before-advancement' : (lstatCheck.error.code || 'source-fs-error'),
      stage,
    };
  }
  if (!lstatCheck.exists) {
    return {
      ok: false,
      error: `Live target "${absLiveTarget}" missing before journal advancement`,
      code: 'source-missing-before-advancement',
      stage,
    };
  }
  if (lstatCheck.isSymbolicLink) {
    return {
      ok: false,
      error: `Live target "${absLiveTarget}" was replaced by a symbolic link before journal advancement`,
      code: 'unsafe-symlink',
      stage,
    };
  }
  if (!lstatCheck.isFile) {
    return {
      ok: false,
      error: `Live target "${absLiveTarget}" is not a regular file before journal advancement`,
      code: 'invalid-source-before-advancement',
      stage,
    };
  }
  if (!lstatCheck.stat || lstatCheck.stat.dev !== expectedDev || lstatCheck.stat.ino !== expectedIno) {
    return {
      ok: false,
      error: `Live target "${absLiveTarget}" inode identity changed before journal advancement (dev: ${lstatCheck.stat?.dev} vs ${expectedDev}, ino: ${lstatCheck.stat?.ino} vs ${expectedIno})`,
      code: 'source-identity-replaced',
      stage,
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(absLiveTarget, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (openErr) {
    if (openErr?._isFault) throw openErr;
    return {
      ok: false,
      error: `Failed to open live target descriptor before journal advancement: ${openErr.message}`,
      code: openErr.code === 'ELOOP' ? 'unsafe-symlink' : (openErr.code || 'source-read-failed'),
      stage,
    };
  }

  try {
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return {
        ok: false,
        error: 'Live target descriptor is not a regular file before journal advancement',
        code: 'invalid-source-before-advancement',
        stage,
      };
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      return {
        ok: false,
        error: 'Live target descriptor has invalid device or inode identity before journal advancement',
        code: 'invalid-file-identity',
        stage,
      };
    }
    if (preStat.dev !== expectedDev || preStat.ino !== expectedIno) {
      return {
        ok: false,
        error: `Live target descriptor identity changed before journal advancement (dev: ${preStat.dev} vs ${expectedDev}, ino: ${preStat.ino} vs ${expectedIno})`,
        code: 'source-identity-replaced',
        stage,
      };
    }

    // Permission mode check: verify exact mode and absence of special bits
    let currentMode;
    try {
      currentMode = extractCanonicalTargetMode(preStat.mode);
    } catch (modeErr) {
      return {
        ok: false,
        error: `Live target permission check failed before journal advancement: ${modeErr.message}`,
        code: modeErr.code || 'invalid-target-mode',
        stage,
      };
    }
    if (currentMode !== originalMode) {
      return {
        ok: false,
        error: `Live target file mode changed before journal advancement: expected "${originalMode}", observed "${currentMode}"`,
        code: 'source-mode-changed',
        stage,
      };
    }

    // Bounded read check
    if (preStat.size > MAX_SOURCE_FILE_BYTES) {
      return {
        ok: false,
        error: `Live target file size (${preStat.size} bytes) exceeds limit (${MAX_SOURCE_FILE_BYTES} bytes)`,
        code: 'file-too-large',
        stage,
      };
    }
    if (preStat.size !== authenticatedBuffer.length) {
      return {
        ok: false,
        error: `Live target size changed in place before journal advancement: expected ${authenticatedBuffer.length}, observed ${preStat.size}`,
        code: 'source-content-changed',
        stage,
      };
    }

    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let readBytes = 0;
    while (readBytes < expectedSize) {
      const chunk = fs.readSync(fd, buffer, readBytes, expectedSize - readBytes, readBytes);
      if (chunk === 0) {
        return {
          ok: false,
          error: `Unexpected EOF reading live target descriptor before journal advancement: read ${readBytes} of ${expectedSize} bytes`,
          code: 'unexpected-eof',
          stage,
        };
      }
      readBytes += chunk;
    }

    // Concurrent expansion check
    const extraCheck = Buffer.alloc(1);
    const extra = fs.readSync(fd, extraCheck, 0, 1, expectedSize);
    if (extra !== 0) {
      return {
        ok: false,
        error: 'Live target expanded concurrently during descriptor read before journal advancement',
        code: 'concurrent-expansion',
        stage,
      };
    }

    const postStat = fs.fstatSync(fd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== expectedSize ||
      !postStat.isFile()
    ) {
      return {
        ok: false,
        error: 'Live target identity or size changed concurrently during descriptor read before journal advancement',
        code: 'source-identity-changed',
        stage,
      };
    }

    // Fingerprint verification
    const actualSha = computeSha256(buffer);
    const actualBlob = computeGitBlobSha(buffer);

    if (actualSha.toLowerCase() !== expectedInitialSha.toLowerCase()) {
      return {
        ok: false,
        error: `Live target content SHA-256 changed before journal advancement: got "${actualSha}", expected "${expectedInitialSha}"`,
        code: 'source-content-changed',
        stage,
      };
    }

    if (actualBlob.toLowerCase() !== expectedInitialBlob.toLowerCase()) {
      return {
        ok: false,
        error: `Live target Git blob SHA changed before journal advancement: got "${actualBlob}", expected "${expectedInitialBlob}"`,
        code: 'source-content-changed',
        stage,
      };
    }

    if (Buffer.compare(buffer, authenticatedBuffer) !== 0) {
      return {
        ok: false,
        error: 'Live target content altered in place before journal advancement',
        code: 'source-content-changed',
        stage,
      };
    }

    // Pathname identity consistency
    let finalPathStat;
    try {
      finalPathStat = fs.lstatSync(absLiveTarget);
    } catch (lstatErr) {
      if (lstatErr?._isFault) throw lstatErr;
      const isMissing = lstatErr.code === 'ENOENT';
      return {
        ok: false,
        error: `Live target pathname missing before journal advancement: ${lstatErr.message}`,
        code: isMissing ? 'source-missing-before-advancement' : (lstatErr.code || 'source-fs-error'),
        stage,
      };
    }

    if (finalPathStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Live target "${absLiveTarget}" was replaced by a symbolic link before journal advancement`,
        code: 'unsafe-symlink',
        stage,
      };
    }

    if (!finalPathStat.isFile()) {
      return {
        ok: false,
        error: `Live target "${absLiveTarget}" is not a regular file before journal advancement`,
        code: 'invalid-source-before-advancement',
        stage,
      };
    }

    if (finalPathStat.dev !== preStat.dev || finalPathStat.ino !== preStat.ino) {
      return {
        ok: false,
        error: `Live target "${absLiveTarget}" inode identity changed before journal advancement`,
        code: 'source-identity-replaced',
        stage,
      };
    }

    return { ok: true, stage };
  } catch (fsErr) {
    if (fsErr?._isFault) throw fsErr;
    return {
      ok: false,
      error: `Live target descriptor verification failed: ${fsErr.message}`,
      code: fsErr.code || 'source-fs-error',
      stage,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Reauthenticate backup artifact descriptor, mode, content, directory cleanliness, and pathname identity.
 * Strictly read-only; bounded reading with O_NOFOLLOW.
 *
 * @param {object} params
 * @param {string} params.backupFile
 * @param {string} params.backupTxDir
 * @param {string} params.targetBase
 * @param {number} params.createdBackupDev
 * @param {number} params.createdBackupIno
 * @param {string} params.expectedInitialSha
 * @param {string} params.expectedInitialBlob
 * @param {Buffer} params.authenticatedBuffer
 * @param {boolean} [params.doFsync=false] - Whether to fsync verified descriptor
 * @param {(stage: string, context?: object) => void} [params.runFault]
 * @returns {{ ok: boolean, error?: string, code?: string, stage?: string, actualBackupSha256?: string, actualBackupBlobSha?: string }}
 */
function reauthenticateBackupFile({
  backupFile,
  backupTxDir,
  targetBase,
  createdBackupDev,
  createdBackupIno,
  expectedInitialSha,
  expectedInitialBlob,
  authenticatedBuffer,
  doFsync = false,
  runFault = null,
  stage = 'final-backup-reauth',
}) {
  // Confirm transaction directory contains exactly the single expected backup file
  let backupChildren;
  try {
    backupChildren = fs.readdirSync(backupTxDir);
  } catch (dirErr) {
    if (dirErr?._isFault) throw dirErr;
    return {
      ok: false,
      error: `Failed to inspect backup directory: ${dirErr.message}`,
      code: dirErr.code || 'inspection-error',
      stage,
    };
  }

  if (backupChildren.length !== 1 || backupChildren[0] !== targetBase) {
    return {
      ok: false,
      error: `Backup directory contains unexpected artifacts: ${backupChildren.join(', ')}`,
      code: 'unexpected-backup-artifacts',
      stage,
    };
  }

  let pathStatCheck;
  try {
    pathStatCheck = getPathLstat(backupFile);
  } catch (err) {
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Failed to inspect backup pathname: ${err.message}`,
      code: err.code || 'backup-fs-error',
      stage,
    };
  }

  if (pathStatCheck.error) {
    if (pathStatCheck.error?._isFault) throw pathStatCheck.error;
    const isMissing = pathStatCheck.error.code === 'ENOENT';
    return {
      ok: false,
      error: `Backup pathname missing or unreadable: ${pathStatCheck.error.message}`,
      code: isMissing ? 'backup-pathname-missing' : (pathStatCheck.error.code || 'backup-fs-error'),
      stage,
    };
  }
  if (!pathStatCheck.exists) {
    return {
      ok: false,
      error: `Backup pathname "${backupFile}" does not exist`,
      code: 'backup-pathname-missing',
      stage,
    };
  }
  if (pathStatCheck.isSymbolicLink) {
    return {
      ok: false,
      error: `Backup pathname "${backupFile}" was replaced by a symbolic link before journal advancement`,
      code: 'unsafe-symlink',
      stage,
    };
  }
  if (!pathStatCheck.isFile) {
    return {
      ok: false,
      error: `Backup pathname "${backupFile}" is not a regular file`,
      code: 'invalid-backup-result',
      stage,
    };
  }
  if (!pathStatCheck.stat || pathStatCheck.stat.dev !== createdBackupDev || pathStatCheck.stat.ino !== createdBackupIno) {
    return {
      ok: false,
      error: `Backup pathname "${backupFile}" inode identity changed`,
      code: 'backup-identity-replaced',
      stage,
    };
  }

  let readFd = null;
  try {
    try {
      readFd = fs.openSync(backupFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (openErr) {
      if (openErr?._isFault) throw openErr;
      return {
        ok: false,
        error: `Failed to open backup file descriptor for verification: ${openErr.message}`,
        code: openErr.code === 'ELOOP' ? 'unsafe-symlink' : (openErr.code || 'backup-open-failed'),
        stage,
      };
    }

    const preStat = fs.fstatSync(readFd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return {
        ok: false,
        error: 'Backup file descriptor is not a regular file',
        code: 'invalid-backup-result',
        stage,
      };
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      return {
        ok: false,
        error: 'Backup file descriptor has invalid device or inode identity',
        code: 'invalid-file-identity',
        stage,
      };
    }
    if (preStat.dev !== createdBackupDev || preStat.ino !== createdBackupIno) {
      return {
        ok: false,
        error: 'Backup file descriptor identity differs from created descriptor',
        code: 'backup-identity-replaced',
        stage,
      };
    }
    if ((preStat.mode & 0o777) !== 0o600) {
      return {
        ok: false,
        error: `Backup file mode mismatch: got 0o${(preStat.mode & 0o777).toString(8)}, expected 0o600`,
        code: 'backup-mode-mismatch',
        stage,
      };
    }
    if (preStat.size !== authenticatedBuffer.length) {
      return {
        ok: false,
        error: `Backup file size mismatch: read ${preStat.size}, expected ${authenticatedBuffer.length}`,
        code: 'backup-size-mismatch',
        stage,
      };
    }

    const expectedSize = preStat.size;
    const readBuffer = Buffer.alloc(expectedSize);
    let readBytes = 0;
    while (readBytes < expectedSize) {
      const chunk = fs.readSync(readFd, readBuffer, readBytes, expectedSize - readBytes, readBytes);
      if (chunk === 0) {
        return {
          ok: false,
          error: `Unexpected EOF reading backup descriptor: read ${readBytes} of ${expectedSize} bytes`,
          code: 'unexpected-eof',
          stage,
        };
      }
      readBytes += chunk;
    }

    const extraCheck = Buffer.alloc(1);
    const extra = fs.readSync(readFd, extraCheck, 0, 1, expectedSize);
    if (extra !== 0) {
      return {
        ok: false,
        error: 'Backup file expanded concurrently during descriptor read',
        code: 'concurrent-expansion',
        stage,
      };
    }

    if (typeof runFault === 'function') {
      runFault('after-backup-readback', { readBuffer });
      runFault('before-fingerprint-verification', { readBuffer });
    }

    const actualBackupSha256 = computeSha256(readBuffer);
    const actualBackupBlobSha = computeGitBlobSha(readBuffer);

    if (actualBackupSha256.toLowerCase() !== expectedInitialSha.toLowerCase()) {
      return {
        ok: false,
        error: `Backup SHA-256 digest mismatch: got "${actualBackupSha256}", expected "${expectedInitialSha}"`,
        code: 'backup-sha256-mismatch',
        stage,
      };
    }

    if (actualBackupBlobSha.toLowerCase() !== expectedInitialBlob.toLowerCase()) {
      return {
        ok: false,
        error: `Backup Git blob SHA mismatch: got "${actualBackupBlobSha}", expected "${expectedInitialBlob}"`,
        code: 'backup-blob-mismatch',
        stage,
      };
    }

    // Exact byte-for-byte comparison against authenticated live source snapshot
    if (Buffer.compare(readBuffer, authenticatedBuffer) !== 0) {
      return {
        ok: false,
        error: 'Backup content does not match authenticated live source buffer byte-for-byte',
        code: 'backup-content-mismatch',
        stage,
      };
    }

    if (typeof runFault === 'function') {
      runFault('after-fingerprint-verification', { actualBackupSha256, actualBackupBlobSha });
    }

    if (doFsync) {
      if (typeof runFault === 'function') {
        runFault('sync-backup-file', { readFd });
      }
      try {
        fs.fsyncSync(readFd);
      } catch (syncErr) {
        if (syncErr?._isFault) throw syncErr;
        return {
          ok: false,
          error: `Failed to synchronize verified backup file: ${syncErr.message}`,
          code: syncErr.code || 'fsync-failed',
          stage: 'sync-backup-file',
        };
      }
    }

    const postStat = fs.fstatSync(readFd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== expectedSize ||
      !postStat.isFile()
    ) {
      return {
        ok: false,
        error: 'Backup file descriptor identity changed during verification',
        code: 'backup-identity-changed',
        stage,
      };
    }

    // Pathname identity check before closing descriptor
    let pathStat;
    try {
      pathStat = fs.lstatSync(backupFile);
    } catch (lstatErr) {
      if (lstatErr?._isFault) throw lstatErr;
      const isMissing = lstatErr.code === 'ENOENT';
      return {
        ok: false,
        error: `Backup pathname missing or unreadable before journal advancement: ${lstatErr.message}`,
        code: isMissing ? 'backup-pathname-missing' : (lstatErr.code || 'backup-fs-error'),
        stage,
      };
    }

    if (pathStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Backup pathname "${backupFile}" was replaced by a symbolic link before journal advancement`,
        code: 'unsafe-symlink',
        stage,
      };
    }

    if (!pathStat.isFile()) {
      return {
        ok: false,
        error: `Backup pathname "${backupFile}" is not a regular file`,
        code: 'invalid-backup-result',
        stage,
      };
    }

    if (pathStat.dev !== preStat.dev || pathStat.ino !== preStat.ino) {
      return {
        ok: false,
        error: `Backup pathname "${backupFile}" inode identity changed`,
        code: 'backup-identity-replaced',
        stage,
      };
    }

    return {
      ok: true,
      stage,
      actualBackupSha256,
      actualBackupBlobSha,
    };
  } catch (fsErr) {
    if (fsErr?._isFault) throw fsErr;
    return {
      ok: false,
      error: `Backup descriptor verification failed: ${fsErr.message}`,
      code: fsErr.code || 'backup-fs-error',
      stage,
    };
  } finally {
    if (readFd !== null) {
      try {
        fs.closeSync(readFd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Create a transaction-owned, verified pre-mutation backup of the live target file.
 * The live target is never mutated, truncated, replaced, or permissions-modified.
 * Reauthenticates existing isolated prepared staging before proceeding.
 * Durably advances journal phase from ISOLATED_PREPARED to BACKUP_CREATED registering
 * backupPath and targetMode.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {'apply' | 'remove'} options.op
 * @param {import('./lock.js').TransactionLease} options.lease
 * @param {object} [options.manifest]
 * @param {(stage: string, context?: object) => void} [options.faultHook]
 * @returns {Promise<{
 *   ok: boolean,
 *   backupPath?: string,
 *   targetMode?: string,
 *   journal?: object,
 *   sha256?: string,
 *   gitBlobSha?: string,
 *   error?: string,
 *   code?: string,
 *   stage?: string
 * }>}
 */
export async function createVerifiedBackup(options = {}) {
  const {
    repoRoot,
    txId,
    op,
    lease,
    manifest: providedManifest = null,
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
      error: `Cannot create backup: valid journal required (errors: ${journalInspection.errors.join('; ')})`,
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

  if (journal.phase !== 'ISOLATED_PREPARED') {
    return {
      ok: false,
      error: `Backup creation requires journal in phase "ISOLATED_PREPARED", observed "${journal.phase}"`,
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
      error: 'Journal missing mandatory isolatedStagedPath auxiliary metadata in phase "ISOLATED_PREPARED"',
      code: 'missing-mandatory-metadata',
    };
  }

  if (
    journal.backupPath !== undefined ||
    journal.targetMode !== undefined ||
    journal.destinationStagedPath !== undefined
  ) {
    return {
      ok: false,
      error: 'Disallowed premature metadata: journal already contains backupPath, targetMode, or destinationStagedPath',
      code: 'premature-metadata',
    };
  }

  runFault('after-preconditions', { journal });

  // 3. Certified Manifest Authentication
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

  // 4. Reauthenticate Existing Isolated Staged Artifact
  runFault('before-staging-reauth', { journal });

  const stagingReauth = reauthenticatePreparedStaging(
    repoRoot,
    txId,
    journal,
    patchEntry,
    expectedResultSha,
    expectedResultBlob
  );
  if (!stagingReauth.ok) {
    return stagingReauth;
  }

  const authenticatedStagedDev = stagingReauth.stagedDev;
  const authenticatedStagedIno = stagingReauth.stagedIno;

  runFault('after-staging-reauth', { stagingReauth });

  // 5. Authenticate Live Target Source
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

  // Capture original mode from authenticated descriptor
  let originalMode;
  try {
    originalMode = extractCanonicalTargetMode(liveSource.stat.mode);
  } catch (modeErr) {
    return {
      ok: false,
      error: `Live target mode extraction failed: ${modeErr.message}`,
      code: modeErr.code || 'invalid-target-mode',
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

  const authenticatedSourceDev = liveSource.stat.dev;
  const authenticatedSourceIno = liveSource.stat.ino;

  runFault('after-source-read', { liveSource, originalMode });

  // 6. Exclusive Backup Allocation
  const ciPatchCheck = validateCiPatchPath(repoRoot);
  if (!ciPatchCheck.ok || !ciPatchCheck.exists || !ciPatchCheck.isDirectory || ciPatchCheck.isSymlink) {
    return {
      ok: false,
      error: ciPatchCheck.error || 'Installer directory (.ci-patch) is invalid, missing, or is a symbolic link',
      code: ciPatchCheck.isSymlink ? 'unsafe-symlink' : 'invalid-installer-dir',
    };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  const backupBaseDir = path.join(ciPatchDir, 'backup');
  const backupTxDir = path.join(backupBaseDir, txId);
  const targetBase = path.basename(journal.targetFile);
  const backupFile = path.join(backupTxDir, targetBase);

  // Validate .ci-patch/backup
  const backupBaseCheck = getPathLstat(backupBaseDir);
  if (backupBaseCheck.error && backupBaseCheck.error.code !== 'ENOENT') {
    return {
      ok: false,
      error: `Failed to inspect backup parent directory (.ci-patch/backup): ${backupBaseCheck.error.message}`,
      code: 'inspection-error',
    };
  }
  if (backupBaseCheck.isSymbolicLink) {
    return {
      ok: false,
      error: 'Backup directory (.ci-patch/backup) is a symbolic link',
      code: 'unsafe-symlink',
    };
  }
  if (backupBaseCheck.exists && !backupBaseCheck.isDirectory) {
    return {
      ok: false,
      error: 'Backup path (.ci-patch/backup) exists but is not a directory',
      code: 'invalid-backup-dir',
    };
  }

  if (!backupBaseCheck.exists) {
    runFault('before-backup-parent-creation', { backupBaseDir });
    try {
      fs.mkdirSync(backupBaseDir, { mode: 0o700 });
    } catch (mkdirErr) {
      return {
        ok: false,
        error: `Failed to create backup parent directory: ${mkdirErr.message}`,
        code: mkdirErr.code || 'backup-dir-failed',
      };
    }
    const verifyBase = getPathLstat(backupBaseDir);
    if (!verifyBase.exists || !verifyBase.isDirectory || verifyBase.isSymbolicLink) {
      return {
        ok: false,
        error: 'Backup parent directory verification failed after creation',
        code: 'backup-dir-failed',
      };
    }
    runFault('after-backup-parent-creation', { backupBaseDir });
    const syncRes = syncPathDurable(ciPatchDir, 'backup-parent', true, runFault);
    if (!syncRes.ok) {
      return syncRes;
    }
  }

  // Validate .ci-patch/backup/<txId>
  const txDirCheck = getPathLstat(backupTxDir);
  if (txDirCheck.error && txDirCheck.error.code !== 'ENOENT') {
    return {
      ok: false,
      error: `Failed to inspect backup transaction directory: ${txDirCheck.error.message}`,
      code: 'inspection-error',
    };
  }
  if (txDirCheck.exists || txDirCheck.isSymbolicLink) {
    return {
      ok: false,
      error: `Backup directory already exists for transaction "${txId}" (collision)`,
      code: 'backup-collision',
    };
  }

  runFault('before-dir-allocation', { backupTxDir });

  try {
    fs.mkdirSync(backupTxDir, { mode: 0o700 });
  } catch (mkdirErr) {
    return {
      ok: false,
      error: `Failed to create isolated transaction backup directory: ${mkdirErr.message}`,
      code: mkdirErr.code || 'backup-dir-failed',
    };
  }

  const verifyTxDir = getPathLstat(backupTxDir);
  if (!verifyTxDir.exists || !verifyTxDir.isDirectory || verifyTxDir.isSymbolicLink) {
    return {
      ok: false,
      error: 'Transaction backup directory verification failed after creation',
      code: 'backup-dir-failed',
    };
  }

  const txDirSync = syncPathDurable(backupBaseDir, 'backup-txdir-parent', true, runFault);
  if (!txDirSync.ok) {
    return txDirSync;
  }

  runFault('after-dir-allocation', { backupTxDir });

  // 7. Exclusive Backup File Creation
  runFault('before-file-create', { backupFile });

  let backupFd = null;
  let createdBackupDev = null;
  let createdBackupIno = null;
  try {
    backupFd = fs.openSync(
      backupFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );

    const initialStat = fs.fstatSync(backupFd);
    if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
      throw new Error('Created backup descriptor is not a regular file');
    }
    if (!isValidDeviceIdentifier(initialStat.dev) || !isValidInodeIdentifier(initialStat.ino)) {
      throw new Error('Failed to establish usable file identity on backup descriptor');
    }
    createdBackupDev = initialStat.dev;
    createdBackupIno = initialStat.ino;

    runFault('during-backup-write', { backupFd });

    let written = 0;
    while (written < liveSource.buffer.length) {
      const bytesWritten = fs.writeSync(
        backupFd,
        liveSource.buffer,
        written,
        liveSource.buffer.length - written,
        written
      );
      if (bytesWritten === 0) {
        throw new Error('Short write writing live source bytes to backup file');
      }
      written += bytesWritten;
    }

    runFault('sync-initial-backup-file', { backupFd });
    try {
      fs.fsyncSync(backupFd);
    } catch (syncErr) {
      if (syncErr?._isFault) throw syncErr;
      return {
        ok: false,
        error: `Failed to synchronize backup file: ${syncErr.message}`,
        code: syncErr.code || 'fsync-failed',
        stage: 'sync-initial-backup-file',
      };
    }
  } catch (writeErr) {
    if (writeErr?._isFault) {
      throw writeErr;
    }
    return {
      ok: false,
      error: `Failed to create isolated backup file: ${writeErr.message}`,
      code: writeErr.code || 'backup-file-write-failed',
    };
  } finally {
    if (backupFd !== null) {
      try {
        fs.closeSync(backupFd);
      } catch {
        // ignore
      }
      backupFd = null;
    }
  }

  const backupPostStat = getPathLstat(backupFile);
  if (!backupPostStat.exists || !backupPostStat.isFile || backupPostStat.isSymbolicLink) {
    return {
      ok: false,
      error: 'Backup file verification failed after initial write',
      code: 'invalid-backup-result',
    };
  }

  const initialTxSync = syncPathDurable(backupTxDir, 'initial-backup-txdir', true, runFault);
  if (!initialTxSync.ok) {
    return initialTxSync;
  }

  runFault('after-file-create', { backupFile });

  // 8. Backup Independent Readback and Durability Verification
  runFault('before-backup-readback', { backupFile });

  const initialBackupVerify = reauthenticateBackupFile({
    backupFile,
    backupTxDir,
    targetBase,
    createdBackupDev,
    createdBackupIno,
    expectedInitialSha,
    expectedInitialBlob,
    authenticatedBuffer: liveSource.buffer,
    doFsync: true,
    runFault,
    stage: 'backup-readback',
  });
  if (!initialBackupVerify.ok) {
    return initialBackupVerify;
  }

  // Synchronize backup containing directories
  const syncTxDir = syncPathDurable(backupTxDir, 'backup-txdir', true, runFault);
  if (!syncTxDir.ok) {
    return syncTxDir;
  }

  const syncBackupParent = syncPathDurable(backupBaseDir, 'backup-parent', true, runFault);
  if (!syncBackupParent.ok) {
    return syncBackupParent;
  }

  const syncCiPatch = syncPathDurable(ciPatchDir, 'backup-ci-patch', true, runFault);
  if (!syncCiPatch.ok) {
    return syncCiPatch;
  }

  const relBackupPath = `.ci-patch/backup/${txId}/${targetBase}`;

  // 9. Fault Hook Executed BEFORE Final Publication Integrity Checks
  runFault('before-journal-advancement', { relBackupPath, originalMode });

  // 10. Complete Final Publication Integrity Checks (NO fault hook after this point)
  // A. Revalidate lock ownership and lease
  const reLockAuth = verifyLockOwnershipForMutation(repoRoot, txId, op, lease);
  if (!reLockAuth.ok) {
    return {
      ok: false,
      error: `Pre-publication lock authorization failed: ${reLockAuth.reason || reLockAuth.error}`,
      code: reLockAuth.error,
    };
  }

  // B. Revalidate journal state and transaction consistency
  const currentJournalInspect = inspectJournal(repoRoot);
  if (!currentJournalInspect.isValid || !currentJournalInspect.journal) {
    return {
      ok: false,
      error: 'Journal missing or invalid before journal advancement',
      code: 'invalid-journal',
    };
  }
  const currentJournal = currentJournalInspect.journal;
  if (currentJournal.txId !== txId || currentJournal.op !== op) {
    return {
      ok: false,
      error: `Journal transaction mismatch before advancement: expected txId "${txId}" op "${op}", got txId "${currentJournal.txId}" op "${currentJournal.op}"`,
      code: 'journal-mismatch',
    };
  }
  if (currentJournal.phase !== 'ISOLATED_PREPARED') {
    return {
      ok: false,
      error: `Journal phase mismatch before advancement: expected "ISOLATED_PREPARED", got "${currentJournal.phase}"`,
      code: 'invalid-journal-phase',
    };
  }

  // C. Reauthenticate prepared staging output
  let finalStagingReauth;
  try {
    finalStagingReauth = reauthenticatePreparedStaging(
      repoRoot,
      txId,
      journal,
      patchEntry,
      expectedResultSha,
      expectedResultBlob,
      authenticatedStagedDev,
      authenticatedStagedIno
    );
  } catch (err) {
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Pre-publication staging reauthentication failed: ${err.message}`,
      code: err.code || 'staging-fs-error',
      stage: 'final-staging-reauth',
    };
  }
  if (!finalStagingReauth.ok) {
    if (!finalStagingReauth.stage) {
      finalStagingReauth.stage = 'final-staging-reauth';
    }
    return finalStagingReauth;
  }

  // D. Reauthenticate live target source content, mode, and identity
  let finalSourceReauth;
  try {
    finalSourceReauth = reauthenticateLiveSource({
      absLiveTarget,
      expectedDev: authenticatedSourceDev,
      expectedIno: authenticatedSourceIno,
      expectedInitialSha,
      expectedInitialBlob,
      originalMode,
      authenticatedBuffer: liveSource.buffer,
    });
  } catch (err) {
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Pre-publication live source reauthentication failed: ${err.message}`,
      code: err.code || 'source-fs-error',
      stage: 'final-source-reauth',
    };
  }
  if (!finalSourceReauth.ok) {
    return finalSourceReauth;
  }

  // E. Reauthenticate backup content, mode, directory cleanliness, and identity
  let finalBackupReauth;
  try {
    finalBackupReauth = reauthenticateBackupFile({
      backupFile,
      backupTxDir,
      targetBase,
      createdBackupDev,
      createdBackupIno,
      expectedInitialSha,
      expectedInitialBlob,
      authenticatedBuffer: liveSource.buffer,
      doFsync: false,
      runFault: null,
      stage: 'final-backup-reauth',
    });
  } catch (err) {
    if (err?._isFault) throw err;
    return {
      ok: false,
      error: `Pre-publication backup reauthentication failed: ${err.message}`,
      code: err.code || 'backup-fs-error',
      stage: 'final-backup-reauth',
    };
  }
  if (!finalBackupReauth.ok) {
    return finalBackupReauth;
  }

  // 11. Atomic Journal Advancement
  const advanceRes = advanceJournalPhase({
    repoRoot,
    txId,
    nextPhase: 'BACKUP_CREATED',
    metadataUpdate: {
      backupPath: relBackupPath,
      targetMode: originalMode,
    },
    lease,
  });

  if (!advanceRes.ok) {
    return {
      ok: false,
      error: `Failed to advance journal to BACKUP_CREATED: ${advanceRes.error}`,
      code: advanceRes.code || 'journal-advancement-failed',
      stage: advanceRes.stage,
    };
  }

  runFault('after-journal-advancement', { journal: advanceRes.journal });

  return {
    ok: true,
    backupPath: relBackupPath,
    targetMode: originalMode,
    journal: advanceRes.journal,
    sha256: liveSource.sha256,
    gitBlobSha: liveSource.gitBlobSha,
  };
}

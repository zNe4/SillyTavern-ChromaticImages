import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const BACKUPS_SUBDIR_NAME = 'backups';
export const LOCKS_SUBDIR_NAME = 'locks';

/**
 * Compute SHA-256 lowercase hex digest of buffer or string.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Format a Date object into UTC compact format: YYYYMMDD-HHmmss
 * @param {Date} [date]
 * @returns {string}
 */
export function formatCompactTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const Y = date.getUTCFullYear();
  const M = pad(date.getUTCMonth() + 1);
  const D = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const m = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${Y}${M}${D}-${h}${m}${s}`;
}

/**
 * Inspect every existing ancestor segment of a path to verify it does not resolve
 * into the target SillyTavern repository via symlinks, and does not contain unsafe symlinks.
 *
 * @param {string} targetPath - Normalized absolute target directory
 * @param {string} canonicalRepoRoot - Realpath of target SillyTavern repository
 * @param {boolean} isOverride - Whether targetPath was explicitly specified
 * @returns {{ ok: boolean, error?: string }}
 */
function validateAncestorConfinement(targetPath, canonicalRepoRoot, isOverride) {
  const root = path.parse(targetPath).root;
  const relative = path.relative(root, targetPath);
  const segments = relative.split(path.sep).filter(Boolean);

  let currentPath = root;

  for (let i = 0; i < segments.length; i++) {
    const nextPath = path.join(currentPath, segments[i]);

    if (fs.existsSync(nextPath)) {
      const lstat = fs.lstatSync(nextPath);

      if (lstat.isSymbolicLink()) {
        let realSegment;
        try {
          realSegment = fs.realpathSync(nextPath);
        } catch (err) {
          return {
            ok: false,
            error: `Failed to resolve realpath for storage path segment "${nextPath}": ${err.message}`,
          };
        }

        // 1. Direct symlink target check
        if (realSegment === canonicalRepoRoot || realSegment.startsWith(canonicalRepoRoot + path.sep)) {
          return {
            ok: false,
            error: `Storage directory ancestor "${nextPath}" is a symbolic link resolving inside the target SillyTavern repository: "${realSegment}"`,
          };
        }

        // 2. Projected path check through symlinked ancestor
        const remainingSegments = segments.slice(i + 1).join(path.sep);
        const projectedTarget = remainingSegments
          ? path.resolve(realSegment, remainingSegments)
          : realSegment;

        if (projectedTarget === canonicalRepoRoot || projectedTarget.startsWith(canonicalRepoRoot + path.sep)) {
          return {
            ok: false,
            error: `Storage directory through ancestor symlink "${nextPath}" resolves inside the target SillyTavern repository: "${projectedTarget}"`,
          };
        }

        // 3. Reject any symbolic link component in storage path (both default XDG and override)
        return {
          ok: false,
          error: isOverride
            ? `Storage directory override contains a symbolic link component: "${nextPath}"`
            : `Storage directory path contains a symbolic link component: "${nextPath}"`,
        };
      } else if (!lstat.isDirectory()) {
        return {
          ok: false,
          error: `Storage directory ancestor is not a directory: "${nextPath}"`,
        };
      }

      currentPath = nextPath;
    } else {
      // nextPath does not exist yet. Check whether currentPath (the deepest existing ancestor)
      // resolves inside SillyTavern or projects into it.
      let realDeepest;
      try {
        realDeepest = fs.realpathSync(currentPath);
      } catch (err) {
        return {
          ok: false,
          error: `Failed to resolve realpath for deepest existing ancestor "${currentPath}": ${err.message}`,
        };
      }

      if (realDeepest === canonicalRepoRoot || realDeepest.startsWith(canonicalRepoRoot + path.sep)) {
        return {
          ok: false,
          error: `Deepest existing storage ancestor "${currentPath}" resolves inside the target SillyTavern repository: "${realDeepest}"`,
        };
      }

      const remainingFromDeepest = segments.slice(i).join(path.sep);
      const projectedFromDeepest = path.resolve(realDeepest, remainingFromDeepest);
      if (projectedFromDeepest === canonicalRepoRoot || projectedFromDeepest.startsWith(canonicalRepoRoot + path.sep)) {
        return {
          ok: false,
          error: `Storage directory projected from "${currentPath}" resolves inside the target SillyTavern repository: "${projectedFromDeepest}"`,
        };
      }

      break;
    }
  }

  return { ok: true };
}

/**
 * Resolve and validate the user-local storage directory outside SillyTavern.
 *
 * Enforces:
 * - Rejects explicitly empty backup-directory overrides without falling back.
 * - Every existing ancestor relevant to storage destination is inspected for symlinks before creation.
 * - Storage location is strictly outside the target SillyTavern repository (before and after creation).
 * - Resolves ${XDG_DATA_HOME:-$HOME/.local/share}/chromatic-images/ by default.
 * - Validates CI_BACKUP_DIR override if provided.
 * - Rejects symbolic links in directory paths.
 * - Rejects unsafe existing permissions (must have no group or world access).
 * - Creates private directories with mode 0700 without altering unrelated pre-existing directories.
 *
 * @param {object} options
 * @param {string} options.repoRoot - SillyTavern repository root
 * @param {string|null} [options.customOverride] - Optional explicit storage directory override
 * @returns {{
 *   ok: boolean,
 *   baseDir: string|null,
 *   backupsDir: string|null,
 *   locksDir: string|null,
 *   error: string|null
 * }}
 */
export function resolveStorageDirectory({ repoRoot, customOverride = null }) {
  if (!repoRoot || typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: 'Invalid repository root path' };
  }

  let canonicalRepoRoot;
  try {
    if (!fs.existsSync(repoRoot)) {
      return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Repository root does not exist: "${repoRoot}"` };
    }
    const stat = fs.statSync(repoRoot);
    if (!stat.isDirectory()) {
      return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Repository root is not a directory: "${repoRoot}"` };
    }
    canonicalRepoRoot = fs.realpathSync(repoRoot);
  } catch (err) {
    return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Failed to resolve repository root: ${err.message}` };
  }

  // 1. Determine candidate base storage directory and validate overrides strictly
  let rawBaseDir = null;
  let isOverride = false;

  if (customOverride !== null) {
    if (typeof customOverride !== 'string' || customOverride.trim() === '') {
      return {
        ok: false,
        baseDir: null,
        backupsDir: null,
        locksDir: null,
        error: 'Storage directory override cannot be empty or whitespace-only',
      };
    }
    rawBaseDir = customOverride.trim();
    isOverride = true;
  } else if (process.env.CI_BACKUP_DIR !== undefined) {
    if (typeof process.env.CI_BACKUP_DIR !== 'string' || process.env.CI_BACKUP_DIR.trim() === '') {
      return {
        ok: false,
        baseDir: null,
        backupsDir: null,
        locksDir: null,
        error: 'Environment variable CI_BACKUP_DIR cannot be empty or whitespace-only',
      };
    }
    rawBaseDir = process.env.CI_BACKUP_DIR.trim();
    isOverride = true;
  } else {
    const xdgDataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim() !== ''
      ? process.env.XDG_DATA_HOME.trim()
      : path.join(os.homedir(), '.local/share');
    rawBaseDir = path.join(xdgDataHome, 'chromatic-images');
  }

  if (/[\x00-\x1f\x7f]/.test(rawBaseDir)) {
    return {
      ok: false,
      baseDir: null,
      backupsDir: null,
      locksDir: null,
      error: 'Storage directory path contains control characters',
    };
  }

  const candidateBase = path.resolve(rawBaseDir);

  // 2. Direct textual containment check
  if (candidateBase === canonicalRepoRoot || candidateBase.startsWith(canonicalRepoRoot + path.sep)) {
    return {
      ok: false,
      baseDir: null,
      backupsDir: null,
      locksDir: null,
      error: `Storage directory resides inside the target SillyTavern repository: "${candidateBase}"`,
    };
  }

  // 3. Pre-creation ancestor confinement and symlink inspection
  const ancestorCheck = validateAncestorConfinement(candidateBase, canonicalRepoRoot, isOverride);
  if (!ancestorCheck.ok) {
    return {
      ok: false,
      baseDir: null,
      backupsDir: null,
      locksDir: null,
      error: ancestorCheck.error,
    };
  }

  // 4. Initialize and validate base directory
  try {
    if (fs.existsSync(candidateBase)) {
      const lstat = fs.lstatSync(candidateBase);
      if (lstat.isSymbolicLink()) {
        return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Storage directory is a symbolic link: "${candidateBase}"` };
      }
      if (!lstat.isDirectory()) {
        return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Storage directory path exists but is not a directory: "${candidateBase}"` };
      }
      // Check existing permissions: reject if group or world has read, write, or execute access
      const mode = lstat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          ok: false,
          baseDir: null,
          backupsDir: null,
          locksDir: null,
          error: `Storage directory has unsafe existing permissions 0o${mode.toString(8)} (group/world accessible); expected 0700`,
        };
      }
    } else {
      // Create private directory with mode 0700
      fs.mkdirSync(candidateBase, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(candidateBase, 0o700);
      } catch {
        // ignore if filesystem does not support chmod
      }
    }
  } catch (err) {
    return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Failed to initialize storage directory: ${err.message}` };
  }

  // Post-creation realpath containment verification for base directory
  try {
    const postRealBase = fs.realpathSync(candidateBase);
    if (postRealBase === canonicalRepoRoot || postRealBase.startsWith(canonicalRepoRoot + path.sep)) {
      return {
        ok: false,
        baseDir: null,
        backupsDir: null,
        locksDir: null,
        error: `Storage directory resolves inside the target SillyTavern repository after creation: "${postRealBase}"`,
      };
    }
  } catch (err) {
    return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Failed to verify storage directory realpath: ${err.message}` };
  }

  // 5. Initialize and validate subdirectories: backups and locks
  const backupsDir = path.join(candidateBase, BACKUPS_SUBDIR_NAME);
  const locksDir = path.join(candidateBase, LOCKS_SUBDIR_NAME);

  for (const [name, dirPath] of [['backups', backupsDir], ['locks', locksDir]]) {
    try {
      if (fs.existsSync(dirPath)) {
        const subStat = fs.lstatSync(dirPath);
        if (subStat.isSymbolicLink()) {
          return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Storage ${name} directory is a symbolic link: "${dirPath}"` };
        }
        if (!subStat.isDirectory()) {
          return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Storage ${name} directory is not a directory: "${dirPath}"` };
        }
        const subMode = subStat.mode & 0o777;
        if ((subMode & 0o077) !== 0) {
          return {
            ok: false,
            baseDir: null,
            backupsDir: null,
            locksDir: null,
            error: `Storage ${name} directory has unsafe existing permissions 0o${subMode.toString(8)} (group/world accessible); expected 0700`,
          };
        }
      } else {
        fs.mkdirSync(dirPath, { mode: 0o700 });
        try {
          fs.chmodSync(dirPath, 0o700);
        } catch {
          // ignore
        }
      }

      // Verify realpath of subdirectories after creation
      const postRealSub = fs.realpathSync(dirPath);
      if (postRealSub === canonicalRepoRoot || postRealSub.startsWith(canonicalRepoRoot + path.sep)) {
        return {
          ok: false,
          baseDir: null,
          backupsDir: null,
          locksDir: null,
          error: `Storage ${name} directory resolves inside the target SillyTavern repository: "${postRealSub}"`,
        };
      }
    } catch (err) {
      return { ok: false, baseDir: null, backupsDir: null, locksDir: null, error: `Failed to initialize ${name} directory: ${err.message}` };
    }
  }

  return {
    ok: true,
    baseDir: candidateBase,
    backupsDir,
    locksDir,
    error: null,
  };
}

/**
 * Create a cryptographically verified pre-mutation backup file and metadata descriptor.
 *
 * Safely creates the backup with O_CREAT | O_EXCL, mode 0600, flushes with fsyncSync,
 * and verifies that the written bytes exactly match expectedSha256 before returning.
 * Preserves incomplete backup evidence if metadata creation or verification fails.
 *
 * @param {object} options
 * @param {string} options.repoRoot - SillyTavern repository root
 * @param {string} options.targetFilePath - Absolute path to target file in working tree
 * @param {string} options.expectedSha256 - Expected SHA-256 fingerprint of the target file
 * @param {'apply'|'remove'} [options.operation='apply']
 * @param {string} options.backupDir - Resolved private backups directory
 * @param {string} [options.targetMode='0644'] - Canonical mode recorded in metadata
 * @param {object} [options._testHooks] - Internal test-only hooks for error simulation
 * @returns {{
 *   ok: boolean,
 *   backupFilePath: string,
 *   metaFilePath: string,
 *   backupFileName: string,
 *   metaFileName: string,
 *   sha256: string,
 *   size: number,
 *   createdAt: string
 * }}
 */
export function createPreMutationBackup({
  repoRoot,
  targetFilePath,
  expectedSha256,
  operation = 'apply',
  backupDir,
  targetMode = '0644',
  _testHooks = {},
}) {
  if (!repoRoot || !targetFilePath || !expectedSha256 || !backupDir) {
    throw new Error('createPreMutationBackup: missing required parameters');
  }

  // Inspect target file
  const tStat = fs.lstatSync(targetFilePath);
  if (tStat.isSymbolicLink()) {
    throw new Error(`Target file is a symbolic link: "${targetFilePath}"`);
  }
  if (!tStat.isFile()) {
    throw new Error(`Target file is not a regular file: "${targetFilePath}"`);
  }

  // Read content bytes and verify initial hash
  const contentBuffer = fs.readFileSync(targetFilePath);
  const readSha = computeSha256(contentBuffer);
  if (readSha.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Target file content SHA-256 (${readSha}) does not match expected SHA-256 (${expectedSha256}) before backup`
    );
  }

  const canonicalRepoRoot = fs.realpathSync(repoRoot);
  const repoHash = computeSha256(canonicalRepoRoot).slice(0, 12);
  const timestamp = formatCompactTimestamp(new Date());
  const randHex = crypto.randomBytes(4).toString('hex');
  const tag = operation === 'remove' ? 'patched' : 'stock';
  const targetRelFile = path.relative(canonicalRepoRoot, targetFilePath).replace(/\\/g, '/');

  const backupBaseName = `stable-diffusion.js.${timestamp}.${repoHash}.${randHex}.${tag}.bak`;
  const metaBaseName = `stable-diffusion.js.${timestamp}.${repoHash}.${randHex}.meta.json`;
  const backupFilePath = path.join(backupDir, backupBaseName);
  const metaFilePath = path.join(backupDir, metaBaseName);

  if (typeof _testHooks.beforeBackupOpen === 'function') {
    _testHooks.beforeBackupOpen({ backupFilePath, metaFilePath });
  }

  const openFlags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW || 0);

  // 1. Write backup file exclusively with mode 0600
  let backupFd = null;
  let backupFileCreated = false;

  try {
    backupFd = fs.openSync(backupFilePath, openFlags, 0o600);
    backupFileCreated = true;

    try {
      const bytesWritten = fs.writeSync(backupFd, contentBuffer);
      if (bytesWritten !== contentBuffer.length) {
        throw new Error(
          `Incomplete backup write: wrote ${bytesWritten} of ${contentBuffer.length} bytes (${backupFilePath})`
        );
      }
      if (typeof _testHooks.beforeBackupFsync === 'function') {
        _testHooks.beforeBackupFsync({ backupFd, backupFilePath });
      }
      fs.fsyncSync(backupFd);
    } finally {
      if (backupFd !== null) {
        try {
          fs.closeSync(backupFd);
          backupFd = null;
        } catch {
          // ignore
        }
      }
    }

    // 2. Verify backup file on disk
    let bStat;
    try {
      bStat = fs.lstatSync(backupFilePath);
    } catch (statErr) {
      throw new Error(`Backup file validation failed: could not stat (${statErr.message})`);
    }
    if (bStat.isSymbolicLink() || !bStat.isFile()) {
      throw new Error(`Backup file validation failed: not a regular file (${backupFilePath})`);
    }
    if (bStat.size !== contentBuffer.length) {
      throw new Error(
        `Backup file size mismatch: expected ${contentBuffer.length} bytes, found ${bStat.size} bytes (${backupFilePath})`
      );
    }
    let readBack;
    try {
      readBack = fs.readFileSync(backupFilePath);
    } catch (readErr) {
      throw new Error(`Backup file verification failed: could not read back (${readErr.message})`);
    }
    const backSha = computeSha256(readBack);
    if (backSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Backup file verification failed: written SHA-256 (${backSha}) does not match expected (${expectedSha256})`
      );
    }

    // 3. Write metadata file exclusively with mode 0600
    const createdAt = new Date().toISOString();
    const metaPayloadObj = {
      schemaVersion: '1.1.0',
      createdAt,
      operation,
      repoRoot: canonicalRepoRoot,
      repoHash,
      targetFile: targetRelFile,
      sha256: expectedSha256,
      targetMode,
      backupFileName: backupBaseName,
    };
    const metaContent = JSON.stringify(metaPayloadObj, null, 2) + '\n';

    let metaFd = null;
    try {
      if (typeof _testHooks.beforeMetaOpen === 'function') {
        _testHooks.beforeMetaOpen({ metaFilePath, backupFilePath });
      }
      metaFd = fs.openSync(metaFilePath, openFlags, 0o600);
      fs.writeSync(metaFd, Buffer.from(metaContent, 'utf-8'));
      if (typeof _testHooks.beforeMetaFsync === 'function') {
        _testHooks.beforeMetaFsync({ metaFd, metaFilePath, backupFilePath });
      }
      fs.fsyncSync(metaFd);
    } catch (err) {
      // Preserve partial backup evidence: do NOT delete backupFilePath!
      const wrappedErr = new Error(`Backup metadata creation failed: ${err.message}`);
      wrappedErr.backupFilePath = backupFilePath;
      wrappedErr.metaFilePath = metaFilePath;
      throw wrappedErr;
    } finally {
      if (metaFd !== null) {
        try {
          fs.closeSync(metaFd);
        } catch {
          // ignore
        }
      }
    }

    // 4. Verify metadata file on disk
    try {
      const mStat = fs.lstatSync(metaFilePath);
      if (mStat.isSymbolicLink() || !mStat.isFile()) {
        throw new Error(`Metadata file validation failed: not a regular file (${metaFilePath})`);
      }
      let parsedMeta;
      try {
        parsedMeta = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
      } catch (parseErr) {
        throw new Error(`Failed to read/parse backup metadata file: ${parseErr.message}`);
      }

      if (
        parsedMeta.schemaVersion !== '1.1.0' ||
        parsedMeta.sha256.toLowerCase() !== expectedSha256.toLowerCase() ||
        parsedMeta.repoHash !== repoHash
      ) {
        throw new Error(`Metadata validation failed: content mismatch in ${metaFilePath}`);
      }
    } catch (err) {
      const wrappedErr = new Error(`Backup metadata verification failed: ${err.message}`);
      wrappedErr.backupFilePath = backupFilePath;
      wrappedErr.metaFilePath = metaFilePath;
      throw wrappedErr;
    }

    return {
      ok: true,
      backupFilePath,
      metaFilePath,
      backupFileName: backupBaseName,
      metaFileName: metaBaseName,
      sha256: expectedSha256,
      size: contentBuffer.length,
      createdAt,
    };
  } catch (err) {
    if (backupFileCreated && !err.backupFilePath) {
      err.backupFilePath = backupFilePath;
    }
    throw err;
  }
}

/**
 * Verify integrity of an existing backup file against expected SHA-256.
 * @param {string} backupFilePath
 * @param {string} expectedSha256
 * @returns {{ ok: boolean, error?: string, size?: number }}
 */
export function verifyBackupIntegrity(backupFilePath, expectedSha256) {
  try {
    if (!fs.existsSync(backupFilePath)) {
      return { ok: false, error: `Backup file does not exist: "${backupFilePath}"` };
    }
    const stat = fs.lstatSync(backupFilePath);
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `Backup file is a symbolic link: "${backupFilePath}"` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Backup file is not a regular file: "${backupFilePath}"` };
    }
    const bytes = fs.readFileSync(backupFilePath);
    const sha = computeSha256(bytes);
    if (sha.toLowerCase() !== expectedSha256.toLowerCase()) {
      return {
        ok: false,
        error: `Backup SHA-256 mismatch: observed ${sha}, expected ${expectedSha256}`,
      };
    }
    return { ok: true, size: bytes.length };
  } catch (err) {
    return { ok: false, error: `Failed to verify backup integrity: ${err.message}` };
  }
}

/**
 * Acquire exclusive operation lock for the repository in user-local locks directory.
 *
 * Creates <repoHash>.lock exclusively with mode 0600.
 * Records process PID, nonce, timestamp, repo identity, and filesystem identity (dev, ino, uid).
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {string} options.lockDir - Directory where lock file will be created
 * @param {string} [options.operation='apply']
 * @returns {{
 *   ok: boolean,
 *   lockPath: string,
 *   pid?: number,
 *   nonce?: string,
 *   dev?: number,
 *   ino?: number,
 *   uid?: number,
 *   createdAt?: string,
 *   repoRoot?: string,
 *   repoHash?: string,
 *   operation?: string,
 *   existingLock?: object|null,
 *   error?: string
 * }}
 */
export function acquireProcessLock(repoRoot, { lockDir, operation = 'apply' } = {}) {
  if (!repoRoot || !lockDir) {
    return { ok: false, lockPath: '', error: 'acquireProcessLock: repoRoot and lockDir are required' };
  }

  let canonicalRepoRoot;
  try {
    canonicalRepoRoot = fs.realpathSync(repoRoot);
  } catch (err) {
    return { ok: false, lockPath: '', error: `Cannot resolve repository root: ${err.message}` };
  }

  const repoHash = computeSha256(canonicalRepoRoot).slice(0, 12);
  const lockFileName = `${repoHash}.lock`;
  const lockFilePath = path.join(lockDir, lockFileName);
  const nonce = crypto.randomBytes(8).toString('hex');
  const createdAt = new Date().toISOString();

  const payload = {
    lockVersion: 1,
    pid: process.pid,
    nonce,
    createdAt,
    repoRoot: canonicalRepoRoot,
    repoHash,
    operation,
  };
  const payloadStr = JSON.stringify(payload, null, 2) + '\n';

  const openFlags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW || 0);

  let fd = null;
  try {
    fd = fs.openSync(lockFilePath, openFlags, 0o600);
    fs.writeSync(fd, Buffer.from(payloadStr, 'utf-8'));
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);

    return {
      ok: true,
      lockPath: lockFilePath,
      pid: process.pid,
      nonce,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      createdAt,
      repoRoot: canonicalRepoRoot,
      repoHash,
      operation,
    };
  } catch (err) {
    if (err.code === 'EEXIST') {
      let existingLock = null;
      try {
        const raw = fs.readFileSync(lockFilePath, 'utf-8');
        existingLock = JSON.parse(raw);
      } catch {
        // unreadable or corrupt
      }
      return {
        ok: false,
        lockPath: lockFilePath,
        error: `Exclusive operation lock is already held for repository at ${lockFilePath}`,
        existingLock,
      };
    }
    return {
      ok: false,
      lockPath: lockFilePath,
      error: `Failed to acquire operation lock at ${lockFilePath}: ${err.message}`,
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
 * Verify ownership and continuity of an acquired operation lock.
 *
 * Confirms:
 * - Lock file still exists and is a regular file.
 * - Device, inode, and UID match original creation stat.
 * - Process PID, nonce, and repository hash match recorded handle.
 *
 * @param {object} lockHandle
 * @returns {{ ok: boolean, error?: string }}
 */
export function verifyLockOwnership(lockHandle) {
  if (!lockHandle || typeof lockHandle !== 'object' || !lockHandle.lockPath) {
    return { ok: false, error: 'Invalid lock handle' };
  }

  const lockPath = lockHandle.lockPath;
  try {
    if (!fs.existsSync(lockPath)) {
      return { ok: false, error: `Lock file does not exist: "${lockPath}"` };
    }
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `Lock file is a symbolic link: "${lockPath}"` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Lock file is not a regular file: "${lockPath}"` };
    }
    if (stat.dev !== lockHandle.dev || stat.ino !== lockHandle.ino) {
      return {
        ok: false,
        error: `Lock filesystem identity mismatch: dev/ino changed (expected ${lockHandle.dev}:${lockHandle.ino}, found ${stat.dev}:${stat.ino})`,
      };
    }
    if (lockHandle.uid !== undefined && stat.uid !== lockHandle.uid) {
      return {
        ok: false,
        error: `Lock filesystem identity mismatch: UID changed (expected ${lockHandle.uid}, found ${stat.uid})`,
      };
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return {
        ok: false,
        error: `Lock filesystem identity mismatch: UID does not match current process UID (${stat.uid} !== ${process.getuid()})`,
      };
    }

    const content = fs.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (
      parsed.pid !== lockHandle.pid ||
      parsed.nonce !== lockHandle.nonce ||
      parsed.repoHash !== lockHandle.repoHash
    ) {
      return { ok: false, error: 'Lock ownership metadata mismatch: PID, nonce, or repoHash changed' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to verify lock ownership: ${err.message}` };
  }
}

/**
 * Release an acquired operation lock after verifying ownership continuity.
 *
 * Will refuse to delete the lock file if ownership, device, inode, or UID verification fails.
 *
 * @param {object} lockHandle
 * @returns {{ ok: boolean, error?: string }}
 */
export function releaseProcessLock(lockHandle) {
  if (!lockHandle || !lockHandle.lockPath) {
    return { ok: false, error: 'Invalid lock handle for release' };
  }

  const check = verifyLockOwnership(lockHandle);
  if (!check.ok) {
    return {
      ok: false,
      error: `Lock release refused: ownership verification failed (${check.error}); preserving lock file`,
    };
  }

  try {
    fs.unlinkSync(lockHandle.lockPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to unlink lock file: ${err.message}` };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getCiPatchDir,
  validateCiPatchPath,
  inspectLock,
  LOCK_DIR_NAME,
  getPathLstat,
} from './lock.js';
import {
  inspectJournal,
  JOURNAL_FILE_NAME,
  isValidDeviceIdentifier,
  isValidInodeIdentifier,
} from './journal.js';

const RECOGNIZED_ENTRIES = Object.freeze([
  LOCK_DIR_NAME,
  JOURNAL_FILE_NAME,
  'staging',
  'backup',
]);

const TMP_JOURNAL_REGEX = /^\.journal\..*\.tmp$/;

const BACKUP_REQUIRING_PHASES = Object.freeze([
  'BACKUP_CREATED',
  'READY_TO_SWAP',
  'SWAPPED',
  'COMPLETED',
]);


/**
 * Allowed artifact file basenames for a transaction's staging or backup directory.
 * Narrow explicit contract for P3B-1.
 * Final details for multi-file or full directory tree mirroring will be formalized in P3B-2.
 *
 * @param {object|null} journal
 * @param {'staging'|'backup'} kind
 * @returns {Set<string>}
 */
export function getPermittedArtifactNames(journal, kind) {
  const permitted = new Set();
  if (!journal) return permitted;

  if (typeof journal.targetFile === 'string' && journal.targetFile.trim() !== '') {
    const base = path.basename(journal.targetFile.trim());
    permitted.add(base);
    if (kind === 'backup') {
      permitted.add(`${base}.bak`);
      permitted.add(`${base}.orig`);
    }
  }

  if (kind === 'staging') {
    if (typeof journal.isolatedStagedPath === 'string' && journal.isolatedStagedPath.trim() !== '') {
      permitted.add(path.basename(journal.isolatedStagedPath.trim()));
    }
    if (typeof journal.stagedPath === 'string' && journal.stagedPath.trim() !== '') {
      permitted.add(path.basename(journal.stagedPath.trim()));
    }
  }
  if (kind === 'backup' && typeof journal.backupPath === 'string' && journal.backupPath.trim() !== '') {
    permitted.add(path.basename(journal.backupPath.trim()));
  }

  return permitted;
}

export const MAX_BACKUP_INSPECT_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Pure capability predicate that checks whether a constants object satisfies
 * the required platform O_NOFOLLOW capability.
 *
 * @param {object|null|undefined} constants
 * @returns {boolean}
 */
export function hasRequiredNoFollow(constants) {
  return Boolean(
    constants &&
    typeof constants.O_NOFOLLOW === 'number' &&
    Number.isInteger(constants.O_NOFOLLOW) &&
    constants.O_NOFOLLOW !== 0
  );
}

/**
 * Bounded, descriptor-based readback and SHA-256 verification of a backup artifact.
 * Strictly read-only; imposes size bounds before allocating buffer.
 *
 * @param {string} cPath - Absolute path to backup artifact
 * @param {string} expectedSha - Expected initial SHA-256 hex digest
 * @param {string} phase - Current journal phase
 * @param {string} relArtifact - Human-readable relative artifact name for error messages
 * @returns {{
 *   ok: boolean,
 *   isSymlink?: boolean,
 *   isForeign?: boolean,
 *   isError?: boolean,
 *   isOversized?: boolean,
 *   isIncomplete?: boolean,
 *   isCorrupt?: boolean,
 *   actualSha?: string,
 *   reason?: string
 * }}
 */
export function inspectBackupArtifactFile(cPath, expectedSha, phase, relArtifact) {
  if (!hasRequiredNoFollow(fs.constants)) {
    return {
      ok: false,
      isError: true,
      reason: `Unsupported platform: O_NOFOLLOW file open flag is required for safe backup inspection of "${relArtifact}"`,
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(cPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ELOOP') {
      return { ok: false, isSymlink: true, reason: `Backup artifact is a symbolic link: "${relArtifact}"` };
    }
    if (err?.code === 'ENOENT') {
      return { ok: false, isIncomplete: true, reason: `Backup artifact was not found when opening: "${relArtifact}"` };
    }
    return { ok: false, isError: true, reason: `Failed to open backup artifact descriptor: ${err.message}` };
  }

  try {
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return { ok: false, isForeign: true, reason: `Backup artifact descriptor is not a regular file: "${relArtifact}"` };
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      return { ok: false, isError: true, reason: `Backup artifact descriptor has invalid device or inode identity: "${relArtifact}"` };
    }
    if (preStat.size > MAX_BACKUP_INSPECT_BYTES) {
      return {
        ok: false,
        isOversized: true,
        reason: `Backup artifact size (${preStat.size} bytes) exceeds safety limit (${MAX_BACKUP_INSPECT_BYTES} bytes): "${relArtifact}"`,
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
          isIncomplete: true,
          reason: `Unexpected EOF reading backup artifact: read ${readBytes} of ${expectedSize} bytes: "${relArtifact}"`,
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
        isIncomplete: true,
        reason: `Backup artifact expanded concurrently during inspection: "${relArtifact}"`,
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
        isIncomplete: true,
        reason: `Backup artifact identity or size changed concurrently during inspection: "${relArtifact}"`,
      };
    }

    // Pathname-to-descriptor identity consistency
    const pathCheck = getPathLstat(cPath);
    if (pathCheck.error) {
      if (pathCheck.error.code === 'ENOENT') {
        return { ok: false, isIncomplete: true, reason: `Backup artifact was unlinked during inspection: "${relArtifact}"` };
      }
      return { ok: false, isError: true, reason: `Failed to inspect backup pathname: ${pathCheck.error.message}` };
    }
    if (!pathCheck.exists) {
      return { ok: false, isIncomplete: true, reason: `Backup artifact was unlinked during inspection: "${relArtifact}"` };
    }
    if (pathCheck.isSymbolicLink) {
      return { ok: false, isSymlink: true, reason: `Backup artifact was replaced by a symbolic link: "${relArtifact}"` };
    }
    if (!pathCheck.isFile) {
      return { ok: false, isForeign: true, reason: `Backup pathname is no longer a regular file: "${relArtifact}"` };
    }
    if (!pathCheck.stat || pathCheck.stat.dev !== preStat.dev || pathCheck.stat.ino !== preStat.ino) {
      return { ok: false, isIncomplete: true, reason: `Backup pathname inode identity changed during inspection: "${relArtifact}"` };
    }

    if (typeof expectedSha === 'string' && expectedSha.trim() !== '') {
      const actualSha = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
        return {
          ok: false,
          isCorrupt: true,
          actualSha,
          reason: `Corrupted backup artifact in phase "${phase}": "${relArtifact}" SHA-256 (${actualSha}) does not match expected initial SHA-256 (${expectedSha})`,
        };
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, isError: true, reason: `Error during backup descriptor inspection: ${err.message}` };
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

export const MAX_DESTINATION_INSPECT_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Bounded, descriptor-based readback and verification of a destination candidate artifact.
 * Strictly read-only; imposes size bounds before allocating buffer.
 *
 * @param {string} cPath - Absolute path to candidate artifact
 * @param {string} expectedSha - Expected result SHA-256 hex digest
 * @param {string} expectedMode - Expected 4-character octal targetMode (e.g. "0644")
 * @param {string} phase - Current journal phase
 * @param {string} relArtifact - Human-readable relative artifact name for error messages
 * @returns {{
 *   ok: boolean,
 *   isSymlink?: boolean,
 *   isForeign?: boolean,
 *   isError?: boolean,
 *   isOversized?: boolean,
 *   isIncomplete?: boolean,
 *   isCorrupt?: boolean,
 *   actualSha?: string,
 *   actualMode?: string,
 *   reason?: string
 * }}
 */
export function inspectDestinationCandidateFile(cPath, expectedSha, expectedMode, phase, relArtifact) {
  if (!hasRequiredNoFollow(fs.constants)) {
    return {
      ok: false,
      isError: true,
      reason: `Unsupported platform: O_NOFOLLOW file open flag is required for safe candidate inspection of "${relArtifact}"`,
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(cPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ELOOP') {
      return { ok: false, isSymlink: true, reason: `Destination candidate is a symbolic link: "${relArtifact}"` };
    }
    if (err?.code === 'ENOENT') {
      return { ok: false, isIncomplete: true, reason: `Destination candidate was not found when opening: "${relArtifact}"` };
    }
    return { ok: false, isError: true, reason: `Failed to open destination candidate descriptor: ${err.message}` };
  }

  try {
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return { ok: false, isForeign: true, reason: `Destination candidate descriptor is not a regular file: "${relArtifact}"` };
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      return { ok: false, isError: true, reason: `Destination candidate descriptor has invalid device or inode identity: "${relArtifact}"` };
    }
    if (preStat.size > MAX_DESTINATION_INSPECT_BYTES) {
      return {
        ok: false,
        isOversized: true,
        reason: `Destination candidate size (${preStat.size} bytes) exceeds safety limit (${MAX_DESTINATION_INSPECT_BYTES} bytes): "${relArtifact}"`,
      };
    }
    if (preStat.size === 0) {
      return {
        ok: false,
        isIncomplete: true,
        reason: `Destination candidate file is unexpectedly empty (0 bytes): "${relArtifact}"`,
      };
    }

    if (typeof expectedMode === 'string' && expectedMode.trim() !== '') {
      const expectedModeInt = parseInt(expectedMode, 8);
      if ((preStat.mode & 0o777) !== expectedModeInt) {
        const actualOctal = '0' + (preStat.mode & 0o777).toString(8).padStart(3, '0');
        return {
          ok: false,
          isIncomplete: true,
          actualMode: actualOctal,
          reason: `Destination candidate mode mismatch in phase "${phase}": expected ${expectedMode}, observed ${actualOctal}: "${relArtifact}"`,
        };
      }
    }

    const expectedSize = preStat.size;
    const buffer = Buffer.alloc(expectedSize);
    let totalRead = 0;
    while (totalRead < expectedSize) {
      const chunk = fs.readSync(fd, buffer, totalRead, expectedSize - totalRead, totalRead);
      if (chunk === 0) {
        return {
          ok: false,
          isIncomplete: true,
          reason: `Unexpected EOF reading destination candidate: read ${totalRead} of ${expectedSize} bytes: "${relArtifact}"`,
        };
      }
      totalRead += chunk;
    }

    // Concurrent expansion check
    const extraCheck = Buffer.alloc(1);
    const extra = fs.readSync(fd, extraCheck, 0, 1, expectedSize);
    if (extra !== 0) {
      return {
        ok: false,
        isIncomplete: true,
        reason: `Destination candidate expanded concurrently during inspection: "${relArtifact}"`,
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
        isIncomplete: true,
        reason: `Destination candidate identity or size changed concurrently during inspection: "${relArtifact}"`,
      };
    }

    // Pathname-to-descriptor identity consistency
    const pathCheck = getPathLstat(cPath);
    if (pathCheck.error) {
      if (pathCheck.error.code === 'ENOENT') {
        return { ok: false, isIncomplete: true, reason: `Destination candidate was unlinked during inspection: "${relArtifact}"` };
      }
      return { ok: false, isError: true, reason: `Failed to inspect destination candidate pathname: ${pathCheck.error.message}` };
    }
    if (!pathCheck.exists) {
      return { ok: false, isIncomplete: true, reason: `Destination candidate was unlinked during inspection: "${relArtifact}"` };
    }
    if (pathCheck.isSymbolicLink) {
      return { ok: false, isSymlink: true, reason: `Destination candidate was replaced by a symbolic link: "${relArtifact}"` };
    }
    if (!pathCheck.isFile) {
      return { ok: false, isForeign: true, reason: `Destination candidate pathname is no longer a regular file: "${relArtifact}"` };
    }
    if (!pathCheck.stat || pathCheck.stat.dev !== preStat.dev || pathCheck.stat.ino !== preStat.ino) {
      return { ok: false, isIncomplete: true, reason: `Destination candidate pathname inode identity changed during inspection: "${relArtifact}"` };
    }

    if (typeof expectedSha === 'string' && expectedSha.trim() !== '') {
      const actualSha = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
        return {
          ok: false,
          isCorrupt: true,
          actualSha,
          reason: `Corrupted destination candidate in phase "${phase}": "${relArtifact}" SHA-256 (${actualSha}) does not match expected result SHA-256 (${expectedSha})`,
        };
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, isError: true, reason: `Error during destination candidate descriptor inspection: ${err.message}` };
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


export const MAX_LIVE_TARGET_INSPECT_BYTES = 50 * 1024 * 1024; // 50 MiB

/**
 * Bounded, descriptor-based readback and verification of the live target file.
 * Strictly read-only; imposes size bounds before allocating buffer.
 * Prechecks pathname type and uses O_NONBLOCK to prevent blocking on FIFOs or special files.
 * Verifies stable permissions across pre-read, post-read, and pathname checks.
 *
 * @param {string} cPath - Absolute path to live target file
 * @param {string} expectedInitialSha - Expected initial SHA-256 hex digest
 * @param {string} expectedResultSha - Expected result SHA-256 hex digest
 * @param {string} expectedMode - Expected 4-character octal targetMode (e.g. "0644")
 * @param {string} phase - Current journal phase
 * @param {string} relTarget - Human-readable relative target name for error messages
 * @returns {{
 *   ok: boolean,
 *   isMissing?: boolean,
 *   isSymlink?: boolean,
 *   isUnsupportedType?: boolean,
 *   isForeign?: boolean,
 *   isError?: boolean,
 *   isOversized?: boolean,
 *   isIncomplete?: boolean,
 *   actualSha?: string,
 *   actualMode?: string,
 *   isInitial?: boolean,
 *   isResult?: boolean,
 *   modeMatches?: boolean,
 *   size?: number,
 *   reason?: string
 * }}
 */
export function inspectLiveTargetFile(cPath, expectedInitialSha, expectedResultSha, expectedMode, phase, relTarget) {
  if (!hasRequiredNoFollow(fs.constants)) {
    return {
      ok: false,
      isError: true,
      reason: `Unsupported platform: O_NOFOLLOW file open flag is required for safe live target inspection of "${relTarget}"`,
    };
  }

  // Pathname precheck to avoid hanging on FIFOs or non-regular files
  const preCheck = getPathLstat(cPath);
  if (preCheck.error) {
    if (preCheck.error.code === 'ENOENT') {
      return { ok: false, isMissing: true, isIncomplete: true, reason: `Live target was not found: "${relTarget}"` };
    }
    return { ok: false, isError: true, reason: `Failed to inspect live target pathname before opening: ${preCheck.error.message}` };
  }
  if (!preCheck.exists) {
    return { ok: false, isMissing: true, isIncomplete: true, reason: `Live target does not exist: "${relTarget}"` };
  }
  if (preCheck.isSymbolicLink) {
    return { ok: false, isSymlink: true, reason: `Live target is a symbolic link: "${relTarget}"` };
  }
  if (!preCheck.isFile) {
    return { ok: false, isUnsupportedType: true, isIncomplete: true, reason: `Live target pathname is not a regular file: "${relTarget}"` };
  }

  let fd = null;
  const openFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0);
  try {
    fd = fs.openSync(cPath, openFlags);
  } catch (err) {
    if (err?.code === 'ELOOP') {
      return { ok: false, isSymlink: true, reason: `Live target is a symbolic link: "${relTarget}"` };
    }
    if (err?.code === 'ENOENT') {
      return { ok: false, isMissing: true, isIncomplete: true, reason: `Live target was not found when opening: "${relTarget}"` };
    }
    return { ok: false, isError: true, reason: `Failed to open live target descriptor: ${err.message}` };
  }

  try {
    const preStat = fs.fstatSync(fd);
    if (!preStat.isFile() || preStat.isSymbolicLink()) {
      return { ok: false, isUnsupportedType: true, isIncomplete: true, reason: `Live target descriptor is not a regular file: "${relTarget}"` };
    }
    if (!isValidDeviceIdentifier(preStat.dev) || !isValidInodeIdentifier(preStat.ino)) {
      return { ok: false, isError: true, reason: `Live target descriptor has invalid device or inode identity: "${relTarget}"` };
    }
    if (preStat.size > MAX_LIVE_TARGET_INSPECT_BYTES) {
      return {
        ok: false,
        isOversized: true,
        isError: true,
        reason: `Live target size (${preStat.size} bytes) exceeds safety limit (${MAX_LIVE_TARGET_INSPECT_BYTES} bytes): "${relTarget}"`,
      };
    }

    const expectedSize = preStat.size;
    const preMode = preStat.mode & 0o777;
    const buffer = Buffer.alloc(expectedSize);
    let totalRead = 0;
    while (totalRead < expectedSize) {
      const chunk = fs.readSync(fd, buffer, totalRead, expectedSize - totalRead, totalRead);
      if (chunk === 0) {
        return {
          ok: false,
          isIncomplete: true,
          reason: `Unexpected EOF reading live target: read ${totalRead} of ${expectedSize} bytes: "${relTarget}"`,
        };
      }
      totalRead += chunk;
    }

    // Concurrent expansion check
    const extraCheck = Buffer.alloc(1);
    const extra = fs.readSync(fd, extraCheck, 0, 1, expectedSize);
    if (extra !== 0) {
      return {
        ok: false,
        isIncomplete: true,
        reason: `Live target expanded concurrently during inspection: "${relTarget}"`,
      };
    }

    // Post-read descriptor consistency check
    const postStat = fs.fstatSync(fd);
    if (
      postStat.dev !== preStat.dev ||
      postStat.ino !== preStat.ino ||
      postStat.size !== expectedSize ||
      !postStat.isFile()
    ) {
      return {
        ok: false,
        isIncomplete: true,
        reason: `Live target identity or size changed concurrently during inspection: "${relTarget}"`,
      };
    }

    // Stable Permissions Verification across descriptor readback
    if ((postStat.mode & 0o777) !== preMode) {
      return {
        ok: false,
        isIncomplete: true,
        reason: `Live target permissions changed concurrently during descriptor readback: "${relTarget}"`,
      };
    }

    // Pathname-to-descriptor identity and stable permissions check
    const pathCheck = getPathLstat(cPath);
    if (pathCheck.error) {
      if (pathCheck.error.code === 'ENOENT') {
        return { ok: false, isIncomplete: true, reason: `Live target was unlinked during inspection: "${relTarget}"` };
      }
      return { ok: false, isError: true, reason: `Failed to inspect live target pathname: ${pathCheck.error.message}` };
    }
    if (!pathCheck.exists) {
      return { ok: false, isIncomplete: true, reason: `Live target was unlinked during inspection: "${relTarget}"` };
    }
    if (pathCheck.isSymbolicLink) {
      return { ok: false, isSymlink: true, reason: `Live target was replaced by a symbolic link: "${relTarget}"` };
    }
    if (!pathCheck.isFile) {
      return { ok: false, isUnsupportedType: true, isIncomplete: true, reason: `Live target pathname is no longer a regular file: "${relTarget}"` };
    }
    if (!pathCheck.stat || pathCheck.stat.dev !== preStat.dev || pathCheck.stat.ino !== preStat.ino) {
      return { ok: false, isIncomplete: true, reason: `Live target pathname inode identity changed during inspection: "${relTarget}"` };
    }
    if ((pathCheck.stat.mode & 0o777) !== preMode) {
      return {
        ok: false,
        isIncomplete: true,
        reason: `Live target permissions changed concurrently between pathname and descriptor: "${relTarget}"`,
      };
    }

    const actualSha = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
    const actualMode = '0' + preMode.toString(8).padStart(3, '0');
    const isInitial = typeof expectedInitialSha === 'string' && actualSha === expectedInitialSha.toLowerCase();
    const isResult = typeof expectedResultSha === 'string' && actualSha === expectedResultSha.toLowerCase();

    let modeMatches = true;
    if (typeof expectedMode === 'string' && expectedMode.trim() !== '') {
      modeMatches = preMode === parseInt(expectedMode, 8);
    }

    return {
      ok: true,
      actualSha,
      actualMode,
      isInitial,
      isResult,
      modeMatches,
      size: expectedSize,
    };
  } catch (err) {
    return { ok: false, isError: true, reason: `Error during live target descriptor inspection: ${err.message}` };
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
 * Perform comprehensive read-only inspection of installer transaction metadata.
 * Never mutates, acquires, steals, or deletes locks or journals.
 * Detects orphaned artifacts, dangling symlinks, and ambiguous metadata.
 *
 * @param {string} repoRoot
 * @returns {{
 *   state: 'none' | 'ownership-unverified' | 'orphaned-journal' | 'corrupted-journal' | 'corrupted-lock' | 'mismatched-metadata' | 'foreign-content' | 'unsafe-symlink' | 'orphaned-artifact' | 'incomplete-transaction' | 'inspection-error',
 *   hasLock: boolean,
 *   hasJournal: boolean,
 *   isPending: boolean,
 *   lock: object|null,
 *   journal: object|null,
 *   foreignEntries: string[],
 *   orphanedArtifacts: string[],
 *   reasons: string[]
 * }}
 */
export function inspectTransactionState(repoRoot) {
  const reasons = [];
  const foreignEntries = [];
  const orphanedArtifacts = [];
  const inspectionErrors = [];
  let hasUnsafeSymlink = false;
  let hasInspectionError = false;
  let isIncompleteTransaction = false;

  const ciPathCheck = validateCiPatchPath(repoRoot);
  if (!ciPathCheck.ok) {
    if (ciPathCheck.isSymlink) {
      return {
        state: 'unsafe-symlink',
        hasLock: false,
        hasJournal: false,
        isPending: true,
        lock: null,
        journal: null,
        foreignEntries: [],
        orphanedArtifacts: [],
        reasons: ['Installer directory (.ci-patch) is a symbolic link, which is not permitted'],
      };
    }
    return {
      state: 'inspection-error',
      hasLock: false,
      hasJournal: false,
      isPending: true,
      lock: null,
      journal: null,
      foreignEntries: [],
      orphanedArtifacts: [],
      reasons: [ciPathCheck.error || 'Installer directory (.ci-patch) path is invalid'],
    };
  }

  let dirEntries = [];
  let lockInspection = { hasLock: false, isValid: true, isSymlink: false, owner: null, lockDirPath: '', errors: [] };
  let journalInspection = { hasJournal: false, isValid: true, isSymlink: false, journal: null, journalPath: '', errors: [] };
  let hasLock = false;
  let hasJournal = false;
  let isMismatched = false;

  if (ciPathCheck.exists) {
    const ciPatchDir = getCiPatchDir(repoRoot);
    try {
      dirEntries = fs.readdirSync(ciPatchDir);
    } catch (err) {
      return {
        state: 'inspection-error',
        hasLock: false,
        hasJournal: false,
        isPending: true,
        lock: null,
        journal: null,
        foreignEntries: [],
        orphanedArtifacts: [],
        reasons: [`Failed to read installer directory: ${err.message}`],
      };
    }

    // Inspect lock and journal first
    lockInspection = inspectLock(repoRoot);
    journalInspection = inspectJournal(repoRoot);

    hasLock = lockInspection.hasLock;
    hasJournal = journalInspection.hasJournal;

  if (lockInspection.isSymlink || journalInspection.isSymlink) {
    hasUnsafeSymlink = true;
    reasons.push('Installer lock or journal component is a symbolic link');
  }

  // Inspect entries in .ci-patch
  for (const entry of dirEntries) {
    if (TMP_JOURNAL_REGEX.test(entry)) {
      orphanedArtifacts.push(entry);
      reasons.push(`Orphaned temporary journal file detected: ${entry}`);
      const tmpPath = path.join(ciPatchDir, entry);
      const tmpCheck = getPathLstat(tmpPath);
      if (tmpCheck.error) {
        hasInspectionError = true;
        inspectionErrors.push(`Failed to inspect temporary journal file (${entry}): ${tmpCheck.error.message}`);
        reasons.push(`Failed to inspect temporary journal file (${entry}): ${tmpCheck.error.message}`);
      } else if (tmpCheck.isSymbolicLink) {
        hasUnsafeSymlink = true;
        reasons.push(`Temporary journal file (${entry}) is a symbolic link`);
      }
      continue;
    }

    if (!RECOGNIZED_ENTRIES.includes(entry)) {
      foreignEntries.push(entry);
      continue;
    }
  }

  // Full lock/journal transaction consistency
  if (hasLock && hasJournal && lockInspection.isValid && journalInspection.isValid && lockInspection.owner && journalInspection.journal) {
    const lockOwner = lockInspection.owner;
    const journalObj = journalInspection.journal;

    // 1. Transaction ID match
    if (lockOwner.txId !== journalObj.txId) {
      isMismatched = true;
      reasons.push(
        `Transaction ID mismatch: lock belongs to "${lockOwner.txId}" but journal belongs to "${journalObj.txId}"`
      );
    }

    // 2. Operation match ('apply' vs 'remove')
    if (lockOwner.op !== journalObj.op) {
      isMismatched = true;
      reasons.push(
        `Transaction operation mismatch: lock operation is "${lockOwner.op}" but journal operation is "${journalObj.op}"`
      );
    }

    // 3. Repository root match
    if (path.resolve(lockOwner.repoRoot) !== path.resolve(repoRoot)) {
      isMismatched = true;
      reasons.push(
        `Transaction repository root mismatch: lock repoRoot "${lockOwner.repoRoot}" does not match inspected repoRoot "${repoRoot}"`
      );
    }
  }

  // Corrupted lock
  if (hasLock && !lockInspection.isValid) {
    reasons.push(...lockInspection.errors);
  }

  // Corrupted journal
  if (hasJournal && !journalInspection.isValid) {
    reasons.push(...journalInspection.errors);
  }

  // Orphaned journal (journal exists without lock)
  if (hasJournal && !hasLock) {
    reasons.push(
      `Orphaned journal detected: journal exists in phase "${journalInspection.journal?.phase || 'unknown'}" without an active lock`
    );
  }

  // Legacy journal schema note
  if (hasJournal && journalInspection.isValid && journalInspection.journal) {
    if (typeof journalInspection.journal.stagedPath === 'string') {
      reasons.push('Legacy journal schema detected: journal contains deprecated "stagedPath"');
    }
  }

  // Inspect recognized directory: staging
  const stagingPath = path.join(ciPatchDir, 'staging');
  const stagingCheck = getPathLstat(stagingPath);
  if (stagingCheck.error) {
    hasInspectionError = true;
    inspectionErrors.push(`Failed to inspect staging path (.ci-patch/staging): ${stagingCheck.error.message}`);
    reasons.push(`Failed to inspect staging path (.ci-patch/staging): ${stagingCheck.error.message}`);
  } else if (stagingCheck.exists) {
    if (stagingCheck.isSymbolicLink) {
      hasUnsafeSymlink = true;
      reasons.push('Staging path (.ci-patch/staging) is a symbolic link');
    } else if (!stagingCheck.isDirectory) {
      foreignEntries.push('staging');
      reasons.push('Staging path (.ci-patch/staging) exists but is not a directory');
    } else {
      try {
        const stagingEntries = fs.readdirSync(stagingPath);
        if (stagingEntries.length > 0) {
          if (!hasLock || !lockInspection.isValid || !lockInspection.owner) {
            orphanedArtifacts.push(...stagingEntries.map((e) => `staging/${e}`));
            reasons.push(`Non-empty staging directory detected with no active valid transaction: ${stagingEntries.join(', ')}`);
          } else {
            const expectedTxId = lockInspection.owner.txId;

            for (const sEntry of stagingEntries) {
              const sSubPath = path.join(stagingPath, sEntry);
              const sSubCheck = getPathLstat(sSubPath);

              if (sSubCheck.error) {
                hasInspectionError = true;
                inspectionErrors.push(`Failed to inspect staging component (staging/${sEntry}): ${sSubCheck.error.message}`);
                reasons.push(`Failed to inspect staging component (staging/${sEntry}): ${sSubCheck.error.message}`);
              } else if (sSubCheck.isSymbolicLink) {
                hasUnsafeSymlink = true;
                reasons.push(`Staging component (staging/${sEntry}) is a symbolic link`);
              } else if (sEntry !== expectedTxId) {
                orphanedArtifacts.push(`staging/${sEntry}`);
                reasons.push(`Staging entry "${sEntry}" does not match active transaction "${expectedTxId}"`);
              } else if (!sSubCheck.isDirectory) {
                orphanedArtifacts.push(`staging/${sEntry}`);
                reasons.push(`Staging entry "staging/${sEntry}" is not a directory`);
              } else {
                // Inspect inside staging/<txId>
                try {
                  const txChildren = fs.readdirSync(sSubPath);

                  if (txChildren.length > 0) {
                    if (!hasJournal || !journalInspection.isValid || !journalInspection.journal || isMismatched) {
                      orphanedArtifacts.push(...txChildren.map((c) => `staging/${sEntry}/${c}`));
                      reasons.push(`Staging directory for "${expectedTxId}" contains artifacts but journal is missing, invalid, or mismatched`);
                    } else {
                      const journalObj = journalInspection.journal;

                      // Phase consistency: in 'LOCKED', staging has not been prepared yet!
                      if (journalObj.phase === 'LOCKED') {
                        const expectedTargetBase = path.basename(journalObj.targetFile || '');
                        for (const cEntry of txChildren) {
                          const cPath = path.join(sSubPath, cEntry);
                          const cCheck = getPathLstat(cPath);

                          if (cCheck.error) {
                            hasInspectionError = true;
                            inspectionErrors.push(`Failed to inspect staging artifact (staging/${sEntry}/${cEntry}): ${cCheck.error.message}`);
                            reasons.push(`Failed to inspect staging artifact (staging/${sEntry}/${cEntry}): ${cCheck.error.message}`);
                          } else if (cCheck.isSymbolicLink) {
                            hasUnsafeSymlink = true;
                            reasons.push(`Staging artifact (staging/${sEntry}/${cEntry}) is a symbolic link`);
                          } else if (cCheck.isDirectory || !cCheck.isFile) {
                            orphanedArtifacts.push(`staging/${sEntry}/${cEntry}`);
                            reasons.push(`Unexpected filesystem object in staging during LOCKED phase: "staging/${sEntry}/${cEntry}"`);
                          } else if (cEntry !== expectedTargetBase) {
                            orphanedArtifacts.push(`staging/${sEntry}/${cEntry}`);
                            reasons.push(`Unexpected regular file in staging during LOCKED phase: "staging/${sEntry}/${cEntry}" (expected: ${expectedTargetBase})`);
                          } else {
                            // Structurally consistent incomplete staging preparation
                            isIncompleteTransaction = true;
                            reasons.push(`Interrupted staging preparation detected: staging directory for active transaction "${expectedTxId}" contains target artifact "${cEntry}" in phase "LOCKED" prior to journal advancement`);
                          }
                        }
                      } else {
                        const permittedStagingNames = getPermittedArtifactNames(journalObj, 'staging');
                        for (const cEntry of txChildren) {
                          const cPath = path.join(sSubPath, cEntry);
                          const cCheck = getPathLstat(cPath);

                          if (cCheck.error) {
                            hasInspectionError = true;
                            inspectionErrors.push(`Failed to inspect staging artifact (staging/${sEntry}/${cEntry}): ${cCheck.error.message}`);
                            reasons.push(`Failed to inspect staging artifact (staging/${sEntry}/${cEntry}): ${cCheck.error.message}`);
                          } else if (cCheck.isSymbolicLink) {
                            hasUnsafeSymlink = true;
                            reasons.push(`Staging artifact (staging/${sEntry}/${cEntry}) is a symbolic link`);
                          } else if (cCheck.isDirectory) {
                            // Subdirectories are unexpected in P3B-1 flat staging contract
                            orphanedArtifacts.push(`staging/${sEntry}/${cEntry}`);
                            reasons.push(`Unexpected subdirectory in staging: "staging/${sEntry}/${cEntry}"`);
                          } else if (!cCheck.isFile) {
                            // Unsupported filesystem object type (FIFO, socket, device)
                            orphanedArtifacts.push(`staging/${sEntry}/${cEntry}`);
                            reasons.push(`Unsupported filesystem object type in staging: "staging/${sEntry}/${cEntry}"`);
                          } else if (!permittedStagingNames.has(cEntry)) {
                            // Unexpected regular file
                            orphanedArtifacts.push(`staging/${sEntry}/${cEntry}`);
                            reasons.push(`Unexpected regular file in staging: "staging/${sEntry}/${cEntry}" (permitted: ${Array.from(permittedStagingNames).join(', ')})`);
                          }
                        }
                      }
                    }
                  }
                } catch (readErr) {
                  hasInspectionError = true;
                  inspectionErrors.push(`Failed to inspect staging contents for transaction ${sEntry}: ${readErr.message}`);
                  reasons.push(`Failed to inspect staging contents for transaction ${sEntry}: ${readErr.message}`);
                }
              }
            }
          }
        }
      } catch (err) {
        hasInspectionError = true;
        inspectionErrors.push(`Failed to read staging directory: ${err.message}`);
        reasons.push(`Failed to read staging directory: ${err.message}`);
      }
    }
  }

  // Inspect recognized directory: backup
  const backupPath = path.join(ciPatchDir, 'backup');
  const backupCheck = getPathLstat(backupPath);
  if (backupCheck.error) {
    hasInspectionError = true;
    inspectionErrors.push(`Failed to inspect backup path (.ci-patch/backup): ${backupCheck.error.message}`);
    reasons.push(`Failed to inspect backup path (.ci-patch/backup): ${backupCheck.error.message}`);
  } else if (!backupCheck.exists) {
    if (hasLock && lockInspection.isValid && hasJournal && journalInspection.isValid && !isMismatched) {
      const jObj = journalInspection.journal;
      if (jObj && BACKUP_REQUIRING_PHASES.includes(jObj.phase)) {
        isIncompleteTransaction = true;
        reasons.push(`Missing backup directory in phase "${jObj.phase}": ".ci-patch/backup" does not exist`);
      }
    }
  } else if (backupCheck.exists) {
    if (backupCheck.isSymbolicLink) {
      hasUnsafeSymlink = true;
      reasons.push('Backup path (.ci-patch/backup) is a symbolic link');
    } else if (!backupCheck.isDirectory) {
      foreignEntries.push('backup');
      reasons.push('Backup path (.ci-patch/backup) exists but is not a directory');
    } else {
      try {
        const backupEntries = fs.readdirSync(backupPath);
        if (backupEntries.length === 0) {
          if (hasLock && lockInspection.isValid && hasJournal && journalInspection.isValid && !isMismatched) {
            const jObj = journalInspection.journal;
            if (jObj && jObj.phase === 'ISOLATED_PREPARED') {
              isIncompleteTransaction = true;
              reasons.push(
                'Interrupted backup preparation detected: empty backup parent directory exists in phase "ISOLATED_PREPARED" prior to transaction backup directory creation'
              );
            } else if (jObj && BACKUP_REQUIRING_PHASES.includes(jObj.phase)) {
              isIncompleteTransaction = true;
              reasons.push(
                `Missing backup transaction directory in phase "${jObj.phase}": ".ci-patch/backup" is empty`
              );
            }
          }
        } else if (!hasLock || !lockInspection.isValid || !lockInspection.owner) {
          orphanedArtifacts.push(...backupEntries.map((e) => `backup/${e}`));
          reasons.push(`Non-empty backup directory detected with no active valid transaction: ${backupEntries.join(', ')}`);
        } else {
          const expectedTxId = lockInspection.owner.txId;
          const journalObj = (hasJournal && journalInspection.isValid && !isMismatched) ? journalInspection.journal : null;

          if (journalObj && BACKUP_REQUIRING_PHASES.includes(journalObj.phase) && !backupEntries.includes(expectedTxId)) {
            isIncompleteTransaction = true;
            reasons.push(`Missing backup directory for active transaction "${expectedTxId}" in phase "${journalObj.phase}"`);
          }

          for (const bEntry of backupEntries) {
            const bSubPath = path.join(backupPath, bEntry);
            const bSubCheck = getPathLstat(bSubPath);

            if (bSubCheck.error) {
              hasInspectionError = true;
              inspectionErrors.push(`Failed to inspect backup component (backup/${bEntry}): ${bSubCheck.error.message}`);
              reasons.push(`Failed to inspect backup component (backup/${bEntry}): ${bSubCheck.error.message}`);
            } else if (bSubCheck.isSymbolicLink) {
              hasUnsafeSymlink = true;
              reasons.push(`Backup component (backup/${bEntry}) is a symbolic link`);
            } else if (bEntry !== expectedTxId) {
              orphanedArtifacts.push(`backup/${bEntry}`);
              reasons.push(`Backup entry "${bEntry}" does not match active transaction "${expectedTxId}"`);
            } else if (!bSubCheck.isDirectory) {
              orphanedArtifacts.push(`backup/${bEntry}`);
              reasons.push(`Backup entry "backup/${bEntry}" is not a directory`);
            } else {
              // Inspect inside backup/<txId>
              try {
                const txChildren = fs.readdirSync(bSubPath);

                if (txChildren.length === 0) {
                  if (journalObj) {
                    if (journalObj.phase === 'ISOLATED_PREPARED') {
                      isIncompleteTransaction = true;
                      reasons.push(
                        `Interrupted backup preparation detected: empty backup directory for active transaction "${expectedTxId}" in phase "ISOLATED_PREPARED" prior to backup file creation`
                      );
                    } else if (BACKUP_REQUIRING_PHASES.includes(journalObj.phase)) {
                      isIncompleteTransaction = true;
                      reasons.push(
                        `Missing backup artifact in phase "${journalObj.phase}": backup directory for transaction "${expectedTxId}" is empty`
                      );
                    }
                  }
                } else if (!hasJournal || !journalInspection.isValid || !journalInspection.journal || isMismatched) {
                  orphanedArtifacts.push(...txChildren.map((c) => `backup/${bEntry}/${c}`));
                  reasons.push(`Backup directory for "${expectedTxId}" contains artifacts but journal is missing, invalid, or mismatched`);
                } else {
                  // Phase consistency:
                  if (journalObj.phase === 'LOCKED') {
                    orphanedArtifacts.push(...txChildren.map((c) => `backup/${bEntry}/${c}`));
                    reasons.push(`Backup directory contains artifacts in phase "LOCKED" before backup creation: ${txChildren.join(', ')}`);
                  } else if (journalObj.phase === 'ISOLATED_PREPARED') {
                    const expectedTargetBase = path.basename(journalObj.targetFile || '');
                    for (const cEntry of txChildren) {
                      const cPath = path.join(bSubPath, cEntry);
                      const cCheck = getPathLstat(cPath);

                      if (cCheck.error) {
                        hasInspectionError = true;
                        inspectionErrors.push(`Failed to inspect backup artifact (backup/${bEntry}/${cEntry}): ${cCheck.error.message}`);
                        reasons.push(`Failed to inspect backup artifact (backup/${bEntry}/${cEntry}): ${cCheck.error.message}`);
                      } else if (cCheck.isSymbolicLink) {
                        hasUnsafeSymlink = true;
                        reasons.push(`Backup artifact (backup/${bEntry}/${cEntry}) is a symbolic link`);
                      } else if (cCheck.isDirectory || !cCheck.isFile) {
                        orphanedArtifacts.push(`backup/${bEntry}/${cEntry}`);
                        reasons.push(`Unexpected filesystem object in backup during ISOLATED_PREPARED phase: "backup/${bEntry}/${cEntry}"`);
                      } else if (cEntry !== expectedTargetBase) {
                        orphanedArtifacts.push(`backup/${bEntry}/${cEntry}`);
                        reasons.push(`Unexpected regular file in backup during ISOLATED_PREPARED phase: "backup/${bEntry}/${cEntry}" (expected: ${expectedTargetBase})`);
                      } else {
                        // Structurally consistent incomplete backup preparation (partially written or complete backup file before journal advancement)
                        isIncompleteTransaction = true;
                        reasons.push(`Interrupted backup preparation detected: backup directory for active transaction "${expectedTxId}" contains target artifact "${cEntry}" in phase "ISOLATED_PREPARED" prior to journal advancement`);
                      }
                    }
                  } else {
                    const expectedTargetBase = path.basename(journalObj.targetFile || '');
                    const isLegacyJournal = typeof journalObj.stagedPath === 'string';
                    const permittedBackupNames = isLegacyJournal
                      ? getPermittedArtifactNames(journalObj, 'backup')
                      : new Set([expectedTargetBase]);
                    let foundRegisteredBackup = false;

                    for (const cEntry of txChildren) {
                      const cPath = path.join(bSubPath, cEntry);
                      const cCheck = getPathLstat(cPath);
                      const relArtifact = `backup/${bEntry}/${cEntry}`;

                      if (cCheck.error) {
                        hasInspectionError = true;
                        inspectionErrors.push(`Failed to inspect backup artifact (${relArtifact}): ${cCheck.error.message}`);
                        reasons.push(`Failed to inspect backup artifact (${relArtifact}): ${cCheck.error.message}`);
                      } else if (cCheck.isSymbolicLink) {
                        hasUnsafeSymlink = true;
                        reasons.push(`Backup artifact (${relArtifact}) is a symbolic link`);
                      } else if (cCheck.isDirectory) {
                        orphanedArtifacts.push(relArtifact);
                        reasons.push(`Unexpected subdirectory in backup: "${relArtifact}"`);
                      } else if (!cCheck.isFile) {
                        orphanedArtifacts.push(relArtifact);
                        reasons.push(`Unsupported filesystem object type in backup: "${relArtifact}"`);
                      } else if (!permittedBackupNames.has(cEntry)) {
                        orphanedArtifacts.push(relArtifact);
                        reasons.push(
                          `Unexpected regular file in backup: "${relArtifact}" (${isLegacyJournal ? `permitted: ${Array.from(permittedBackupNames).join(', ')}` : `expected only: ${expectedTargetBase}`})`
                        );
                      } else if (cEntry === expectedTargetBase) {
                        foundRegisteredBackup = true;
                        const inspectRes = inspectBackupArtifactFile(
                          cPath,
                          journalObj.expectedInitialSha256,
                          journalObj.phase,
                          relArtifact
                        );
                        if (!inspectRes.ok) {
                          if (inspectRes.isSymlink) {
                            hasUnsafeSymlink = true;
                          } else if (inspectRes.isError || inspectRes.isOversized) {
                            hasInspectionError = true;
                            inspectionErrors.push(inspectRes.reason);
                          } else if (inspectRes.isForeign) {
                            orphanedArtifacts.push(relArtifact);
                          } else if (inspectRes.isIncomplete || inspectRes.isCorrupt) {
                            isIncompleteTransaction = true;
                          }
                          reasons.push(inspectRes.reason);
                        }
                      }
                    }

                    if (BACKUP_REQUIRING_PHASES.includes(journalObj.phase) && !foundRegisteredBackup) {
                      isIncompleteTransaction = true;
                      reasons.push(`Missing backup artifact in phase "${journalObj.phase}": "${expectedTargetBase}" not found in backup directory`);
                    }
                  }
                }
              } catch (readErr) {
                hasInspectionError = true;
                inspectionErrors.push(`Failed to inspect backup contents for transaction ${bEntry}: ${readErr.message}`);
                reasons.push(`Failed to inspect backup contents for transaction ${bEntry}: ${readErr.message}`);
              }
            }
          }
        }
      } catch (err) {
        hasInspectionError = true;
        inspectionErrors.push(`Failed to read backup directory: ${err.message}`);
        reasons.push(`Failed to read backup directory: ${err.message}`);
      }
    }
  }

  // Foreign content inside .ci-patch
  if (foreignEntries.length > 0) {
    reasons.push(`Installer directory contains unexpected foreign files: ${foreignEntries.join(', ')}`);
  }
  }

  // Inspect destination parent directory for candidate artifacts
  const targetRelDir = 'src/endpoints';
  const targetBase = 'stable-diffusion.js';
  const absParentDir = path.join(repoRoot, targetRelDir);
  const candidateRegex = /^\.stable-diffusion\.js\.ci-staged-(.+)\.tmp$/;

  const parentCheck = getPathLstat(absParentDir);
  const srcCheck = getPathLstat(path.join(repoRoot, 'src'));

  const hasValidAgreedTransaction = Boolean(
    hasLock &&
    lockInspection.isValid &&
    lockInspection.owner &&
    hasJournal &&
    journalInspection.isValid &&
    journalInspection.journal &&
    !isMismatched &&
    lockInspection.owner.txId === journalInspection.journal.txId &&
    lockInspection.owner.op === journalInspection.journal.op
  );

  const POST_SWAP_INSPECTION_PHASES = Object.freeze([
    'READY_TO_SWAP',
    'SWAPPED',
    'COMPLETED',
  ]);

  const shouldInspectLiveTarget = Boolean(
    hasValidAgreedTransaction &&
    POST_SWAP_INSPECTION_PHASES.includes(journalInspection.journal.phase)
  );

  if (srcCheck.isSymbolicLink || parentCheck.isSymbolicLink) {
    hasUnsafeSymlink = true;
    reasons.push('Destination parent directory contains a symbolic link');
  } else if (parentCheck.error && parentCheck.error.code !== 'ENOENT') {
    hasInspectionError = true;
    inspectionErrors.push(`Failed to inspect destination parent directory: ${parentCheck.error.message}`);
    reasons.push(`Failed to inspect destination parent directory: ${parentCheck.error.message}`);
  } else if (!parentCheck.exists) {
    if (shouldInspectLiveTarget) {
      const jObj = journalInspection.journal;
      isIncompleteTransaction = true;
      reasons.push(`Missing destination directory in phase "${jObj.phase}": "src/endpoints" does not exist`);
    }
  } else if (parentCheck.exists && !parentCheck.isDirectory) {
    hasInspectionError = true;
    inspectionErrors.push('Destination parent path exists but is not a directory: src/endpoints');
    reasons.push('Destination parent path exists but is not a directory: src/endpoints');
  } else if (parentCheck.exists && parentCheck.isDirectory) {
    try {
      const endpointEntries = fs.readdirSync(absParentDir);
      const activeTxId = (hasLock && lockInspection.isValid && lockInspection.owner) ? lockInspection.owner.txId : null;
      const journalObj = (hasJournal && journalInspection.isValid && !isMismatched) ? journalInspection.journal : null;
      let foundRegisteredCandidate = false;

      for (const entry of endpointEntries) {
        const match = entry.match(candidateRegex);
        if (!match) continue; // Ordinary endpoint files ignored

        const cPath = path.join(absParentDir, entry);
        const relArtifact = `${targetRelDir}/${entry}`;
        const cCheck = getPathLstat(cPath);

        if (cCheck.error) {
          hasInspectionError = true;
          inspectionErrors.push(`Failed to inspect destination candidate (${relArtifact}): ${cCheck.error.message}`);
          reasons.push(`Failed to inspect destination candidate (${relArtifact}): ${cCheck.error.message}`);
        } else if (cCheck.isSymbolicLink) {
          hasUnsafeSymlink = true;
          reasons.push(`Destination candidate (${relArtifact}) is a symbolic link`);
        } else if (cCheck.isDirectory || !cCheck.isFile) {
          orphanedArtifacts.push(relArtifact);
          reasons.push(`Unsupported filesystem object type at destination candidate path: "${relArtifact}"`);
        } else {
          const fileTxId = match[1];
          if (activeTxId && fileTxId === activeTxId && journalObj && journalObj.txId === activeTxId) {
            if (journalObj.phase === 'LOCKED' || journalObj.phase === 'ISOLATED_PREPARED' || journalObj.phase === 'BACKUP_CREATED') {
              isIncompleteTransaction = true;
              reasons.push(`Interrupted destination staging detected: candidate file for active transaction "${activeTxId}" exists in phase "${journalObj.phase}" prior to journal advancement`);
            } else if (journalObj.phase === 'READY_TO_SWAP') {
              foundRegisteredCandidate = true;
              const inspectRes = inspectDestinationCandidateFile(
                cPath,
                journalObj.expectedResultSha256,
                journalObj.targetMode,
                journalObj.phase,
                relArtifact
              );
              if (!inspectRes.ok) {
                if (inspectRes.isSymlink) {
                  hasUnsafeSymlink = true;
                } else if (inspectRes.isError || inspectRes.isOversized) {
                  hasInspectionError = true;
                  inspectionErrors.push(inspectRes.reason);
                } else if (inspectRes.isForeign) {
                  orphanedArtifacts.push(relArtifact);
                } else if (inspectRes.isIncomplete || inspectRes.isCorrupt) {
                  isIncompleteTransaction = true;
                }
                reasons.push(inspectRes.reason);
              }
            } else if (journalObj.phase === 'SWAPPED' || journalObj.phase === 'COMPLETED') {
              orphanedArtifacts.push(relArtifact);
              reasons.push(`Unexpected destination candidate remains present in phase "${journalObj.phase}": "${relArtifact}"`);
            }
          } else {
            orphanedArtifacts.push(relArtifact);
            reasons.push(`Orphaned destination staging candidate detected without active valid transaction: "${relArtifact}"`);
          }
        }
      }

      // Live target inspection when active valid transaction is in READY_TO_SWAP, SWAPPED, or COMPLETED
      if (shouldInspectLiveTarget) {
        const jObj = journalInspection.journal;
        const targetRelFile = path.join(targetRelDir, targetBase);
        const absTargetFile = path.join(repoRoot, targetRelFile);

        const targetCheck = getPathLstat(absTargetFile);
        if (targetCheck.error) {
          if (targetCheck.error.code === 'ENOENT') {
            isIncompleteTransaction = true;
            reasons.push(`Missing live target file in phase "${jObj.phase}": "${targetRelFile}" does not exist`);
            if (jObj.phase === 'READY_TO_SWAP' && !foundRegisteredCandidate) {
              const expectedCandidateName = `.${targetBase}.ci-staged-${jObj.txId}.tmp`;
              reasons.push(`Missing destination candidate in phase "READY_TO_SWAP": "${expectedCandidateName}" not found in destination parent directory`);
            }
          } else {
            hasInspectionError = true;
            inspectionErrors.push(`Failed to inspect live target path ("${targetRelFile}"): ${targetCheck.error.message}`);
            reasons.push(`Failed to inspect live target path ("${targetRelFile}"): ${targetCheck.error.message}`);
          }
        } else if (!targetCheck.exists) {
          isIncompleteTransaction = true;
          reasons.push(`Missing live target file in phase "${jObj.phase}": "${targetRelFile}" does not exist`);
          if (jObj.phase === 'READY_TO_SWAP' && !foundRegisteredCandidate) {
            const expectedCandidateName = `.${targetBase}.ci-staged-${jObj.txId}.tmp`;
            reasons.push(`Missing destination candidate in phase "READY_TO_SWAP": "${expectedCandidateName}" not found in destination parent directory`);
          }
        } else if (targetCheck.isSymbolicLink) {
          hasUnsafeSymlink = true;
          reasons.push(`Live target file is a symbolic link: "${targetRelFile}"`);
        } else if (!targetCheck.isFile) {
          // Unsupported filesystem object type (FIFO, socket, directory, device)
          isIncompleteTransaction = true;
          reasons.push(`Live target path is not a regular file (unsupported filesystem object type): "${targetRelFile}"`);
        } else {
          const liveRes = inspectLiveTargetFile(
            absTargetFile,
            jObj.expectedInitialSha256,
            jObj.expectedResultSha256,
            jObj.targetMode,
            jObj.phase,
            targetRelFile
          );

          if (!liveRes.ok) {
            if (liveRes.isSymlink) {
              hasUnsafeSymlink = true;
            } else if (liveRes.isError || liveRes.isOversized) {
              hasInspectionError = true;
              inspectionErrors.push(liveRes.reason);
            } else if (liveRes.isUnsupportedType || liveRes.isIncomplete || liveRes.isMissing) {
              isIncompleteTransaction = true;
            }
            reasons.push(liveRes.reason);
          } else {
            if (jObj.phase === 'READY_TO_SWAP') {
              if (foundRegisteredCandidate) {
                if (liveRes.isInitial) {
                  if (!liveRes.modeMatches) {
                    isIncompleteTransaction = true;
                    reasons.push(
                      `Live target mode mismatch in phase "READY_TO_SWAP": expected ${jObj.targetMode}, observed ${liveRes.actualMode}: "${targetRelFile}"`
                    );
                  }
                } else if (liveRes.isResult) {
                  isIncompleteTransaction = true;
                  reasons.push(
                    `Ambiguous transaction state: destination candidate remains present but live target already contains expected result in phase "READY_TO_SWAP": "${targetRelFile}"`
                  );
                } else {
                  isIncompleteTransaction = true;
                  reasons.push(
                    `Live target content modified unexpectedly in phase "READY_TO_SWAP": "${targetRelFile}" SHA-256 (${liveRes.actualSha}) matches neither expected initial nor result`
                  );
                }
              } else {
                // Destination candidate is ABSENT in READY_TO_SWAP
                if (liveRes.isResult) {
                  isIncompleteTransaction = true;
                  reasons.push(
                    `Possible unrecorded swap detected: journal phase is "READY_TO_SWAP" with destination candidate absent, but live target contains expected result: "${targetRelFile}"`
                  );
                  if (!liveRes.modeMatches) {
                    reasons.push(
                      `Live target mode mismatch in phase "READY_TO_SWAP": expected ${jObj.targetMode}, observed ${liveRes.actualMode}: "${targetRelFile}"`
                    );
                  }
                } else if (liveRes.isInitial) {
                  isIncompleteTransaction = true;
                  const expectedCandidateName = `.${targetBase}.ci-staged-${jObj.txId}.tmp`;
                  reasons.push(
                    `Missing destination candidate in phase "READY_TO_SWAP": "${expectedCandidateName}" not found in destination parent directory`
                  );
                  if (!liveRes.modeMatches) {
                    reasons.push(
                      `Live target mode mismatch in phase "READY_TO_SWAP": expected ${jObj.targetMode}, observed ${liveRes.actualMode}: "${targetRelFile}"`
                    );
                  }
                } else {
                  isIncompleteTransaction = true;
                  const expectedCandidateName = `.${targetBase}.ci-staged-${jObj.txId}.tmp`;
                  reasons.push(
                    `Missing destination candidate in phase "READY_TO_SWAP": "${expectedCandidateName}" not found in destination parent directory`
                  );
                  reasons.push(
                    `Live target content modified unexpectedly in phase "READY_TO_SWAP": "${targetRelFile}" SHA-256 (${liveRes.actualSha}) matches neither expected initial nor result`
                  );
                }
              }
            } else if (jObj.phase === 'SWAPPED') {
              if (!foundRegisteredCandidate) {
                if (liveRes.isResult) {
                  if (!liveRes.modeMatches) {
                    isIncompleteTransaction = true;
                    reasons.push(
                      `Live target mode mismatch in phase "SWAPPED": expected ${jObj.targetMode}, observed ${liveRes.actualMode}: "${targetRelFile}"`
                    );
                  }
                } else if (liveRes.isInitial) {
                  isIncompleteTransaction = true;
                  reasons.push(
                    `Incomplete swap detected: journal phase is "SWAPPED" but live target still contains initial content: "${targetRelFile}"`
                  );
                } else {
                  isIncompleteTransaction = true;
                  reasons.push(
                    `Live target content mismatch in phase "SWAPPED": "${targetRelFile}" SHA-256 (${liveRes.actualSha}) does not match expected result SHA-256`
                  );
                }
              }
            } else if (jObj.phase === 'COMPLETED') {
              if (!foundRegisteredCandidate) {
                if (liveRes.isResult) {
                  if (!liveRes.modeMatches) {
                    isIncompleteTransaction = true;
                    reasons.push(
                      `Live target mode mismatch in phase "COMPLETED": expected ${jObj.targetMode}, observed ${liveRes.actualMode}: "${targetRelFile}"`
                    );
                  }
                } else {
                  isIncompleteTransaction = true;
                  reasons.push(
                    `Live target content mismatch in phase "COMPLETED": "${targetRelFile}" SHA-256 (${liveRes.actualSha}) does not match expected result SHA-256`
                  );
                }
              }
            }
          }
        }
      } else if (journalObj && journalObj.phase === 'READY_TO_SWAP' && !foundRegisteredCandidate) {
        // Fallback for phase inconsistency if journal exists but transaction is unverified
        isIncompleteTransaction = true;
        const expectedCandidateName = `.${targetBase}.ci-staged-${journalObj.txId}.tmp`;
        reasons.push(`Missing destination candidate in phase "READY_TO_SWAP": "${expectedCandidateName}" not found in destination parent directory`);
      }
    } catch (readDirErr) {
      hasInspectionError = true;
      inspectionErrors.push(`Failed to read destination parent directory: ${readDirErr.message}`);
      reasons.push(`Failed to read destination parent directory: ${readDirErr.message}`);
    }
  }

  // Determine overall classification state
  let state = 'none';

  if (hasUnsafeSymlink) {
    state = 'unsafe-symlink';
  } else if (hasInspectionError) {
    state = 'inspection-error';
  } else if (foreignEntries.length > 0) {
    state = 'foreign-content';
  } else if (orphanedArtifacts.length > 0) {
    state = 'orphaned-artifact';
  } else if (isIncompleteTransaction) {
    state = 'incomplete-transaction';
  } else if (hasLock && !lockInspection.isValid) {
    state = 'corrupted-lock';
  } else if (hasJournal && !journalInspection.isValid) {
    state = 'corrupted-journal';
  } else if (hasJournal && !hasLock) {
    state = 'orphaned-journal';
  } else if (isMismatched) {
    state = 'mismatched-metadata';
  } else if (hasLock) {
    state = 'ownership-unverified';
    if (reasons.length === 0) {
      const jPhase = journalInspection.journal?.phase ? ` (journal: ${journalInspection.journal.phase})` : '';
      reasons.push(
        `Installer lock is present for txId "${lockInspection.owner.txId}" (op: ${lockInspection.owner.op}, pid: ${lockInspection.owner.pid})${jPhase}`
      );
    }
  }

  const isPending = state !== 'none';

  return {
    state,
    hasLock,
    hasJournal,
    isPending,
    lock: hasLock ? lockInspection : null,
    journal: hasJournal ? journalInspection : null,
    foreignEntries,
    orphanedArtifacts,
    reasons,
  };
}

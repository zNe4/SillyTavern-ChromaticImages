import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const LOCK_SCHEMA_VERSION = '1.0.0';
export const CI_PATCH_DIR_NAME = '.ci-patch';
export const LOCK_DIR_NAME = 'lock.d';
export const LOCK_OWNER_FILE = 'owner.json';

const TX_ID_REGEX = /^ci-tx-[0-9]+-[0-9a-f]+$/i;

/**
 * Generate a cryptographically randomized transaction ID.
 * @returns {string}
 */
export function generateTxId() {
  return `ci-tx-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Resolve the canonical path to the .ci-patch directory.
 * @param {string} repoRoot
 * @returns {string}
 */
export function getCiPatchDir(repoRoot) {
  return path.resolve(repoRoot, CI_PATCH_DIR_NAME);
}

/**
 * Resolve the canonical path to the lock directory.
 * @param {string} repoRoot
 * @returns {string}
 */
export function getLockDirPath(repoRoot) {
  return path.resolve(repoRoot, CI_PATCH_DIR_NAME, LOCK_DIR_NAME);
}

/**
 * Resolve the canonical path to the lock owner metadata file.
 * @param {string} repoRoot
 * @returns {string}
 */
export function getLockOwnerPath(repoRoot) {
  return path.resolve(repoRoot, CI_PATCH_DIR_NAME, LOCK_DIR_NAME, LOCK_OWNER_FILE);
}

/**
 * Validate that a target path is strictly contained within repoRoot.
 * @param {string} repoRoot
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isPathContained(repoRoot, targetPath) {
  const normRoot = path.resolve(repoRoot);
  const normTarget = path.resolve(targetPath);
  return normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
}

/**
 * Inspect .ci-patch path component safety.
 * Verifies that repoRoot and .ci-patch are not symlinks and do not escape boundaries.
 *
 * @param {string} repoRoot
 * @returns {{ ok: boolean, exists: boolean, isSymlink: boolean, isDirectory: boolean, path: string, error?: string }}
 */
export function validateCiPatchPath(repoRoot) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    return { ok: false, exists: false, isSymlink: false, isDirectory: false, path: '', error: 'Invalid repository root' };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  if (!isPathContained(repoRoot, ciPatchDir)) {
    return { ok: false, exists: false, isSymlink: false, isDirectory: false, path: ciPatchDir, error: 'Path escapes repository root' };
  }

  try {
    if (!fs.existsSync(ciPatchDir)) {
      return { ok: true, exists: false, isSymlink: false, isDirectory: false, path: ciPatchDir };
    }

    const lstat = fs.lstatSync(ciPatchDir);
    if (lstat.isSymbolicLink()) {
      return { ok: false, exists: true, isSymlink: true, isDirectory: false, path: ciPatchDir, error: 'Installer directory is a symbolic link' };
    }
    if (!lstat.isDirectory()) {
      return { ok: false, exists: true, isSymlink: false, isDirectory: false, path: ciPatchDir, error: 'Installer directory is not a directory' };
    }

    return { ok: true, exists: true, isSymlink: false, isDirectory: true, path: ciPatchDir };
  } catch (err) {
    return { ok: false, exists: false, isSymlink: false, isDirectory: false, path: ciPatchDir, error: err.message };
  }
}

/**
 * Ensure the .ci-patch directory exists safely without symlink attacks.
 * @param {string} repoRoot
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function ensureCiPatchDir(repoRoot) {
  const check = validateCiPatchPath(repoRoot);
  if (!check.ok) {
    return { ok: false, path: check.path, error: check.error };
  }

  const ciPatchDir = check.path;
  if (!check.exists) {
    try {
      fs.mkdirSync(ciPatchDir, { mode: 0o700 });
      // Re-verify created directory
      const postStat = fs.lstatSync(ciPatchDir);
      if (postStat.isSymbolicLink() || !postStat.isDirectory()) {
        return { ok: false, path: ciPatchDir, error: 'Created directory is unsafe' };
      }
    } catch (err) {
      return { ok: false, path: ciPatchDir, error: `Failed to create .ci-patch: ${err.message}` };
    }
  }

  return { ok: true, path: ciPatchDir };
}

/**
 * Validate lock owner metadata structure.
 * @param {any} owner
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLockOwner(owner) {
  const errors = [];
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    return { valid: false, errors: ['Owner metadata must be a non-null object'] };
  }

  if (owner.schemaVersion !== LOCK_SCHEMA_VERSION) {
    errors.push(`Invalid schemaVersion: expected "${LOCK_SCHEMA_VERSION}", received "${owner.schemaVersion}"`);
  }

  if (typeof owner.txId !== 'string' || !TX_ID_REGEX.test(owner.txId.trim())) {
    errors.push(`Invalid txId format: "${owner.txId}"`);
  }

  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    errors.push(`Invalid process ID: "${owner.pid}"`);
  }

  if (typeof owner.hostname !== 'string' || owner.hostname.trim() === '') {
    errors.push('Missing or empty hostname');
  }

  if (owner.op !== 'apply' && owner.op !== 'remove') {
    errors.push(`Invalid operation identifier: "${owner.op}" (must be "apply" or "remove")`);
  }

  if (typeof owner.createdAt !== 'string' || Number.isNaN(Date.parse(owner.createdAt))) {
    errors.push(`Invalid createdAt timestamp: "${owner.createdAt}"`);
  }

  if (typeof owner.repoRoot !== 'string' || owner.repoRoot.trim() === '') {
    errors.push('Missing or empty repoRoot');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Read-only inspection of installer lock state.
 * Never acquires, steals, mutates, or deletes locks.
 *
 * @param {string} repoRoot
 * @returns {{
 *   hasLock: boolean,
 *   isValid: boolean,
 *   isSymlink: boolean,
 *   owner: object|null,
 *   lockDirPath: string,
 *   errors: string[]
 * }}
 */
export function inspectLock(repoRoot) {
  const lockDirPath = getLockDirPath(repoRoot);
  const ownerPath = getLockOwnerPath(repoRoot);
  const errors = [];

  const ciPathCheck = validateCiPatchPath(repoRoot);
  if (!ciPathCheck.ok) {
    return {
      hasLock: false,
      isValid: false,
      isSymlink: ciPathCheck.isSymlink,
      owner: null,
      lockDirPath,
      errors: [ciPathCheck.error || 'Invalid .ci-patch directory'],
    };
  }

  if (!ciPathCheck.exists) {
    return { hasLock: false, isValid: true, isSymlink: false, owner: null, lockDirPath, errors: [] };
  }

  try {
    if (!fs.existsSync(lockDirPath)) {
      return { hasLock: false, isValid: true, isSymlink: false, owner: null, lockDirPath, errors: [] };
    }

    const lockStat = fs.lstatSync(lockDirPath);
    if (lockStat.isSymbolicLink()) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: true,
        owner: null,
        lockDirPath,
        errors: ['Lock directory is a symbolic link'],
      };
    }
    if (!lockStat.isDirectory()) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: false,
        owner: null,
        lockDirPath,
        errors: ['Lock path exists but is not a directory'],
      };
    }

    // Check owner metadata
    if (!fs.existsSync(ownerPath)) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: false,
        owner: null,
        lockDirPath,
        errors: ['Lock owner metadata file (owner.json) is missing'],
      };
    }

    const ownerStat = fs.lstatSync(ownerPath);
    if (ownerStat.isSymbolicLink()) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: false,
        owner: null,
        lockDirPath,
        errors: ['Lock owner file is a symbolic link'],
      };
    }
    if (!ownerStat.isFile()) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: false,
        owner: null,
        lockDirPath,
        errors: ['Lock owner path is not a regular file'],
      };
    }

    const raw = fs.readFileSync(ownerPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: false,
        owner: null,
        lockDirPath,
        errors: [`Lock owner metadata contains invalid JSON: ${parseErr.message}`],
      };
    }

    const val = validateLockOwner(parsed);
    if (!val.valid) {
      return {
        hasLock: true,
        isValid: false,
        isSymlink: false,
        owner: parsed,
        lockDirPath,
        errors: val.errors,
      };
    }

    return {
      hasLock: true,
      isValid: true,
      isSymlink: false,
      owner: parsed,
      lockDirPath,
      errors: [],
    };
  } catch (err) {
    return {
      hasLock: false,
      isValid: false,
      isSymlink: false,
      owner: null,
      lockDirPath,
      errors: [`Filesystem error inspecting lock: ${err.message}`],
    };
  }
}

/**
 * Acquire exclusive installer lock using atomic directory creation.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {'apply' | 'remove'} options.op
 * @param {number} [options.pid]
 * @param {string} [options.hostname]
 * @returns {{
 *   ok: boolean,
 *   error?: 'lock-contention' | 'unsafe-path' | 'validation-error' | 'fs-error',
 *   reason?: string,
 *   lock?: { lockDirPath: string, ownerPath: string, owner: object }
 * }}
 */
export function acquireLock(options = {}) {
  const { repoRoot, txId, op } = options;
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? os.hostname();

  if (!repoRoot || typeof repoRoot !== 'string') {
    return { ok: false, error: 'validation-error', reason: 'Target repository root is required' };
  }
  if (!txId || typeof txId !== 'string' || !TX_ID_REGEX.test(txId.trim())) {
    return { ok: false, error: 'validation-error', reason: `Invalid transaction ID: "${txId}"` };
  }
  if (op !== 'apply' && op !== 'remove') {
    return { ok: false, error: 'validation-error', reason: `Invalid operation: "${op}" (must be "apply" or "remove")` };
  }

  // 1. Ensure .ci-patch exists safely
  const patchDirRes = ensureCiPatchDir(repoRoot);
  if (!patchDirRes.ok) {
    return { ok: false, error: 'unsafe-path', reason: patchDirRes.error };
  }

  const lockDirPath = getLockDirPath(repoRoot);
  const ownerPath = getLockOwnerPath(repoRoot);

  // 2. Atomic directory creation (mkdir)
  try {
    fs.mkdirSync(lockDirPath, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') {
      return {
        ok: false,
        error: 'lock-contention',
        reason: 'Installer lock already exists (.ci-patch/lock.d)',
      };
    }
    return {
      ok: false,
      error: 'fs-error',
      reason: `Failed to create lock directory: ${err.message}`,
    };
  }

  // 3. Formulate and write owner metadata
  const owner = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    txId: txId.trim(),
    pid,
    hostname,
    op,
    createdAt: new Date().toISOString(),
    repoRoot: path.resolve(repoRoot),
  };

  const val = validateLockOwner(owner);
  if (!val.valid) {
    // Attempt cleanup of empty lock directory on validation failure
    try { fs.rmdirSync(lockDirPath); } catch { /* ignore */ }
    return { ok: false, error: 'validation-error', reason: val.errors.join('; ') };
  }

  try {
    fs.writeFileSync(ownerPath, JSON.stringify(owner, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });

    // Sync owner file
    const fileFd = fs.openSync(ownerPath, 'r');
    try {
      fs.fsyncSync(fileFd);
    } finally {
      fs.closeSync(fileFd);
    }

    // Sync lock.d directory
    const dirFd = fs.openSync(lockDirPath, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }

    return {
      ok: true,
      lock: {
        lockDirPath,
        ownerPath,
        owner,
      },
    };
  } catch (writeErr) {
    // Fail closed: preserve whatever was written rather than risking partial overwrite
    return {
      ok: false,
      error: 'fs-error',
      reason: `Failed to write lock owner metadata: ${writeErr.message}`,
    };
  }
}

/**
 * Release an installer lock under positive ownership verification.
 * Refuses to release foreign, corrupted, or unverified locks.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.txId
 * @param {object} [options.expectedOwner]
 * @returns {{ ok: boolean, error?: string, reason?: string }}
 */
export function releaseLock(options = {}) {
  const { repoRoot, txId, expectedOwner } = options;

  if (!repoRoot || !txId) {
    return { ok: false, error: 'validation-error', reason: 'repoRoot and txId are required to release lock' };
  }

  const inspection = inspectLock(repoRoot);
  if (!inspection.hasLock) {
    return { ok: false, error: 'no-lock', reason: 'No lock exists to release' };
  }

  if (!inspection.isValid || !inspection.owner) {
    return {
      ok: false,
      error: 'unverified-lock',
      reason: `Cannot release corrupted or invalid lock: ${inspection.errors.join('; ')}`,
    };
  }

  if (inspection.owner.txId !== txId.trim()) {
    return {
      ok: false,
      error: 'ownership-mismatch',
      reason: `Cannot release lock: owned by transaction "${inspection.owner.txId}", not "${txId}"`,
    };
  }

  if (expectedOwner) {
    if (expectedOwner.pid && inspection.owner.pid !== expectedOwner.pid) {
      return {
        ok: false,
        error: 'ownership-mismatch',
        reason: `Cannot release lock: PID mismatch (owned by ${inspection.owner.pid}, caller expected ${expectedOwner.pid})`,
      };
    }
    if (expectedOwner.hostname && inspection.owner.hostname !== expectedOwner.hostname) {
      return {
        ok: false,
        error: 'ownership-mismatch',
        reason: `Cannot release lock: hostname mismatch (owned by ${inspection.owner.hostname})`,
      };
    }
  }

  const lockDirPath = inspection.lockDirPath;
  const ownerPath = getLockOwnerPath(repoRoot);

  try {
    if (fs.existsSync(ownerPath)) {
      fs.unlinkSync(ownerPath);
    }
    fs.rmdirSync(lockDirPath);

    // Sync containing .ci-patch directory
    const ciPatchDir = getCiPatchDir(repoRoot);
    if (fs.existsSync(ciPatchDir)) {
      const dirFd = fs.openSync(ciPatchDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: 'fs-error',
      reason: `Failed to clean up lock directory: ${err.message}`,
    };
  }
}

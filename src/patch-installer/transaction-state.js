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
export function inspectBackupArtifactFile(cPath, expectedSha, phase, relArtifact, constants = fs.constants) {
  if (!constants || typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    return {
      ok: false,
      isError: true,
      reason: `Unsupported platform: O_NOFOLLOW file open flag is required for safe backup inspection of "${relArtifact}"`,
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(cPath, constants.O_RDONLY | constants.O_NOFOLLOW);
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

/**
 * Perform comprehensive read-only inspection of installer transaction metadata.
 * Never mutates, acquires, steals, or deletes locks or journals.
 * Detects orphaned artifacts, dangling symlinks, and ambiguous metadata.
 *
 * @param {string} repoRoot
 * @param {object} [options]
 * @param {object} [options._fsConstants]
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
export function inspectTransactionState(repoRoot, options = {}) {
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

  if (!ciPathCheck.exists) {
    return {
      state: 'none',
      hasLock: false,
      hasJournal: false,
      isPending: false,
      lock: null,
      journal: null,
      foreignEntries: [],
      orphanedArtifacts: [],
      reasons: [],
    };
  }

  const ciPatchDir = getCiPatchDir(repoRoot);
  let dirEntries = [];
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
  const lockInspection = inspectLock(repoRoot);
  const journalInspection = inspectJournal(repoRoot);

  const hasLock = lockInspection.hasLock;
  const hasJournal = journalInspection.hasJournal;

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
  let isMismatched = false;
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
                          relArtifact,
                          options?._fsConstants || fs.constants
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

  // Foreign content
  if (foreignEntries.length > 0) {
    reasons.push(`Installer directory contains unexpected foreign files: ${foreignEntries.join(', ')}`);
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

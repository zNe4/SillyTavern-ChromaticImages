import fs from 'node:fs';
import path from 'node:path';
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
} from './journal.js';

const RECOGNIZED_ENTRIES = Object.freeze([
  LOCK_DIR_NAME,
  JOURNAL_FILE_NAME,
  'staging',
  'backup',
]);

const TMP_JOURNAL_REGEX = /^\.journal\..*\.tmp$/;

/**
 * Perform comprehensive read-only inspection of installer transaction metadata.
 * Never mutates, acquires, steals, or deletes locks or journals.
 * Detects orphaned artifacts, dangling symlinks, and ambiguous metadata.
 *
 * @param {string} repoRoot
 * @returns {{
 *   state: 'none' | 'ownership-unverified' | 'orphaned-journal' | 'corrupted-journal' | 'corrupted-lock' | 'mismatched-metadata' | 'foreign-content' | 'unsafe-symlink' | 'orphaned-artifact',
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
  let hasUnsafeSymlink = false;

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
      state: 'unsafe-symlink',
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
      state: 'corrupted-lock',
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
      if (tmpCheck.isSymbolicLink) {
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

  // Inspect recognized directory: staging
  const stagingPath = path.join(ciPatchDir, 'staging');
  const stagingCheck = getPathLstat(stagingPath);
  if (stagingCheck.exists) {
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
              if (sSubCheck.isSymbolicLink) {
                hasUnsafeSymlink = true;
                reasons.push(`Staging component (staging/${sEntry}) is a symbolic link`);
              } else if (sEntry !== expectedTxId) {
                orphanedArtifacts.push(`staging/${sEntry}`);
                reasons.push(`Staging entry "${sEntry}" does not match active transaction "${expectedTxId}"`);
              } else if (sSubCheck.isDirectory) {
                try {
                  const txChildren = fs.readdirSync(sSubPath);
                  for (const cEntry of txChildren) {
                    const cPath = path.join(sSubPath, cEntry);
                    const cCheck = getPathLstat(cPath);
                    if (cCheck.isSymbolicLink) {
                      hasUnsafeSymlink = true;
                      reasons.push(`Staging artifact (staging/${sEntry}/${cEntry}) is a symbolic link`);
                    }
                  }
                } catch (readErr) {
                  reasons.push(`Failed to inspect staging contents for transaction ${sEntry}: ${readErr.message}`);
                }
              }
            }
          }
        }
      } catch (err) {
        reasons.push(`Failed to read staging directory: ${err.message}`);
      }
    }
  }

  // Inspect recognized directory: backup
  const backupPath = path.join(ciPatchDir, 'backup');
  const backupCheck = getPathLstat(backupPath);
  if (backupCheck.exists) {
    if (backupCheck.isSymbolicLink) {
      hasUnsafeSymlink = true;
      reasons.push('Backup path (.ci-patch/backup) is a symbolic link');
    } else if (!backupCheck.isDirectory) {
      foreignEntries.push('backup');
      reasons.push('Backup path (.ci-patch/backup) exists but is not a directory');
    } else {
      try {
        const backupEntries = fs.readdirSync(backupPath);
        if (backupEntries.length > 0) {
          if (!hasLock || !lockInspection.isValid || !lockInspection.owner) {
            orphanedArtifacts.push(...backupEntries.map((e) => `backup/${e}`));
            reasons.push(`Non-empty backup directory detected with no active valid transaction: ${backupEntries.join(', ')}`);
          } else {
            const expectedTxId = lockInspection.owner.txId;
            for (const bEntry of backupEntries) {
              const bSubPath = path.join(backupPath, bEntry);
              const bSubCheck = getPathLstat(bSubPath);
              if (bSubCheck.isSymbolicLink) {
                hasUnsafeSymlink = true;
                reasons.push(`Backup component (backup/${bEntry}) is a symbolic link`);
              } else if (bEntry !== expectedTxId) {
                orphanedArtifacts.push(`backup/${bEntry}`);
                reasons.push(`Backup entry "${bEntry}" does not match active transaction "${expectedTxId}"`);
              } else if (bSubCheck.isDirectory) {
                try {
                  const txChildren = fs.readdirSync(bSubPath);
                  for (const cEntry of txChildren) {
                    const cPath = path.join(bSubPath, cEntry);
                    const cCheck = getPathLstat(cPath);
                    if (cCheck.isSymbolicLink) {
                      hasUnsafeSymlink = true;
                      reasons.push(`Backup artifact (backup/${bEntry}/${cEntry}) is a symbolic link`);
                    }
                  }
                } catch (readErr) {
                  reasons.push(`Failed to inspect backup contents for transaction ${bEntry}: ${readErr.message}`);
                }
              }
            }
          }
        }
      } catch (err) {
        reasons.push(`Failed to read backup directory: ${err.message}`);
      }
    }
  }

  // Foreign content
  if (foreignEntries.length > 0) {
    reasons.push(`Installer directory contains unexpected foreign files: ${foreignEntries.join(', ')}`);
  }

  // Corrupted lock
  if (hasLock && !lockInspection.isValid) {
    reasons.push(...lockInspection.errors);
  }

  // Corrupted journal
  if (hasJournal && !journalInspection.isValid) {
    reasons.push(...journalInspection.errors);
  }

  // Mismatched transaction IDs
  let isMismatched = false;
  if (hasLock && hasJournal && lockInspection.isValid && journalInspection.isValid) {
    if (lockInspection.owner.txId !== journalInspection.journal.txId) {
      isMismatched = true;
      reasons.push(
        `Transaction ID mismatch: lock belongs to "${lockInspection.owner.txId}" but journal belongs to "${journalInspection.journal.txId}"`
      );
    }
  }

  // Orphaned journal (journal exists without lock)
  if (hasJournal && !hasLock) {
    reasons.push(
      `Orphaned journal detected: journal exists in phase "${journalInspection.journal?.phase || 'unknown'}" without an active lock`
    );
  }

  // Determine overall classification state
  let state = 'none';

  if (hasUnsafeSymlink) {
    state = 'unsafe-symlink';
  } else if (foreignEntries.length > 0) {
    state = 'foreign-content';
  } else if (orphanedArtifacts.length > 0) {
    state = 'orphaned-artifact';
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

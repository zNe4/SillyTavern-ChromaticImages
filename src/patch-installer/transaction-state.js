import fs from 'node:fs';
import path from 'node:path';
import {
  getCiPatchDir,
  validateCiPatchPath,
  inspectLock,
  LOCK_DIR_NAME,
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
 *
 * @param {string} repoRoot
 * @returns {{
 *   state: 'none' | 'ownership-unverified' | 'orphaned-journal' | 'corrupted-journal' | 'corrupted-lock' | 'mismatched-metadata' | 'foreign-content' | 'unsafe-symlink',
 *   hasLock: boolean,
 *   hasJournal: boolean,
 *   isPending: boolean,
 *   lock: object|null,
 *   journal: object|null,
 *   foreignEntries: string[],
 *   reasons: string[]
 * }}
 */
export function inspectTransactionState(repoRoot) {
  const reasons = [];

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
      reasons: [`Failed to read installer directory: ${err.message}`],
    };
  }

  // Identify foreign entries
  const foreignEntries = [];
  for (const entry of dirEntries) {
    if (RECOGNIZED_ENTRIES.includes(entry) || TMP_JOURNAL_REGEX.test(entry)) {
      continue;
    }
    foreignEntries.push(entry);
  }

  // Inspect lock and journal
  const lockInspection = inspectLock(repoRoot);
  const journalInspection = inspectJournal(repoRoot);

  const hasLock = lockInspection.hasLock;
  const hasJournal = journalInspection.hasJournal;

  // 1. Symlink checks
  if (lockInspection.isSymlink || journalInspection.isSymlink) {
    reasons.push('Installer lock or journal component is a symbolic link');
    return {
      state: 'unsafe-symlink',
      hasLock,
      hasJournal,
      isPending: true,
      lock: lockInspection,
      journal: journalInspection,
      foreignEntries,
      reasons,
    };
  }

  // 2. Foreign content
  if (foreignEntries.length > 0) {
    reasons.push(`Installer directory contains unexpected foreign files: ${foreignEntries.join(', ')}`);
  }

  // 3. Corrupted lock
  if (hasLock && !lockInspection.isValid) {
    reasons.push(...lockInspection.errors);
  }

  // 4. Corrupted journal
  if (hasJournal && !journalInspection.isValid) {
    reasons.push(...journalInspection.errors);
  }

  // 5. Mismatched transaction IDs
  let isMismatched = false;
  if (hasLock && hasJournal && lockInspection.isValid && journalInspection.isValid) {
    if (lockInspection.owner.txId !== journalInspection.journal.txId) {
      isMismatched = true;
      reasons.push(
        `Transaction ID mismatch: lock belongs to "${lockInspection.owner.txId}" but journal belongs to "${journalInspection.journal.txId}"`
      );
    }
  }

  // 6. Orphaned journal (journal exists without lock)
  if (hasJournal && !hasLock) {
    reasons.push(
      `Orphaned journal detected: journal exists in phase "${journalInspection.journal?.phase || 'unknown'}" without an active lock`
    );
  }

  // Determine overall classification state
  let state = 'none';

  if (!hasLock && !hasJournal && foreignEntries.length === 0) {
    state = 'none';
  } else if (foreignEntries.length > 0) {
    state = 'foreign-content';
  } else if (hasLock && !lockInspection.isValid) {
    state = 'corrupted-lock';
  } else if (hasJournal && !journalInspection.isValid) {
    state = 'corrupted-journal';
  } else if (hasJournal && !hasLock) {
    state = 'orphaned-journal';
  } else if (isMismatched) {
    state = 'mismatched-metadata';
  } else if (hasLock) {
    // Lock present with valid metadata (with or without matching journal)
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
    reasons,
  };
}

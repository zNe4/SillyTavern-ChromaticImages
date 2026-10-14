import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  acquireLock,
  releaseLock,
  inspectLock,
  generateTxId,
  validateLockOwner,
  validateCiPatchPath,
  LOCK_SCHEMA_VERSION,
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  advanceJournalPhase,
  removeJournal,
  inspectJournal,
  validateJournalStructure,
  validatePhaseTransition,
  JOURNAL_SCHEMA_VERSION,
  PERMITTED_PHASES,
} from '../src/patch-installer/journal.js';

import {
  inspectTransactionState,
} from '../src/patch-installer/transaction-state.js';

const tempDirsToClean = [];
after(() => {
  for (const d of tempDirsToClean) {
    try {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors on exit
    }
  }
});

function createTempDir(prefix = 'ci-tx-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

describe('Installer Lock Primitives (lock.js)', () => {
  test('acquireLock creates lock.d and owner.json with verified metadata', () => {
    const repo = createTempDir('lock-acquire-');
    const txId = generateTxId();

    const res = acquireLock({
      repoRoot: repo,
      txId,
      op: 'apply',
      pid: 12345,
      hostname: 'test-host',
    });

    assert.equal(res.ok, true);
    assert.ok(res.lock);
    assert.equal(res.lock.owner.txId, txId);
    assert.equal(res.lock.owner.pid, 12345);
    assert.equal(res.lock.owner.hostname, 'test-host');
    assert.equal(res.lock.owner.op, 'apply');
    assert.equal(res.lock.owner.schemaVersion, LOCK_SCHEMA_VERSION);

    // Verify disk state
    const lockDir = path.join(repo, '.ci-patch/lock.d');
    const ownerFile = path.join(lockDir, 'owner.json');
    assert.equal(fs.existsSync(lockDir), true);
    assert.equal(fs.existsSync(ownerFile), true);

    const onDisk = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    assert.equal(onDisk.txId, txId);
    assert.equal(onDisk.pid, 12345);
  });

  test('acquireLock fails with lock-contention when lock already exists', () => {
    const repo = createTempDir('lock-contention-');
    const tx1 = generateTxId();
    const tx2 = generateTxId();

    const res1 = acquireLock({ repoRoot: repo, txId: tx1, op: 'apply' });
    assert.equal(res1.ok, true);

    // Second acquisition attempt must fail closed
    const res2 = acquireLock({ repoRoot: repo, txId: tx2, op: 'apply' });
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'lock-contention');
    assert.match(res2.reason, /already exists/);

    // First lock owner metadata remains completely untouched
    const inspection = inspectLock(repo);
    assert.equal(inspection.hasLock, true);
    assert.equal(inspection.owner?.txId, tx1);
  });

  test('acquireLock refuses invalid options', () => {
    const repo = createTempDir('lock-invalid-opts-');

    assert.equal(acquireLock({}).ok, false);
    assert.equal(acquireLock({ repoRoot: repo, txId: 'invalid-tx', op: 'apply' }).ok, false);
    assert.equal(acquireLock({ repoRoot: repo, txId: generateTxId(), op: 'invalid-op' }).ok, false);
  });

  test('acquireLock rejects symlink .ci-patch directory', () => {
    const repo = createTempDir('lock-symlink-root-');
    const realTarget = createTempDir('real-ci-patch-');
    const symlinkPath = path.join(repo, '.ci-patch');
    fs.symlinkSync(realTarget, symlinkPath);

    const res = acquireLock({ repoRoot: repo, txId: generateTxId(), op: 'apply' });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unsafe-path');
    assert.match(res.reason, /symbolic link/);
  });

  test('releaseLock successfully releases lock when ownership matches', () => {
    const repo = createTempDir('lock-release-clean-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply', pid: 9999, hostname: 'host-a' });

    const releaseRes = releaseLock({
      repoRoot: repo,
      txId,
      expectedOwner: { pid: 9999, hostname: 'host-a' },
    });

    assert.equal(releaseRes.ok, true);

    const postInspection = inspectLock(repo);
    assert.equal(postInspection.hasLock, false);
    assert.equal(fs.existsSync(path.join(repo, '.ci-patch/lock.d')), false);
  });

  test('releaseLock refuses to release foreign lock with ownership-mismatch', () => {
    const repo = createTempDir('lock-foreign-release-');
    const txOwner = generateTxId();
    const txOther = generateTxId();

    acquireLock({ repoRoot: repo, txId: txOwner, op: 'apply', pid: 1111, hostname: 'host-1' });

    // Different txId
    const res1 = releaseLock({ repoRoot: repo, txId: txOther });
    assert.equal(res1.ok, false);
    assert.equal(res1.error, 'ownership-mismatch');

    // Mismatched PID
    const res2 = releaseLock({ repoRoot: repo, txId: txOwner, expectedOwner: { pid: 2222 } });
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'ownership-mismatch');

    // Mismatched hostname
    const res3 = releaseLock({ repoRoot: repo, txId: txOwner, expectedOwner: { hostname: 'host-2' } });
    assert.equal(res3.ok, false);
    assert.equal(res3.error, 'ownership-mismatch');

    // Lock remains intact
    const inspection = inspectLock(repo);
    assert.equal(inspection.hasLock, true);
    assert.equal(inspection.owner?.txId, txOwner);
  });

  test('inspectLock detects missing, malformed, and symlink owner metadata', () => {
    const repo = createTempDir('lock-inspect-anomalies-');
    const lockDir = path.join(repo, '.ci-patch/lock.d');
    fs.mkdirSync(lockDir, { recursive: true });

    // Case 1: Missing owner.json
    const resMissing = inspectLock(repo);
    assert.equal(resMissing.hasLock, true);
    assert.equal(resMissing.isValid, false);
    assert.match(resMissing.errors[0], /owner\.json.*missing/);

    // Case 2: Symlink owner.json
    const realFile = path.join(repo, 'real-owner.json');
    fs.writeFileSync(realFile, '{}');
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.symlinkSync(realFile, ownerFile);

    const resSymlink = inspectLock(repo);
    assert.equal(resSymlink.hasLock, true);
    assert.equal(resSymlink.isValid, false);
    assert.match(resSymlink.errors[0], /symbolic link/);

    // Case 3: Corrupted JSON in owner.json
    fs.unlinkSync(ownerFile);
    fs.writeFileSync(ownerFile, '{ not valid json');

    const resCorrupt = inspectLock(repo);
    assert.equal(resCorrupt.hasLock, true);
    assert.equal(resCorrupt.isValid, false);
    assert.match(resCorrupt.errors[0], /invalid JSON/);

    // Case 4: Schema validation failure
    fs.writeFileSync(ownerFile, JSON.stringify({ schemaVersion: '9.9.9' }));
    const resSchema = inspectLock(repo);
    assert.equal(resSchema.hasLock, true);
    assert.equal(resSchema.isValid, false);
    assert.match(resSchema.errors[0], /Invalid schemaVersion/);
  });
});

describe('Installer Journal Primitives (journal.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('createJournal creates initial journal in LOCKED phase with durable flush', () => {
    const repo = createTempDir('journal-create-');
    const txId = generateTxId();

    const res = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    assert.equal(res.ok, true);
    assert.ok(res.journal);
    assert.equal(res.journal.phase, 'LOCKED');
    assert.equal(res.journal.op, 'apply');
    assert.equal(res.journal.expectedInitialSha256, stockSha);
    assert.equal(res.journal.expectedResultSha256, patchedSha);

    const inspection = inspectJournal(repo);
    assert.equal(inspection.hasJournal, true);
    assert.equal(inspection.isValid, true);
    assert.equal(inspection.journal?.phase, 'LOCKED');
  });

  test('createJournal refuses creation when journal already exists', () => {
    const repo = createTempDir('journal-exists-');
    const txId = generateTxId();

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    const res2 = createJournal({
      repoRoot: repo,
      txId: generateTxId(),
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    assert.equal(res2.ok, false);
    assert.match(res2.error, /already present/);
  });

  test('advanceJournalPhase strictly enforces valid phase transitions', () => {
    const repo = createTempDir('journal-phases-');
    const txId = generateTxId();

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    // Illegal jump: LOCKED -> READY_TO_SWAP
    const illegalJump = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'READY_TO_SWAP' });
    assert.equal(illegalJump.ok, false);
    assert.match(illegalJump.error, /Illegal phase transition/);

    // Legal progression:
    const p1 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'ISOLATED_PREPARED' });
    assert.equal(p1.ok, true);
    assert.equal(p1.journal?.phase, 'ISOLATED_PREPARED');

    const p2 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'BACKUP_CREATED' });
    assert.equal(p2.ok, true);
    assert.equal(p2.journal?.phase, 'BACKUP_CREATED');

    const p3 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'READY_TO_SWAP' });
    assert.equal(p3.ok, true);
    assert.equal(p3.journal?.phase, 'READY_TO_SWAP');

    const p4 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'SWAPPED' });
    assert.equal(p4.ok, true);
    assert.equal(p4.journal?.phase, 'SWAPPED');

    // Backward transition: SWAPPED -> READY_TO_SWAP
    const backward = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'READY_TO_SWAP' });
    assert.equal(backward.ok, false);
    assert.match(backward.error, /Illegal phase transition/);

    const p5 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'COMPLETED' });
    assert.equal(p5.ok, true);
    assert.equal(p5.journal?.phase, 'COMPLETED');
  });

  test('advanceJournalPhase refuses mismatched txId', () => {
    const repo = createTempDir('journal-tx-mismatch-');
    const txOwner = generateTxId();
    const txOther = generateTxId();

    createJournal({
      repoRoot: repo,
      txId: txOwner,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    const res = advanceJournalPhase({ repoRoot: repo, txId: txOther, nextPhase: 'ISOLATED_PREPARED' });
    assert.equal(res.ok, false);
    assert.match(res.error, /owned by transaction/);
  });

  test('removeJournal refuses removal of incomplete journal without explicit override', () => {
    const repo = createTempDir('journal-incomplete-remove-');
    const txId = generateTxId();

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    // Removal while in LOCKED phase
    const refuseRes = removeJournal({ repoRoot: repo, txId });
    assert.equal(refuseRes.ok, false);
    assert.match(refuseRes.error, /Refusing to remove incomplete journal/);

    // Advance to COMPLETED
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'ISOLATED_PREPARED' });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'BACKUP_CREATED' });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'READY_TO_SWAP' });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'SWAPPED' });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'COMPLETED' });

    // Removal of COMPLETED journal succeeds
    const removeRes = removeJournal({ repoRoot: repo, txId });
    assert.equal(removeRes.ok, true);
    assert.equal(inspectJournal(repo).hasJournal, false);
  });

  test('inspectJournal detects corrupted JSON and invalid schema', () => {
    const repo = createTempDir('journal-corrupted-');
    const jPath = path.join(repo, '.ci-patch/journal.json');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });

    // Corrupted JSON
    fs.writeFileSync(jPath, '{ invalid json');
    const res1 = inspectJournal(repo);
    assert.equal(res1.hasJournal, true);
    assert.equal(res1.isValid, false);
    assert.match(res1.errors[0], /invalid JSON/);

    // Schema violation
    fs.writeFileSync(jPath, JSON.stringify({ schemaVersion: '1.0.0', op: 'unknown' }));
    const res2 = inspectJournal(repo);
    assert.equal(res2.hasJournal, true);
    assert.equal(res2.isValid, false);
    assert.ok(res2.errors.length > 0);
  });

  test('validatePhaseTransition handles all valid and invalid phase combinations', () => {
    for (const phase of PERMITTED_PHASES) {
      assert.equal(validatePhaseTransition('INVALID', phase).ok, false);
      assert.equal(validatePhaseTransition(phase, 'INVALID').ok, false);
    }
    assert.equal(validatePhaseTransition('LOCKED', 'ISOLATED_PREPARED').ok, true);
    assert.equal(validatePhaseTransition('COMPLETED', 'LOCKED').ok, false);
  });

  describe('Fault Injection & Error Resilience', () => {
    test('createJournal preserves state and fails closed when file write or fsync fails', () => {
      const repo = createTempDir('journal-fault-write-');
      const ciPatchDir = path.join(repo, '.ci-patch');
      fs.mkdirSync(ciPatchDir, { recursive: true, mode: 0o500 }); // read-only directory

      const txId = generateTxId();
      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
        });

        assert.equal(res.ok, false);
        assert.match(res.error, /Failed to write journal/);
      } finally {
        fs.chmodSync(ciPatchDir, 0o700); // restore for cleanup
      }
    });

    test('advanceJournalPhase preserves existing journal when write failure occurs', () => {
      const repo = createTempDir('journal-fault-advance-');
      const txId = generateTxId();

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
      });

      const ciPatchDir = path.join(repo, '.ci-patch');
      fs.chmodSync(ciPatchDir, 0o500); // read-only

      try {
        const res = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'ISOLATED_PREPARED' });
        assert.equal(res.ok, false);
        assert.match(res.error, /Failed to write journal/);

        // Verify existing journal remains in phase LOCKED and uncorrupted
        fs.chmodSync(ciPatchDir, 0o700);
        const inspection = inspectJournal(repo);
        assert.equal(inspection.hasJournal, true);
        assert.equal(inspection.isValid, true);
        assert.equal(inspection.journal?.phase, 'LOCKED');
      } finally {
        fs.chmodSync(ciPatchDir, 0o700);
      }
    });

    test('createJournal cleans up temporary journal file if rename fails', () => {
      const repo = createTempDir('journal-fault-rename-');
      const txId = generateTxId();
      const originalRename = fs.renameSync;

      // Mock fs.renameSync to throw error
      fs.renameSync = () => {
        throw new Error('Simulated atomic rename failure');
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
        });

        assert.equal(res.ok, false);
        assert.match(res.error, /Simulated atomic rename failure/);

        // Ensure temp file was cleaned up
        const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.equal(fs.existsSync(tmpPath), false);
      } finally {
        fs.renameSync = originalRename;
      }
    });

    test('createJournal handles simulated fsync failure cleanly', () => {
      const repo = createTempDir('journal-fault-fsync-');
      const txId = generateTxId();
      const originalFsync = fs.fsyncSync;

      // Mock fs.fsyncSync to throw error
      fs.fsyncSync = () => {
        throw new Error('Simulated EIO on fsync');
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
        });

        assert.equal(res.ok, false);
        assert.match(res.error, /Simulated EIO on fsync/);
      } finally {
        fs.fsyncSync = originalFsync;
      }
    });
  });
});

describe('Transaction State Inspection (transaction-state.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('reports state: none on clean repository with no .ci-patch', () => {
    const repo = createTempDir('tx-state-none-');
    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'none');
    assert.equal(res.isPending, false);
    assert.equal(res.hasLock, false);
    assert.equal(res.hasJournal, false);
    assert.equal(res.foreignEntries.length, 0);
  });

  test('reports state: ownership-unverified when lock and journal are present and valid', () => {
    const repo = createTempDir('tx-state-active-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'ownership-unverified');
    assert.equal(res.isPending, true);
    assert.equal(res.hasLock, true);
    assert.equal(res.hasJournal, true);
    assert.equal(res.lock?.owner?.txId, txId);
    assert.equal(res.journal?.journal?.txId, txId);
  });

  test('reports state: orphaned-journal when journal exists without a lock', () => {
    const repo = createTempDir('tx-state-orphaned-');
    const txId = generateTxId();

    // Create journal directly without lock
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'orphaned-journal');
    assert.equal(res.isPending, true);
    assert.equal(res.hasLock, false);
    assert.equal(res.hasJournal, true);
    assert.match(res.reasons[0], /Orphaned journal detected/);
  });

  test('reports state: mismatched-metadata when lock txId != journal txId', () => {
    const repo = createTempDir('tx-state-mismatch-');
    const tx1 = generateTxId();
    const tx2 = generateTxId();

    acquireLock({ repoRoot: repo, txId: tx1, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId: tx2,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'mismatched-metadata');
    assert.equal(res.isPending, true);
    assert.match(res.reasons[0], /Transaction ID mismatch/);
  });

  test('reports state: foreign-content when unrecognized files are present in .ci-patch', () => {
    const repo = createTempDir('tx-state-foreign-');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ci-patch/unrelated.txt'), 'foreign content\n');

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'foreign-content');
    assert.equal(res.isPending, true);
    assert.equal(res.foreignEntries.includes('unrelated.txt'), true);
  });

  test('reports state: corrupted-journal when journal.json is corrupt', () => {
    const repo = createTempDir('tx-state-corrupt-journal-');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ci-patch/journal.json'), '{ broken json');

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'corrupted-journal');
    assert.equal(res.isPending, true);
  });

  test('reports state: corrupted-lock when lock.d is missing owner.json', () => {
    const repo = createTempDir('tx-state-corrupt-lock-');
    fs.mkdirSync(path.join(repo, '.ci-patch/lock.d'), { recursive: true });

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'corrupted-lock');
    assert.equal(res.isPending, true);
  });

  test('reports state: unsafe-symlink when .ci-patch is a symlink', () => {
    const repo = createTempDir('tx-state-symlink-');
    const realDir = createTempDir('real-dir-');
    fs.symlinkSync(realDir, path.join(repo, '.ci-patch'));

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'unsafe-symlink');
    assert.equal(res.isPending, true);
    assert.match(res.reasons[0], /symbolic link/);
  });
});

import { execFileSync } from 'node:child_process';
import {
  inspectTargetInstallation,
  checkInstallationPreflight,
} from '../src/patch-installer/inspect.js';
import { main } from '../scripts/sillytavern-patch.mjs';

describe('Read-Only Integration & CLI Transaction Inspection', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  function setupDisposableRepo(prefix = 'st-tx-fixture-') {
    const repoDir = createTempDir(prefix);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
    fs.writeFileSync(path.join(repoDir, 'server.js'), '// server\n');
    fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), '// original\n');

    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: repoDir });

    return repoDir;
  }

  test('checkInstallationPreflight strictly refuses when transaction lock is present', async () => {
    const repo = setupDisposableRepo();
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.verdict, 'refused');
    assert.equal(preflight.exitCode, 1);
    assert.equal(preflight.canApply, false);
    assert.equal(preflight.alreadyApplied, false);
    assert.match(preflight.reason, /installer transaction is pending or ambiguous/);
    assert.equal(preflight.inspection.transaction.state, 'ownership-unverified');
  });

  test('CLI --status and --check format transaction state correctly and stay strictly read-only', async () => {
    const repo = setupDisposableRepo('st-cli-tx-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply', pid: 54321, hostname: 'workstation-test' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });

    const ownerFile = path.join(repo, '.ci-patch/lock.d/owner.json');
    const journalFile = path.join(repo, '.ci-patch/journal.json');
    const ownerBeforeBuf = fs.readFileSync(ownerFile);
    const journalBeforeBuf = fs.readFileSync(journalFile);

    // 1. Capture --status human output
    let statusOut = '';
    const origLog = console.log;
    console.log = (msg) => { statusOut += msg + '\n'; };

    let statusExit;
    try {
      statusExit = await main([repo, '--status']);
    } finally {
      console.log = origLog;
    }

    assert.equal(statusExit, 0);
    assert.match(statusOut, /Transaction State:\s+ownership-unverified/);
    assert.match(statusOut, /Lock Details:\s+txId=ci-tx-.*pid=54321/);
    assert.match(statusOut, /Journal Details:\s+phase=LOCKED/);

    // 2. Capture --check human output
    let checkOut = '';
    console.log = (msg) => { checkOut += msg + '\n'; };

    let checkExit;
    try {
      checkExit = await main([repo, '--check']);
    } finally {
      console.log = origLog;
    }

    assert.equal(checkExit, 1);
    assert.match(checkOut, /Verdict:\s+refused/);
    assert.match(checkOut, /Can Apply:\s+NO/);
    assert.match(checkOut, /Transaction State:\s+ownership-unverified/);
    assert.match(checkOut, /installer transaction is pending or ambiguous/);

    // 3. Capture --status --json output
    let jsonStatusOut = '';
    console.log = (msg) => { jsonStatusOut += msg + '\n'; };
    try {
      await main([repo, '--status', '--json']);
    } finally {
      console.log = origLog;
    }

    const parsedStatus = JSON.parse(jsonStatusOut);
    assert.equal(parsedStatus.command, 'status');
    assert.equal(parsedStatus.transaction.state, 'ownership-unverified');
    assert.equal(parsedStatus.transaction.hasLock, true);
    assert.equal(parsedStatus.transaction.hasJournal, true);
    assert.equal(parsedStatus.transaction.lock.owner.txId, txId);
    assert.equal(parsedStatus.transaction.journal.journal.phase, 'LOCKED');

    // 4. Capture --check --json output
    let jsonCheckOut = '';
    console.log = (msg) => { jsonCheckOut += msg + '\n'; };
    let jsonCheckExit;
    try {
      jsonCheckExit = await main([repo, '--check', '--json']);
    } finally {
      console.log = origLog;
    }

    assert.equal(jsonCheckExit, 1);
    const parsedCheck = JSON.parse(jsonCheckOut);
    assert.equal(parsedCheck.command, 'check');
    assert.equal(parsedCheck.verdict, 'refused');
    assert.equal(parsedCheck.canApply, false);
    assert.equal(parsedCheck.transaction.state, 'ownership-unverified');

    // 5. Immutability verification: lock and journal files are bit-for-bit identical
    const ownerAfterBuf = fs.readFileSync(ownerFile);
    const journalAfterBuf = fs.readFileSync(journalFile);
    assert.deepEqual(ownerAfterBuf, ownerBeforeBuf, 'Lock owner metadata must remain bit-for-bit unchanged');
    assert.deepEqual(journalAfterBuf, journalBeforeBuf, 'Journal metadata must remain bit-for-bit unchanged');
  });
});

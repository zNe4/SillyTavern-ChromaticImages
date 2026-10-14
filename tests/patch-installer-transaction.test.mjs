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

  test('releaseLock refuses release and preserves owner.json when lock.d contains unexpected entries', () => {
    const repo = createTempDir('lock-release-unexpected-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const lockDir = path.join(repo, '.ci-patch/lock.d');
    const unexpectedFile = path.join(lockDir, 'foreign.txt');
    fs.writeFileSync(unexpectedFile, 'unauthorized file in lock.d\n');

    const res = releaseLock({ repoRoot: repo, txId });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unexpected-lock-contents');
    assert.match(res.reason, /unexpected entries: foreign\.txt/);

    // Verify owner.json still exists and was NOT unlinked
    const ownerFile = path.join(lockDir, 'owner.json');
    assert.equal(fs.existsSync(ownerFile), true);

    // After removing unexpected entry, release succeeds
    fs.unlinkSync(unexpectedFile);
    const retryRes = releaseLock({ repoRoot: repo, txId });
    assert.equal(retryRes.ok, true);
    assert.equal(fs.existsSync(lockDir), false);
  });
});

describe('Installer Journal Primitives (journal.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('createJournal creates initial journal in LOCKED phase with durable flush', () => {
    const repo = createTempDir('journal-create-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply' });

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

    acquireLock({ repoRoot: repo, txId, op: 'apply' });

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
    assert.match(res2.error, /(already present|Lock belongs to transaction)/);
  });

  test('createJournal enforces lock ownership and rejects unauthenticated callers', () => {
    const repo = createTempDir('journal-lock-enforce-');
    const tx1 = generateTxId();
    const tx2 = generateTxId();

    // 1. Calling without lock fails
    const resNoLock = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(resNoLock.ok, false);
    assert.match(resNoLock.error, /Cannot mutate journal without an active exclusive lock/);

    // Acquire lock for tx1 on repo with op: apply
    acquireLock({ repoRoot: repo, txId: tx1, op: 'apply', pid: 12345, hostname: 'host-1' });

    // 2. Caller txId mismatch
    const resTxMismatch = createJournal({
      repoRoot: repo,
      txId: tx2,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(resTxMismatch.ok, false);
    assert.match(resTxMismatch.error, /Lock belongs to transaction/);

    // 3. Operation mismatch
    const resOpMismatch = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'remove',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(resOpMismatch.ok, false);
    assert.match(resOpMismatch.error, /does not match journal operation/);

    // 4. Repo mismatch
    const otherRepo = createTempDir('journal-other-repo-');
    const resRepoMismatch = createJournal({
      repoRoot: otherRepo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(resRepoMismatch.ok, false);
    assert.match(resRepoMismatch.error, /Cannot mutate journal without an active exclusive lock/);

    // 5. CallerOwner PID mismatch
    const resPidMismatch = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      callerOwner: { pid: 99999 },
    });
    assert.equal(resPidMismatch.ok, false);
    assert.match(resPidMismatch.error, /PID mismatch/);

    // 6. Valid call succeeds
    const resValid = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      callerOwner: { pid: 12345, hostname: 'host-1' },
    });
    assert.equal(resValid.ok, true);
  });

  test('createJournal rejects immutable and forbidden fields in extraMetadata', () => {
    const repo = createTempDir('journal-immutable-create-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Attempt to override phase at creation
    const resPhase = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { phase: 'COMPLETED' },
    });
    assert.equal(resPhase.ok, false);
    assert.match(resPhase.error, /Cannot create with forbidden journal field: "phase"/);

    // Attempt to override txId
    const resTxId = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { txId: 'other-id' },
    });
    assert.equal(resTxId.ok, false);
    assert.match(resTxId.error, /Cannot create with forbidden journal field: "txId"/);

    // Attempt to override schemaVersion
    const resSchema = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { schemaVersion: '9.9.9' },
    });
    assert.equal(resSchema.ok, false);
    assert.match(resSchema.error, /Cannot create with forbidden journal field: "schemaVersion"/);

    // Attempt to supply disallowed extra field
    const resDisallowed = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { arbitraryKey: 'not-allowed' },
    });
    assert.equal(resDisallowed.ok, false);
    assert.match(resDisallowed.error, /Disallowed auxiliary journal field/);
  });

  test('advanceJournalPhase strictly enforces valid phase transitions and verifies lock', () => {
    const repo = createTempDir('journal-phases-');
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

  test('advanceJournalPhase rejects metadataUpdate trying to override immutable fields', () => {
    const repo = createTempDir('journal-immutable-advance-');
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

    // Attempt to bypass phase transition by supplying metadataUpdate.phase: 'COMPLETED'
    const resBypass = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { phase: 'COMPLETED' },
    });
    assert.equal(resBypass.ok, false);
    assert.match(resBypass.error, /Cannot overwrite immutable journal field: "phase"/);

    // Attempt to override txId
    const resTxId = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { txId: 'tampered-txId' },
    });
    assert.equal(resTxId.ok, false);
    assert.match(resTxId.error, /Cannot overwrite immutable journal field: "txId"/);

    // Attempt to override expectedResultSha256
    const resHash = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { expectedResultSha256: '0000000000000000000000000000000000000000000000000000000000000000' },
    });
    assert.equal(resHash.ok, false);
    assert.match(resHash.error, /Cannot overwrite immutable journal field: "expectedResultSha256"/);

    // Allowed auxiliary metadata update succeeds
    const resAux = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { stagedPath: '/path/to/staged' },
    });
    assert.equal(resAux.ok, true);
    assert.equal(resAux.journal?.phase, 'ISOLATED_PREPARED');
    assert.equal(resAux.journal?.stagedPath, '/path/to/staged');
    assert.equal(resAux.journal?.txId, txId);
  });

  test('advanceJournalPhase refuses mismatched txId', () => {
    const repo = createTempDir('journal-tx-mismatch-');
    const txOwner = generateTxId();
    const txOther = generateTxId();

    acquireLock({ repoRoot: repo, txId: txOwner, op: 'apply' });
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

  test('removeJournal refuses removal of incomplete journal without explicit override and verifies lock', () => {
    const repo = createTempDir('journal-incomplete-remove-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply', pid: 4444 });

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

    // Removal with callerOwner PID mismatch
    const badPidRes = removeJournal({ repoRoot: repo, txId, callerOwner: { pid: 9999 } });
    assert.equal(badPidRes.ok, false);
    assert.match(badPidRes.error, /PID mismatch/);

    // Removal of COMPLETED journal with valid lock succeeds
    const removeRes = removeJournal({ repoRoot: repo, txId, callerOwner: { pid: 4444 } });
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
    test('createJournal preserves state and fails closed when file write fails (pre-rename)', () => {
      const repo = createTempDir('journal-fault-write-');
      const txId = generateTxId();
      acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const ciPatchDir = path.join(repo, '.ci-patch');
      fs.chmodSync(ciPatchDir, 0o500); // read-only directory

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
        assert.equal(res.stage, 'pre-rename');
        assert.match(res.error, /Failed to prepare journal update before rename/);
      } finally {
        fs.chmodSync(ciPatchDir, 0o700); // restore for cleanup
      }
    });

    test('advanceJournalPhase preserves existing journal when write failure occurs', () => {
      const repo = createTempDir('journal-fault-advance-');
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

      const ciPatchDir = path.join(repo, '.ci-patch');
      fs.chmodSync(ciPatchDir, 0o500); // read-only

      try {
        const res = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'ISOLATED_PREPARED' });
        assert.equal(res.ok, false);
        assert.equal(res.stage, 'pre-rename');
        assert.match(res.error, /Failed to prepare journal update before rename/);

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
      acquireLock({ repoRoot: repo, txId, op: 'apply' });

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
        assert.equal(res.stage, 'pre-rename');
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
      acquireLock({ repoRoot: repo, txId, op: 'apply' });

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
        assert.equal(res.stage, 'pre-rename');
        assert.match(res.error, /Simulated EIO on fsync/);
      } finally {
        fs.fsyncSync = originalFsync;
      }
    });

    test('writeJournalDurable reports stage: post-rename if directory fsync fails after rename', () => {
      const repo = createTempDir('journal-fault-post-rename-');
      const txId = generateTxId();
      acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const originalFsync = fs.fsyncSync;
      let fsyncCallCount = 0;
      fs.fsyncSync = (fd) => {
        fsyncCallCount++;
        // The 1st fsync in createJournal is on the tmp file descriptor.
        // The 2nd fsync is on the directory descriptor after rename!
        if (fsyncCallCount >= 2) {
          throw new Error('Simulated directory fsync EIO after rename');
        }
        return originalFsync(fd);
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
        assert.equal(res.stage, 'post-rename');
        assert.match(res.error, /directory synchronization failed/);
        // Journal was renamed onto disk before sync error
        assert.ok(res.journal);
        assert.equal(res.journal.phase, 'LOCKED');
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

  test('reports state: orphaned-journal when journal exists without a lock (fixture)', () => {
    const repo = createTempDir('tx-state-orphaned-');
    const txId = generateTxId();

    const ciPatchDir = path.join(repo, '.ci-patch');
    fs.mkdirSync(ciPatchDir, { recursive: true });
    const journalPath = path.join(ciPatchDir, 'journal.json');
    const journalObj = {
      schemaVersion: '1.0.0',
      txId,
      op: 'apply',
      phase: 'LOCKED',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(journalPath, JSON.stringify(journalObj, null, 2) + '\n');

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

    const journalPath = path.join(repo, '.ci-patch/journal.json');
    const journalObj = {
      schemaVersion: '1.0.0',
      txId: tx2,
      op: 'apply',
      phase: 'LOCKED',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(journalPath, JSON.stringify(journalObj, null, 2) + '\n');

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

  test('detects orphaned temporary journal files as orphaned-artifact with isPending true', () => {
    const repo = createTempDir('tx-state-tmp-journal-');
    const ciPatchDir = path.join(repo, '.ci-patch');
    fs.mkdirSync(ciPatchDir, { recursive: true });

    const tmpJournal = path.join(ciPatchDir, '.journal.ci-tx-12345-abcdef.tmp');
    fs.writeFileSync(tmpJournal, '{ "partial": true }\n');

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'orphaned-artifact');
    assert.equal(res.isPending, true);
    assert.equal(res.orphanedArtifacts.includes('.journal.ci-tx-12345-abcdef.tmp'), true);
    assert.match(res.reasons[0], /Orphaned temporary journal file detected/);
  });

  test('detects nonempty staging or backup directory without transaction as orphaned-artifact', () => {
    // 1. Nonempty staging without transaction
    const repo1 = createTempDir('tx-state-orphaned-staging-');
    fs.mkdirSync(path.join(repo1, '.ci-patch/staging/orphaned-tx-1'), { recursive: true });
    const res1 = inspectTransactionState(repo1);
    assert.equal(res1.state, 'orphaned-artifact');
    assert.equal(res1.isPending, true);
    assert.match(res1.reasons[0], /Non-empty staging directory detected with no active valid transaction/);

    // 2. Nonempty backup without transaction
    const repo2 = createTempDir('tx-state-orphaned-backup-');
    fs.mkdirSync(path.join(repo2, '.ci-patch/backup/orphaned-tx-2'), { recursive: true });
    const res2 = inspectTransactionState(repo2);
    assert.equal(res2.state, 'orphaned-artifact');
    assert.equal(res2.isPending, true);
    assert.match(res2.reasons[0], /Non-empty backup directory detected with no active valid transaction/);
  });

  test('detects staging or backup contents not matching active transaction txId', () => {
    const repo = createTempDir('tx-state-mismatched-staging-');
    const tx1 = generateTxId();
    acquireLock({ repoRoot: repo, txId: tx1, op: 'apply' });

    // Create staging directory for a different txId
    fs.mkdirSync(path.join(repo, '.ci-patch/staging/ci-tx-foreign-999'), { recursive: true });

    const res = inspectTransactionState(repo);
    assert.equal(res.state, 'orphaned-artifact');
    assert.equal(res.isPending, true);
    assert.match(res.reasons.find((r) => r.includes('does not match active transaction')), /ci-tx-foreign-999/);
  });

  test('detects dangling symbolic links across all 6 targets (.ci-patch, lock.d, owner.json, journal.json, staging, backup)', () => {
    // 1. Dangling symlink at .ci-patch
    const repo1 = createTempDir('tx-symlink-root-');
    fs.symlinkSync('/nonexistent/path/to/nowhere', path.join(repo1, '.ci-patch'));
    const res1 = inspectTransactionState(repo1);
    assert.equal(res1.state, 'unsafe-symlink');
    assert.equal(res1.isPending, true);
    assert.match(res1.reasons[0], /symbolic link/);

    // 2. Dangling symlink at lock.d
    const repo2 = createTempDir('tx-symlink-lockdir-');
    fs.mkdirSync(path.join(repo2, '.ci-patch'), { recursive: true });
    fs.symlinkSync('/nonexistent/lock.d', path.join(repo2, '.ci-patch/lock.d'));
    const res2 = inspectTransactionState(repo2);
    assert.equal(res2.state, 'unsafe-symlink');
    assert.equal(res2.isPending, true);

    // 3. Dangling symlink at owner.json
    const repo3 = createTempDir('tx-symlink-owner-');
    fs.mkdirSync(path.join(repo3, '.ci-patch/lock.d'), { recursive: true });
    fs.symlinkSync('/nonexistent/owner.json', path.join(repo3, '.ci-patch/lock.d/owner.json'));
    const res3 = inspectTransactionState(repo3);
    assert.equal(res3.state, 'unsafe-symlink');
    assert.equal(res3.isPending, true);

    // 4. Dangling symlink at journal.json
    const repo4 = createTempDir('tx-symlink-journal-');
    fs.mkdirSync(path.join(repo4, '.ci-patch'), { recursive: true });
    fs.symlinkSync('/nonexistent/journal.json', path.join(repo4, '.ci-patch/journal.json'));
    const res4 = inspectTransactionState(repo4);
    assert.equal(res4.state, 'unsafe-symlink');
    assert.equal(res4.isPending, true);

    // 5. Dangling symlink at staging
    const repo5 = createTempDir('tx-symlink-staging-');
    fs.mkdirSync(path.join(repo5, '.ci-patch'), { recursive: true });
    fs.symlinkSync('/nonexistent/staging', path.join(repo5, '.ci-patch/staging'));
    const res5 = inspectTransactionState(repo5);
    assert.equal(res5.state, 'unsafe-symlink');
    assert.equal(res5.isPending, true);

    // 6. Dangling symlink at backup
    const repo6 = createTempDir('tx-symlink-backup-');
    fs.mkdirSync(path.join(repo6, '.ci-patch'), { recursive: true });
    fs.symlinkSync('/nonexistent/backup', path.join(repo6, '.ci-patch/backup'));
    const res6 = inspectTransactionState(repo6);
    assert.equal(res6.state, 'unsafe-symlink');
    assert.equal(res6.isPending, true);
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

  test('checkInstallationPreflight strictly refuses when orphaned artifacts are present', async () => {
    const repo = setupDisposableRepo('st-preflight-orphan-');
    // Create orphaned staging directory
    fs.mkdirSync(path.join(repo, '.ci-patch/staging/orphaned-tx-folder'), { recursive: true });

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.verdict, 'refused');
    assert.equal(preflight.exitCode, 1);
    assert.equal(preflight.canApply, false);
    assert.equal(preflight.alreadyApplied, false);
    assert.equal(preflight.inspection.transaction.state, 'orphaned-artifact');
    assert.match(preflight.reason, /installer transaction is pending or ambiguous/);
  });

  test('checkInstallationPreflight strictly refuses when dangling symlink is present at .ci-patch', async () => {
    const repo = setupDisposableRepo('st-preflight-symlink-');
    fs.symlinkSync('/nonexistent/path/to/ci-patch', path.join(repo, '.ci-patch'));

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.ok, false);
    assert.equal(preflight.verdict, 'refused');
    assert.equal(preflight.exitCode, 1);
    assert.equal(preflight.canApply, false);
    assert.equal(preflight.alreadyApplied, false);
    assert.equal(preflight.inspection.transaction.state, 'unsafe-symlink');
    assert.match(preflight.reason, /Installer directory \(\.ci-patch\) is a symbolic link/);
  });
});

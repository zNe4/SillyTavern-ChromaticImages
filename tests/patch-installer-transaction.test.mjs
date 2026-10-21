import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  acquireLock,
  releaseLock,
  inspectLock,
  generateTxId,
  validateLockOwner,
  validateCiPatchPath,
  LOCK_SCHEMA_VERSION,
  TransactionLease,
  validateLease,
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  advanceJournalPhase,
  removeJournal,
  inspectJournal,
  validateJournalStructure,
  validatePhaseTransition,
  safeUnlinkCreatedFile,
  isValidDeviceIdentifier,
  isValidInodeIdentifier,
  JOURNAL_SCHEMA_VERSION,
  PERMITTED_PHASES,
} from '../src/patch-installer/journal.js';

import {
  inspectTransactionState,
  inspectBackupArtifactFile,
  inspectDestinationCandidateFile,
  inspectLiveTargetFile,
  MAX_DESTINATION_INSPECT_BYTES,
  MAX_LIVE_TARGET_INSPECT_BYTES,
  hasRequiredNoFollow,
  hasRequiredLiveTargetFlags,
  getPermittedArtifactNames,
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

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply', hostname: 'host-a' });

    const releaseRes = releaseLock({
      repoRoot: repo,
      txId,
      lease,
      expectedOwner: { pid: process.pid, hostname: 'host-a' },
    });

    assert.equal(releaseRes.ok, true);

    const postInspection = inspectLock(repo);
    assert.equal(postInspection.hasLock, false);
    assert.equal(fs.existsSync(path.join(repo, '.ci-patch/lock.d')), false);
  });

  test('releaseLock refuses to release foreign lock with ownership-mismatch and requires lease', () => {
    const repo = createTempDir('lock-foreign-release-');
    const txOwner = generateTxId();
    const txOther = generateTxId();

    const { lease } = acquireLock({ repoRoot: repo, txId: txOwner, op: 'apply', hostname: 'host-1' });

    // Calling releaseLock without lease fails closed
    const resNoLease = releaseLock({ repoRoot: repo, txId: txOwner });
    assert.equal(resNoLease.ok, false);
    assert.equal(resNoLease.error, 'lease-required');

    // Different txId with foreign lease
    const res1 = releaseLock({ repoRoot: repo, txId: txOther, lease });
    assert.equal(res1.ok, false);
    assert.match(res1.error, /(lease-tx-mismatch|ownership-mismatch)/);

    // Mismatched PID in expectedOwner
    const res2 = releaseLock({ repoRoot: repo, txId: txOwner, lease, expectedOwner: { pid: 99999 } });
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'ownership-mismatch');

    // Mismatched hostname
    const res3 = releaseLock({ repoRoot: repo, txId: txOwner, lease, expectedOwner: { hostname: 'host-2' } });
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

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const lockDir = path.join(repo, '.ci-patch/lock.d');
    const unexpectedFile = path.join(lockDir, 'foreign.txt');
    fs.writeFileSync(unexpectedFile, 'unauthorized file in lock.d\n');

    const res = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unexpected-lock-contents');
    assert.match(res.reason, /unexpected entries: foreign\.txt/);

    // Verify owner.json still exists and was NOT unlinked
    const ownerFile = path.join(lockDir, 'owner.json');
    assert.equal(fs.existsSync(ownerFile), true);

    // After removing unexpected entry, release succeeds
    fs.unlinkSync(unexpectedFile);
    const retryRes = releaseLock({ repoRoot: repo, txId, lease });
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

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const res = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
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

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const res2 = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    assert.equal(res2.ok, false);
    assert.match(res2.error, /(already present|already exists)/);
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
    const { lease } = acquireLock({ repoRoot: repo, txId: tx1, op: 'apply', hostname: 'host-1' });

    // 2. Calling without lease fails closed
    const resNoLease = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(resNoLease.ok, false);
    assert.equal(resNoLease.code, 'lease-required');
    assert.match(resNoLease.error, /Cannot mutate journal without the active acquisition lease/);

    // 3. Caller txId mismatch
    const resTxMismatch = createJournal({
      repoRoot: repo,
      txId: tx2,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(resTxMismatch.ok, false);
    assert.equal(resTxMismatch.code, 'lease-tx-mismatch');
    assert.match(resTxMismatch.error, /Transaction lease txId mismatch/);

    // 4. Operation mismatch
    const resOpMismatch = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'remove',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(resOpMismatch.ok, false);
    assert.equal(resOpMismatch.code, 'lease-op-mismatch');
    assert.match(resOpMismatch.error, /Transaction lease operation mismatch/);

    // 5. Repo mismatch
    const otherRepo = createTempDir('journal-other-repo-');
    const resRepoMismatch = createJournal({
      repoRoot: otherRepo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(resRepoMismatch.ok, false);
    assert.equal(resRepoMismatch.code, 'lease-repo-mismatch');
    assert.match(resRepoMismatch.error, /Transaction lease repository (root|path) mismatch/);

    // 6. Valid call succeeds
    const resValid = createJournal({
      repoRoot: repo,
      txId: tx1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(resValid.ok, true);
  });

  test('createJournal rejects immutable and forbidden fields in extraMetadata', () => {
    const repo = createTempDir('journal-immutable-create-');
    const txId = generateTxId();

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Attempt to override phase at creation
    const resPhase = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { phase: 'COMPLETED' },
      lease,
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
      lease,
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
      lease,
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
      lease,
    });
    assert.equal(resDisallowed.ok, false);
    assert.match(resDisallowed.error, /Disallowed auxiliary journal field/);
  });

  test('advanceJournalPhase strictly enforces valid phase transitions and verifies lock', () => {
    const repo = createTempDir('journal-phases-');
    const txId = generateTxId();

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Illegal jump: LOCKED -> READY_TO_SWAP
    const illegalJump = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'READY_TO_SWAP', lease });
    assert.equal(illegalJump.ok, false);
    assert.match(illegalJump.error, /Illegal phase transition/);

    // Legal progression:
    const p1 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(p1.ok, true);
    assert.equal(p1.journal?.phase, 'ISOLATED_PREPARED');

    const p2 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      lease,
    });
    assert.equal(p2.ok, true);
    assert.equal(p2.journal?.phase, 'BACKUP_CREATED');

    const p3 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      lease,
    });
    assert.equal(p3.ok, true);
    assert.equal(p3.journal?.phase, 'READY_TO_SWAP');

    const p4 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'SWAPPED', lease });
    assert.equal(p4.ok, true);
    assert.equal(p4.journal?.phase, 'SWAPPED');

    // Backward transition: SWAPPED -> READY_TO_SWAP
    const backward = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      lease,
    });
    assert.equal(backward.ok, false);
    assert.match(backward.error, /Illegal phase transition/);

    const p5 = advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'COMPLETED', lease });
    assert.equal(p5.ok, true);
    assert.equal(p5.journal?.phase, 'COMPLETED');
  });

  test('advanceJournalPhase rejects metadataUpdate trying to override immutable fields', () => {
    const repo = createTempDir('journal-immutable-advance-');
    const txId = generateTxId();

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Attempt to bypass phase transition by supplying metadataUpdate.phase: 'COMPLETED'
    const resBypass = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { phase: 'COMPLETED' },
      lease,
    });
    assert.equal(resBypass.ok, false);
    assert.match(resBypass.error, /Cannot overwrite immutable journal field: "phase"/);

    // Attempt to override txId
    const resTxId = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { txId: 'tampered-txId' },
      lease,
    });
    assert.equal(resTxId.ok, false);
    assert.match(resTxId.error, /Cannot overwrite immutable journal field: "txId"/);

    // Attempt to override expectedResultSha256
    const resHash = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { expectedResultSha256: '0000000000000000000000000000000000000000000000000000000000000000' },
      lease,
    });
    assert.equal(resHash.ok, false);
    assert.match(resHash.error, /Cannot overwrite immutable journal field: "expectedResultSha256"/);

    // Disallowed legacy stagedPath update is rejected
    const resLegacy = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { stagedPath: `/path/to/staged` },
      lease,
    });
    assert.equal(resLegacy.ok, false);
    assert.match(resLegacy.error, /legacy "stagedPath" is rejected/);

    // Allowed auxiliary metadata update succeeds
    const resAux = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(resAux.ok, true);
    assert.equal(resAux.journal?.phase, 'ISOLATED_PREPARED');
    assert.equal(resAux.journal?.isolatedStagedPath, `.ci-patch/staging/${txId}/stable-diffusion.js`);
    assert.equal(resAux.journal?.txId, txId);
  });

  test('advanceJournalPhase refuses mismatched txId', () => {
    const repo = createTempDir('journal-tx-mismatch-');
    const txOwner = generateTxId();
    const txOther = generateTxId();

    const { lease: leaseOwner } = acquireLock({ repoRoot: repo, txId: txOwner, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId: txOwner,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease: leaseOwner,
    });

    const res = advanceJournalPhase({ repoRoot: repo, txId: txOther, nextPhase: 'ISOLATED_PREPARED', lease: leaseOwner });
    assert.equal(res.ok, false);
    assert.match(res.error, /(owned by transaction|lease-tx-mismatch)/);
  });

  test('removeJournal refuses removal of incomplete journal without explicit override and verifies lock', () => {
    const repo = createTempDir('journal-incomplete-remove-');
    const txId = generateTxId();

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Calling removeJournal without lease fails closed
    const badLeaseRes = removeJournal({ repoRoot: repo, txId });
    assert.equal(badLeaseRes.ok, false);
    assert.equal(badLeaseRes.code, 'lease-required');
    assert.match(badLeaseRes.error, /Cannot mutate journal without the active acquisition lease/);

    // Removal while in LOCKED phase
    const refuseRes = removeJournal({ repoRoot: repo, txId, lease });
    assert.equal(refuseRes.ok, false);
    assert.match(refuseRes.error, /Refusing to remove incomplete journal/);

    // Advance to COMPLETED
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      lease,
    });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'SWAPPED', lease });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'COMPLETED', lease });

    // Removal with callerOwner PID mismatch
    const badPidRes = removeJournal({ repoRoot: repo, txId, lease, callerOwner: { pid: 99999 } });
    assert.equal(badPidRes.ok, false);
    assert.match(badPidRes.error, /PID mismatch/);

    // Removal of COMPLETED journal with valid lock and lease succeeds
    const removeRes = removeJournal({ repoRoot: repo, txId, lease, callerOwner: { pid: process.pid } });
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
    test('createJournal preserves state and fails closed when file write fails (pre-publication)', () => {
      const repo = createTempDir('journal-fault-write-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

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
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'pre-publication');
        assert.match(res.error, /Failed to prepare journal update before publication/);
      } finally {
        fs.chmodSync(ciPatchDir, 0o700); // restore for cleanup
      }
    });

    test('advanceJournalPhase preserves existing journal when write failure occurs', () => {
      const repo = createTempDir('journal-fault-advance-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const ciPatchDir = path.join(repo, '.ci-patch');
      fs.chmodSync(ciPatchDir, 0o500); // read-only

      try {
        const res = advanceJournalPhase({
          repoRoot: repo,
          txId,
          lease,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        });
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

    test('createJournal preserves temporary journal file if atomic link publication fails (JH2)', () => {
      const repo = createTempDir('journal-fault-link-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const originalLink = fs.linkSync;
      // Mock fs.linkSync to throw error
      fs.linkSync = () => {
        throw new Error('Simulated atomic link publication failure');
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'publication-attempted');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, null);
        assert.equal(res.uncertain, true);
        assert.match(res.error, /Simulated atomic link publication failure/);

        // Under JH2: No speculative deletion of evidence after publication was attempted and threw!
        const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.equal(fs.existsSync(tmpPath), true);
      } finally {
        fs.linkSync = originalLink;
      }
    });

    test('createJournal handles simulated fsync failure cleanly', () => {
      const repo = createTempDir('journal-fault-fsync-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

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
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'pre-publication');
        assert.match(res.error, /Simulated EIO on fsync/);
      } finally {
        fs.fsyncSync = originalFsync;
      }
    });

    test('writeJournalDurable reports stage: post-publication if directory fsync fails after publication', () => {
      const repo = createTempDir('journal-fault-post-link-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const originalFsync = fs.fsyncSync;
      let fsyncCallCount = 0;
      fs.fsyncSync = (fd) => {
        fsyncCallCount++;
        // The 1st fsync in createJournal is on the tmp file descriptor.
        // The 2nd fsync is on the directory descriptor after publication (linkSync)!
        if (fsyncCallCount >= 2) {
          throw new Error('Simulated directory fsync EIO after publication');
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
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'post-publication');
        assert.match(res.error, /directory synchronization failed/);
        // Journal was published onto disk before sync error
        assert.ok(res.journal);
        assert.equal(res.journal.phase, 'LOCKED');
      } finally {
        fs.fsyncSync = originalFsync;
      }
    });

    test('advanceJournalPhase reports stage: post-rename if directory fsync fails after phase rename', () => {
      const repo = createTempDir('journal-fault-post-rename-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const originalFsync = fs.fsyncSync;
      let fsyncCallCount = 0;
      fs.fsyncSync = (fd) => {
        fsyncCallCount++;
        // The 1st fsync in advanceJournalPhase is on the tmp file descriptor.
        // The 2nd fsync is on the directory descriptor after rename!
        if (fsyncCallCount >= 2) {
          throw new Error('Simulated directory fsync EIO after rename');
        }
        return originalFsync(fd);
      };

      try {
        const res = advanceJournalPhase({
          repoRoot: repo,
          txId,
          lease,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'post-rename');
        assert.match(res.error, /directory synchronization failed/);
        assert.ok(res.journal);
        assert.equal(res.journal.phase, 'ISOLATED_PREPARED');
      } finally {
        fs.fsyncSync = originalFsync;
      }
    });
  });

  describe('D01-P3B-2D-2-C-JH1: Temporary Journal I/O Integrity', () => {
    test('JH1-01: normal journal creation writes complete UTF-8 payload and advances to LOCKED', () => {
      const repo = createTempDir('jh1-create-normal-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, true);
      assert.ok(res.journal);
      assert.equal(res.journal.phase, 'LOCKED');

      const journalPath = path.join(repo, '.ci-patch', 'journal.json');
      const raw = fs.readFileSync(journalPath, 'utf8');
      assert.ok(raw.endsWith('\n'));
      assert.deepEqual(JSON.parse(raw), res.journal);

      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.equal(fs.existsSync(tmpPath), false);
    });

    test('JH1-02: normal phase advancement writes complete UTF-8 payload and advances phase', () => {
      const repo = createTempDir('jh1-advance-normal-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const res = advanceJournalPhase({
        repoRoot: repo,
        txId,
        lease,
        nextPhase: 'ISOLATED_PREPARED',
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      });

      assert.equal(res.ok, true);
      assert.ok(res.journal);
      assert.equal(res.journal.phase, 'ISOLATED_PREPARED');

      const journalPath = path.join(repo, '.ci-patch', 'journal.json');
      const raw = fs.readFileSync(journalPath, 'utf8');
      assert.deepEqual(JSON.parse(raw), res.journal);

      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.equal(fs.existsSync(tmpPath), false);
    });

    test('JH1-03: recovers from positive partial writes during createJournal and advanceJournalPhase', () => {
      // 1. In createJournal
      const repo1 = createTempDir('jh1-partial-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      const origWrite = fs.writeSync;
      let partialCalls1 = 0;
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string') {
          const buf = Buffer.from(data, 'utf8');
          if (buf.length > 30) {
            partialCalls1++;
            const chunk = buf.subarray(0, 30);
            return origWrite.call(fs, fd, chunk, 0, 30, 0);
          }
        } else if (Buffer.isBuffer(data) && args[1] > 30) {
          partialCalls1++;
          const chunk = Math.min(30, args[1]);
          return origWrite.call(fs, fd, data, args[0], chunk, args[2]);
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res1 = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res1.ok, true);
        assert.ok(partialCalls1 > 1, 'Expected multiple writeSync chunks');
        const raw1 = fs.readFileSync(path.join(repo1, '.ci-patch', 'journal.json'), 'utf8');
        assert.deepEqual(JSON.parse(raw1), res1.journal);
      } finally {
        fs.writeSync = origWrite;
      }

      // 2. In advanceJournalPhase
      const repo2 = createTempDir('jh1-partial-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      let partialCalls2 = 0;
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string') {
          const buf = Buffer.from(data, 'utf8');
          if (buf.length > 30) {
            partialCalls2++;
            const chunk = buf.subarray(0, 30);
            return origWrite.call(fs, fd, chunk, 0, 30, 0);
          }
        } else if (Buffer.isBuffer(data) && args[1] > 30) {
          partialCalls2++;
          const chunk = Math.min(30, args[1]);
          return origWrite.call(fs, fd, data, args[0], chunk, args[2]);
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res2.ok, true);
        assert.ok(partialCalls2 > 1, 'Expected multiple writeSync chunks');
        const raw2 = fs.readFileSync(path.join(repo2, '.ci-patch', 'journal.json'), 'utf8');
        assert.deepEqual(JSON.parse(raw2), res2.journal);
      } finally {
        fs.writeSync = origWrite;
      }
    });

    test('JH1-04: rejects zero-byte progress writes during createJournal and advanceJournalPhase', () => {
      const origWrite = fs.writeSync;

      // 1. createJournal
      const repo1 = createTempDir('jh1-zero-write-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          return 0; // zero progress!
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res1 = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res1.ok, false);
        assert.equal(res1.stage, 'pre-publication');
        assert.equal(res1.code, 'short-write');
        assert.match(res1.error, /Non-positive or invalid progress/);
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', 'journal.json')), false);
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', `.journal.${txId1}.tmp`)), false);
      } finally {
        fs.writeSync = origWrite;
      }

      // 2. advanceJournalPhase
      const repo2 = createTempDir('jh1-zero-write-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          return 0; // zero progress!
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res2.ok, false);
        assert.equal(res2.stage, 'pre-rename');
        assert.equal(res2.code, 'short-write');
        assert.match(res2.error, /Non-positive or invalid progress/);

        // Original journal unchanged in LOCKED phase
        const j = inspectJournal(repo2);
        assert.equal(j.hasJournal, true);
        assert.equal(j.journal.phase, 'LOCKED');
        assert.equal(fs.existsSync(path.join(repo2, '.ci-patch', `.journal.${txId2}.tmp`)), false);
      } finally {
        fs.writeSync = origWrite;
      }
    });

    test('JH1-05: write throws after partial progress during createJournal and advanceJournalPhase', () => {
      const origWrite = fs.writeSync;

      // 1. createJournal
      const repo1 = createTempDir('jh1-write-throw-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      let writeCount1 = 0;
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          writeCount1++;
          if (writeCount1 === 1) {
            const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            const chunk = buf.subarray(0, Math.min(40, buf.length));
            return origWrite.call(fs, fd, chunk, 0, chunk.length, 0);
          }
          const err = new Error('Simulated ENOSPC on write');
          err.code = 'ENOSPC';
          throw err;
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res1 = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res1.ok, false);
        assert.equal(res1.stage, 'pre-publication');
        assert.equal(res1.code, 'ENOSPC');
        assert.match(res1.error, /Simulated ENOSPC on write/);
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', 'journal.json')), false);
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', `.journal.${txId1}.tmp`)), false);
      } finally {
        fs.writeSync = origWrite;
      }

      // 2. advanceJournalPhase
      const repo2 = createTempDir('jh1-write-throw-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      let writeCount2 = 0;
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          writeCount2++;
          if (writeCount2 === 1) {
            const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
            const chunk = buf.subarray(0, Math.min(40, buf.length));
            return origWrite.call(fs, fd, chunk, 0, chunk.length, 0);
          }
          const err = new Error('Simulated ENOSPC on write');
          err.code = 'ENOSPC';
          throw err;
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res2.ok, false);
        assert.equal(res2.stage, 'pre-rename');
        assert.equal(res2.code, 'ENOSPC');
        assert.match(res2.error, /Simulated ENOSPC on write/);

        const j = inspectJournal(repo2);
        assert.equal(j.hasJournal, true);
        assert.equal(j.journal.phase, 'LOCKED');
        assert.equal(fs.existsSync(path.join(repo2, '.ci-patch', `.journal.${txId2}.tmp`)), false);
      } finally {
        fs.writeSync = origWrite;
      }
    });

    test('JH1-06: file fsync failure aborts createJournal and advanceJournalPhase before publication', () => {
      const origFsync = fs.fsyncSync;

      // 1. createJournal
      const repo1 = createTempDir('jh1-fsync-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      fs.fsyncSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile()) {
            const err = new Error('Simulated EIO on tmpFd fsync');
            err.code = 'EIO';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EIO') throw err;
        }
        return origFsync(fd);
      };

      try {
        const res1 = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res1.ok, false);
        assert.equal(res1.stage, 'pre-publication');
        assert.equal(res1.code, 'EIO');
        assert.match(res1.error, /Simulated EIO on tmpFd fsync/);
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', 'journal.json')), false);
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', `.journal.${txId1}.tmp`)), false);
      } finally {
        fs.fsyncSync = origFsync;
      }

      // 2. advanceJournalPhase
      const repo2 = createTempDir('jh1-fsync-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      fs.fsyncSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile()) {
            const err = new Error('Simulated EIO on tmpFd fsync');
            err.code = 'EIO';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EIO') throw err;
        }
        return origFsync(fd);
      };

      try {
        const res2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res2.ok, false);
        assert.equal(res2.stage, 'pre-rename');
        assert.equal(res2.code, 'EIO');

        const j = inspectJournal(repo2);
        assert.equal(j.hasJournal, true);
        assert.equal(j.journal.phase, 'LOCKED');
        assert.equal(fs.existsSync(path.join(repo2, '.ci-patch', `.journal.${txId2}.tmp`)), false);
      } finally {
        fs.fsyncSync = origFsync;
      }
    });

    test('JH1-07: temporary descriptor close failure before publication fails closed and preserves temp artifact', () => {
      const origClose = fs.closeSync;

      // 1. createJournal
      const repo1 = createTempDir('jh1-close-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      let closeFailed1 = false;
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && (st.mode & 0o777) === 0o600 && !closeFailed1) {
            closeFailed1 = true;
            origClose(fd); // Close in OS to prevent test process leak
            const err = new Error('Simulated EIO on tmpFd closeSync');
            err.code = 'EIO';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EIO') throw err;
        }
        return origClose(fd);
      };

      try {
        const res1 = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res1.ok, false);
        assert.equal(res1.stage, 'pre-publication');
        assert.equal(res1.descriptorCloseUncertain, true);
        assert.equal(res1.code, 'EIO');
        assert.ok(res1.closeError);
        assert.equal(res1.closeError.code, 'EIO');
        assert.equal(res1.closeError.uncertain, true);
        assert.match(res1.error, /Failed to close temporary journal descriptor before publication/);

        // Publication did NOT occur
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', 'journal.json')), false);
        // Temporary artifact is PRESERVED on disk due to uncertainty
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', `.journal.${txId1}.tmp`)), true);
      } finally {
        fs.closeSync = origClose;
      }

      // 2. advanceJournalPhase
      const repo2 = createTempDir('jh1-close-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      let closeFailed2 = false;
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && (st.mode & 0o777) === 0o600 && !closeFailed2) {
            closeFailed2 = true;
            origClose(fd);
            const err = new Error('Simulated EIO on tmpFd closeSync');
            err.code = 'EIO';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EIO') throw err;
        }
        return origClose(fd);
      };

      try {
        const res2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res2.ok, false);
        assert.equal(res2.stage, 'pre-rename');
        assert.equal(res2.descriptorCloseUncertain, true);
        assert.ok(res2.closeError);
        assert.equal(res2.code, 'EIO');
        assert.match(res2.error, /Failed to close temporary journal descriptor before rename/);

        // Original journal unchanged in LOCKED phase
        const j = inspectJournal(repo2);
        assert.equal(j.hasJournal, true);
        assert.equal(j.journal.phase, 'LOCKED');
        // Temporary artifact is PRESERVED on disk due to uncertainty
        assert.equal(fs.existsSync(path.join(repo2, '.ci-patch', `.journal.${txId2}.tmp`)), true);
      } finally {
        fs.closeSync = origClose;
      }
    });

    test('JH1-08: primary write error plus secondary close failure preserves primary error and preserves temp artifact', () => {
      const origWrite = fs.writeSync;
      const origClose = fs.closeSync;

      // 1. createJournal
      const repo1 = createTempDir('jh1-write-close-fail-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          const err = new Error('Primary write fault');
          err.code = 'EIO';
          throw err;
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      let closeFailed1 = false;
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && (st.mode & 0o777) === 0o600 && !closeFailed1) {
            closeFailed1 = true;
            origClose(fd);
            const err = new Error('Secondary close cleanup fault');
            err.code = 'EBADF';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EBADF') throw err;
        }
        return origClose(fd);
      };

      try {
        const res1 = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res1.ok, false);
        assert.equal(res1.stage, 'pre-publication');
        assert.equal(res1.code, 'EIO', 'Primary error code must be preserved');
        assert.match(res1.error, /Primary write fault/, 'Primary error message must be preserved');
        assert.equal(res1.descriptorCloseUncertain, true);
        assert.ok(res1.closeError);
        assert.equal(res1.closeError.code, 'EBADF');
        assert.match(res1.closeError.error, /Secondary close cleanup fault/);

        // Destination journal not published
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', 'journal.json')), false);
        // Temp file preserved due to cleanup uncertainty
        assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', `.journal.${txId1}.tmp`)), true);
      } finally {
        fs.writeSync = origWrite;
        fs.closeSync = origClose;
      }

      // 2. advanceJournalPhase
      const repo2 = createTempDir('jh1-write-close-fail-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          const err = new Error('Primary write fault');
          err.code = 'EIO';
          throw err;
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      let closeFailed2 = false;
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && (st.mode & 0o777) === 0o600 && !closeFailed2) {
            closeFailed2 = true;
            origClose(fd);
            const err = new Error('Secondary close cleanup fault');
            err.code = 'EBADF';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EBADF') throw err;
        }
        return origClose(fd);
      };

      try {
        const res2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res2.ok, false);
        assert.equal(res2.stage, 'pre-rename');
        assert.equal(res2.code, 'EIO', 'Primary error code must be preserved');
        assert.match(res2.error, /Primary write fault/);
        assert.equal(res2.descriptorCloseUncertain, true);
        assert.ok(res2.closeError);
        assert.equal(res2.closeError.code, 'EBADF');

        // Original journal intact in LOCKED phase
        const j = inspectJournal(repo2);
        assert.equal(j.hasJournal, true);
        assert.equal(j.journal.phase, 'LOCKED');
        // Temp file preserved due to cleanup uncertainty
        assert.equal(fs.existsSync(path.join(repo2, '.ci-patch', `.journal.${txId2}.tmp`)), true);
      } finally {
        fs.writeSync = origWrite;
        fs.closeSync = origClose;
      }
    });

    test('JH1-09: pre-existing temporary artifact collision preserves pre-existing file in create and advance', () => {
      // 1. createJournal
      const repo1 = createTempDir('jh1-collision-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      const tmpPath1 = path.join(repo1, '.ci-patch', `.journal.${txId1}.tmp`);
      fs.writeFileSync(tmpPath1, 'colliding-create-data\n', { mode: 0o600 });

      const res1 = createJournal({
        repoRoot: repo1,
        txId: txId1,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease1,
      });

      assert.equal(res1.ok, false);
      assert.equal(res1.stage, 'pre-publication');
      assert.equal(res1.code, 'EEXIST');
      assert.match(res1.error, /pre-existing temporary artifact.*already exists \(collision\)/);
      assert.equal(fs.readFileSync(tmpPath1, 'utf8'), 'colliding-create-data\n');
      assert.equal(fs.existsSync(path.join(repo1, '.ci-patch', 'journal.json')), false);

      // 2. advanceJournalPhase
      const repo2 = createTempDir('jh1-collision-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      const tmpPath2 = path.join(repo2, '.ci-patch', `.journal.${txId2}.tmp`);
      fs.writeFileSync(tmpPath2, 'colliding-advance-data\n', { mode: 0o600 });

      const res2 = advanceJournalPhase({
        repoRoot: repo2,
        txId: txId2,
        lease: lease2,
        nextPhase: 'ISOLATED_PREPARED',
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
      });

      assert.equal(res2.ok, false);
      assert.equal(res2.stage, 'pre-rename');
      assert.equal(res2.code, 'EEXIST');
      assert.match(res2.error, /pre-existing temporary artifact.*already exists \(collision\)/);
      assert.equal(fs.readFileSync(tmpPath2, 'utf8'), 'colliding-advance-data\n');

      const j = inspectJournal(repo2);
      assert.equal(j.hasJournal, true);
      assert.equal(j.journal.phase, 'LOCKED');
    });

    test('JH1-10: safeUnlinkCreatedFile enforces positive device/inode identity and rejects foreign or symlink files', () => {
      const dir = createTempDir('jh1-safe-unlink-');
      const filePath = path.join(dir, 'target.tmp');
      fs.writeFileSync(filePath, 'safe-unlink-payload\n');
      const st = fs.lstatSync(filePath);

      // 1. Invalid dev / ino
      assert.equal(safeUnlinkCreatedFile(filePath, null, st.ino), false);
      assert.equal(safeUnlinkCreatedFile(filePath, st.dev, null), false);
      assert.equal(safeUnlinkCreatedFile(filePath, -1, st.ino), false);
      assert.equal(safeUnlinkCreatedFile(filePath, st.dev, 0), false);
      assert.equal(safeUnlinkCreatedFile(filePath, st.dev, -5), false);
      assert.equal(fs.existsSync(filePath), true);

      // 2. Mismatched dev / ino
      const fakeDev = typeof st.dev === 'bigint' ? st.dev + 999999n : st.dev + 999999;
      const fakeIno = typeof st.ino === 'bigint' ? st.ino + 999999n : st.ino + 999999;
      assert.equal(safeUnlinkCreatedFile(filePath, fakeDev, st.ino), false);
      assert.equal(safeUnlinkCreatedFile(filePath, st.dev, fakeIno), false);
      assert.equal(fs.existsSync(filePath), true);

      // 3. Symlink target
      const symPath = path.join(dir, 'target-sym.tmp');
      fs.symlinkSync(filePath, symPath);
      assert.equal(safeUnlinkCreatedFile(symPath, st.dev, st.ino), false);
      assert.equal(fs.existsSync(symPath), true);
      fs.unlinkSync(symPath);

      // 4. Exact dev & ino match
      assert.equal(safeUnlinkCreatedFile(filePath, st.dev, st.ino), true);
      assert.equal(fs.existsSync(filePath), false);
    });

    test('JH1-11: no journal publication occurs after incomplete write or write failure', () => {
      const origLink = fs.linkSync;
      const origRename = fs.renameSync;
      const origWrite = fs.writeSync;

      let linkCalled = false;
      let renameCalled = false;

      fs.linkSync = (...args) => {
        linkCalled = true;
        return origLink.apply(fs, args);
      };
      fs.renameSync = (...args) => {
        renameCalled = true;
        return origRename.apply(fs, args);
      };

      // 1. Create with short write
      const repo1 = createTempDir('jh1-no-pub-write-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          return 0; // zero progress
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res.ok, false);
        assert.equal(linkCalled, false, 'linkSync must never be called after write failure');
      } finally {
        fs.writeSync = origWrite;
        fs.linkSync = origLink;
        fs.renameSync = origRename;
      }

      // 2. Advance with write throw
      const repo2 = createTempDir('jh1-no-pub-write-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      fs.linkSync = (...args) => {
        linkCalled = true;
        return origLink.apply(fs, args);
      };
      fs.renameSync = (...args) => {
        renameCalled = true;
        return origRename.apply(fs, args);
      };

      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          throw new Error('EIO on write');
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        const res = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res.ok, false);
        assert.equal(renameCalled, false, 'renameSync must never be called after write failure');
      } finally {
        fs.writeSync = origWrite;
        fs.linkSync = origLink;
        fs.renameSync = origRename;
      }
    });

    test('JH1-12: no journal publication occurs after uncertain temporary descriptor close', () => {
      const origLink = fs.linkSync;
      const origRename = fs.renameSync;
      const origClose = fs.closeSync;

      let linkCalled = false;
      let renameCalled = false;

      fs.linkSync = (...args) => {
        linkCalled = true;
        return origLink.apply(fs, args);
      };
      fs.renameSync = (...args) => {
        renameCalled = true;
        return origRename.apply(fs, args);
      };

      // 1. Create with close throw
      const repo1 = createTempDir('jh1-no-pub-close-create-');
      const txId1 = generateTxId();
      const { lease: lease1 } = acquireLock({ repoRoot: repo1, txId: txId1, op: 'apply' });

      let closeFailed1 = false;
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && (st.mode & 0o777) === 0o600 && !closeFailed1) {
            closeFailed1 = true;
            origClose(fd);
            const err = new Error('EIO on close');
            err.code = 'EIO';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EIO') throw err;
        }
        return origClose(fd);
      };

      try {
        const res = createJournal({
          repoRoot: repo1,
          txId: txId1,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease1,
        });

        assert.equal(res.ok, false);
        assert.equal(linkCalled, false, 'linkSync must never be called after close failure');
      } finally {
        fs.closeSync = origClose;
        fs.linkSync = origLink;
        fs.renameSync = origRename;
      }

      // 2. Advance with close throw
      const repo2 = createTempDir('jh1-no-pub-close-advance-');
      const txId2 = generateTxId();
      const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

      createJournal({
        repoRoot: repo2,
        txId: txId2,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: lease2,
      });

      let closeFailed2 = false;
      fs.closeSync = (fd) => {
        try {
          const st = fs.fstatSync(fd);
          if (st.isFile() && (st.mode & 0o777) === 0o600 && !closeFailed2) {
            closeFailed2 = true;
            origClose(fd);
            const err = new Error('EIO on close');
            err.code = 'EIO';
            throw err;
          }
        } catch (err) {
          if (err.code === 'EIO') throw err;
        }
        return origClose(fd);
      };

      try {
        const res = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          lease: lease2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js` },
        });

        assert.equal(res.ok, false);
        assert.equal(renameCalled, false, 'renameSync must never be called after close failure');
      } finally {
        fs.closeSync = origClose;
        fs.linkSync = origLink;
        fs.renameSync = origRename;
      }
    });

    test('JH1-13: original journal is preserved 100% identically when advancement preparation fails', () => {
      const repo = createTempDir('jh1-preserve-orig-advance-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const journalPath = path.join(repo, '.ci-patch', 'journal.json');
      const beforeContent = fs.readFileSync(journalPath, 'utf8');
      const beforeStat = fs.lstatSync(journalPath);

      // Trigger write failure
      const origWrite = fs.writeSync;
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string' || Buffer.isBuffer(data)) {
          throw new Error('EIO on write');
        }
        return origWrite.call(fs, fd, data, ...args);
      };

      try {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          lease,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        });
      } finally {
        fs.writeSync = origWrite;
      }

      const afterContent = fs.readFileSync(journalPath, 'utf8');
      const afterStat = fs.lstatSync(journalPath);

      assert.equal(afterContent, beforeContent);
      assert.equal(afterStat.ino, beforeStat.ino);
      assert.equal(afterStat.size, beforeStat.size);
      assert.equal(afterStat.mode, beforeStat.mode);
    });

    test('JH1-14: zero descriptor leaks across normal execution, partial writes, and failures', () => {
      const openedFds = new Set();
      const closedFds = new Set();
      const origOpen = fs.openSync;
      const origClose = fs.closeSync;

      fs.openSync = (...args) => {
        const fd = origOpen.apply(fs, args);
        openedFds.add(fd);
        return fd;
      };
      fs.closeSync = (fd) => {
        closedFds.add(fd);
        return origClose.apply(fs, [fd]);
      };

      try {
        const repo = createTempDir('jh1-fd-leaks-');
        const txId = generateTxId();
        const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

        // Normal create
        createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        // Normal advance
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          lease,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        });

        const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
        assert.equal(unclosed.length, 0, `All descriptors must be closed; leaked: ${unclosed.join(', ')}`);
      } finally {
        fs.openSync = origOpen;
        fs.closeSync = origClose;
      }
    });

    test('JH1-15: child process isolation for genuine uncertain kernel close failure', () => {
      const repo = createTempDir('jh1-child-close-fail-');
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import assert from 'node:assert/strict';
        import { acquireLock, generateTxId } from './src/patch-installer/lock.js';
        import { createJournal, advanceJournalPhase, inspectJournal } from './src/patch-installer/journal.js';

        const repo = ${JSON.stringify(repo)};
        const txId = generateTxId();
        const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

        fs.closeSync = (fd) => {
          // Strictly simulate kernel close failure: throw WITHOUT calling origClose
          const err = new Error('simulated kernel close failure on tmpFd');
          err.code = 'EIO';
          throw err;
        };

        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43',
          expectedResultSha256: '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6',
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'pre-publication');
        assert.equal(res.descriptorCloseUncertain, true);
        assert.ok(res.closeError);
        assert.equal(res.closeError.code, 'EIO');

        // Confirm publication did not occur
        const journalPath = path.join(repo, '.ci-patch', 'journal.json');
        assert.equal(fs.existsSync(journalPath), false);

        // Confirm temporary artifact was preserved
        const tmpPath = path.join(repo, '.ci-patch', '.journal.' + txId + '.tmp');
        assert.equal(fs.existsSync(tmpPath), true);
      `;

      child_process.execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });
  });

  describe('D01-P3B-2D-2-C-JH2: Journal Publication, Durability and Uncertainty Hardening', () => {
    const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
    const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

    test('JH2-01: normal journal creation and phase advancement lifecycle with full outcome schema', () => {
      const repo = createTempDir('jh2-01-normal-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // 1. Initial creation
      const createRes = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(createRes.ok, true);
      assert.equal(createRes.stage, 'post-publication');
      assert.equal(createRes.publicationAttempted, true);
      assert.equal(createRes.publicationConfirmed, true);
      assert.equal(createRes.directoryFsyncAttempted, true);
      assert.equal(createRes.directoryFsyncConfirmed, true);
      assert.equal(createRes.uncertain, false);
      assert.equal(createRes.observedJournalPhase, 'LOCKED');
      assert.equal(createRes.journal?.phase, 'LOCKED');

      // Temporary link unlinked
      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.equal(fs.existsSync(tmpPath), false);

      // Inspect state
      const state1 = inspectTransactionState(repo);
      assert.equal(state1.state, 'ownership-unverified');
      assert.equal(state1.isPending, true);

      // 2. Phase advancement
      const advRes = advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'ISOLATED_PREPARED',
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        lease,
      });

      assert.equal(advRes.ok, true);
      assert.equal(advRes.stage, 'post-rename');
      assert.equal(advRes.publicationAttempted, true);
      assert.equal(advRes.publicationConfirmed, true);
      assert.equal(advRes.directoryFsyncAttempted, true);
      assert.equal(advRes.directoryFsyncConfirmed, true);
      assert.equal(advRes.uncertain, false);
      assert.equal(advRes.observedJournalPhase, 'ISOLATED_PREPARED');
      assert.equal(advRes.journal?.phase, 'ISOLATED_PREPARED');

      const insp = inspectJournal(repo);
      assert.equal(insp.hasJournal, true);
      assert.equal(insp.isValid, true);
      assert.equal(insp.journal.phase, 'ISOLATED_PREPARED');
    });

    test('JH2-02: descriptor-anchored initial publication uses procfs paths for linkSync', () => {
      const repo = createTempDir('jh2-02-anchored-link-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      let capturedSrc = null;
      let capturedDst = null;
      const origLinkSync = fs.linkSync;
      fs.linkSync = (src, dst) => {
        capturedSrc = src;
        capturedDst = dst;
        return origLinkSync(src, dst);
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(res.ok, true);
        assert.ok(capturedSrc, 'linkSync must be called');
        assert.match(capturedSrc, /^\/proc\/self\/fd\/\d+\/\.journal\..+\.tmp$/);
        assert.match(capturedDst, /^\/proc\/self\/fd\/\d+\/journal\.json$/);
      } finally {
        fs.linkSync = origLinkSync;
      }
    });

    test('JH2-03: descriptor-anchored phase replacement uses procfs paths for renameSync', () => {
      const repo = createTempDir('jh2-03-anchored-rename-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      let capturedSrc = null;
      let capturedDst = null;
      const origRenameSync = fs.renameSync;
      fs.renameSync = (src, dst) => {
        if (typeof src === 'string' && src.includes(`.journal.${txId}.tmp`)) {
          capturedSrc = src;
          capturedDst = dst;
        }
        return origRenameSync(src, dst);
      };

      try {
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
          lease,
        });

        assert.equal(advRes.ok, true);
        assert.ok(capturedSrc, 'renameSync must be called with procfs path');
        assert.match(capturedSrc, /^\/proc\/self\/fd\/\d+\/\.journal\..+\.tmp$/);
        assert.match(capturedDst, /^\/proc\/self\/fd\/\d+\/journal\.json$/);
      } finally {
        fs.renameSync = origRenameSync;
      }
    });

    test('JH2-04: unsupported O_DIRECTORY or O_NOFOLLOW capability fails closed before publication', async () => {
      const repo = createTempDir('jh2-04-platform-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // 1. Caller-supplied constants and procDir overrides are strictly IGNORED by production
      const resIgnored = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
        options: {
          constants: { ...fs.constants, O_DIRECTORY: 0 },
          procDir: '/fake/proc/dir',
        },
      });
      assert.equal(resIgnored.ok, true);
      assert.equal(resIgnored.stage, 'post-publication');

      // 2. Test genuine missing capabilities via test-isolated instrumented modules
      const testUnsupportedConstant = async (constantOverride) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh2-04-inst-'));
        try {
          const srcDir = path.resolve('src/patch-installer');
          for (const f of fs.readdirSync(srcDir)) {
            fs.symlinkSync(path.join(srcDir, f), path.join(tmpDir, f));
          }
          fs.unlinkSync(path.join(tmpDir, 'journal.js'));
          const src = fs.readFileSync(path.join(srcDir, 'journal.js'), 'utf8');
          const instrumented = src.replace(
            'const constants = fs.constants;',
            `const constants = { ...fs.constants, ${constantOverride} };`
          );
          fs.writeFileSync(path.join(tmpDir, 'journal.js'), instrumented);

          const mod = await import(pathToFileURL(path.join(tmpDir, 'journal.js')).href + `?t=${Date.now()}_${Math.random()}`);
          const testRepo = createTempDir('jh2-04-sub-');
          const testTxId = generateTxId();
          const { lease: testLease } = acquireLock({ repoRoot: testRepo, txId: testTxId, op: 'apply' });

          const res = mod.createJournal({
            repoRoot: testRepo,
            txId: testTxId,
            op: 'apply',
            targetFile: 'src/endpoints/stable-diffusion.js',
            expectedInitialSha256: stockSha,
            expectedResultSha256: patchedSha,
            lease: testLease,
          });

          assert.equal(res.ok, false);
          assert.equal(res.code, 'unsupported-platform');
          assert.equal(res.publicationAttempted, false);
          assert.equal(res.publicationConfirmed, false);
          assert.equal(res.uncertain, false);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      };

      await testUnsupportedConstant('O_DIRECTORY: 0');
      await testUnsupportedConstant('O_NOFOLLOW: -1');
      await testUnsupportedConstant('O_RDONLY: -1');
    });

    test('JH2-05: symlink substitution of .ci-patch fails closed and is classified as unsafe-symlink', () => {
      const repo = createTempDir('jh2-05-symlink-ci-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // Substitute .ci-patch with a symlink to another directory
      const targetDir = createTempDir('jh2-05-target-');
      fs.rmSync(path.join(repo, '.ci-patch'), { recursive: true, force: true });
      fs.symlinkSync(targetDir, path.join(repo, '.ci-patch'));

      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'ci-patch-symlink');
      assert.equal(res.publicationAttempted, false);
      assert.equal(res.publicationConfirmed, false);
      assert.equal(res.uncertain, false);

      const txState = inspectTransactionState(repo);
      assert.equal(txState.state, 'unsafe-symlink');
      assert.equal(txState.isPending, true);
    });

    test('JH2-06: directory inode replacement before publication refuses publication', () => {
      const repo = createTempDir('jh2-06-dir-replace-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const faultHook = (hookStage) => {
        if (hookStage === 'before-publication') {
          // Replace .ci-patch directory on disk
          const ciPatch = path.join(repo, '.ci-patch');
          const displaced = path.join(repo, '.ci-patch-displaced');
          fs.renameSync(ciPatch, displaced);
          fs.mkdirSync(ciPatch, { mode: 0o700 });
        }
      };

      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
        options: { faultHook },
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'directory-identity-mismatch');
      assert.equal(res.stage, 'pre-publication');
      assert.equal(res.publicationAttempted, false);
      assert.equal(res.publicationConfirmed, false);
      assert.equal(res.uncertain, false);
    });

    test('JH2-07: directory pathname replacement after publication reports uncertainty and preserves confirmed evidence', () => {
      const repo = createTempDir('jh2-07-dir-post-replace-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const faultHook = (hookStage) => {
        if (hookStage === 'after-directory-fsync') {
          // Displace .ci-patch directory after renameSync and fsyncSync have succeeded
          const ciPatch = path.join(repo, '.ci-patch');
          const displaced = path.join(repo, '.ci-patch-displaced');
          fs.renameSync(ciPatch, displaced);
          fs.mkdirSync(ciPatch, { mode: 0o700 });
        }
      };

      const advRes = advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'ISOLATED_PREPARED',
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        lease,
        options: { faultHook },
      });

      assert.equal(advRes.ok, false);
      assert.equal(advRes.stage, 'post-rename');
      assert.equal(advRes.code, 'directory-identity-mismatch');
      assert.equal(advRes.publicationAttempted, true);
      assert.equal(advRes.publicationConfirmed, true);
      assert.equal(advRes.directoryFsyncAttempted, true);
      assert.equal(advRes.directoryFsyncConfirmed, true); // Preserved confirmed evidence!
      assert.equal(advRes.uncertain, true);
    });

    test('JH2-08: publication syscall throws before performing operation reports publicationConfirmed: null and preserves evidence', () => {
      const repo = createTempDir('jh2-08-throw-before-op-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const origRenameSync = fs.renameSync;
      fs.renameSync = (src, dst) => {
        if (typeof src === 'string' && src.includes(`.journal.${txId}.tmp`)) {
          const err = new Error('Simulated publication syscall failure before operation');
          err.code = 'EIO';
          throw err;
        }
        return origRenameSync(src, dst);
      };

      try {
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
          lease,
        });

        assert.equal(advRes.ok, false);
        assert.equal(advRes.stage, 'rename-attempted');
        assert.equal(advRes.code, 'EIO');
        assert.equal(advRes.publicationAttempted, true);
        assert.equal(advRes.publicationConfirmed, null);
        assert.equal(advRes.directoryFsyncAttempted, false);
        assert.equal(advRes.directoryFsyncConfirmed, false);
        assert.equal(advRes.uncertain, true);
        assert.equal(advRes.observedJournalPhase, 'LOCKED');

        // Evidence preserved: temporary journal file is NOT deleted
        const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.equal(fs.existsSync(tmpPath), true);

        // Crash-state classification: orphaned-artifact due to unmerged temp journal alongside LOCKED journal
        const state = inspectTransactionState(repo);
        assert.equal(state.state, 'orphaned-artifact');
        assert.equal(state.isPending, true);
      } finally {
        fs.renameSync = origRenameSync;
      }
    });

    test('JH2-09: publication syscall performs operation then wrapper throws reports publicationConfirmed: null despite observable bytes', () => {
      const repo = createTempDir('jh2-09-throw-after-op-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const origRenameSync = fs.renameSync;
      fs.renameSync = (src, dst) => {
        if (typeof src === 'string' && src.includes(`.journal.${txId}.tmp`)) {
          origRenameSync(src, dst); // Operates on disk successfully!
          const err = new Error('Simulated process interruption immediately after rename execution');
          err.code = 'EIO';
          throw err;
        }
        return origRenameSync(src, dst);
      };

      try {
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
          lease,
        });

        assert.equal(advRes.ok, false);
        assert.equal(advRes.stage, 'rename-attempted');
        assert.equal(advRes.code, 'EIO');
        assert.equal(advRes.publicationAttempted, true);
        // Requirement: publicationConfirmed MUST be null when syscall threw, even if bytes are visible on disk!
        assert.equal(advRes.publicationConfirmed, null);
        assert.equal(advRes.uncertain, true);
        // Observable journal phase reflects bytes visible on disk
        assert.equal(advRes.observedJournalPhase, 'ISOLATED_PREPARED');
      } finally {
        fs.renameSync = origRenameSync;
      }
    });

    test('JH2-10: journal rename attempted with unknown outcome preserves temporary file without deletion', () => {
      const repo = createTempDir('jh2-10-rename-unknown-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      const origRenameSync = fs.renameSync;
      fs.renameSync = (src, dst) => {
        if (typeof src === 'string' && src.includes(`.journal.${txId}.tmp`)) {
          const err = new Error('Unknown outcome during rename');
          err.code = 'EBUSY';
          throw err;
        }
        return origRenameSync(src, dst);
      };

      try {
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
          lease,
        });

        assert.equal(advRes.ok, false);
        assert.equal(advRes.publicationAttempted, true);
        assert.equal(advRes.publicationConfirmed, null);
        assert.equal(advRes.uncertain, true);
        assert.equal(advRes.code, 'EBUSY');

        // Verify temp file preserved
        const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.equal(fs.existsSync(tmpPath), true);
      } finally {
        fs.renameSync = origRenameSync;
      }
    });

    test('JH2-11: initial hard-link publication attempted with unknown outcome preserves temporary file without deletion', () => {
      const repo = createTempDir('jh2-11-link-unknown-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const origLinkSync = fs.linkSync;
      fs.linkSync = (src, dst) => {
        const err = new Error('Unknown outcome during initial linkSync');
        err.code = 'EIO';
        throw err;
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'publication-attempted');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, null);
        assert.equal(res.directoryFsyncAttempted, false);
        assert.equal(res.directoryFsyncConfirmed, false);
        assert.equal(res.uncertain, true);
        assert.equal(res.code, 'EIO');

        // Verify temp file preserved
        const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.equal(fs.existsSync(tmpPath), true);
        // Verify journal was NOT published
        assert.equal(fs.existsSync(path.join(repo, '.ci-patch', 'journal.json')), false);

        // Crash-state classification: orphaned-artifact
        const state = inspectTransactionState(repo);
        assert.equal(state.state, 'orphaned-artifact');
        assert.equal(state.isPending, true);
      } finally {
        fs.linkSync = origLinkSync;
      }
    });

    test('JH2-12: directory fsync failure after confirmed publication reports uncertainty with confirmed publication', () => {
      const repo = createTempDir('jh2-12-fsync-fail-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      // Hook after publication to cause fsync to fail
      let interceptFsync = false;
      const faultHook = (hookStage) => {
        if (hookStage === 'after-publication') {
          interceptFsync = true;
        }
      };

      const origFsyncSync = fs.fsyncSync;
      fs.fsyncSync = (fd) => {
        if (interceptFsync) {
          interceptFsync = false;
          const err = new Error('Simulated directory fsync failure');
          err.code = 'EIO';
          throw err;
        }
        return origFsyncSync(fd);
      };

      try {
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
          lease,
          options: { faultHook },
        });

        assert.equal(advRes.ok, false);
        assert.equal(advRes.stage, 'post-rename');
        assert.equal(advRes.publicationAttempted, true);
        assert.equal(advRes.publicationConfirmed, true);
        assert.equal(advRes.directoryFsyncAttempted, true);
        assert.equal(advRes.directoryFsyncConfirmed, false);
        assert.equal(advRes.uncertain, true);
        assert.equal(advRes.code, 'EIO');
        assert.equal(advRes.observedJournalPhase, 'ISOLATED_PREPARED');
      } finally {
        fs.fsyncSync = origFsyncSync;
      }
    });

    test('JH2-13: directory descriptor close failure after successful fsync reports descriptorCloseUncertain and preserves fsync evidence', () => {
      // Run in child process to isolate kernel closeSync failure and prevent descriptor leak in test runner
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import os from 'node:os';
        import assert from 'node:assert/strict';
        import { acquireLock, generateTxId } from './src/patch-installer/lock.js';
        import { createJournal } from './src/patch-installer/journal.js';

        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jh2-13-proc-'));
        const txId = generateTxId();
        const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

        // Let closeSync fail for the directory descriptor at before-close
        let interceptClose = false;
        const faultHook = (hookStage) => {
          if (hookStage === 'before-close') {
            interceptClose = true;
          }
        };

        const origCloseSync = fs.closeSync;
        fs.closeSync = (fd) => {
          if (interceptClose) {
            interceptClose = false;
            const err = new Error('Simulated directory descriptor close failure');
            err.code = 'EIO';
            throw err;
          }
          return origCloseSync(fd);
        };

        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43',
          expectedResultSha256: '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6',
          lease,
          options: { faultHook },
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'post-publication');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, true);
        assert.equal(res.directoryFsyncAttempted, true);
        assert.equal(res.directoryFsyncConfirmed, true);
        assert.equal(res.uncertain, true);
        assert.equal(res.descriptorCloseUncertain, true);
        assert.ok(res.closeError);
        assert.equal(res.closeError.code, 'EIO');
      `;

      child_process.execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });

    test('JH2-14: primary publication error with secondary close failure preserves primary error and attaches closeError', () => {
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import os from 'node:os';
        import assert from 'node:assert/strict';
        import { acquireLock, generateTxId } from './src/patch-installer/lock.js';
        import { createJournal } from './src/patch-installer/journal.js';

        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jh2-14-proc-'));
        const txId = generateTxId();
        const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

        // Primary error: linkSync fails with EACCES
        let linkAttempted = false;
        const origLinkSync = fs.linkSync;
        fs.linkSync = () => {
          linkAttempted = true;
          const err = new Error('Permission denied on publication');
          err.code = 'EACCES';
          throw err;
        };

        // Secondary error: closeSync fails with EIO on directory descriptor
        const origCloseSync = fs.closeSync;
        fs.closeSync = (fd) => {
          if (linkAttempted) {
            const err = new Error('Secondary close failure');
            err.code = 'EIO';
            throw err;
          }
          return origCloseSync(fd);
        };

        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43',
          expectedResultSha256: '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6',
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.code, 'EACCES'); // Primary error preserved!
        assert.match(res.error, /Permission denied on publication/);
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, null);
        assert.equal(res.uncertain, true);
        assert.equal(res.descriptorCloseUncertain, true);
        assert.ok(res.closeError);
        assert.equal(res.closeError.code, 'EIO'); // Secondary close error attached!
      `;

      child_process.execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });

    test('JH2-15: temporary artifact collision preserves pre-existing colliding artifact untouched', () => {
      const repo = createTempDir('jh2-15-collision-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // Pre-create colliding artifact
      const collidingPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      fs.writeFileSync(collidingPath, 'colliding-unrelated-payload', { mode: 0o600 });

      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'EEXIST');
      assert.equal(res.publicationAttempted, false);
      assert.equal(res.publicationConfirmed, false);
      assert.equal(res.uncertain, false);

      // Colliding file remains completely untouched
      assert.equal(fs.readFileSync(collidingPath, 'utf8'), 'colliding-unrelated-payload');
    });

    test('JH2-16: no speculative cleanup after ambiguous publication preserves evidence', () => {
      const repo = createTempDir('jh2-16-no-spec-del-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      let unlinkedPaths = [];
      const origUnlinkSync = fs.unlinkSync;
      fs.unlinkSync = (p) => {
        unlinkedPaths.push(p);
        return origUnlinkSync(p);
      };

      const origRenameSync = fs.renameSync;
      fs.renameSync = (src, dst) => {
        if (typeof src === 'string' && src.includes(`.journal.${txId}.tmp`)) {
          const err = new Error('Ambiguous rename error');
          err.code = 'EIO';
          throw err;
        }
        return origRenameSync(src, dst);
      };

      try {
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
          lease,
        });

        assert.equal(advRes.ok, false);
        assert.equal(advRes.uncertain, true);

        // Crucial requirement: No unlinkSync was attempted on the temporary artifact
        assert.equal(
          unlinkedPaths.some((p) => String(p).includes(`.journal.${txId}.tmp`)),
          false,
          'Must not attempt speculative deletion of evidence after ambiguous rename'
        );

        // Temp file remains on disk
        const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.equal(fs.existsSync(tmpPath), true);
      } finally {
        fs.unlinkSync = origUnlinkSync;
        fs.renameSync = origRenameSync;
      }
    });

    test('JH2-17: initial hard-link cleanup failure reports post-publication uncertainty with confirmed publication', () => {
      const repo = createTempDir('jh2-17-cleanup-fail-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // In createJournal, linkSync succeeds, initial fsync succeeds, but safeUnlinkCreatedFile throws
      const origUnlinkSync = fs.unlinkSync;
      fs.unlinkSync = (p) => {
        if (typeof p === 'string' && p.includes(`.journal.${txId}.tmp`)) {
          const err = new Error('Simulated unlink failure during temporary link cleanup');
          err.code = 'EPERM';
          throw err;
        }
        return origUnlinkSync(p);
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'post-publication');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, true);
        assert.equal(res.directoryFsyncAttempted, true);
        assert.equal(res.directoryFsyncConfirmed, true);
        assert.equal(res.uncertain, true);
        assert.equal(res.code, 'cleanup-failed');
        assert.match(res.error, /removing temporary link failed/);
        assert.equal(res.observedJournalPhase, 'LOCKED');
      } finally {
        fs.unlinkSync = origUnlinkSync;
      }
    });

    test('JH2-18: post-cleanup directory fsync failure reports post-publication uncertainty with confirmed publication', () => {
      const repo = createTempDir('jh2-18-post-sync-fail-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // In createJournal, first directory fsync succeeds, link cleanup succeeds, but second fsync throws
      let syncCount = 0;
      const origFsyncSync = fs.fsyncSync;
      fs.fsyncSync = (fd) => {
        syncCount++;
        // The first fsync is for the temporary file (tmpFd).
        // The second fsync is the first directory sync (dirFd).
        // The third fsync is the second directory sync (post-cleanup).
        if (syncCount === 3) {
          const err = new Error('Simulated post-cleanup directory fsync failure');
          err.code = 'EIO';
          throw err;
        }
        return origFsyncSync(fd);
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'post-publication');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, true);
        assert.equal(res.directoryFsyncAttempted, true);
        assert.equal(res.directoryFsyncConfirmed, true); // First dir fsync was confirmed!
        assert.equal(res.uncertain, true);
        assert.equal(res.code, 'EIO');
        assert.match(res.error, /post-cleanup directory synchronization failed/);
        assert.equal(res.observedJournalPhase, 'LOCKED');
      } finally {
        fs.fsyncSync = origFsyncSync;
      }
    });

    test('JH2-19: read-only inspectJournal observations never invent provenance or phase', () => {
      const repo = createTempDir('jh2-19-inspect-');

      // 1. Missing .ci-patch
      const insp1 = inspectJournal(repo);
      assert.equal(insp1.hasJournal, false);
      assert.equal(insp1.isValid, true);
      assert.equal(insp1.journal, null);

      // 2. Corrupted JSON journal
      fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.ci-patch', 'journal.json'), '{ invalid json ...', 'utf8');
      const insp2 = inspectJournal(repo);
      assert.equal(insp2.hasJournal, true);
      assert.equal(insp2.isValid, false);
      assert.equal(insp2.journal, null);
      assert.ok(insp2.errors.some((e) => e.includes('invalid JSON')));

      // 3. Symlink journal
      fs.unlinkSync(path.join(repo, '.ci-patch', 'journal.json'));
      const outsideFile = path.join(repo, 'outside.json');
      fs.writeFileSync(outsideFile, '{"phase":"LOCKED"}', 'utf8');
      fs.symlinkSync(outsideFile, path.join(repo, '.ci-patch', 'journal.json'));
      const insp3 = inspectJournal(repo);
      assert.equal(insp3.hasJournal, true);
      assert.equal(insp3.isValid, false);
      assert.equal(insp3.isSymlink, true);
      assert.equal(insp3.journal, null);
      assert.ok(insp3.errors.some((e) => e.includes('symbolic link')));

      // 4. Directory journal
      fs.unlinkSync(path.join(repo, '.ci-patch', 'journal.json'));
      fs.mkdirSync(path.join(repo, '.ci-patch', 'journal.json'));
      const insp4 = inspectJournal(repo);
      assert.equal(insp4.hasJournal, true);
      assert.equal(insp4.isValid, false);
      assert.equal(insp4.journal, null);
      assert.ok(insp4.errors.some((e) => e.includes('not a regular file')));

      // In none of these corrupted/invalid cases is a fake phase invented!
    });

    test('JH2-20: crash-state interpretation compares syscall outcomes, observed bytes, and inspectTransactionState', () => {
      // Scenario A: Ambiguous publication failure on initial creation
      const repoA = createTempDir('jh2-20-state-a-');
      const txIdA = generateTxId();
      const { lease: leaseA } = acquireLock({ repoRoot: repoA, txId: txIdA, op: 'apply' });

      const origLinkSync = fs.linkSync;
      fs.linkSync = () => {
        const err = new Error('Link interrupted');
        err.code = 'EIO';
        throw err;
      };

      try {
        const resA = createJournal({
          repoRoot: repoA,
          txId: txIdA,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: leaseA,
        });

        assert.equal(resA.ok, false);
        assert.equal(resA.publicationConfirmed, null);
        assert.equal(resA.uncertain, true);

        // inspectTransactionState reports orphaned-artifact due to leftover temp journal without valid journal
        const stateA = inspectTransactionState(repoA);
        assert.equal(stateA.state, 'orphaned-artifact');
        assert.equal(stateA.isPending, true);
      } finally {
        fs.linkSync = origLinkSync;
      }

      // Scenario B: Incomplete transaction when journal is LOCKED without staging
      const repoB = createTempDir('jh2-20-state-b-');
      const txIdB = generateTxId();
      const { lease: leaseB } = acquireLock({ repoRoot: repoB, txId: txIdB, op: 'apply' });

      createJournal({
        repoRoot: repoB,
        txId: txIdB,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease: leaseB,
      });

      const stateB = inspectTransactionState(repoB);
      assert.equal(stateB.state, 'ownership-unverified');
      assert.equal(stateB.isPending, true);
    });

    test('JH2-22: genuine multibyte UTF-8 partial-write boundary regression across chunk boundaries', () => {
      const repo = createTempDir('jh2-22-multibyte-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      // Create journal with multibyte UTF-8 sequences in metadata/messages (e.g. 4-byte emojis and 3-byte characters: 🎯, 🎨, 🛡️, 日本語)
      const specialString = '🎨 Multibyte UTF-8 Test — 日本語 & 🛡️ 🎯';

      const origWriteSync = fs.writeSync;
      let splitBoundaryHit = false;

      // Mock writeSync so that if a write is called, it splits at an offset that cuts across a multibyte character
      fs.writeSync = (fd, data, ...args) => {
        if (typeof data === 'string') {
          const buf = Buffer.from(data, 'utf8');
          // Find an index that lands in the middle of specialString
          const specialIndex = buf.indexOf('🎨');
          if (specialIndex !== -1 && buf.length > specialIndex + 2) {
            splitBoundaryHit = true;
            // Cut precisely at specialIndex + 2 (in the middle of the 4-byte UTF-8 emoji 🎨 which is 0xF0 0x9F 0x8E 0xA8)
            const partialLen = specialIndex + 2;
            const chunk = buf.subarray(0, partialLen);
            return origWriteSync.call(fs, fd, chunk, 0, partialLen, 0);
          }
        }
        return origWriteSync.call(fs, fd, data, ...args);
      };

      try {
        const createRes = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(createRes.ok, true);

        // Advance with auxiliary metadata containing special multibyte string
        const advRes = advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: {
            isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
          },
          lease,
        });

        assert.equal(advRes.ok, true);

        // Now test advanceJournalPhase with writeSync forced to chunk at small 7-byte chunks
        // crossing multibyte byte sequences
        const repo2 = createTempDir('jh2-22-multibyte-chunk-');
        const txId2 = generateTxId();
        const { lease: lease2 } = acquireLock({ repoRoot: repo2, txId: txId2, op: 'apply' });

        createJournal({
          repoRoot: repo2,
          txId: txId2,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease: lease2,
        });

        let chunkCalls = 0;
        fs.writeSync = (fd, data, ...args) => {
          if (typeof data === 'string') {
            const buf = Buffer.from(data, 'utf8');
            if (buf.length > 7) {
              chunkCalls++;
              const chunk = buf.subarray(0, 7);
              return origWriteSync.call(fs, fd, chunk, 0, 7, 0);
            }
          } else if (Buffer.isBuffer(data) && args[1] > 7) {
            chunkCalls++;
            return origWriteSync.call(fs, fd, data, args[0], 7, args[2]);
          }
          return origWriteSync.call(fs, fd, data, ...args);
        };

        const advRes2 = advanceJournalPhase({
          repoRoot: repo2,
          txId: txId2,
          nextPhase: 'ISOLATED_PREPARED',
          metadataUpdate: {
            isolatedStagedPath: `.ci-patch/staging/${txId2}/stable-diffusion.js`,
          },
          lease: lease2,
        });

        assert.equal(advRes2.ok, true);
        assert.ok(chunkCalls > 5, 'Expected multiple small chunk writes');

        // Verify written file on disk is valid UTF-8 and parses JSON perfectly
        const journalPath = path.join(repo2, '.ci-patch', 'journal.json');
        const rawBytes = fs.readFileSync(journalPath);
        const parsed = JSON.parse(rawBytes.toString('utf8'));
        assert.deepEqual(parsed, advRes2.journal);
      } finally {
        fs.writeSync = origWriteSync;
      }
    });

    test('JH2-F1-01: anchored cleanup failure does not attempt absolute-path unlink and reports uncertainty (F1-A)', () => {
      const repo = createTempDir('jh2-f1-01-anchored-cleanup-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const attemptedUnlinks = [];
      const origWriteSync = fs.writeSync;
      const origUnlinkSync = fs.unlinkSync;

      // Fail during write progress after creating the temporary file
      let writeFails = true;
      fs.writeSync = (fd, data, ...args) => {
        if (writeFails) {
          writeFails = false;
          const err = new Error('Simulated write failure during temporary journal preparation');
          err.code = 'EIO';
          throw err;
        }
        return origWriteSync.call(fs, fd, data, ...args);
      };

      // Spy and fail unlinkSync when called on descriptor-anchored procfs path
      fs.unlinkSync = (targetPath) => {
        attemptedUnlinks.push(targetPath);
        if (typeof targetPath === 'string' && targetPath.includes('/proc/self/fd/')) {
          const err = new Error('Simulated unlink failure on descriptor path');
          err.code = 'EACCES';
          throw err;
        }
        return origUnlinkSync.call(fs, targetPath);
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
        });

        assert.equal(res.ok, false);
        assert.equal(res.stage, 'pre-publication');
        assert.equal(res.publicationAttempted, false);
        assert.equal(res.publicationConfirmed, false);
        assert.equal(res.uncertain, true, 'Cleanup failure must accurately report uncertainty');
        assert.equal(res.code, 'EIO', 'Primary write error code must be preserved');

        // Verify anchored procfs path was attempted
        assert.ok(
          attemptedUnlinks.some((p) => typeof p === 'string' && p.includes('/proc/self/fd/')),
          'Expected unlinkSync on procfs descriptor path'
        );

        // Verify absolute pathname was NEVER attempted for unlink
        const absTmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
        assert.ok(
          !attemptedUnlinks.includes(absTmpPath),
          'Unlink must strictly NEVER fall back to absolute pathname'
        );

        // Artifact must remain preserved on disk
        assert.equal(fs.existsSync(absTmpPath), true, 'Artifact must be preserved on disk');
      } finally {
        fs.writeSync = origWriteSync;
        fs.unlinkSync = origUnlinkSync;
      }
    });

    test('JH2-F1-02: post-publication link cleanup lstat failure (EACCES) refuses success (F1-B)', () => {
      const repo = createTempDir('jh2-f1-02-cleanup-eacces-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      let interceptLstat = false;
      const faultHook = (stage) => {
        if (stage === 'before-link-cleanup') {
          interceptLstat = true;
        }
      };

      const origLstatSync = fs.lstatSync;
      fs.lstatSync = (p, ...args) => {
        if (interceptLstat && typeof p === 'string' && p.includes(`.journal.${txId}.tmp`)) {
          interceptLstat = false;
          const err = new Error('Permission denied inspecting temporary link');
          err.code = 'EACCES';
          throw err;
        }
        return origLstatSync.call(fs, p, ...args);
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
          options: { faultHook },
        });

        assert.equal(res.ok, false, 'Inspection failure cannot be reported as successful journal creation');
        assert.equal(res.stage, 'post-publication');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, true);
        assert.equal(res.directoryFsyncAttempted, true);
        assert.equal(res.directoryFsyncConfirmed, true);
        assert.equal(res.uncertain, true);
        assert.equal(res.code, 'EACCES');
        assert.match(res.error, /Failed to inspect temporary link path/);
      } finally {
        fs.lstatSync = origLstatSync;
      }
    });

    test('JH2-F1-03: post-publication link cleanup lstat failure (EIO) refuses success (F1-B)', () => {
      const repo = createTempDir('jh2-f1-03-cleanup-eio-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      let interceptLstat = false;
      const faultHook = (stage) => {
        if (stage === 'before-link-cleanup') {
          interceptLstat = true;
        }
      };

      const origLstatSync = fs.lstatSync;
      fs.lstatSync = (p, ...args) => {
        if (interceptLstat && typeof p === 'string' && p.includes(`.journal.${txId}.tmp`)) {
          interceptLstat = false;
          const err = new Error('I/O error inspecting temporary link');
          err.code = 'EIO';
          throw err;
        }
        return origLstatSync.call(fs, p, ...args);
      };

      try {
        const res = createJournal({
          repoRoot: repo,
          txId,
          op: 'apply',
          targetFile: 'src/endpoints/stable-diffusion.js',
          expectedInitialSha256: stockSha,
          expectedResultSha256: patchedSha,
          lease,
          options: { faultHook },
        });

        assert.equal(res.ok, false, 'Inspection failure cannot be reported as successful journal creation');
        assert.equal(res.stage, 'post-publication');
        assert.equal(res.publicationAttempted, true);
        assert.equal(res.publicationConfirmed, true);
        assert.equal(res.directoryFsyncAttempted, true);
        assert.equal(res.directoryFsyncConfirmed, true);
        assert.equal(res.uncertain, true);
        assert.equal(res.code, 'EIO');
        assert.match(res.error, /Failed to inspect temporary link path/);
      } finally {
        fs.lstatSync = origLstatSync;
      }
    });

    test('JH2-F1-04: intentional crash exception (_isFault) retains primary identity and closes descriptors (F1-D)', () => {
      const repo = createTempDir('jh2-f1-04-fault-propagate-');
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      const closedFds = [];
      const origCloseSync = fs.closeSync;
      fs.closeSync = (fd) => {
        closedFds.push(fd);
        return origCloseSync(fd);
      };

      const faultHook = (stage) => {
        if (stage === 'before-publication') {
          const err = new Error('Intentional crash fault before publication');
          err._isFault = true;
          err.customTag = 'CRASH_PROBE';
          throw err;
        }
      };

      try {
        assert.throws(
          () => {
            createJournal({
              repoRoot: repo,
              txId,
              op: 'apply',
              targetFile: 'src/endpoints/stable-diffusion.js',
              expectedInitialSha256: stockSha,
              expectedResultSha256: patchedSha,
              lease,
              options: { faultHook },
            });
          },
          (err) => {
            assert.equal(err._isFault, true);
            assert.equal(err.customTag, 'CRASH_PROBE');
            assert.match(err.message, /Intentional crash fault before publication/);
            return true;
          }
        );

        // Descriptors must have been closed in finally block
        assert.ok(closedFds.length > 0, 'Descriptors must be closed upon exception');
      } finally {
        fs.closeSync = origCloseSync;
      }
    });

    test('JH2-F1-05: secondary descriptor-close failure during intentional crash exception is attached as diagnostic (F1-D)', () => {
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import os from 'node:os';
        import assert from 'node:assert/strict';
        import { acquireLock, generateTxId } from './src/patch-installer/lock.js';
        import { createJournal } from './src/patch-installer/journal.js';

        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jh2-f1-05-proc-'));
        const txId = generateTxId();
        const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

        let faultTriggered = false;
        const faultHook = (stage) => {
          if (stage === 'before-publication') {
            faultTriggered = true;
            const err = new Error('Intentional crash fault');
            err._isFault = true;
            throw err;
          }
        };

        const origCloseSync = fs.closeSync;
        fs.closeSync = (fd) => {
          if (faultTriggered) {
            const err = new Error('Simulated secondary close failure in finally');
            err.code = 'EBADF';
            throw err;
          }
          return origCloseSync(fd);
        };

        try {
          createJournal({
            repoRoot: repo,
            txId,
            op: 'apply',
            targetFile: 'src/endpoints/stable-diffusion.js',
            expectedInitialSha256: '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43',
            expectedResultSha256: '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6',
            lease,
            options: { faultHook },
          });
          assert.fail('Should have thrown intentional crash exception');
        } catch (err) {
          assert.equal(err._isFault, true);
          assert.match(err.message, /Intentional crash fault/);
          assert.ok(err.closeError, 'Secondary close error must be attached as diagnostic');
          assert.equal(err.closeError.code, 'EBADF');
          assert.equal(err.closeError.uncertain, true);
        }
      `;

      child_process.execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
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

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
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

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply', hostname: 'workstation-test' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
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
    assert.match(statusOut, new RegExp(`Lock Details:\\s+txId=ci-tx-.*pid=${process.pid}`));
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

describe('Transaction Lease Capability Security & Multi-Process Hardening', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('reading owner.json from disk does NOT grant mutation authority', () => {
    const repo = createTempDir('lease-sec-disk-');
    const txId = generateTxId();

    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Read on-disk owner.json public metadata
    const ownerFile = path.join(repo, '.ci-patch/lock.d/owner.json');
    const diskOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    assert.equal(diskOwner.txId, txId);

    // Caller attempting journal creation with on-disk metadata but no in-process lease capability is strictly rejected
    const createRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(createRes.ok, false);
    assert.equal(createRes.code, 'lease-required');
    assert.match(createRes.error, /Cannot mutate journal without the active acquisition lease/);

    // Caller attempting lock release with on-disk metadata but no lease is rejected
    const releaseRes = releaseLock({
      repoRoot: repo,
      txId,
      expectedOwner: diskOwner,
    });
    assert.equal(releaseRes.ok, false);
    assert.equal(releaseRes.error, 'lease-required');
  });

  test('rejects forged or tampered lease objects', () => {
    const repo = createTempDir('lease-sec-forged-');
    const txId = generateTxId();
    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Forged lease token
    const forgedLease = new TransactionLease(txId, path.resolve(repo), 'apply', 'forged-token-12345', process.pid);

    const createRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease: forgedLease,
    });
    assert.equal(createRes.ok, false);
    assert.equal(createRes.code, 'invalid-lease-token');
    assert.match(createRes.error, /Transaction lease token or process identity verification failed/);

    // Non-instance or plain dictionary lease
    const plainObjLease = { txId, repoRoot: path.resolve(repo), op: 'apply', token: 'fake' };
    const plainRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease: plainObjLease,
    });
    assert.equal(plainRes.ok, false);
    assert.equal(plainRes.code, 'lease-required');
  });

  test('revoking lease on lock release prevents subsequent mutations', () => {
    const repo = createTempDir('lease-sec-revocation-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Create journal while holding valid lease
    const createRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(createRes.ok, true);

    // Advance to COMPLETED and remove journal
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      lease,
    });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'SWAPPED', lease });
    advanceJournalPhase({ repoRoot: repo, txId, nextPhase: 'COMPLETED', lease });
    removeJournal({ repoRoot: repo, txId, lease });

    // Release lock -> lease is revoked from ACTIVE_LEASES
    const releaseRes = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(releaseRes.ok, true);

    // Attempting to reuse revoked lease fails closed
    const reuseRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(reuseRes.ok, false);
    assert.equal(reuseRes.code, 'lease-not-active');
  });

  test('another process supplying matching metadata cannot release lock or mutate journal', () => {
    const repo = createTempDir('lease-sec-foreign-pid-');
    const txId = generateTxId();

    // Acquire lock with foreign PID
    acquireLock({ repoRoot: repo, txId, op: 'apply', pid: 77777, hostname: 'other-box' });

    // Attempt to release from current process PID fails closed
    const releaseRes = releaseLock({
      repoRoot: repo,
      txId,
      expectedOwner: { pid: 77777, hostname: 'other-box' },
    });
    assert.equal(releaseRes.ok, false);
    assert.equal(releaseRes.error, 'lease-required');

    // Attempt to mutate journal for foreign PID lock fails closed
    const createRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
    });
    assert.equal(createRes.ok, false);
    assert.equal(createRes.code, 'lease-required');
  });
});

describe('Atomic No-Replace Journal Publication (link(2) Hardening)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('atomic linkSync fails with publication-attempted and preserves destination on destination collision (EEXIST) (JH2)', () => {
    const repo = createTempDir('link-collision-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const journalPath = path.join(repo, '.ci-patch/journal.json');

    const originalLink = fs.linkSync;
    let linkCalled = false;
    fs.linkSync = (src, dest) => {
      linkCalled = true;
      // Competing process creates destination right at publication boundary
      fs.writeFileSync(dest, '{"pre_existing": true}\n');
      const err = new Error('Destination already exists');
      err.code = 'EEXIST';
      throw err;
    };

    try {
      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(linkCalled, true);
      assert.equal(res.ok, false);
      assert.equal(res.stage, 'publication-attempted');
      assert.equal(res.publicationAttempted, true);
      assert.equal(res.publicationConfirmed, null);
      assert.equal(res.uncertain, true);
      assert.match(res.error, /atomic publication collision|Destination already exists/);

      // Pre-existing destination content is untouched and uncorrupted
      assert.equal(fs.readFileSync(journalPath, 'utf8'), '{"pre_existing": true}\n');

      // Under JH2: Temporary file must be preserved for evidence (no speculative deletion)
      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.equal(fs.existsSync(tmpPath), true);
    } finally {
      fs.linkSync = originalLink;
    }
  });

  test('fails closed cleanly when filesystem does not support hard links (EXDEV/ENOTSUP) (JH2)', () => {
    const repo = createTempDir('link-unsupported-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalLink = fs.linkSync;
    fs.linkSync = () => {
      const err = new Error('Cross-device link');
      err.code = 'EXDEV';
      throw err;
    };

    try {
      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.stage, 'publication-attempted');
      assert.equal(res.publicationAttempted, true);
      assert.equal(res.publicationConfirmed, null);
      assert.equal(res.uncertain, true);
      assert.match(res.error, /Atomic no-replace journal publication unsupported on this filesystem|Cross-device link/);

      // Under JH2: Temporary file must be preserved for evidence (no speculative deletion)
      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.equal(fs.existsSync(tmpPath), true);
    } finally {
      fs.linkSync = originalLink;
    }
  });
});

describe('Fail-Closed Filesystem Inspection Errors & Preflight Refusal', () => {
  function setupDisposableRepo(prefix = 'st-inspect-err-') {
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

  test('inspectTransactionState fails closed on lstat error other than ENOENT', () => {
    const repo = createTempDir('inspect-lstat-err-');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });

    const originalLstat = fs.lstatSync;
    fs.lstatSync = (p, opts) => {
      if (typeof p === 'string' && p.endsWith('.ci-patch')) {
        const err = new Error('Permission denied on .ci-patch');
        err.code = 'EACCES';
        throw err;
      }
      return originalLstat(p, opts);
    };

    try {
      const res = inspectTransactionState(repo);
      assert.equal(res.state, 'inspection-error');
      assert.equal(res.isPending, true);
      assert.match(res.reasons[0], /(Failed to inspect installer directory|Permission denied on \.ci-patch)/);
    } finally {
      fs.lstatSync = originalLstat;
    }
  });

  test('inspectTransactionState fails closed on readdir error on .ci-patch', () => {
    const repo = createTempDir('inspect-readdir-err-');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });

    const originalReaddir = fs.readdirSync;
    fs.readdirSync = (p, opts) => {
      if (typeof p === 'string' && p.endsWith('.ci-patch')) {
        const err = new Error('Simulated EIO on readdir');
        err.code = 'EIO';
        throw err;
      }
      return originalReaddir(p, opts);
    };

    try {
      const res = inspectTransactionState(repo);
      assert.equal(res.state, 'inspection-error');
      assert.equal(res.isPending, true);
      assert.match(res.reasons[0], /Failed to read installer directory/);
    } finally {
      fs.readdirSync = originalReaddir;
    }
  });

  test('inspectTransactionState fails closed on staging or backup inspection error', () => {
    // 1. Staging inspection error
    const repo1 = createTempDir('inspect-staging-err-');
    fs.mkdirSync(path.join(repo1, '.ci-patch/staging'), { recursive: true });

    const originalLstat = fs.lstatSync;
    fs.lstatSync = (p, opts) => {
      if (typeof p === 'string' && p.endsWith('staging')) {
        const err = new Error('Simulated EACCES on staging');
        err.code = 'EACCES';
        throw err;
      }
      return originalLstat(p, opts);
    };

    try {
      const res1 = inspectTransactionState(repo1);
      assert.equal(res1.state, 'inspection-error');
      assert.equal(res1.isPending, true);
      assert.match(res1.reasons[0], /Failed to inspect staging path/);
    } finally {
      fs.lstatSync = originalLstat;
    }

    // 2. Backup inspection error
    const repo2 = createTempDir('inspect-backup-err-');
    fs.mkdirSync(path.join(repo2, '.ci-patch/backup'), { recursive: true });

    fs.lstatSync = (p, opts) => {
      if (typeof p === 'string' && p.endsWith('backup')) {
        const err = new Error('Simulated EACCES on backup');
        err.code = 'EACCES';
        throw err;
      }
      return originalLstat(p, opts);
    };

    try {
      const res2 = inspectTransactionState(repo2);
      assert.equal(res2.state, 'inspection-error');
      assert.equal(res2.isPending, true);
      assert.match(res2.reasons[0], /Failed to inspect backup path/);
    } finally {
      fs.lstatSync = originalLstat;
    }
  });

  test('checkInstallationPreflight refuses to proceed with exitCode 1 when inspection-error is present', async () => {
    const repo = setupDisposableRepo('st-preflight-inspect-err-');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });

    const originalReaddir = fs.readdirSync;
    fs.readdirSync = (p, opts) => {
      if (typeof p === 'string' && p.endsWith('.ci-patch')) {
        const err = new Error('Simulated EACCES on .ci-patch');
        err.code = 'EACCES';
        throw err;
      }
      return originalReaddir(p, opts);
    };

    try {
      const preflight = await checkInstallationPreflight({ targetDir: repo });
      assert.equal(preflight.ok, false);
      assert.equal(preflight.verdict, 'refused');
      assert.equal(preflight.exitCode, 1);
      assert.equal(preflight.canApply, false);
      assert.equal(preflight.inspection.transaction.state, 'inspection-error');
      assert.match(preflight.reason, /Failed to read installer directory/);
    } finally {
      fs.readdirSync = originalReaddir;
    }
  });

  test('clean checkouts without transaction metadata remain correctly classified as state: none and isPending: false', async () => {
    const repo = setupDisposableRepo('st-clean-checkout-');

    const txState = inspectTransactionState(repo);
    assert.equal(txState.state, 'none');
    assert.equal(txState.isPending, false);
    assert.equal(txState.hasLock, false);
    assert.equal(txState.hasJournal, false);

    const inspection = await inspectTargetInstallation({ targetDir: repo });
    assert.equal(inspection.transaction.state, 'none');
    assert.equal(inspection.transaction.isPending, false);
  });
});

describe('P3B-1-F: Temporary Journal Preservation and Ownership (journal.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('existing .journal.<txId>.tmp survives exclusive-creation collision unchanged', () => {
    const repo = createTempDir('journal-collision-create-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
    const preExistingContent = 'precious-evidence-do-not-delete';
    fs.writeFileSync(tmpPath, preExistingContent, 'utf8');

    const res = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.stage, 'pre-publication');
    assert.match(res.error, /already exists/);

    // Verify evidence survived unchanged
    assert.ok(fs.existsSync(tmpPath), 'Pre-existing temporary journal must not be deleted');
    assert.equal(fs.readFileSync(tmpPath, 'utf8'), preExistingContent);

    // Verify journal.json was not created
    assert.ok(!fs.existsSync(path.join(repo, '.ci-patch', 'journal.json')));
  });

  test('advanceJournalPhase collision preserves existing artifact and previous durable journal', () => {
    const repo = createTempDir('journal-collision-advance-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const createRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(createRes.ok, true);

    const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
    const preExistingContent = 'unrelated-or-prior-tmp-artifact';
    fs.writeFileSync(tmpPath, preExistingContent, 'utf8');

    const advanceRes = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    assert.equal(advanceRes.ok, false);
    assert.equal(advanceRes.stage, 'pre-rename');
    assert.match(advanceRes.error, /already exists/);

    // Verify evidence survived unchanged
    assert.ok(fs.existsSync(tmpPath));
    assert.equal(fs.readFileSync(tmpPath, 'utf8'), preExistingContent);

    // Verify durable journal remains at LOCKED phase
    const journalInspection = inspectJournal(repo);
    assert.equal(journalInspection.isValid, true);
    assert.equal(journalInspection.journal.phase, 'LOCKED');
  });

  test('pre-publication write/sync failure cleans up created tmp without deleting foreign file', () => {
    const repo = createTempDir('journal-fail-cleanup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const foreignPath = path.join(repo, '.ci-patch', 'foreign-artifact.txt');
    fs.writeFileSync(foreignPath, 'keep-me', 'utf8');

    const originalWriteSync = fs.writeSync;
    fs.writeSync = () => {
      const err = new Error('Simulated write failure (disk full)');
      err.code = 'ENOSPC';
      throw err;
    };

    try {
      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.stage, 'pre-publication');
      assert.match(res.error, /Simulated write failure/);
    } finally {
      fs.writeSync = originalWriteSync;
    }

    // Foreign file must remain intact
    assert.ok(fs.existsSync(foreignPath));
    assert.equal(fs.readFileSync(foreignPath, 'utf8'), 'keep-me');
  });

  test('post-publication directory sync failure reports durability uncertainty correctly', () => {
    const repo = createTempDir('journal-post-sync-fail-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalFsyncSync = fs.fsyncSync;
    let callCount = 0;
    fs.fsyncSync = (fd) => {
      callCount++;
      // First fsyncSync is on the file descriptor; second is on the directory descriptor
      if (callCount > 1) {
        const err = new Error('Simulated directory fsync failure');
        err.code = 'EIO';
        throw err;
      }
      return originalFsyncSync(fd);
    };

    try {
      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.stage, 'post-publication');
      assert.match(res.error, /directory synchronization failed/);
      assert.ok(res.journal, 'New journal object returned to avoid claiming old state is authoritative');
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
  });

  test('isValidDeviceIdentifier and isValidInodeIdentifier strictly validate identifier constraints', () => {
    // Device: non-negative integer, rejects negative, non-integers, NaN, strings, null, undefined
    assert.equal(isValidDeviceIdentifier(0), true);
    assert.equal(isValidDeviceIdentifier(1), true);
    assert.equal(isValidDeviceIdentifier(2049), true);
    assert.equal(isValidDeviceIdentifier(100n), true);
    assert.equal(isValidDeviceIdentifier(0n), true);
    assert.equal(isValidDeviceIdentifier(-1), false);
    assert.equal(isValidDeviceIdentifier(-1n), false);
    assert.equal(isValidDeviceIdentifier(NaN), false);
    assert.equal(isValidDeviceIdentifier(1.5), false);
    assert.equal(isValidDeviceIdentifier('123'), false);
    assert.equal(isValidDeviceIdentifier(null), false);
    assert.equal(isValidDeviceIdentifier(undefined), false);
    assert.equal(isValidDeviceIdentifier({}), false);

    // Inode: positive nonzero integer, rejects 0, negative, non-integers, NaN, strings, null, undefined
    assert.equal(isValidInodeIdentifier(1), true);
    assert.equal(isValidInodeIdentifier(412356), true);
    assert.equal(isValidInodeIdentifier(1n), true);
    assert.equal(isValidInodeIdentifier(0), false);
    assert.equal(isValidInodeIdentifier(0n), false);
    assert.equal(isValidInodeIdentifier(-1), false);
    assert.equal(isValidInodeIdentifier(-1n), false);
    assert.equal(isValidInodeIdentifier(NaN), false);
    assert.equal(isValidInodeIdentifier(2.5), false);
    assert.equal(isValidInodeIdentifier('456'), false);
    assert.equal(isValidInodeIdentifier(null), false);
    assert.equal(isValidInodeIdentifier(undefined), false);
    assert.equal(isValidInodeIdentifier([]), false);
  });

  test('safeUnlinkCreatedFile strictly requires valid positive identity and refuses deletion on invalid or missing identifiers', () => {
    const dir = createTempDir('safe-unlink-identity-');
    const regularFile = path.join(dir, 'evidence.txt');
    const expectedContent = 'precious-evidence-never-delete';
    fs.writeFileSync(regularFile, expectedContent, 'utf8');
    const stat = fs.statSync(regularFile);

    const invalidDevCases = [
      null,
      undefined,
      -1,
      -9999,
      NaN,
      '123',
      'dev-string',
      1.5,
      {},
      [],
      true,
      false,
    ];

    const invalidInoCases = [
      null,
      undefined,
      0,
      -1,
      -9999,
      NaN,
      '456',
      'ino-string',
      2.5,
      {},
      [],
      true,
      false,
    ];

    for (const badDev of invalidDevCases) {
      assert.equal(safeUnlinkCreatedFile(regularFile, badDev, stat.ino), false);
      assert.ok(fs.existsSync(regularFile), `File must survive invalid dev: ${badDev}`);
      assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);
    }

    for (const badIno of invalidInoCases) {
      assert.equal(safeUnlinkCreatedFile(regularFile, stat.dev, badIno), false);
      assert.ok(fs.existsSync(regularFile), `File must survive invalid ino: ${badIno}`);
      assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);
    }

    // Both undefined or null
    assert.equal(safeUnlinkCreatedFile(regularFile, undefined, undefined), false);
    assert.ok(fs.existsSync(regularFile));
    assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);

    assert.equal(safeUnlinkCreatedFile(regularFile, null, null), false);
    assert.ok(fs.existsSync(regularFile));
    assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);

    // Non-existent target file returns false
    assert.equal(safeUnlinkCreatedFile(path.join(dir, 'nonexistent.txt'), stat.dev, stat.ino), false);

    // Mismatched dev returns false and preserves file
    assert.equal(safeUnlinkCreatedFile(regularFile, stat.dev + 99999, stat.ino), false);
    assert.ok(fs.existsSync(regularFile));
    assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);

    // Mismatched ino returns false and preserves file
    assert.equal(safeUnlinkCreatedFile(regularFile, stat.dev, stat.ino + 99999), false);
    assert.ok(fs.existsSync(regularFile));
    assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);

    // Symlink targeting regularFile returns false and preserves both
    const linkPath = path.join(dir, 'symlink.txt');
    fs.symlinkSync(regularFile, linkPath);
    assert.equal(safeUnlinkCreatedFile(linkPath, stat.dev, stat.ino), false);
    assert.ok(fs.existsSync(linkPath));
    assert.ok(fs.existsSync(regularFile));
    assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);

    // Directory returns false and preserves directory
    const subDir = path.join(dir, 'subfolder');
    fs.mkdirSync(subDir);
    const dirStat = fs.statSync(subDir);
    assert.equal(safeUnlinkCreatedFile(subDir, dirStat.dev, dirStat.ino), false);
    assert.ok(fs.existsSync(subDir));

    // Filesystem lstat error fails closed and preserves file
    const origLstat = fs.lstatSync;
    fs.lstatSync = () => {
      const err = new Error('Simulated EACCES inspection error');
      err.code = 'EACCES';
      throw err;
    };
    try {
      assert.equal(safeUnlinkCreatedFile(regularFile, stat.dev, stat.ino), false);
      assert.ok(fs.existsSync(regularFile));
      assert.equal(fs.readFileSync(regularFile, 'utf8'), expectedContent);
    } finally {
      fs.lstatSync = origLstat;
    }

    // Matching valid dev and ino succeeds and unlinks
    assert.equal(safeUnlinkCreatedFile(regularFile, stat.dev, stat.ino), true);
    assert.ok(!fs.existsSync(regularFile));
  });

  test('failure to establish temporary file identity in writeJournalDurable preserves temporary file and fails closed', () => {
    const repo = createTempDir('journal-identity-fail-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalFstatSync = fs.fstatSync;
    fs.fstatSync = () => {
      const err = new Error('Simulated fstatSync failure (EIO)');
      err.code = 'EIO';
      throw err;
    };

    try {
      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.stage, 'pre-publication');
      assert.match(res.error, /Simulated fstatSync failure/);

      // Verify that the temporary file was NOT deleted and is preserved for evidence
      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.ok(fs.existsSync(tmpPath), 'Temporary file must be preserved when identity cannot be established');

      // Verify journal was NOT published
      assert.ok(!fs.existsSync(path.join(repo, '.ci-patch', 'journal.json')));
    } finally {
      fs.fstatSync = originalFstatSync;
    }
  });

  test('fstatSync returning unusable zero inode in writeJournalDurable preserves temporary file and fails closed', () => {
    const repo = createTempDir('journal-zero-ino-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalFstatSync = fs.fstatSync;
    fs.fstatSync = (fd) => {
      const realStat = originalFstatSync(fd);
      return {
        ...realStat,
        ino: 0, // Unusable zero inode
      };
    };

    try {
      const res = createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.stage, 'pre-publication');
      assert.match(res.error, /Failed to establish usable file identity/);

      // Verify that the temporary file was preserved
      const tmpPath = path.join(repo, '.ci-patch', `.journal.${txId}.tmp`);
      assert.ok(fs.existsSync(tmpPath), 'Temporary file must be preserved when inode is zero');

      // Verify journal was NOT published
      assert.ok(!fs.existsSync(path.join(repo, '.ci-patch', 'journal.json')));
    } finally {
      fs.fstatSync = originalFstatSync;
    }
  });

  test('valid journal creation and permitted phase updates advance through complete lifecycle', () => {
    const repo = createTempDir('journal-lifecycle-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const phases = ['LOCKED', 'ISOLATED_PREPARED', 'BACKUP_CREATED', 'READY_TO_SWAP', 'SWAPPED', 'COMPLETED'];
    const createRes = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(createRes.ok, true);
    assert.equal(createRes.journal.phase, 'LOCKED');

    const phaseMetadata = {
      ISOLATED_PREPARED: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      BACKUP_CREATED: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      READY_TO_SWAP: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      SWAPPED: {},
      COMPLETED: {},
    };

    for (let i = 1; i < phases.length; i++) {
      const nextPhase = phases[i];
      const advRes = advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase,
        metadataUpdate: phaseMetadata[nextPhase],
        lease,
      });
      assert.equal(advRes.ok, true);
      assert.equal(advRes.journal.phase, nextPhase);
    }

    const finalInspection = inspectJournal(repo);
    assert.equal(finalInspection.journal.phase, 'COMPLETED');
  });
});

describe('P3B-1-F: Strict Validation of Recognized Transaction Artifacts (transaction-state.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  function setupRepo(prefix = 'st-tx-artifacts-') {
    const repoDir = createTempDir(prefix);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    return repoDir;
  }

  test('unexpected regular file in matching staging transaction directory is rejected as orphaned-artifact', async () => {
    const repo = setupRepo('st-staging-unexpected-file-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    // Permitted file
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'patched', 'utf8');
    // Intruder file
    fs.writeFileSync(path.join(txStagingDir, 'intruder.txt'), 'unexpected', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.some((p) => p.endsWith('intruder.txt')));

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.verdict, 'refused');
    assert.equal(preflight.canApply, false);
  });

  test('unexpected subdirectory in staging transaction directory is rejected as orphaned-artifact', async () => {
    const repo = setupRepo('st-staging-unexpected-dir-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(path.join(txStagingDir, 'unexpected-subdir'), { recursive: true });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.verdict, 'refused');
  });

  test('unexpected regular file or subdirectory in backup transaction directory is rejected as orphaned-artifact', async () => {
    const repo = setupRepo('st-backup-unexpected-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      lease,
    });

    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    // Permitted file
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'stock', 'utf8');
    // Intruder regular file
    fs.writeFileSync(path.join(txBackupDir, 'unrelated.png'), 'png', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.some((p) => p.endsWith('unrelated.png')));

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.verdict, 'refused');
  });

  test('foreign transaction directories in staging or backup are rejected as orphaned-artifact', async () => {
    const repo = setupRepo('st-foreign-tx-dir-');
    const txId = generateTxId();
    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Staging contains a folder for a different txId
    const foreignDir = path.join(repo, '.ci-patch/staging/other-tx-folder-1234');
    fs.mkdirSync(foreignDir, { recursive: true });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.some((p) => p.includes('other-tx-folder-1234')));

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.verdict, 'refused');
  });

  test('nested symlinks and dangling nested symlinks in transaction directories are rejected as unsafe-symlink', async () => {
    const repo = setupRepo('st-nested-symlink-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });

    // Dangling nested symlink
    fs.symlinkSync('/nonexistent/path/outside', path.join(txStagingDir, 'stable-diffusion.js'));

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'unsafe-symlink');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('stable-diffusion.js')));

    const preflight = await checkInstallationPreflight({ targetDir: repo });
    assert.equal(preflight.verdict, 'refused');
  });

  test('child path inspection filesystem errors fail closed with inspection-error', async () => {
    const repo = setupRepo('st-child-inspect-err-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'test.js'), 'code', 'utf8');

    const originalLstat = fs.lstatSync;
    fs.lstatSync = (p, opts) => {
      if (typeof p === 'string' && p.endsWith('test.js')) {
        const err = new Error('Simulated EACCES on child entry');
        err.code = 'EACCES';
        throw err;
      }
      return originalLstat(p, opts);
    };

    try {
      const state = inspectTransactionState(repo);
      assert.equal(state.state, 'inspection-error');
      assert.equal(state.isPending, true);

      const preflight = await checkInstallationPreflight({ targetDir: repo });
      assert.equal(preflight.verdict, 'refused');
      assert.equal(preflight.exitCode, 1);
    } finally {
      fs.lstatSync = originalLstat;
    }
  });

  test('matching staging artifact in LOCKED phase reports incomplete-transaction', () => {
    const repo = setupRepo('st-premature-artifacts-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Journal created in LOCKED phase (staging not yet prepared)
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'code', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Interrupted staging preparation detected')));

    // If an unexpected artifact is also present, it becomes orphaned-artifact
    fs.writeFileSync(path.join(txStagingDir, 'intruder.txt'), 'unexpected', 'utf8');
    const state2 = inspectTransactionState(repo);
    assert.equal(state2.state, 'orphaned-artifact');
    assert.equal(state2.isPending, true);
    assert.ok(state2.orphanedArtifacts.some((p) => p.endsWith('intruder.txt')));
  });

  test('legitimate empty recognized directories report state: none and isPending: false', () => {
    const repo = setupRepo('st-empty-recognized-');
    fs.mkdirSync(path.join(repo, '.ci-patch/staging'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.ci-patch/backup'), { recursive: true });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'none');
    assert.equal(state.isPending, false);
    assert.equal(state.hasLock, false);
    assert.equal(state.hasJournal, false);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('valid recognized transaction with permitted artifacts reports clean pending state without orphans', () => {
    const repo = setupRepo('st-valid-tx-permitted-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'valid-patched-code', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('getPermittedArtifactNames helper returns exact allowable filenames for staging and backup', () => {
    const journal = {
      targetFile: 'src/endpoints/stable-diffusion.js',
      isolatedStagedPath: '.ci-patch/staging/ci-tx-123-abc/stable-diffusion.js',
      stagedPath: '/path/to/custom-staged.js',
      backupPath: '/path/to/custom-backup.js.bak',
    };

    const stagingAllowlist = getPermittedArtifactNames(journal, 'staging');
    assert.ok(stagingAllowlist.has('stable-diffusion.js'));
    assert.ok(stagingAllowlist.has('custom-staged.js'));
    assert.ok(!stagingAllowlist.has('other.js'));

    const backupAllowlist = getPermittedArtifactNames(journal, 'backup');
    assert.ok(backupAllowlist.has('stable-diffusion.js'));
    assert.ok(backupAllowlist.has('stable-diffusion.js.bak'));
    assert.ok(backupAllowlist.has('stable-diffusion.js.orig'));
    assert.ok(backupAllowlist.has('custom-backup.js.bak'));
    assert.ok(!backupAllowlist.has('unrelated.png'));
  });
});

describe('P3B-1-F: Lock Release Hardening Against Partial Cleanup Failures (lock.js)', () => {
  test('unexpected files appearing in lock.d before release causes refusal without deletion', () => {
    const repo = createTempDir('lock-release-unexpected-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Plant unexpected file
    const intruderPath = path.join(repo, '.ci-patch/lock.d/intruder.txt');
    fs.writeFileSync(intruderPath, 'unauthorized', 'utf8');

    const res = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unexpected-lock-contents');

    // Verify lock and intruder remain intact
    assert.ok(fs.existsSync(intruderPath));
    assert.ok(fs.existsSync(path.join(repo, '.ci-patch/lock.d/owner.json')));

    // Lease should remain active because release was refused before mutation
    const leaseCheck = validateLease(lease, repo, txId, 'apply');
    assert.equal(leaseCheck.ok, true);
  });

  test('owner metadata modified or tampered before cleanup causes release refusal', () => {
    const repo = createTempDir('lock-release-tampered-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Tamper owner.json
    const ownerPath = path.join(repo, '.ci-patch/lock.d/owner.json');
    const ownerData = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    ownerData.txId = generateTxId(); // foreign txId
    fs.writeFileSync(ownerPath, JSON.stringify(ownerData, null, 2), 'utf8');

    const res = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'ownership-mismatch');

    // Lock must remain intact
    assert.ok(fs.existsSync(ownerPath));
  });

  test('owner metadata replaced by a symlink causes release refusal', () => {
    const repo = createTempDir('lock-release-symlink-owner-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const ownerPath = path.join(repo, '.ci-patch/lock.d/owner.json');
    fs.unlinkSync(ownerPath);
    fs.symlinkSync('/dev/null', ownerPath);

    const res = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unverified-lock');
  });

  test('failure to unlink owner metadata leaves lock intact with active lease', () => {
    const repo = createTempDir('lock-unlink-owner-fail-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = (p) => {
      if (typeof p === 'string' && p.endsWith('owner.json')) {
        const err = new Error('Simulated unlink permission failure');
        err.code = 'EACCES';
        throw err;
      }
      return originalUnlink(p);
    };

    try {
      const res = releaseLock({ repoRoot: repo, txId, lease });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'fs-error');
      assert.equal(res.stage, 'owner-unlink-failed');

      // Lease remains active because lock was not removed
      const leaseCheck = validateLease(lease, repo, txId, 'apply');
      assert.equal(leaseCheck.ok, true);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
  });

  test('failure to remove lock directory attempts owner restoration and marks lease uncertain', () => {
    const repo = createTempDir('lock-rmdir-fail-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalRmdir = fs.rmdirSync;
    fs.rmdirSync = (p) => {
      if (typeof p === 'string' && p.endsWith('lock.d')) {
        const err = new Error('Simulated rmdir failure (EIO)');
        err.code = 'EIO';
        throw err;
      }
      return originalRmdir(p);
    };

    try {
      const res = releaseLock({ repoRoot: repo, txId, lease });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'fs-error');
      assert.equal(res.stage, 'lock-removal-failed');
      assert.equal(res.uncertain, true);

      // Verify owner.json restoration was attempted
      const ownerPath = path.join(repo, '.ci-patch/lock.d/owner.json');
      assert.ok(fs.existsSync(ownerPath), 'owner.json should be restored after failed rmdir');

      // Verify lease is now marked uncertain
      const leaseCheck = validateLease(lease, repo, txId, 'apply');
      assert.equal(leaseCheck.ok, false);
      assert.equal(leaseCheck.error, 'lease-uncertain');
    } finally {
      fs.rmdirSync = originalRmdir;
    }
  });

  test('failure to synchronize containing directory after removal marks lease uncertain', () => {
    const repo = createTempDir('lock-post-sync-fail-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const originalFsync = fs.fsyncSync;
    fs.fsyncSync = () => {
      const err = new Error('Simulated directory fsync failure');
      err.code = 'EIO';
      throw err;
    };

    try {
      const res = releaseLock({ repoRoot: repo, txId, lease });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'fs-error');
      assert.equal(res.stage, 'post-removal-sync');
      assert.equal(res.uncertain, true);

      // Verify lease is marked uncertain
      const leaseCheck = validateLease(lease, repo, txId, 'apply');
      assert.equal(leaseCheck.ok, false);
      assert.equal(leaseCheck.error, 'lease-uncertain');
    } finally {
      fs.fsyncSync = originalFsync;
    }
  });

  test('successful release deletes lease from active set while uncertain release preserves lease as uncertain', () => {
    const repo = createTempDir('lock-lease-distinction-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const res = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(res.ok, true);

    const leaseCheck = validateLease(lease, repo, txId, 'apply');
    assert.equal(leaseCheck.ok, false);
    assert.equal(leaseCheck.error, 'lease-not-active');
  });

  test('unrelated files in .ci-patch are preserved during lock release', () => {
    const repo = createTempDir('lock-preserve-foreign-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const unrelatedLog = path.join(repo, '.ci-patch/installer-audit.log');
    fs.writeFileSync(unrelatedLog, 'important-audit-trail', 'utf8');

    const res = releaseLock({ repoRoot: repo, txId, lease });
    assert.equal(res.ok, true);

    assert.ok(fs.existsSync(unrelatedLog));
    assert.equal(fs.readFileSync(unrelatedLog, 'utf8'), 'important-audit-trail');
  });
});

describe('P3B-1-F: Full Lock/Journal Transaction Consistency', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('conflicting operation (lock apply vs journal remove) classified as mismatched-metadata', () => {
    const repo = createTempDir('tx-op-mismatch-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // createJournal refuses mismatched op at creation time
    const resCreate = createJournal({
      repoRoot: repo,
      txId,
      op: 'remove',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    assert.equal(resCreate.ok, false);
    assert.equal(resCreate.code, 'lease-op-mismatch');

    // If mismatched journal is already present on disk, inspectTransactionState rejects it
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const journalPath = path.join(repo, '.ci-patch/journal.json');
    const journalData = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journalData.op = 'remove';
    fs.writeFileSync(journalPath, JSON.stringify(journalData, null, 2), 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'mismatched-metadata');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Transaction operation mismatch')));
  });

  test('conflicting repository identity (repoRoot mismatch) classified as mismatched-metadata', () => {
    const repo = createTempDir('tx-reporoot-mismatch-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Tamper lock owner repoRoot
    const ownerPath = path.join(repo, '.ci-patch/lock.d/owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    owner.repoRoot = '/completely/different/repo/root';
    fs.writeFileSync(ownerPath, JSON.stringify(owner, null, 2), 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'mismatched-metadata');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.toLowerCase().includes('repository root mismatch')));
  });

  test('corrupted lock directory (missing owner.json) with journal classified as corrupted-lock', () => {
    const repo = createTempDir('tx-corrupt-lock-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Remove owner.json while leaving lock.d
    fs.unlinkSync(path.join(repo, '.ci-patch/lock.d/owner.json'));

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'corrupted-lock');
    assert.equal(state.isPending, true);
  });

  test('valid matching lock and journal metadata classified as ownership-unverified and consistent', () => {
    const repo = createTempDir('tx-valid-matching-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('journal mutation strictly requires valid active lease matching txId and refuses uncertain or foreign lease', () => {
    const repo = createTempDir('tx-journal-lease-enforcement-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Attempt mutation without lease
    const noLeaseRes = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
    });
    assert.equal(noLeaseRes.ok, false);
    assert.equal(noLeaseRes.code, 'lease-required');

    // Attempt mutation with foreign lease
    const foreignTxId = generateTxId();
    const foreignRepo = createTempDir('tx-foreign-lease-');
    const { lease: foreignLease } = acquireLock({ repoRoot: foreignRepo, txId: foreignTxId, op: 'apply' });

    const foreignLeaseRes = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      lease: foreignLease,
    });
    assert.equal(foreignLeaseRes.ok, false);
    assert.equal(foreignLeaseRes.code, 'lease-tx-mismatch');

    // Attempt mutation with uncertain lease
    const uncertainRepo = createTempDir('tx-uncertain-lease-');
    const uTxId = generateTxId();
    const { lease: uLease } = acquireLock({ repoRoot: uncertainRepo, txId: uTxId, op: 'apply' });
    createJournal({
      repoRoot: uncertainRepo,
      txId: uTxId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease: uLease,
    });

    // Simulate rmdir failure to mark uLease uncertain
    const origRmdir = fs.rmdirSync;
    fs.rmdirSync = () => { throw new Error('EIO'); };
    try {
      releaseLock({ repoRoot: uncertainRepo, txId: uTxId, lease: uLease });
    } finally {
      fs.rmdirSync = origRmdir;
    }

    const uncertainLeaseRes = advanceJournalPhase({
      repoRoot: uncertainRepo,
      txId: uTxId,
      nextPhase: 'ISOLATED_PREPARED',
      lease: uLease,
    });
    assert.equal(uncertainLeaseRes.ok, false);
    assert.equal(uncertainLeaseRes.code, 'lease-uncertain');
  });
});

describe('P3B-2A: Journal Phase-Bound Resource Contracts & Metadata Immutability (journal.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  test('createJournal rejects any auxiliary metadata fields at creation time', () => {
    const repo = createTempDir('j-meta-create-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const resAux = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(resAux.ok, false);
    assert.match(resAux.error, /Disallowed auxiliary journal field at creation/);

    const resLegacy = createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      extraMetadata: { stagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(resLegacy.ok, false);
    assert.match(resLegacy.error, /Disallowed auxiliary journal field at creation/);
  });

  test('advanceJournalPhase enforces mandatory metadata and rejects premature fields', () => {
    const repo = createTempDir('j-meta-phases-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // 1. Omission of isolatedStagedPath at LOCKED -> ISOLATED_PREPARED
    const resOmit1 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      lease,
    });
    assert.equal(resOmit1.ok, false);
    assert.equal(resOmit1.code, 'missing-mandatory-metadata');
    assert.match(resOmit1.error, /isolatedStagedPath/);

    // 2. Premature introduction of backupPath at LOCKED -> ISOLATED_PREPARED
    const resPremature = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: {
        isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
      },
      lease,
    });
    assert.equal(resPremature.ok, false);
    assert.equal(resPremature.code, 'premature-metadata');
    assert.match(resPremature.error, /backupPath/);

    // 3. Valid advance to ISOLATED_PREPARED
    const resAdv1 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(resAdv1.ok, true);

    // 4. Omission of targetMode at ISOLATED_PREPARED -> BACKUP_CREATED
    const resOmitMode = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(resOmitMode.ok, false);
    assert.equal(resOmitMode.code, 'missing-mandatory-metadata');
    assert.match(resOmitMode.error, /targetMode/);

    // 5. Premature destinationStagedPath at ISOLATED_PREPARED -> BACKUP_CREATED
    const resPrematureDest = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
        destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`,
      },
      lease,
    });
    assert.equal(resPrematureDest.ok, false);
    assert.equal(resPrematureDest.code, 'premature-metadata');
    assert.match(resPrematureDest.error, /destinationStagedPath/);

    // 6. Valid advance to BACKUP_CREATED
    const resAdv2 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });
    assert.equal(resAdv2.ok, true);

    // 7. Omission of destinationStagedPath at BACKUP_CREATED -> READY_TO_SWAP
    const resOmitDest = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      lease,
    });
    assert.equal(resOmitDest.ok, false);
    assert.equal(resOmitDest.code, 'missing-mandatory-metadata');

    // 8. Valid advance to READY_TO_SWAP
    const resAdv3 = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      metadataUpdate: {
        destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`,
      },
      lease,
    });
    assert.equal(resAdv3.ok, true);
  });

  test('advanceJournalPhase strictly enforces resource path containment and matching txId', () => {
    const repo = createTempDir('j-meta-containment-');
    const txId = generateTxId();
    const otherTxId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Foreign txId in path
    const resForeignTx = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${otherTxId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(resForeignTx.ok, false);
    assert.equal(resForeignTx.code, 'invalid-resource-path');

    // Directory traversal
    const resTraversal = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/../escape.js` },
      lease,
    });
    assert.equal(resTraversal.ok, false);
    assert.equal(resTraversal.code, 'invalid-resource-path');

    // Absolute path
    const resAbs = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: path.resolve(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`) },
      lease,
    });
    assert.equal(resAbs.ok, false);
    assert.equal(resAbs.code, 'invalid-resource-path');
  });

  test('advanceJournalPhase validates canonical targetMode octal string', () => {
    const repo = createTempDir('j-meta-mode-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const invalidModes = ['644', '07777', '0abc', '0888', '064', '', '0100644'];
    for (const badMode of invalidModes) {
      const resBad = advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'BACKUP_CREATED',
        metadataUpdate: {
          backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
          targetMode: badMode,
        },
        lease,
      });
      assert.equal(resBad.ok, false);
      assert.match(resBad.error, /targetMode/i);
    }

    const resValid = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });
    assert.equal(resValid.ok, true);
    assert.equal(resValid.journal?.targetMode, '0644');
  });

  test('advanceJournalPhase enforces permanent immutability and permits identical resubmission', () => {
    const repo = createTempDir('j-meta-immutability-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    // Conflicting resubmission of isolatedStagedPath during BACKUP_CREATED
    const resConflict = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        isolatedStagedPath: `.ci-patch/staging/${txId}/other-name.js`,
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });
    assert.equal(resConflict.ok, false);
    assert.equal(resConflict.code, 'immutable-field-conflict');

    // Identical resubmission of isolatedStagedPath succeeds idempotently
    const resIdentical = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });
    assert.equal(resIdentical.ok, true);
    assert.equal(resIdentical.journal?.isolatedStagedPath, `.ci-patch/staging/${txId}/stable-diffusion.js`);
  });

  test('advanceJournalPhase refuses to advance legacy journal containing stagedPath', () => {
    const repo = createTempDir('j-legacy-refusal-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Manually create a legacy journal with stagedPath on disk
    const jPath = path.join(repo, '.ci-patch/journal.json');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });
    const legacyJournal = {
      schemaVersion: '1.0.0',
      txId,
      op: 'apply',
      phase: 'LOCKED',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
    };
    fs.writeFileSync(jPath, JSON.stringify(legacyJournal, null, 2) + '\n');

    // Inspecting legacy journal succeeds with note
    const inspection = inspectJournal(repo);
    assert.equal(inspection.hasJournal, true);
    assert.equal(inspection.isValid, true);
    assert.equal(inspection.journal?.stagedPath, legacyJournal.stagedPath);

    // State inspection recognizes legacy schema
    const txState = inspectTransactionState(repo);
    assert.ok(txState.reasons.some((r) => r.includes('Legacy journal schema detected')));

    // Attempting to advance legacy journal is strictly refused
    const advRes = advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    assert.equal(advRes.ok, false);
    assert.equal(advRes.code, 'legacy-schema');
    assert.match(advRes.error, /legacy journals containing "stagedPath" are refused/);
  });
});

describe('P3B-2A-F1: Phase-Aware Persisted Journal Validation (validateJournalStructure)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  const baseValidJournal = (phase = 'LOCKED', txId = generateTxId()) => ({
    schemaVersion: '1.0.0',
    txId,
    op: 'apply',
    phase,
    targetFile: 'src/endpoints/stable-diffusion.js',
    expectedInitialSha256: stockSha,
    expectedResultSha256: patchedSha,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  test('validates journals across every permitted phase when exact mandatory metadata is present', () => {
    const txId = generateTxId();

    // 1. LOCKED (no auxiliary metadata)
    const jLocked = baseValidJournal('LOCKED', txId);
    assert.equal(validateJournalStructure(jLocked).valid, true);

    // 2. ISOLATED_PREPARED
    const jPrep = {
      ...baseValidJournal('ISOLATED_PREPARED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
    };
    assert.equal(validateJournalStructure(jPrep).valid, true);

    // 3. BACKUP_CREATED
    const jBak = {
      ...jPrep,
      phase: 'BACKUP_CREATED',
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
      targetMode: '0644',
    };
    assert.equal(validateJournalStructure(jBak).valid, true);

    // 4. READY_TO_SWAP
    const jSwap = {
      ...jBak,
      phase: 'READY_TO_SWAP',
      destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`,
    };
    assert.equal(validateJournalStructure(jSwap).valid, true);

    // 5. SWAPPED
    const jSwapped = { ...jSwap, phase: 'SWAPPED' };
    assert.equal(validateJournalStructure(jSwapped).valid, true);

    // 6. COMPLETED
    const jDone = { ...jSwap, phase: 'COMPLETED' };
    assert.equal(validateJournalStructure(jDone).valid, true);
  });

  test('rejects ISOLATED_PREPARED when isolatedStagedPath is missing', () => {
    const j = baseValidJournal('ISOLATED_PREPARED');
    const res = validateJournalStructure(j);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('Missing mandatory auxiliary field for phase "ISOLATED_PREPARED": "isolatedStagedPath"')));
  });

  test('rejects BACKUP_CREATED when backupPath or targetMode is missing', () => {
    const txId = generateTxId();
    // Missing backupPath
    const jNoBak = {
      ...baseValidJournal('BACKUP_CREATED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      targetMode: '0644',
    };
    const resNoBak = validateJournalStructure(jNoBak);
    assert.equal(resNoBak.valid, false);
    assert.ok(resNoBak.errors.some((e) => e.includes('Missing mandatory auxiliary field for phase "BACKUP_CREATED": "backupPath"')));

    // Missing targetMode
    const jNoMode = {
      ...baseValidJournal('BACKUP_CREATED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
    };
    const resNoMode = validateJournalStructure(jNoMode);
    assert.equal(resNoMode.valid, false);
    assert.ok(resNoMode.errors.some((e) => e.includes('Missing mandatory auxiliary field for phase "BACKUP_CREATED": "targetMode"')));
  });

  test('rejects READY_TO_SWAP when destinationStagedPath is missing', () => {
    const txId = generateTxId();
    const j = {
      ...baseValidJournal('READY_TO_SWAP', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
      targetMode: '0644',
    };
    const res = validateJournalStructure(j);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('Missing mandatory auxiliary field for phase "READY_TO_SWAP": "destinationStagedPath"')));
  });

  test('rejects premature auxiliary metadata in early phases', () => {
    const txId = generateTxId();

    // LOCKED with isolatedStagedPath
    const jLockWithPrep = {
      ...baseValidJournal('LOCKED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
    };
    const resLock = validateJournalStructure(jLockWithPrep);
    assert.equal(resLock.valid, false);
    assert.ok(resLock.errors.some((e) => e.includes('Disallowed premature or extraneous auxiliary field in phase "LOCKED"')));

    // ISOLATED_PREPARED with backupPath
    const jPrepWithBak = {
      ...baseValidJournal('ISOLATED_PREPARED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
    };
    const resPrep = validateJournalStructure(jPrepWithBak);
    assert.equal(resPrep.valid, false);
    assert.ok(resPrep.errors.some((e) => e.includes('Disallowed premature or extraneous auxiliary field in phase "ISOLATED_PREPARED"')));

    // BACKUP_CREATED with destinationStagedPath
    const jBakWithDest = {
      ...baseValidJournal('BACKUP_CREATED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
      targetMode: '0644',
      destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`,
    };
    const resBak = validateJournalStructure(jBakWithDest);
    assert.equal(resBak.valid, false);
    assert.ok(resBak.errors.some((e) => e.includes('Disallowed premature or extraneous auxiliary field in phase "BACKUP_CREATED"')));
  });

  test('rejects resource paths with wrong txId binding, directory traversal, or wrong directory', () => {
    const txId = generateTxId();
    const otherTxId = generateTxId();

    // Wrong txId in isolatedStagedPath
    const jForeignTx = {
      ...baseValidJournal('ISOLATED_PREPARED', txId),
      isolatedStagedPath: `.ci-patch/staging/${otherTxId}/stable-diffusion.js`,
    };
    const resForeign = validateJournalStructure(jForeignTx);
    assert.equal(resForeign.valid, false);
    assert.ok(resForeign.errors.some((e) => e.includes('Invalid isolatedStagedPath')));

    // Directory traversal in backupPath
    const jTraversal = {
      ...baseValidJournal('BACKUP_CREATED', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      backupPath: `.ci-patch/backup/${txId}/../escape.js`,
      targetMode: '0644',
    };
    const resTraversal = validateJournalStructure(jTraversal);
    assert.equal(resTraversal.valid, false);
    assert.ok(resTraversal.errors.some((e) => e.includes('Invalid backupPath')));

    // Wrong filename in destinationStagedPath
    const jWrongFile = {
      ...baseValidJournal('READY_TO_SWAP', txId),
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
      targetMode: '0644',
      destinationStagedPath: `src/endpoints/.other-file.js.ci-staged-${txId}.tmp`,
    };
    const resWrongFile = validateJournalStructure(jWrongFile);
    assert.equal(resWrongFile.valid, false);
    assert.ok(resWrongFile.errors.some((e) => e.includes('Invalid destinationStagedPath')));
  });

  test('rejects malformed targetMode format', () => {
    const txId = generateTxId();
    const invalidModes = ['644', '07777', '0abc', '0888', '064', ''];
    for (const badMode of invalidModes) {
      const j = {
        ...baseValidJournal('BACKUP_CREATED', txId),
        isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: badMode,
      };
      const res = validateJournalStructure(j);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => /targetMode/i.test(e)));
    }
  });

  test('inspectJournal detects on-disk phase-inconsistent journals as invalid', () => {
    const repo = createTempDir('inspect-phase-invalid-');
    const txId = generateTxId();
    const jPath = path.join(repo, '.ci-patch/journal.json');
    fs.mkdirSync(path.join(repo, '.ci-patch'), { recursive: true });

    // On-disk journal claiming ISOLATED_PREPARED without isolatedStagedPath
    const corruptJournal = baseValidJournal('ISOLATED_PREPARED', txId);
    fs.writeFileSync(jPath, JSON.stringify(corruptJournal, null, 2) + '\n');

    const inspection = inspectJournal(repo);
    assert.equal(inspection.hasJournal, true);
    assert.equal(inspection.isValid, false);
    assert.ok(inspection.errors.some((e) => e.includes('Missing mandatory auxiliary field for phase "ISOLATED_PREPARED"')));

    // Read-only state inspection detects corrupted-journal
    const txState = inspectTransactionState(repo);
    assert.equal(txState.state, 'corrupted-journal');
    assert.equal(txState.isPending, true);
  });
});

describe('P3B-2B: Read-Only Incomplete and Corrupted Backup State Classification (transaction-state.js)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';
  test('interrupted backup preparation in ISOLATED_PREPARED is classified as incomplete-transaction', () => {
    const repo = createTempDir('tx-incomplete-backup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'code', 'utf8');

    // Case 1: Empty backup parent directory exists
    fs.mkdirSync(path.join(repo, '.ci-patch/backup'), { recursive: true });
    let state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);

    // Case 2: Empty transaction backup directory exists
    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);

    // Case 3: Target artifact written in backup before journal advancement
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'backup-bytes', 'utf8');
    state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
  });

  test('corrupt or missing backup file in BACKUP_CREATED is classified as incomplete-transaction', () => {
    const repo = createTempDir('tx-corrupt-backup-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'code', 'utf8');

    // Case 1: Missing backup file on disk (backup directory exists but is empty)
    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    let state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Missing backup artifact in phase "BACKUP_CREATED"')));

    // Case 2: Corrupt backup file on disk (wrong SHA-256)
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'corrupted-data', 'utf8');
    state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Corrupted backup artifact in phase "BACKUP_CREATED"')));
  });
});

describe('P3B-2B-F1: Read-Only Backup Inspection Hardening (Finding C)', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  function setupBackupCreatedRepo(prefix = 'tx-inspect-f1-') {
    const repo = createTempDir(prefix);
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'code', 'utf8');

    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });

    return { repo, txId, txBackupDir };
  }

  test('oversized backup file (> 50 MiB) fails closed with inspection-error without OOM', () => {
    const { repo, txBackupDir } = setupBackupCreatedRepo('tx-oversized-backup-');
    const backupFile = path.join(txBackupDir, 'stable-diffusion.js');

    const fd = fs.openSync(backupFile, 'w');
    fs.ftruncateSync(fd, 51 * 1024 * 1024);
    fs.closeSync(fd);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'inspection-error');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('exceeds safety limit')));
  });

  test('unreadable backup file descriptor / permission error fails closed with inspection-error', () => {
    const { repo, txBackupDir } = setupBackupCreatedRepo('tx-unreadable-backup-');
    const backupFile = path.join(txBackupDir, 'stable-diffusion.js');
    fs.writeFileSync(backupFile, 'stock-data', 'utf8');

    const originalOpenSync = fs.openSync;
    fs.openSync = (...args) => {
      const [targetPath, flags] = args;
      if (typeof targetPath === 'string' && targetPath.includes('.ci-patch/backup') && flags === (fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)) {
        const err = new Error('Simulated EACCES on backup file');
        err.code = 'EACCES';
        throw err;
      }
      return originalOpenSync(...args);
    };

    try {
      const state = inspectTransactionState(repo);
      assert.equal(state.state, 'inspection-error');
      assert.equal(state.isPending, true);
      assert.ok(state.reasons.some((r) => r.includes('Failed to open backup artifact')));
    } finally {
      fs.openSync = originalOpenSync;
    }
  });

  test('legacy .bak filename in current-schema backup directory is rejected as orphaned-artifact', () => {
    const { repo, txBackupDir } = setupBackupCreatedRepo('tx-bak-reject-');
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'something', 'utf8');
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js.bak'), 'legacy-content', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.some((a) => a.endsWith('stable-diffusion.js.bak')));
    assert.ok(state.reasons.some((r) => r.includes('Unexpected regular file in backup') && r.includes('expected only: stable-diffusion.js')));
  });

  test('legacy .orig filename in current-schema backup directory is rejected as orphaned-artifact', () => {
    const { repo, txBackupDir } = setupBackupCreatedRepo('tx-orig-reject-');
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'something', 'utf8');
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js.orig'), 'legacy-content', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.some((a) => a.endsWith('stable-diffusion.js.orig')));
  });

  test('foreign file alongside canonical backup in current-schema backup directory is rejected as orphaned-artifact', () => {
    const { repo, txBackupDir } = setupBackupCreatedRepo('tx-foreign-reject-');
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js'), 'something', 'utf8');
    fs.writeFileSync(path.join(txBackupDir, 'random-unrelated.txt'), 'intruder', 'utf8');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.some((a) => a.endsWith('random-unrelated.txt')));
  });

  test('legacy journal schema permits legacy .bak in backup directory without orphaned-artifact classification', () => {
    const repo = createTempDir('tx-legacy-bak-');
    const txId = generateTxId();
    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Manually write a legacy journal containing stagedPath
    const ciPatchDir = path.join(repo, '.ci-patch');
    fs.mkdirSync(ciPatchDir, { recursive: true });
    const legacyJournal = {
      schemaVersion: '1.0.0',
      txId,
      op: 'apply',
      phase: 'BACKUP_CREATED',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      stagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(ciPatchDir, 'journal.json'), JSON.stringify(legacyJournal, null, 2) + '\n', 'utf8');

    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    fs.writeFileSync(path.join(txBackupDir, 'stable-diffusion.js.bak'), 'legacy-backup-bytes', 'utf8');

    const state = inspectTransactionState(repo);
    // Legacy journal allows .bak without marking as orphaned-artifact
    assert.ok(!state.orphanedArtifacts.some((a) => a.endsWith('stable-diffusion.js.bak')));
  });

  test('backup requirement enforced in READY_TO_SWAP, SWAPPED, and COMPLETED phases', () => {
    for (const phase of ['READY_TO_SWAP', 'SWAPPED', 'COMPLETED']) {
      const repo = createTempDir(`tx-phase-${phase.toLowerCase()}-`);
      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'ISOLATED_PREPARED',
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        lease,
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'BACKUP_CREATED',
        metadataUpdate: {
          backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
          targetMode: '0644',
        },
        lease,
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'READY_TO_SWAP',
        metadataUpdate: {
          destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`,
        },
        lease,
      });

      if (phase === 'SWAPPED' || phase === 'COMPLETED') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'SWAPPED',
          lease,
        });
      }
      if (phase === 'COMPLETED') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'COMPLETED',
          lease,
        });
      }

      const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
      fs.mkdirSync(txStagingDir, { recursive: true });
      fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'code', 'utf8');

      // Empty backup directory
      const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
      fs.mkdirSync(txBackupDir, { recursive: true });

      const state = inspectTransactionState(repo);
      assert.equal(state.state, 'incomplete-transaction');
      assert.equal(state.isPending, true);
      assert.ok(
        state.reasons.some((r) => r.includes(`Missing backup artifact in phase "${phase}"`)),
        `Expected missing backup artifact reason for phase "${phase}"`
      );
    }
  });
});

describe('P3B-2B-F3: Finding A — Production Inspector Isolation & Pure No-Follow Capability Check', () => {
  const stockSha = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
  const patchedSha = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';

  function setupValidBackupState(prefix = 'insp-f3-') {
    const dummyContent = 'authentic test backup content\n';
    const dummySha = crypto.createHash('sha256').update(dummyContent).digest('hex');
    const repo = createTempDir(prefix);
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: dummySha,
      expectedResultSha256: patchedSha,
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      lease,
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
      lease,
    });

    const txStagingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(txStagingDir, { recursive: true });
    fs.writeFileSync(path.join(txStagingDir, 'stable-diffusion.js'), 'code', 'utf8');

    const txBackupDir = path.join(repo, '.ci-patch/backup', txId);
    fs.mkdirSync(txBackupDir, { recursive: true });
    const backupFile = path.join(txBackupDir, 'stable-diffusion.js');
    fs.writeFileSync(backupFile, dummyContent);

    return { repo, txId, lease, backupFile, dummyContent, dummySha };
  }

  test('pure predicate hasRequiredNoFollow strictly validates platform capability', () => {
    // 1. Valid on real platform constants
    assert.equal(hasRequiredNoFollow(fs.constants), true);
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: 131072 }), true);
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: 1 }), true);

    // 2. Missing or zero-valued rejected
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: 0 }), false);
    assert.equal(hasRequiredNoFollow({}), false);
    assert.equal(hasRequiredNoFollow(null), false);
    assert.equal(hasRequiredNoFollow(undefined), false);

    // 3. Non-integer or non-number rejected
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: '131072' }), false);
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: NaN }), false);
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: Infinity }), false);
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: 131072.5 }), false);
    assert.equal(hasRequiredNoFollow({ O_NOFOLLOW: true }), false);
  });

  test('pure predicate hasRequiredLiveTargetFlags strictly validates platform capabilities (O_NOFOLLOW and O_NONBLOCK)', () => {
    // 1. Valid on real platform constants
    assert.equal(hasRequiredLiveTargetFlags(fs.constants), true);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: 2048 }), true);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 1, O_NONBLOCK: 1 }), true);

    // 2. Missing or zero-valued O_NONBLOCK rejected
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072 }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: 0 }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: null }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: undefined }), false);

    // 3. Missing or zero-valued O_NOFOLLOW rejected
    assert.equal(hasRequiredLiveTargetFlags({ O_NONBLOCK: 2048 }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 0, O_NONBLOCK: 2048 }), false);

    // 4. Missing or invalid constants object rejected
    assert.equal(hasRequiredLiveTargetFlags({}), false);
    assert.equal(hasRequiredLiveTargetFlags(null), false);
    assert.equal(hasRequiredLiveTargetFlags(undefined), false);

    // 5. Non-integer or non-number O_NONBLOCK rejected
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: '2048' }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: NaN }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: Infinity }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: 2048.5 }), false);
    assert.equal(hasRequiredLiveTargetFlags({ O_NOFOLLOW: 131072, O_NONBLOCK: true }), false);
  });

  test('production inspectTransactionState always uses real platform constants and ignores caller _fsConstants', () => {
    const { repo } = setupValidBackupState('insp-f3-prod-flags-');
    const origOpenSync = fs.openSync;
    let observedFlags = null;
    let openCount = 0;
    try {
      fs.openSync = (p, flags, ...args) => {
        openCount++;
        observedFlags = flags;
        return origOpenSync(p, flags, ...args);
      };

      // Caller attempts to pass _fsConstants override
      const state = inspectTransactionState(repo, {
        _fsConstants: { O_RDONLY: 0x1111, O_NOFOLLOW: 0x2222 },
      });

      assert.equal(state.state, 'ownership-unverified');
      assert.equal(state.isPending, true);
      assert.equal(openCount, 1);
      // Real platform constants must be used, NOT caller-supplied numbers
      assert.equal(observedFlags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      assert.notEqual(observedFlags, 0x1111 | 0x2222);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('production inspectBackupArtifactFile always uses real platform constants and ignores extra caller arguments', () => {
    const { backupFile, dummySha } = setupValidBackupState('insp-f3-direct-flags-');
    const origOpenSync = fs.openSync;
    let observedFlags = null;
    let openCount = 0;
    try {
      fs.openSync = (p, flags, ...args) => {
        openCount++;
        observedFlags = flags;
        return origOpenSync(p, flags, ...args);
      };

      // Caller attempts to supply synthetic constants as a 5th argument
      const res = inspectBackupArtifactFile(
        backupFile,
        dummySha,
        'BACKUP_CREATED',
        'backup/txId/stable-diffusion.js',
        { O_RDONLY: 0x1111, O_NOFOLLOW: 0x2222 }
      );

      assert.equal(res.ok, true);
      assert.equal(openCount, 1);
      assert.equal(observedFlags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      assert.notEqual(observedFlags, 0x1111 | 0x2222);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('classifies EACCES during backup inspection as inspection-error with isPending true', () => {
    const { repo, txId } = setupValidBackupState('insp-f3-eacces-');
    const origLstatSync = fs.lstatSync;
    try {
      fs.lstatSync = (p, ...args) => {
        if (typeof p === 'string' && p.endsWith(path.join('.ci-patch/backup', txId, 'stable-diffusion.js'))) {
          const err = new Error('Permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return origLstatSync(p, ...args);
      };

      const state = inspectTransactionState(repo);
      assert.equal(state.state, 'inspection-error');
      assert.equal(state.isPending, true);
      assert.ok(
        state.reasons.some((r) => r.includes('EACCES') || r.includes('Permission denied') || r.includes('Failed to inspect backup artifact')),
        'Expected inspection-error reason for EACCES'
      );
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });

  test('classifies EIO during backup inspection as inspection-error with isPending true', () => {
    const { repo, txId } = setupValidBackupState('insp-f3-eio-');
    const origLstatSync = fs.lstatSync;
    try {
      fs.lstatSync = (p, ...args) => {
        if (typeof p === 'string' && p.endsWith(path.join('.ci-patch/backup', txId, 'stable-diffusion.js'))) {
          const err = new Error('I/O error reading backup file');
          err.code = 'EIO';
          throw err;
        }
        return origLstatSync(p, ...args);
      };

      const state = inspectTransactionState(repo);
      assert.equal(state.state, 'inspection-error');
      assert.equal(state.isPending, true);
      assert.ok(
        state.reasons.some((r) => r.includes('EIO') || r.includes('I/O error') || r.includes('Failed to inspect backup artifact')),
        'Expected inspection-error reason for EIO'
      );
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });

  test('distinguishes missing backup file (ENOENT) as incomplete-transaction', () => {
    const { repo, backupFile } = setupValidBackupState('insp-f3-missing-');
    fs.unlinkSync(backupFile);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(
      state.reasons.some((r) => r.includes('Missing backup artifact in phase "BACKUP_CREATED"')),
      'Expected incomplete-transaction reason for missing backup'
    );
  });

  test('direct inspectBackupArtifactFile distinguishes pathCheck EACCES from ENOENT unlinking', () => {
    const { backupFile, dummySha } = setupValidBackupState('insp-f3-direct-errs-');

    const origLstatSync = fs.lstatSync;
    // 1. EACCES during post-descriptor getPathLstat
    let lstatCount = 0;
    try {
      fs.lstatSync = (p, ...args) => {
        lstatCount++;
        // First lstat is inside inspectBackupArtifactFile post-read
        if (lstatCount === 1) {
          const err = new Error('Permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return origLstatSync(p, ...args);
      };

      const res = inspectBackupArtifactFile(
        backupFile,
        dummySha,
        'BACKUP_CREATED',
        'backup/txId/stable-diffusion.js'
      );
      assert.equal(res.ok, false);
      assert.equal(res.isError, true);
      assert.match(res.reason, /Failed to inspect backup pathname/);
    } finally {
      fs.lstatSync = origLstatSync;
    }

    // 2. ENOENT unlinked during inspection
    lstatCount = 0;
    try {
      fs.lstatSync = (p, ...args) => {
        lstatCount++;
        if (lstatCount === 1) {
          const err = new Error('No such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        return origLstatSync(p, ...args);
      };

      const res = inspectBackupArtifactFile(
        backupFile,
        dummySha,
        'BACKUP_CREATED',
        'backup/txId/stable-diffusion.js'
      );
      assert.equal(res.ok, false);
      assert.equal(res.isIncomplete, true);
      assert.match(res.reason, /Backup artifact was unlinked during inspection/);
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });
});

describe('P3B-2C: Destination Candidate Inspection & Lifecycle (transaction-state.js)', () => {
  const stockContent = 'original stock content 11111';
  const stockSha = crypto.createHash('sha256').update(stockContent).digest('hex');
  const patchedContent = 'patched result content 22222';
  const patchedSha = crypto.createHash('sha256').update(patchedContent).digest('hex');

  test('orphan destination candidate discovered when .ci-patch is absent', () => {
    const repo = createTempDir('tx-orphan-no-cipatch-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const orphanCandidate = path.join(endpointsDir, '.stable-diffusion.js.ci-staged-orphanTx123.tmp');
    fs.writeFileSync(orphanCandidate, 'console.log("orphan candidate");');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.includes('src/endpoints/.stable-diffusion.js.ci-staged-orphanTx123.tmp'), true);
  });

  test('candidate present in BACKUP_CREATED phase is classified as incomplete-transaction', () => {
    const repo = createTempDir('tx-candidate-backup-created-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    // Advance to ISOLATED_PREPARED
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      lease,
      metadataUpdate: {
        isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
      },
    });

    // Advance to BACKUP_CREATED
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      lease,
      metadataUpdate: {
        backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
        targetMode: '0644',
      },
    });

    // Create staging and backup dirs with valid content
    fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
    fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);

    // Create candidate in src/endpoints (premature before READY_TO_SWAP)
    const prematureCandidate = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(prematureCandidate, 'premature');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.match(state.reasons.join(' '), /Interrupted destination staging detected/);
  });

  test('missing candidate in READY_TO_SWAP phase is classified as incomplete-transaction', () => {
    const repo = createTempDir('tx-missing-candidate-ready-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      lease,
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      lease,
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      lease,
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
    });

    fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
    fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);

    // Candidate file NOT created in src/endpoints
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.match(state.reasons.join(' '), /Missing destination candidate in phase "READY_TO_SWAP"/);
  });

  test('valid candidate in READY_TO_SWAP phase is classified as ownership-unverified and consistent', () => {
    const repo = createTempDir('tx-valid-candidate-ready-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      lease,
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      lease,
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      lease,
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
    });

    fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
    fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);

    // Live target contains certified initial stock bytes
    const liveTargetPath = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTargetPath, stockContent);
    fs.chmodSync(liveTargetPath, 0o644);

    // Create candidate matching patchedSha and targetMode 0644
    const candidatePath = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidatePath, patchedContent);
    fs.chmodSync(candidatePath, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('corrupted candidate (hash mismatch) in READY_TO_SWAP is classified as incomplete-transaction', () => {
    const repo = createTempDir('tx-corrupt-candidate-ready-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'ISOLATED_PREPARED',
      lease,
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'BACKUP_CREATED',
      lease,
      metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId,
      nextPhase: 'READY_TO_SWAP',
      lease,
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
    });

    fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
    fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);

    // Create candidate with wrong content
    const candidatePath = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidatePath, 'tampered content');
    fs.chmodSync(candidatePath, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.match(state.reasons.join(' '), /Corrupted destination candidate/);
  });

  test('candidate symlink in src/endpoints is classified as unsafe-symlink', () => {
    const repo = createTempDir('tx-symlink-candidate-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const txId = generateTxId();
    const candidatePath = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    const dummyTarget = path.join(repo, 'dummy.txt');
    fs.writeFileSync(dummyTarget, 'dummy');
    fs.symlinkSync(dummyTarget, candidatePath);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'unsafe-symlink');
    assert.equal(state.isPending, true);
    assert.match(state.reasons.join(' '), /Destination candidate .* is a symbolic link/);
  });

  test('ordinary endpoint files in src/endpoints are ignored by inspector', () => {
    const repo = createTempDir('tx-ordinary-endpoints-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    fs.writeFileSync(path.join(endpointsDir, 'stable-diffusion.js'), 'live target');
    fs.writeFileSync(path.join(endpointsDir, 'openai.js'), 'another endpoint');
    fs.writeFileSync(path.join(endpointsDir, '.ignored-hidden.js'), 'hidden file');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'none');
    assert.equal(state.isPending, false);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('SWAPPED and COMPLETED phases do not require temporary candidate', () => {
    for (const phase of ['SWAPPED', 'COMPLETED']) {
      const repo = createTempDir(`tx-absent-candidate-${phase.toLowerCase()}-`);
      const endpointsDir = path.join(repo, 'src/endpoints');
      fs.mkdirSync(endpointsDir, { recursive: true });

      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'ISOLATED_PREPARED',
        lease,
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'BACKUP_CREATED',
        lease,
        metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'READY_TO_SWAP',
        lease,
        metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'SWAPPED',
        lease,
      });
      if (phase === 'COMPLETED') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'COMPLETED',
          lease,
        });
      }

      fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
      fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
      fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
      fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);

      // Candidate file is absent (already swapped into place)
      const liveTargetPath = path.join(endpointsDir, 'stable-diffusion.js');
      fs.writeFileSync(liveTargetPath, patchedContent);
      fs.chmodSync(liveTargetPath, 0o644);

      const state = inspectTransactionState(repo);
      // Absent candidate does not make it incomplete-transaction
      assert.notEqual(state.state, 'incomplete-transaction');
    }
  });

  test('SWAPPED or COMPLETED phase with leftover candidate classified as orphaned-artifact', () => {
    for (const phase of ['SWAPPED', 'COMPLETED']) {
      const repo = createTempDir(`tx-leftover-candidate-${phase.toLowerCase()}-`);
      const endpointsDir = path.join(repo, 'src/endpoints');
      fs.mkdirSync(endpointsDir, { recursive: true });

      const txId = generateTxId();
      const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

      createJournal({
        repoRoot: repo,
        txId,
        op: 'apply',
        targetFile: 'src/endpoints/stable-diffusion.js',
        expectedInitialSha256: stockSha,
        expectedResultSha256: patchedSha,
        lease,
      });

      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'ISOLATED_PREPARED',
        lease,
        metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'BACKUP_CREATED',
        lease,
        metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'READY_TO_SWAP',
        lease,
        metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
      });
      advanceJournalPhase({
        repoRoot: repo,
        txId,
        nextPhase: 'SWAPPED',
        lease,
      });
      if (phase === 'COMPLETED') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: 'COMPLETED',
          lease,
        });
      }

      fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
      fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
      fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
      fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);

      // Candidate remains present unexpectedly
      const leftoverCandidate = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
      fs.writeFileSync(leftoverCandidate, 'leftover');

      const state = inspectTransactionState(repo);
      assert.equal(state.state, 'orphaned-artifact');
      assert.equal(state.isPending, true);
      assert.equal(state.orphanedArtifacts.includes(`src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`), true);
    }
  });

  test('inspectDestinationCandidateFile enforces MAX_DESTINATION_INSPECT_BYTES and permissions', () => {
    const dir = createTempDir('inspect-candidate-unit-');
    const candidateFile = path.join(dir, 'test-candidate.tmp');
    fs.writeFileSync(candidateFile, 'hello candidate');
    fs.chmodSync(candidateFile, 0o644);

    const hash = crypto.createHash('sha256').update('hello candidate').digest('hex');

    // Matching inspection
    const goodRes = inspectDestinationCandidateFile(candidateFile, hash, '0644', 'READY_TO_SWAP', 'test-candidate.tmp');
    assert.equal(goodRes.ok, true);

    // Mode mismatch
    const badModeRes = inspectDestinationCandidateFile(candidateFile, hash, '0600', 'READY_TO_SWAP', 'test-candidate.tmp');
    assert.equal(badModeRes.ok, false);
    assert.equal(badModeRes.isIncomplete, true);
    assert.match(badModeRes.reason, /mode mismatch/);

    // Oversized check (simulated via fstatSync override)
    const origFstatSync = fs.fstatSync;
    try {
      fs.fstatSync = (fd, ...args) => {
        const s = origFstatSync(fd, ...args);
        s.size = MAX_DESTINATION_INSPECT_BYTES + 1;
        return s;
      };
      const oversizeRes = inspectDestinationCandidateFile(candidateFile, hash, '0644', 'READY_TO_SWAP', 'test-candidate.tmp');
      assert.equal(oversizeRes.ok, false);
      assert.equal(oversizeRes.isOversized, true);
      assert.match(oversizeRes.reason, /exceeds safety limit/);
    } finally {
      fs.fstatSync = origFstatSync;
    }
  });

  test('foreign transaction candidate in src/endpoints is classified as orphaned-artifact', () => {
    const repo = createTempDir('tx-foreign-candidate-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const activeTxId = generateTxId();
    const foreignTxId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId: activeTxId, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId: activeTxId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    advanceJournalPhase({
      repoRoot: repo,
      txId: activeTxId,
      nextPhase: 'ISOLATED_PREPARED',
      lease,
      metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${activeTxId}/stable-diffusion.js` },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId: activeTxId,
      nextPhase: 'BACKUP_CREATED',
      lease,
      metadataUpdate: { backupPath: `.ci-patch/backup/${activeTxId}/stable-diffusion.js`, targetMode: '0644' },
    });
    advanceJournalPhase({
      repoRoot: repo,
      txId: activeTxId,
      nextPhase: 'READY_TO_SWAP',
      lease,
      metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${activeTxId}.tmp` },
    });

    fs.mkdirSync(path.join(repo, `.ci-patch/staging/${activeTxId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${activeTxId}/stable-diffusion.js`), patchedContent);
    fs.mkdirSync(path.join(repo, `.ci-patch/backup/${activeTxId}`), { recursive: true });
    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${activeTxId}/stable-diffusion.js`), stockContent);

    // Active candidate
    const activeCandidate = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${activeTxId}.tmp`);
    fs.writeFileSync(activeCandidate, patchedContent);
    fs.chmodSync(activeCandidate, 0o644);

    // Foreign candidate for a different transaction
    const foreignCandidate = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${foreignTxId}.tmp`);
    fs.writeFileSync(foreignCandidate, 'foreign candidate content');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.includes(`src/endpoints/.stable-diffusion.js.ci-staged-${foreignTxId}.tmp`));
  });

  test('orphan destination candidate with corrupted journal is classified as orphaned-artifact with corrupt journal registered', () => {
    const repo = createTempDir('tx-orphan-corrupt-journal-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const ciPatchDir = path.join(repo, '.ci-patch');
    fs.mkdirSync(ciPatchDir, { recursive: true });
    fs.writeFileSync(path.join(ciPatchDir, 'journal.json'), '{ invalid json content');

    const orphanCandidate = path.join(endpointsDir, '.stable-diffusion.js.ci-staged-orphanTx777.tmp');
    fs.writeFileSync(orphanCandidate, 'orphan candidate bytes');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.equal(state.journal?.isValid, false);
    assert.ok(state.orphanedArtifacts.includes('src/endpoints/.stable-diffusion.js.ci-staged-orphanTx777.tmp'));
    assert.ok(state.reasons.some((r) => r.includes('corrupted') || r.includes('JSON') || r.includes('SyntaxError') || r.includes('failed to parse')));
  });
});

describe('P3B-2D-1: Read-Only Post-Swap State Inspection (transaction-state.js)', () => {
  const stockContent = 'function stockTarget() { return "stock"; }\n';
  const stockSha = crypto.createHash('sha256').update(stockContent).digest('hex');
  const patchedContent = 'function stockTarget() { return "patched"; }\n';
  const patchedSha = crypto.createHash('sha256').update(patchedContent).digest('hex');

  function setupTxAtPhase(repo, targetPhase, { txId = generateTxId(), op = 'apply' } = {}) {
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const { lease } = acquireLock({ repoRoot: repo, txId, op });

    createJournal({
      repoRoot: repo,
      txId,
      op,
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const phases = ['ISOLATED_PREPARED', 'BACKUP_CREATED', 'READY_TO_SWAP', 'SWAPPED', 'COMPLETED'];
    for (const p of phases) {
      if (p === 'ISOLATED_PREPARED') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: p,
          lease,
          metadataUpdate: { isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js` },
        });
        fs.mkdirSync(path.join(repo, `.ci-patch/staging/${txId}`), { recursive: true });
        fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), patchedContent);
      } else if (p === 'BACKUP_CREATED') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: p,
          lease,
          metadataUpdate: { backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`, targetMode: '0644' },
        });
        fs.mkdirSync(path.join(repo, `.ci-patch/backup/${txId}`), { recursive: true });
        fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), stockContent);
      } else if (p === 'READY_TO_SWAP') {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: p,
          lease,
          metadataUpdate: { destinationStagedPath: `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp` },
        });
      } else {
        advanceJournalPhase({
          repoRoot: repo,
          txId,
          nextPhase: p,
          lease,
        });
      }
      if (p === targetPhase) break;
    }

    return { txId, lease, endpointsDir };
  }

  test('1. Normal READY_TO_SWAP state with candidate', () => {
    const repo = createTempDir('tx-p3b2d1-normal-ready-');
    const { txId, endpointsDir } = setupTxAtPhase(repo, 'READY_TO_SWAP');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, stockContent);
    fs.chmodSync(liveTarget, 0o644);

    const candidate = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidate, patchedContent);
    fs.chmodSync(candidate, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('2. Missing candidate and unchanged live target in READY_TO_SWAP', () => {
    const repo = createTempDir('tx-p3b2d1-missing-cand-');
    const { endpointsDir } = setupTxAtPhase(repo, 'READY_TO_SWAP');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, stockContent);
    fs.chmodSync(liveTarget, 0o644);

    // Candidate absent
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Missing destination candidate in phase "READY_TO_SWAP"')));
    assert.ok(!state.reasons.some((r) => r.includes('Possible unrecorded swap')));
  });

  test('3. Missing candidate but live target containing expected result in READY_TO_SWAP', () => {
    const repo = createTempDir('tx-p3b2d1-unrecorded-swap-');
    const { endpointsDir } = setupTxAtPhase(repo, 'READY_TO_SWAP');

    // Live target has patched bytes (expected result)
    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o644);

    // Candidate absent
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Possible unrecorded swap detected')));
    assert.ok(state.reasons.some((r) => r.includes('destination candidate absent, but live target contains expected result')));
  });

  test('4. SWAPPED with expected result and missing candidate', () => {
    const repo = createTempDir('tx-p3b2d1-swapped-normal-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o644);

    // Candidate absent (consumed by swap)
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('5. SWAPPED with initial bytes', () => {
    const repo = createTempDir('tx-p3b2d1-swapped-initial-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, stockContent);
    fs.chmodSync(liveTarget, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Incomplete swap detected: journal phase is "SWAPPED" but live target still contains initial content')));
  });

  test('6. SWAPPED with unexpected bytes', () => {
    const repo = createTempDir('tx-p3b2d1-swapped-unexpected-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, 'completely unexpected content');
    fs.chmodSync(liveTarget, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Live target content mismatch in phase "SWAPPED"')));
  });

  test('7. COMPLETED with valid result and missing candidate', () => {
    const repo = createTempDir('tx-p3b2d1-completed-normal-');
    const { endpointsDir } = setupTxAtPhase(repo, 'COMPLETED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    assert.equal(state.isPending, true);
    assert.equal(state.orphanedArtifacts.length, 0);
  });

  test('8. COMPLETED with wrong content', () => {
    const repo = createTempDir('tx-p3b2d1-completed-wrong-');
    const { endpointsDir } = setupTxAtPhase(repo, 'COMPLETED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, stockContent);
    fs.chmodSync(liveTarget, 0o644);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Live target content mismatch in phase "COMPLETED"')));
  });

  test('9. Live-target symlink triggers unsafe-symlink', () => {
    const repo = createTempDir('tx-p3b2d1-target-symlink-');
    const { endpointsDir } = setupTxAtPhase(repo, 'READY_TO_SWAP');

    const externalFile = path.join(repo, 'external.js');
    fs.writeFileSync(externalFile, stockContent);

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.symlinkSync(externalFile, liveTarget);

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'unsafe-symlink');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Live target file is a symbolic link')));
  });

  test('10. Missing live target in SWAPPED triggers incomplete-transaction', () => {
    const repo = createTempDir('tx-p3b2d1-target-missing-');
    setupTxAtPhase(repo, 'SWAPPED');

    // stable-diffusion.js does NOT exist
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Missing live target file in phase "SWAPPED"')));
  });

  test('11. Wrong live-target mode in SWAPPED triggers incomplete-transaction', () => {
    const repo = createTempDir('tx-p3b2d1-target-mode-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o600); // 0600 instead of expected 0644

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'incomplete-transaction');
    assert.equal(state.isPending, true);
    assert.ok(state.reasons.some((r) => r.includes('Live target mode mismatch in phase "SWAPPED"')));
  });

  test('12. Oversized or concurrently changed live target', () => {
    const repo = createTempDir('tx-p3b2d1-oversized-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    // Create a real sparse file exceeding 50 MiB specifically for the live target
    const fd = fs.openSync(liveTarget, 'w');
    fs.ftruncateSync(fd, MAX_LIVE_TARGET_INSPECT_BYTES + 1);
    fs.closeSync(fd);
    fs.chmodSync(liveTarget, 0o644);

    // Part A: Precise oversized live target (> 50 MiB) without monkey-patching fstatSync
    // Preserves ordinary staging and backup inspection (backup remains small and valid)
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'inspection-error');
    assert.equal(state.isPending, true);
    // Asserts a diagnostic explicitly identifying the live target and its size limit
    assert.ok(
      state.reasons.some(
        (r) =>
          r.includes('Live target size') &&
          r.includes('exceeds safety limit') &&
          r.includes('52428800 bytes') &&
          r.includes('src/endpoints/stable-diffusion.js')
      ),
      'Expected explicit diagnostic identifying oversized live target'
    );
    // Verifies backup inspection was NOT the source of error
    assert.ok(
      !state.reasons.some((r) => r.includes('Backup artifact size')),
      'Backup inspection must not be triggered as oversized'
    );
    // Verifies no file modification and no descriptor leaks
    const st = fs.statSync(liveTarget);
    assert.equal(st.size, MAX_LIVE_TARGET_INSPECT_BYTES + 1);

    // Also verify unit inspectLiveTargetFile directly reports isOversized and isError
    const unitOversized = inspectLiveTargetFile(
      liveTarget,
      stockSha,
      patchedSha,
      '0644',
      'SWAPPED',
      'src/endpoints/stable-diffusion.js'
    );
    assert.equal(unitOversized.ok, false);
    assert.equal(unitOversized.isOversized, true);
    assert.equal(unitOversized.isError, true);
    assert.match(unitOversized.reason, /Live target size .* exceeds safety limit/);

    // Part B: Simulated concurrent permission change during descriptor readback
    const repoB = createTempDir('tx-p3b2d1-perm-change-');
    const { endpointsDir: edB } = setupTxAtPhase(repoB, 'SWAPPED');
    const liveTargetB = path.join(edB, 'stable-diffusion.js');
    fs.writeFileSync(liveTargetB, patchedContent);
    fs.chmodSync(liveTargetB, 0o644);

    const origFstatSync = fs.fstatSync;
    let callCount = 0;
    try {
      fs.fstatSync = (fdesc, ...args) => {
        const s = origFstatSync(fdesc, ...args);
        callCount++;
        if (callCount > 1) {
          s.mode = (s.mode & ~0o777) | 0o700;
        }
        return s;
      };
      const unitRes = inspectLiveTargetFile(
        liveTargetB,
        stockSha,
        patchedSha,
        '0644',
        'SWAPPED',
        'src/endpoints/stable-diffusion.js'
      );
      assert.equal(unitRes.ok, false);
      assert.equal(unitRes.isIncomplete, true);
      assert.match(unitRes.reason, /permissions changed concurrently/);
    } finally {
      fs.fstatSync = origFstatSync;
    }
  });

  test('13. Unexpected candidate remaining after swap triggers orphaned-artifact', () => {
    const repo = createTempDir('tx-p3b2d1-leftover-cand-');
    const { txId, endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o644);

    const leftover = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(leftover, 'leftover');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.includes(`src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`));
  });

  test('14. Existing orphan detection when .ci-patch is absent', () => {
    const repo = createTempDir('tx-p3b2d1-no-patch-dir-');
    const endpointsDir = path.join(repo, 'src/endpoints');
    fs.mkdirSync(endpointsDir, { recursive: true });

    const candidate = path.join(endpointsDir, '.stable-diffusion.js.ci-staged-tx9999.tmp');
    fs.writeFileSync(candidate, 'orphaned candidate content');

    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'orphaned-artifact');
    assert.equal(state.isPending, true);
    assert.ok(state.orphanedArtifacts.includes('src/endpoints/.stable-diffusion.js.ci-staged-tx9999.tmp'));
  });

  test('15. Preservation of isPending and existing state precedence', () => {
    // Test A: unsafe-symlink takes precedence over incomplete-transaction
    const repo1 = createTempDir('tx-p3b2d1-prec-symlink-');
    const { endpointsDir: ed1 } = setupTxAtPhase(repo1, 'READY_TO_SWAP');
    const ext = path.join(repo1, 'ext.js');
    fs.writeFileSync(ext, 'content');
    fs.symlinkSync(ext, path.join(ed1, 'stable-diffusion.js'));
    const state1 = inspectTransactionState(repo1);
    assert.equal(state1.state, 'unsafe-symlink');
    assert.equal(state1.isPending, true);

    // Test B: foreign-content takes precedence over incomplete-transaction
    const repo2 = createTempDir('tx-p3b2d1-prec-foreign-');
    setupTxAtPhase(repo2, 'SWAPPED');
    fs.writeFileSync(path.join(repo2, '.ci-patch/foreign.txt'), 'extra');
    const state2 = inspectTransactionState(repo2);
    assert.equal(state2.state, 'foreign-content');
    assert.equal(state2.isPending, true);

    // Test C: isPending invariant: true for all non-none states, false only for none
    const cleanRepo = createTempDir('tx-p3b2d1-clean-');
    const cleanState = inspectTransactionState(cleanRepo);
    assert.equal(cleanState.state, 'none');
    assert.equal(cleanState.isPending, false);
  });

  test('16. Read-only behavior, with no mutations to inspected fixtures', () => {
    const repo = createTempDir('tx-p3b2d1-readonly-');
    const { txId, endpointsDir } = setupTxAtPhase(repo, 'READY_TO_SWAP');

    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, stockContent);
    fs.chmodSync(liveTarget, 0o644);

    const candidate = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidate, patchedContent);
    fs.chmodSync(candidate, 0o644);

    function snapshotRepo(dir) {
      const snap = {};
      for (const entry of fs.readdirSync(dir, { recursive: true })) {
        const full = path.join(dir, entry);
        const st = fs.lstatSync(full);
        snap[entry] = {
          mode: st.mode,
          size: st.size,
          dev: st.dev,
          ino: st.ino,
          mtimeMs: st.mtimeMs,
          content: st.isFile() ? fs.readFileSync(full, 'hex') : null,
        };
      }
      return snap;
    }

    const before = snapshotRepo(repo);
    const state = inspectTransactionState(repo);
    assert.equal(state.state, 'ownership-unverified');
    const after = snapshotRepo(repo);

    assert.deepEqual(after, before);
  });

  test('17. Amendments B & C: Live target is directory or FIFO fails closed without orphaned-artifact and without blocking', (t) => {
    // Directory live target
    const repoDir = createTempDir('tx-p3b2d1-target-dir-');
    const { endpointsDir: edDir } = setupTxAtPhase(repoDir, 'SWAPPED');
    fs.mkdirSync(path.join(edDir, 'stable-diffusion.js'));

    const stateDir = inspectTransactionState(repoDir);
    assert.equal(stateDir.state, 'incomplete-transaction');
    assert.equal(stateDir.isPending, true);
    assert.equal(stateDir.orphanedArtifacts.length, 0);
    assert.ok(stateDir.reasons.some((r) => r.includes('not a regular file')));

    // Check whether mkfifo is available before running the FIFO test
    let hasMkfifo = false;
    try {
      child_process.execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
      hasMkfifo = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        hasMkfifo = true;
      }
    }

    if (!hasMkfifo) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping FIFO live target check: mkfifo utility is not available on this platform');
      }
      return;
    }

    // FIFO live target with mkfifo
    const repoFifo = createTempDir('tx-p3b2d1-target-fifo-');
    const { endpointsDir: edFifo } = setupTxAtPhase(repoFifo, 'SWAPPED');
    const fifoTarget = path.join(edFifo, 'stable-diffusion.js');
    child_process.execFileSync('mkfifo', [fifoTarget]);

    const stateFifo = inspectTransactionState(repoFifo);
    assert.equal(stateFifo.state, 'incomplete-transaction');
    assert.equal(stateFifo.isPending, true);
    assert.equal(stateFifo.orphanedArtifacts.length, 0);
    assert.ok(stateFifo.reasons.some((r) => r.includes('not a regular file')));

    const fifoUnit = inspectLiveTargetFile(
      fifoTarget,
      stockSha,
      patchedSha,
      '0644',
      'SWAPPED',
      'src/endpoints/stable-diffusion.js'
    );
    assert.equal(fifoUnit.ok, false);
    assert.equal(fifoUnit.isUnsupportedType, true);
    assert.equal(fifoUnit.isIncomplete, true);
  });

  test('production inspectLiveTargetFile strictly uses real platform constants (O_RDONLY | O_NOFOLLOW | O_NONBLOCK)', () => {
    const repo = createTempDir('tx-p3b2d1-flags-check-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');
    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o644);

    const origOpenSync = fs.openSync;
    let observedFlags = null;
    let openCount = 0;
    try {
      fs.openSync = (p, flags, ...args) => {
        if (typeof p === 'string' && p.endsWith('stable-diffusion.js')) {
          openCount++;
          observedFlags = flags;
        }
        return origOpenSync(p, flags, ...args);
      };

      const res = inspectLiveTargetFile(
        liveTarget,
        stockSha,
        patchedSha,
        '0644',
        'SWAPPED',
        'src/endpoints/stable-diffusion.js'
      );
      assert.equal(res.ok, true);
      assert.equal(openCount, 1);
      const expectedFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
      assert.equal(observedFlags, expectedFlags);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('TOCTOU race: regular file becoming FIFO between precheck and open fails closed safely and non-blockingly', (t) => {
    let hasMkfifo = false;
    try {
      child_process.execFileSync('mkfifo', ['--version'], { stdio: 'ignore' });
      hasMkfifo = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        hasMkfifo = true;
      }
    }

    if (!hasMkfifo) {
      if (typeof t?.diagnostic === 'function') {
        t.diagnostic('Skipping TOCTOU FIFO test: mkfifo utility is not available on this platform');
      }
      return;
    }

    const repo = createTempDir('tx-p3b2d1-toctou-fifo-');
    const { endpointsDir } = setupTxAtPhase(repo, 'SWAPPED');
    const liveTarget = path.join(endpointsDir, 'stable-diffusion.js');
    fs.writeFileSync(liveTarget, patchedContent);
    fs.chmodSync(liveTarget, 0o644);

    const origOpenSync = fs.openSync;
    let intercepted = false;
    try {
      fs.openSync = (p, flags, ...args) => {
        if (!intercepted && typeof p === 'string' && p.endsWith('stable-diffusion.js')) {
          intercepted = true;
          // Simulate race: regular file replaced by a FIFO between precheck and open
          fs.unlinkSync(p);
          child_process.execFileSync('mkfifo', [p]);
        }
        return origOpenSync(p, flags, ...args);
      };

      const res = inspectLiveTargetFile(
        liveTarget,
        stockSha,
        patchedSha,
        '0644',
        'SWAPPED',
        'src/endpoints/stable-diffusion.js'
      );

      assert.equal(res.ok, false);
      assert.equal(res.isUnsupportedType, true);
      assert.equal(res.isIncomplete, true);
      assert.match(res.reason, /not a regular file/);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('non-ENOENT pathname inspection errors (EACCES and EIO) trigger inspection-error and do not treat target as missing', () => {
    // Case 1: EACCES error on live-target path in SWAPPED
    const repoAccess = createTempDir('tx-p3b2d1-eacces-');
    const { endpointsDir: edAccess } = setupTxAtPhase(repoAccess, 'SWAPPED');
    const liveTargetAccess = path.join(edAccess, 'stable-diffusion.js');
    fs.writeFileSync(liveTargetAccess, patchedContent);
    fs.chmodSync(liveTargetAccess, 0o644);

    const origLstatSync = fs.lstatSync;
    try {
      fs.lstatSync = (p, ...args) => {
        if (typeof p === 'string' && p.endsWith(path.join('src/endpoints', 'stable-diffusion.js'))) {
          const err = new Error('Permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return origLstatSync(p, ...args);
      };

      const stateAccess = inspectTransactionState(repoAccess);
      assert.equal(stateAccess.state, 'inspection-error');
      assert.equal(stateAccess.isPending, true);
      assert.ok(
        stateAccess.reasons.some(
          (r) =>
            r.includes('Failed to inspect live target path') &&
            (r.includes('Permission denied') || r.includes('EACCES'))
        ),
        'Expected explicit inspection-error reason for EACCES'
      );
      assert.ok(
        !stateAccess.reasons.some((r) => r.includes('Missing live target') || r.includes('Possible unrecorded swap')),
        'EACCES must not be treated as missing file or unrecorded swap'
      );
    } finally {
      fs.lstatSync = origLstatSync;
    }

    // Case 2: EIO error on live-target path in READY_TO_SWAP without candidate
    const repoIo = createTempDir('tx-p3b2d1-eio-');
    const { endpointsDir: edIo } = setupTxAtPhase(repoIo, 'READY_TO_SWAP');
    const liveTargetIo = path.join(edIo, 'stable-diffusion.js');
    fs.writeFileSync(liveTargetIo, patchedContent);
    fs.chmodSync(liveTargetIo, 0o644);

    try {
      fs.lstatSync = (p, ...args) => {
        if (typeof p === 'string' && p.endsWith(path.join('src/endpoints', 'stable-diffusion.js'))) {
          const err = new Error('Input/output error');
          err.code = 'EIO';
          throw err;
        }
        return origLstatSync(p, ...args);
      };

      const stateIo = inspectTransactionState(repoIo);
      assert.equal(stateIo.state, 'inspection-error');
      assert.equal(stateIo.isPending, true);
      assert.ok(
        stateIo.reasons.some(
          (r) =>
            r.includes('Failed to inspect live target path') &&
            (r.includes('Input/output error') || r.includes('EIO'))
        ),
        'Expected explicit inspection-error reason for EIO'
      );
      assert.ok(
        !stateIo.reasons.some((r) => r.includes('Possible unrecorded swap')),
        'EIO must not trigger unrecorded-swap logic'
      );
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });
});


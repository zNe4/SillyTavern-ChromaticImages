import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acquireLock,
  releaseLock,
  generateTxId,
  TransactionLease,
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  inspectJournal,
  advanceJournalPhase,
} from '../src/patch-installer/journal.js';

import {
  prepareIsolatedPatch,
  computeSha256,
  computeGitBlobSha,
} from '../src/patch-installer/staging.js';

import {
  createVerifiedBackup,
} from '../src/patch-installer/backup.js';

import {
  stageDestinationCandidate,
  readBoundedFile,
  MAX_DESTINATION_FILE_BYTES,
} from '../src/patch-installer/destination-staging.js';

import {
  inspectTransactionState,
} from '../src/patch-installer/transaction-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

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

function createTempDir(prefix = 'ci-dest-stage-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

function setupDisposableRepo(prefix = 'disposable-st-dest-') {
  const repoDir = createTempDir(prefix);
  child_process.execFileSync('git', ['init', '-q'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// mock server entry\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });

  return repoDir;
}

const manifest = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'));
const stockSha = manifest.patches.runtime.original.sha256.toLowerCase();
const stockBlob = manifest.patches.runtime.original.gitBlobSha.toLowerCase();
const patchedSha = manifest.patches.runtime.expected.sha256.toLowerCase();
const patchedBlob = manifest.patches.runtime.expected.gitBlobSha.toLowerCase();

function getVerifiedAuthenticStockContent(targetManifest) {
  const candidateDirs = [
    process.env.SILLYTAVERN_TEST_REPO,
    process.env.SILLYTAVERN_DIR,
    '/home/zzzne4/SillyTavern',
  ].filter(Boolean);

  const expectedSha = targetManifest.patches?.runtime?.original?.sha256?.toLowerCase();
  const expectedBlob = targetManifest.patches?.runtime?.original?.gitBlobSha?.toLowerCase();
  const releaseCommit = targetManifest.releaseCommit;
  const targetFile = targetManifest.patches?.runtime?.targetFile;

  for (const candidate of candidateDirs) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const buf = child_process.execFileSync(
        'git',
        ['-C', candidate, 'show', `${releaseCommit}:${targetFile}`],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (buf && buf.length > 0) {
        const actualSha = computeSha256(buf).toLowerCase();
        const actualBlob = computeGitBlobSha(buf).toLowerCase();
        if (actualSha === expectedSha && actualBlob === expectedBlob) {
          return buf;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function getAuthenticPatchedContent(stockBuf) {
  if (!stockBuf) return null;
  const patchPath = path.resolve(REPO_ROOT, manifest.patches.runtime.relativePath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'get-dest-patched-'));
  try {
    const targetPath = path.join(tempDir, 'stable-diffusion.js');
    fs.writeFileSync(targetPath, stockBuf);
    child_process.execFileSync(
      'git',
      ['apply', '-p3', patchPath],
      { cwd: tempDir, stdio: 'ignore' }
    );
    const patchedBuf = fs.readFileSync(targetPath);
    if (computeSha256(patchedBuf).toLowerCase() === patchedSha && computeGitBlobSha(patchedBuf).toLowerCase() === patchedBlob) {
      return patchedBuf;
    }
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const authenticStock = getVerifiedAuthenticStockContent(manifest);
const authenticPatched = authenticStock ? getAuthenticPatchedContent(authenticStock) : null;

/**
 * Setup a transaction at the BACKUP_CREATED state using authentic SillyTavern contents.
 */
function setupAuthenticBackupCreatedTx({
  repo,
  txId = generateTxId(),
  op = 'apply',
  targetMode = '0644',
}) {
  const isApply = op === 'apply';
  const initialSha = isApply ? stockSha : patchedSha;
  const resultSha = isApply ? patchedSha : stockSha;

  const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
  const liveContent = isApply ? authenticStock : authenticPatched;
  fs.writeFileSync(liveTarget, liveContent);
  fs.chmodSync(liveTarget, parseInt(targetMode, 8));

  const { lease } = acquireLock({ repoRoot: repo, txId, op });

  createJournal({
    repoRoot: repo,
    txId,
    op,
    targetFile: 'src/endpoints/stable-diffusion.js',
    expectedInitialSha256: initialSha,
    expectedResultSha256: resultSha,
    lease,
  });

  advanceJournalPhase({
    repoRoot: repo,
    txId,
    nextPhase: 'ISOLATED_PREPARED',
    lease,
    metadataUpdate: {
      isolatedStagedPath: `.ci-patch/staging/${txId}/stable-diffusion.js`,
    },
  });

  advanceJournalPhase({
    repoRoot: repo,
    txId,
    nextPhase: 'BACKUP_CREATED',
    lease,
    metadataUpdate: {
      backupPath: `.ci-patch/backup/${txId}/stable-diffusion.js`,
      targetMode,
    },
  });

  // Create staging artifact
  const stagingDir = path.join(repo, `.ci-patch/staging/${txId}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  const stagedContent = isApply ? authenticPatched : authenticStock;
  fs.writeFileSync(path.join(stagingDir, 'stable-diffusion.js'), stagedContent);
  fs.chmodSync(path.join(stagingDir, 'stable-diffusion.js'), 0o600);

  // Create backup artifact
  const backupDir = path.join(repo, `.ci-patch/backup/${txId}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupContent = isApply ? authenticStock : authenticPatched;
  fs.writeFileSync(path.join(backupDir, 'stable-diffusion.js'), backupContent);
  fs.chmodSync(path.join(backupDir, 'stable-diffusion.js'), 0o600);

  return { txId, lease, initialSha, resultSha, liveTarget };
}

describe('P3B-2C: Descriptor Bounded Reader (readBoundedFile)', () => {
  test('reads regular file and calculates matching digests', () => {
    const dir = createTempDir('read-bounded-regular-');
    const filePath = path.join(dir, 'test-file.txt');
    const content = Buffer.from('console.log("hello world");\n');
    fs.writeFileSync(filePath, content);

    const res = readBoundedFile(filePath);
    assert.equal(Buffer.compare(res.buffer, content), 0);
    assert.equal(res.sha256, computeSha256(content));
    assert.equal(res.gitBlobSha, computeGitBlobSha(content));
    assert.equal(res.stat.isFile(), true);
  });

  test('rejects file exceeding maxBytes size bound', () => {
    const dir = createTempDir('read-bounded-oversize-');
    const filePath = path.join(dir, 'large-file.bin');
    fs.writeFileSync(filePath, Buffer.alloc(1024, 0x41));

    assert.throws(
      () => readBoundedFile(filePath, { maxBytes: 512 }),
      (err) => {
        assert.equal(err.code, 'file-too-large');
        assert.match(err.message, /exceeds limit/);
        return true;
      }
    );
  });

  test('rejects directory target as file-missing', () => {
    const dir = createTempDir('read-bounded-dir-');
    assert.throws(
      () => readBoundedFile(dir),
      (err) => {
        assert.equal(err.code, 'file-missing');
        assert.match(err.message, /not a regular file/);
        return true;
      }
    );
  });

  test('rejects symbolic link with unsafe-symlink', () => {
    const dir = createTempDir('read-bounded-symlink-');
    const realFile = path.join(dir, 'real.txt');
    const linkFile = path.join(dir, 'link.txt');
    fs.writeFileSync(realFile, 'real content');
    fs.symlinkSync(realFile, linkFile);

    assert.throws(
      () => readBoundedFile(linkFile),
      (err) => {
        assert.equal(err.code, 'unsafe-symlink');
        assert.match(err.message, /symbolic link/);
        return true;
      }
    );
  });

  test('rejects when O_NOFOLLOW is unsupported on platform', () => {
    const dir = createTempDir('read-bounded-no-nofollow-');
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'test');

    assert.throws(
      () => readBoundedFile(filePath, { _testConstants: {} }),
      (err) => {
        assert.equal(err.code, 'unsupported-platform');
        assert.match(err.message, /O_NOFOLLOW/);
        return true;
      }
    );
  });
});

describe('P3B-2C: Precondition, Lock, Lease, and Journal Validation', () => {
  test('rejects missing or non-object options', async () => {
    const res1 = await stageDestinationCandidate();
    assert.equal(res1.ok, false);
    assert.equal(res1.code, 'invalid-arguments');

    const res2 = await stageDestinationCandidate(null);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'invalid-arguments');
  });

  test('rejects missing mandatory option fields', async () => {
    const repo = setupDisposableRepo('dest-stage-missing-args-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    for (const missingKey of ['repoRoot', 'txId', 'op', 'lease']) {
      const opts = { repoRoot: repo, txId, op: 'apply', lease };
      delete opts[missingKey];

      const res = await stageDestinationCandidate(opts);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'invalid-arguments');
    }
  });

  test('rejects invalid op (not apply/remove)', async () => {
    const repo = setupDisposableRepo('dest-stage-bad-op-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'invalid-op', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid-operation');
  });

  test('rejects invalid txId format', async () => {
    const repo = setupDisposableRepo('dest-stage-bad-txid-');
    const validTxId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId: validTxId, op: 'apply' });

    const res = await stageDestinationCandidate({ repoRoot: repo, txId: 'not a valid txId!!!', op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid-txid');
  });

  test('rejects when lock is missing or not acquired', async () => {
    const repo = setupDisposableRepo('dest-stage-no-lock-');
    const txId = generateTxId();
    const fakeLease = new TransactionLease(txId, repo, 'apply', 'fake-token', process.pid);

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease: fakeLease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-not-active');
  });

  test('rejects when journal is missing', async () => {
    const repo = setupDisposableRepo('dest-stage-no-journal-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid-journal');
  });

  test('rejects when journal txId does not match caller txId', async () => {
    const repo = setupDisposableRepo('dest-stage-journal-txid-mismatch-');
    const txId1 = generateTxId();
    const txId2 = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId: txId1, op: 'apply' });

    createJournal({
      repoRoot: repo,
      txId: txId1,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: stockSha,
      expectedResultSha256: patchedSha,
      lease,
    });

    const res = await stageDestinationCandidate({ repoRoot: repo, txId: txId2, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-tx-mismatch');
  });

  test('rejects when journal op does not match caller op', async () => {
    const repo = setupDisposableRepo('dest-stage-journal-op-mismatch-');
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

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'remove', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-op-mismatch');
  });

  test('rejects invalid journal phase (must be exactly BACKUP_CREATED)', async () => {
    const repo = setupDisposableRepo('dest-stage-bad-phase-');
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

    // Journal is in LOCKED phase
    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'illegal-phase');
    assert.match(res.error, /BACKUP_CREATED/);
  });

  test('rejects expired or revoked lease', async () => {
    const repo = setupDisposableRepo('dest-stage-revoked-lease-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Revoke the lease
    releaseLock({ repoRoot: repo, txId, lease });

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-not-active');
  });

  test('rejects lease with mismatched transaction ID', async () => {
    const repo = setupDisposableRepo('dest-stage-mismatched-lease-');
    const txId = generateTxId();
    acquireLock({ repoRoot: repo, txId, op: 'apply' });

    const foreignRepo = setupDisposableRepo('foreign-repo-');
    const foreignTxId = generateTxId();
    const { lease: foreignLease } = acquireLock({ repoRoot: foreignRepo, txId: foreignTxId, op: 'apply' });

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease: foreignLease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-tx-mismatch');
  });
});

describe('P3B-2C: Destination-Parent Staging - Happy Path Transitions', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping authentic happy path tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('forward/apply staging creates candidate, preserves live target, and advances to READY_TO_SWAP', async () => {
    const repo = setupDisposableRepo('dest-stage-apply-');
    const { txId, lease, resultSha, liveTarget } = setupAuthenticBackupCreatedTx({
      repo,
      op: 'apply',
    });

    const initialLiveStat = fs.statSync(liveTarget);
    const initialLiveBytes = fs.readFileSync(liveTarget);

    const stageRes = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(stageRes.ok, true);
    assert.equal(stageRes.candidatePath, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(stageRes.destinationStagedPath, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(stageRes.targetMode, '0644');
    assert.equal(stageRes.sha256, patchedSha);
    assert.equal(stageRes.journal?.phase, 'READY_TO_SWAP');
    assert.equal(stageRes.journal?.destinationStagedPath, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    // Invariant 1: Destination candidate created with exact expected bytes
    const candidateFile = path.join(repo, stageRes.candidatePath);
    assert.equal(fs.existsSync(candidateFile), true);
    const candidateBytes = fs.readFileSync(candidateFile);
    assert.equal(Buffer.compare(candidateBytes, authenticPatched), 0);

    // Invariant 2: Candidate final mode matches targetMode 0644
    const candidateStat = fs.statSync(candidateFile);
    assert.equal(candidateStat.mode & 0o777, 0o644);

    // Invariant 3: Candidate is a distinct inode from staging, backup, and live target
    const stagingStat = fs.statSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`));
    const backupStat = fs.statSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`));
    assert.notEqual(candidateStat.ino, stagingStat.ino);
    assert.notEqual(candidateStat.ino, backupStat.ino);
    assert.notEqual(candidateStat.ino, initialLiveStat.ino);

    // Invariant 4: Live target is completely unchanged
    const currentLiveBytes = fs.readFileSync(liveTarget);
    const currentLiveStat = fs.statSync(liveTarget);
    assert.equal(Buffer.compare(currentLiveBytes, initialLiveBytes), 0);
    assert.equal(currentLiveStat.dev, initialLiveStat.dev);
    assert.equal(currentLiveStat.ino, initialLiveStat.ino);
    assert.equal(currentLiveStat.mode & 0o777, initialLiveStat.mode & 0o777);

    // Invariant 5: Inspector validates READY_TO_SWAP state cleanly
    const insp = inspectTransactionState(repo);
    assert.equal(insp.state, 'ownership-unverified');
    assert.equal(insp.isPending, true);
    assert.equal(insp.orphanedArtifacts.length, 0);
  });

  test('reverse/remove staging creates candidate with stock bytes and advances to READY_TO_SWAP', async () => {
    const repo = setupDisposableRepo('dest-stage-remove-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({
      repo,
      op: 'remove',
    });

    const initialLiveStat = fs.statSync(liveTarget);

    const stageRes = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'remove',
      lease,
    });

    assert.equal(stageRes.ok, true);
    assert.equal(stageRes.candidatePath, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(stageRes.sha256, stockSha);
    assert.equal(stageRes.journal?.phase, 'READY_TO_SWAP');

    // Candidate contains stock bytes
    const candidateFile = path.join(repo, stageRes.candidatePath);
    const candidateBytes = fs.readFileSync(candidateFile);
    assert.equal(Buffer.compare(candidateBytes, authenticStock), 0);

    // Live target unchanged
    const currentLiveStat = fs.statSync(liveTarget);
    assert.equal(currentLiveStat.ino, initialLiveStat.ino);
  });

  test('targetMode 0600 is preserved on destination candidate after metadata sync', async () => {
    const repo = setupDisposableRepo('dest-stage-mode600-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({
      repo,
      targetMode: '0600',
    });

    const stageRes = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(stageRes.ok, true);
    assert.equal(stageRes.targetMode, '0600');

    const candidateFile = path.join(repo, stageRes.candidatePath);
    const candidateStat = fs.statSync(candidateFile);
    assert.equal(candidateStat.mode & 0o777, 0o600);
  });
});

describe('P3B-2C: Cold-Start Cross-Mission Resource Authentication', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping authentication failure tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('rejects staging artifact when file is missing', async () => {
    const repo = setupDisposableRepo('dest-stage-missing-staging-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.unlinkSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`));

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'staging-file-missing');
  });

  test('rejects staging artifact when content SHA does not match expected result SHA', async () => {
    const repo = setupDisposableRepo('dest-stage-corrupt-staging-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), 'corrupted staging');

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'staging-checksum-mismatch');
  });

  test('rejects backup artifact when file is missing', async () => {
    const repo = setupDisposableRepo('dest-stage-missing-backup-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.unlinkSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`));

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-file-missing');
  });

  test('rejects backup artifact when content SHA does not match expected initial SHA', async () => {
    const repo = setupDisposableRepo('dest-stage-corrupt-backup-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), 'corrupted backup');

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-checksum-mismatch');
  });

  test('rejects live target when file is missing', async () => {
    const repo = setupDisposableRepo('dest-stage-missing-live-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });

    fs.unlinkSync(liveTarget);

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'target-file-missing');
  });

  test('rejects live target when content SHA does not match expected initial SHA', async () => {
    const repo = setupDisposableRepo('dest-stage-corrupt-live-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });

    fs.writeFileSync(liveTarget, 'unexpected live modification');

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'target-checksum-mismatch');
  });

  test('rejects when staging or backup or live target is a symbolic link', async () => {
    // 1. Staging symlink
    {
      const repo = setupDisposableRepo('dest-stage-symlink-staging-');
      const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
      const stagedPath = path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`);
      fs.unlinkSync(stagedPath);
      fs.symlinkSync(path.join(repo, 'server.js'), stagedPath);

      const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'staging-unsafe-symlink');
    }

    // 2. Backup symlink
    {
      const repo = setupDisposableRepo('dest-stage-symlink-backup-');
      const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
      const backupPath = path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`);
      fs.unlinkSync(backupPath);
      fs.symlinkSync(path.join(repo, 'server.js'), backupPath);

      const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'backup-unsafe-symlink');
    }

    // 3. Live target symlink
    {
      const repo = setupDisposableRepo('dest-stage-symlink-live-');
      const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });
      fs.unlinkSync(liveTarget);
      fs.symlinkSync(path.join(repo, 'server.js'), liveTarget);

      const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'target-unsafe-symlink');
    }
  });

  test('rejects when target parent directory is a symbolic link', async () => {
    const repo = setupDisposableRepo('dest-stage-symlink-parent-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const realEndpoints = path.join(repo, 'real-endpoints');
    fs.renameSync(path.join(repo, 'src/endpoints'), realEndpoints);
    fs.symlinkSync(realEndpoints, path.join(repo, 'src/endpoints'));

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'parent-unsafe-symlink');
  });
});

describe('P3B-2C: Descriptor Anchoring, procfs Fallback Refusal, and Collisions', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping descriptor and collision tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('rejects creation when procfs is unavailable without falling back to absolute paths', async () => {
    const repo = setupDisposableRepo('dest-stage-no-procfs-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const nonExistentProc = path.join(repo, 'non-existent-proc');

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      _testProcDir: nonExistentProc,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsupported-platform');
    assert.match(res.error, /procfs descriptor anchoring/);

    // Verify candidate was NOT created via absolute path fallback
    const expectedCandidate = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(fs.existsSync(expectedCandidate), false);
  });

  test('collision refusal: rejects pre-existing candidate regular file and preserves it', async () => {
    const repo = setupDisposableRepo('dest-stage-collision-file-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.writeFileSync(candidatePath, 'pre-existing conflicting candidate');

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'collision-detected');

    // Candidate preserved exactly
    assert.equal(fs.readFileSync(candidatePath, 'utf8'), 'pre-existing conflicting candidate');

    // Journal remains in BACKUP_CREATED
    const insp = inspectJournal(repo);
    assert.equal(insp.journal.phase, 'BACKUP_CREATED');
  });

  test('collision refusal: rejects pre-existing candidate symlink and preserves it', async () => {
    const repo = setupDisposableRepo('dest-stage-collision-symlink-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    const dummyTarget = path.join(repo, 'server.js');
    fs.symlinkSync(dummyTarget, candidatePath);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'collision-detected');

    assert.equal(fs.lstatSync(candidatePath).isSymbolicLink(), true);
  });

  test('collision refusal: rejects pre-existing dangling symlink', async () => {
    const repo = setupDisposableRepo('dest-stage-collision-dangling-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    fs.symlinkSync(path.join(repo, 'non-existent-target.txt'), candidatePath);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'collision-detected');

    assert.equal(fs.lstatSync(candidatePath).isSymbolicLink(), true);
  });
});

describe('P3B-2C: Failure Preservation (Zero Automatic Deletion on Error)', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping failure preservation tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('injected write error preserves candidate artifact on disk with 0600 mode', async () => {
    const repo = setupDisposableRepo('dest-stage-write-fault-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const origWriteSync = fs.writeSync;
    try {
      fs.writeSync = (fd, ...args) => {
        const err = new Error('Disk I/O error during candidate payload writing');
        err.code = 'EIO';
        throw err;
      };

      const res = await stageDestinationCandidate({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.uncertain, true);
    } finally {
      fs.writeSync = origWriteSync;
    }

    // CRITICAL: Candidate MUST NOT be unlinked
    assert.equal(fs.existsSync(candidatePath), true);
    const stat = fs.statSync(candidatePath);
    // Initial 0600 mode preserved
    assert.equal(stat.mode & 0o777, 0o600);

    // Journal remains BACKUP_CREATED
    const insp = inspectJournal(repo);
    assert.equal(insp.journal.phase, 'BACKUP_CREATED');
  });

  test('injected sync faults preserve candidate artifact and abort transition', async () => {
    const repo = setupDisposableRepo('dest-stage-fault-sync-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const origFsyncSync = fs.fsyncSync;
    try {
      let syncCount = 0;
      fs.fsyncSync = (fd, ...args) => {
        syncCount++;
        // Fail on candidate file fsync
        if (syncCount === 1) {
          const err = new Error('Sync failure');
          err.code = 'EIO';
          throw err;
        }
        return origFsyncSync(fd, ...args);
      };

      const res = await stageDestinationCandidate({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.uncertain, true);
    } finally {
      fs.fsyncSync = origFsyncSync;
    }

    // Candidate artifact preserved on disk
    assert.equal(fs.existsSync(candidatePath), true);

    // Journal remains in BACKUP_CREATED
    const insp = inspectJournal(repo);
    assert.equal(insp.journal.phase, 'BACKUP_CREATED');
  });
});

describe('P3B-2C: Late Substitution at before-journal-advancement Hook', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping late substitution tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('aborts and preserves candidate if staging buffer is mutated at hook', async () => {
    const repo = setupDisposableRepo('dest-stage-late-staging-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          fs.writeFileSync(
            path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`),
            'late tampered staging content'
          );
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'staging-checksum-mismatch');

    // Candidate preserved on disk
    assert.equal(fs.existsSync(candidatePath), true);
    // Journal unchanged
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });

  test('aborts and preserves candidate if backup file is mutated at hook', async () => {
    const repo = setupDisposableRepo('dest-stage-late-backup-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          fs.writeFileSync(
            path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`),
            'late tampered backup content'
          );
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-checksum-mismatch');

    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });

  test('aborts and preserves candidate if live target is mutated at hook', async () => {
    const repo = setupDisposableRepo('dest-stage-late-live-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          fs.writeFileSync(liveTarget, 'late tampered live content');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'target-checksum-mismatch');

    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });

  test('aborts if destination candidate is unlinked at hook', async () => {
    const repo = setupDisposableRepo('dest-stage-late-candidate-unlink-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          fs.unlinkSync(candidatePath);
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'ENOENT');

    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });

  test('aborts if destination candidate is tampered at hook', async () => {
    const repo = setupDisposableRepo('dest-stage-late-candidate-tamper-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          fs.writeFileSync(candidatePath, 'tampered candidate bytes');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'candidate-sha256-mismatch');

    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });

  test('aborts if lease is revoked at hook', async () => {
    const repo = setupDisposableRepo('dest-stage-late-lease-revoked-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          releaseLock({ repoRoot: repo, txId, lease });
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'lease-revoked');

    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });
});

describe('P3B-2C: Authentic SillyTavern Fixture Integration Tests', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping authentic candidate staging tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('authentic forward/apply candidate staging end-to-end', async () => {
    const repo = setupDisposableRepo('dest-stage-auth-apply-');
    const txId = generateTxId();

    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);
    fs.chmodSync(liveTarget, 0o644);

    const initialStat = fs.statSync(liveTarget);

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

    const prepRes = await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(prepRes.ok, true);

    const backupRes = await createVerifiedBackup({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(backupRes.ok, true);

    const stageRes = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(stageRes.ok, true);
    assert.equal(stageRes.sha256, patchedSha);
    assert.equal(stageRes.targetMode, '0644');
    assert.equal(stageRes.journal?.phase, 'READY_TO_SWAP');

    // Candidate content matches authentic patched bytes
    const candidateFile = path.join(repo, stageRes.candidatePath);
    const candidateBytes = fs.readFileSync(candidateFile);
    assert.equal(Buffer.compare(candidateBytes, authenticPatched), 0);
    assert.equal(computeSha256(candidateBytes), patchedSha);
    assert.equal(computeGitBlobSha(candidateBytes), patchedBlob);

    // Live target remains untouched
    const currentLiveBytes = fs.readFileSync(liveTarget);
    const currentLiveStat = fs.statSync(liveTarget);
    assert.equal(Buffer.compare(currentLiveBytes, authenticStock), 0);
    assert.equal(currentLiveStat.ino, initialStat.ino);
    assert.equal(currentLiveStat.mode & 0o777, 0o644);

    // Inspector validates state cleanly
    const insp = inspectTransactionState(repo);
    assert.equal(insp.state, 'ownership-unverified');
    assert.equal(insp.isPending, true);
  });

  test('authentic reverse/remove candidate staging end-to-end', async () => {
    const repo = setupDisposableRepo('dest-stage-auth-remove-');
    const txId = generateTxId();

    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticPatched);
    fs.chmodSync(liveTarget, 0o644);

    const initialStat = fs.statSync(liveTarget);

    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'remove' });

    createJournal({
      repoRoot: repo,
      txId,
      op: 'remove',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: patchedSha,
      expectedResultSha256: stockSha,
      lease,
    });

    const prepRes = await prepareIsolatedPatch({ repoRoot: repo, txId, op: 'remove', lease });
    assert.equal(prepRes.ok, true);

    const backupRes = await createVerifiedBackup({ repoRoot: repo, txId, op: 'remove', lease });
    assert.equal(backupRes.ok, true);

    const stageRes = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'remove',
      lease,
    });

    assert.equal(stageRes.ok, true);
    assert.equal(stageRes.sha256, stockSha);
    assert.equal(stageRes.journal?.phase, 'READY_TO_SWAP');

    // Candidate content matches authentic stock bytes
    const candidateFile = path.join(repo, stageRes.candidatePath);
    const candidateBytes = fs.readFileSync(candidateFile);
    assert.equal(Buffer.compare(candidateBytes, authenticStock), 0);
    assert.equal(computeSha256(candidateBytes), stockSha);
    assert.equal(computeGitBlobSha(candidateBytes), stockBlob);

    // Live target remains untouched
    const currentLiveStat = fs.statSync(liveTarget);
    assert.equal(currentLiveStat.ino, initialStat.ino);
  });
});

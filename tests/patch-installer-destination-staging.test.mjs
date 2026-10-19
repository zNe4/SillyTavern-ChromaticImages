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

  test('readBoundedFile cannot be redirected to unsafe open flags via _testConstants', () => {
    const dir = createTempDir('read-bounded-const-');
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'hello constants');

    let capturedFlags = null;
    const origOpenSync = fs.openSync;
    try {
      fs.openSync = (p, flags, mode) => {
        if (p === filePath) {
          capturedFlags = flags;
        }
        return origOpenSync(p, flags, mode);
      };

      const res = readBoundedFile(filePath, {
        _testConstants: {
          O_RDONLY: 9999,
          O_NOFOLLOW: 8888,
        },
      });

      assert.equal(res.sha256, computeSha256(Buffer.from('hello constants')));
      assert.equal(capturedFlags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('synthetic nonzero incorrect O_NOFOLLOW flag cannot bypass production protection in readBoundedFile', () => {
    const dir = createTempDir('read-bounded-synthetic-');
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'sample');

    let capturedFlags = null;
    const origOpenSync = fs.openSync;
    try {
      fs.openSync = (p, flags, mode) => {
        if (p === filePath) {
          capturedFlags = flags;
        }
        return origOpenSync(p, flags, mode);
      };

      readBoundedFile(filePath, { _testConstants: { O_NOFOLLOW: 0x999999 } });
      assert.equal(capturedFlags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('readBoundedFile rejects caller-supplied maxBytes exceeding 50 MiB or invalid values', () => {
    const dir = createTempDir('read-bounded-maxbytes-');
    const filePath = path.join(dir, 'test.txt');
    fs.writeFileSync(filePath, 'sample');

    // Exceeding 50 MiB ceiling
    assert.throws(
      () => readBoundedFile(filePath, { maxBytes: 55 * 1024 * 1024 }),
      (err) => {
        assert.equal(err.code, 'invalid-max-bytes');
        assert.match(err.message, /limit/);
        return true;
      }
    );

    // Non-positive, non-integer, or invalid limits
    for (const bad of [0, -1, -100, 1.5, NaN, Infinity, '1000', null]) {
      assert.throws(
        () => readBoundedFile(filePath, { maxBytes: bad }),
        (err) => {
          assert.equal(err.code, 'invalid-max-bytes');
          return true;
        }
      );
    }

    // Invalid non-object options
    assert.throws(
      () => readBoundedFile(filePath, 'not-an-object'),
      (err) => {
        assert.equal(err.code, 'invalid-arguments');
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
    assert.equal(res.code, 'unexpected-staging-artifacts');
  });

  test('rejects staging artifact when content SHA does not match expected result SHA', async () => {
    const repo = setupDisposableRepo('dest-stage-corrupt-staging-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.writeFileSync(path.join(repo, `.ci-patch/staging/${txId}/stable-diffusion.js`), 'corrupted staging');

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'staged-sha256-mismatch');
  });

  test('rejects backup artifact when file is missing', async () => {
    const repo = setupDisposableRepo('dest-stage-missing-backup-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.unlinkSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`));

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unexpected-backup-artifacts');
  });

  test('rejects backup artifact when content SHA does not match expected initial SHA', async () => {
    const repo = setupDisposableRepo('dest-stage-corrupt-backup-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    fs.writeFileSync(path.join(repo, `.ci-patch/backup/${txId}/stable-diffusion.js`), 'corrupted backup');

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'backup-sha256-mismatch');
  });

  test('rejects live target when file is missing', async () => {
    const repo = setupDisposableRepo('dest-stage-missing-live-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });

    fs.unlinkSync(liveTarget);

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'file-missing');
  });

  test('rejects live target when content SHA does not match expected initial SHA', async () => {
    const repo = setupDisposableRepo('dest-stage-corrupt-live-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });

    fs.writeFileSync(liveTarget, 'unexpected live modification');

    const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'initial-sha256-mismatch');
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
      assert.equal(res.code, 'unsafe-symlink');
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
      assert.equal(res.code, 'unsafe-symlink');
    }

    // 3. Live target symlink
    {
      const repo = setupDisposableRepo('dest-stage-symlink-live-');
      const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });
      fs.unlinkSync(liveTarget);
      fs.symlinkSync(path.join(repo, 'server.js'), liveTarget);

      const res = await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'unsafe-symlink');
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
    assert.equal(res.code, 'unsafe-symlink');
  });
});

describe('P3B-2C: Descriptor Anchoring, procfs Fallback Refusal, and Collisions', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping descriptor and collision tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  test('rejects creation when procfs descriptor anchoring fails without falling back to absolute paths', async () => {
    const repo = setupDisposableRepo('dest-stage-no-procfs-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const origOpenSync = fs.openSync;
    try {
      fs.openSync = (targetPath, flags, mode) => {
        if (typeof targetPath === 'string' && targetPath.startsWith('/proc/self/fd/')) {
          const err = new Error('Simulated procfs descriptor open failure');
          err.code = 'ENOENT';
          throw err;
        }
        return origOpenSync(targetPath, flags, mode);
      };

      const res = await stageDestinationCandidate({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'unsupported-platform');
      assert.match(res.error, /procfs|descriptor-anchored/);

      // Verify candidate was NOT created via absolute path fallback
      const expectedCandidate = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
      assert.equal(fs.existsSync(expectedCandidate), false);
      // Journal remains in BACKUP_CREATED
      assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
    } finally {
      fs.openSync = origOpenSync;
    }
  });

  test('extra _testProcDir and _testConstants arguments cannot redirect creation or alter flags', async () => {
    const repo = setupDisposableRepo('dest-stage-overrides-ignored-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const fakeProcDir = path.join(repo, 'fake-proc-dir');
    fs.mkdirSync(fakeProcDir, { recursive: true });

    let capturedFlags = null;
    let capturedPath = null;
    const origOpenSync = fs.openSync;
    try {
      fs.openSync = (targetPath, flags, mode) => {
        if (capturedPath === null && typeof targetPath === 'string' && targetPath.includes(`.ci-staged-${txId}.tmp`)) {
          capturedPath = targetPath;
          capturedFlags = flags;
        }
        return origOpenSync(targetPath, flags, mode);
      };

      const res = await stageDestinationCandidate({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
        _testProcDir: fakeProcDir,
        _testConstants: {
          O_WRONLY: 0,
          O_CREAT: 0,
          O_EXCL: 0,
          O_NOFOLLOW: 0,
        },
      });

      assert.equal(res.ok, true);
      // Candidate path used /proc/self/fd, NOT fakeProcDir
      assert.ok(capturedPath && capturedPath.startsWith('/proc/self/fd/'));
      assert.equal(capturedPath.includes(fakeProcDir), false);
      // Creation flags used real fs.constants, NOT 0
      const expectedFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
      assert.equal(capturedFlags, expectedFlags);
    } finally {
      fs.openSync = origOpenSync;
    }
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
    assert.equal(res.code, 'candidate-collision');

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
    assert.equal(res.code, 'candidate-collision');

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
    assert.equal(res.code, 'candidate-collision');

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
    assert.equal(res.code, 'staged-sha256-mismatch');
    assert.equal(res.stage, 'final-staging-reauth');

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
    assert.equal(res.code, 'backup-sha256-mismatch');
    assert.equal(res.stage, 'final-backup-reauth');

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
    assert.equal(res.code, 'initial-sha256-mismatch');
    assert.equal(res.stage, 'final-source-reauth');

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
    assert.equal(res.code, 'file-missing');

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
    assert.equal(res.code, 'lease-not-active');

    assert.equal(fs.existsSync(candidatePath), true);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });
});

describe('D01-P3B-2C-F1: Adversarial Candidate Verification (Inode & Mode Alteration)', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping adversarial candidate tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  // 7.1 Candidate inode replacement
  test('refuses advancement when candidate is replaced with distinct inode regular file with identical bytes and mode', async () => {
    const repo = setupDisposableRepo('f1-candidate-inode-repl-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    let initialCandidateIno = null;

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          const preStat = fs.statSync(candidatePath);
          initialCandidateIno = preStat.ino;
          const candidateBytes = fs.readFileSync(candidatePath);

          // Replace candidate file: unlink and recreate new regular file with identical content & mode
          fs.unlinkSync(candidatePath);
          fs.writeFileSync(candidatePath, candidateBytes);
          fs.chmodSync(candidatePath, 0o644);

          const postStat = fs.statSync(candidatePath);
          // Confirm inode actually changed
          assert.notEqual(postStat.ino, initialCandidateIno);
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'candidate-identity-replaced');
    assert.equal(res.stage, 'final-candidate-reauth');

    // Journal remains BACKUP_CREATED
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
    // Candidate artifact is preserved on disk (NOT automatically deleted)
    assert.equal(fs.existsSync(candidatePath), true);
  });

  // 7.2 Candidate mode modification
  test('refuses advancement when candidate mode is modified (0644 -> 0600) without byte or inode changes', async () => {
    const repo = setupDisposableRepo('f1-candidate-mode-mod-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    let initialIno = null;

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          const preStat = fs.statSync(candidatePath);
          initialIno = preStat.ino;
          // Modify mode from 0644 to 0600 in-place
          fs.chmodSync(candidatePath, 0o600);
          const postStat = fs.statSync(candidatePath);
          assert.equal(postStat.ino, initialIno);
          assert.equal(postStat.mode & 0o777, 0o600);
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'candidate-mode-mismatch');
    assert.equal(res.stage, 'final-candidate-reauth');

    // Journal remains BACKUP_CREATED
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
    // Candidate remains preserved on disk
    assert.equal(fs.existsSync(candidatePath), true);
  });
});

describe('D01-P3B-2C-F1: Destination-Parent Substitution Resistance', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping parent substitution tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  // 7.3A Destination-parent substitution immediately before candidate allocation
  test('refuses candidate allocation when parent directory is substituted immediately before allocation', async () => {
    const repo = setupDisposableRepo('f1-parent-sub-before-alloc-');
    const { txId, lease, liveTarget } = setupAuthenticBackupCreatedTx({ repo });

    const liveTargetStat = fs.statSync(liveTarget);
    const endpointsDir = path.join(repo, 'src/endpoints');
    const displacedDir = path.join(repo, 'src/endpoints-displaced');

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-candidate-create') {
          // Substitute parent directory
          fs.renameSync(endpointsDir, displacedDir);
          fs.mkdirSync(endpointsDir, { recursive: true });
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'parent-directory-replaced');

    // Journal stays BACKUP_CREATED
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');

    // Live target in displaced directory is untouched
    const displacedLiveTarget = path.join(displacedDir, 'stable-diffusion.js');
    assert.equal(fs.existsSync(displacedLiveTarget), true);
    const curLiveStat = fs.statSync(displacedLiveTarget);
    assert.equal(curLiveStat.ino, liveTargetStat.ino);

    // No candidate file created in the substituted endpointsDir
    const expectedCandidateInNewDir = path.join(endpointsDir, `.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(fs.existsSync(expectedCandidateInNewDir), false);
  });

  // 7.3B Destination-parent substitution immediately after candidate creation
  test('detects parent substitution after candidate creation, preserves candidate in displaced directory', async () => {
    const repo = setupDisposableRepo('f1-parent-sub-after-alloc-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const endpointsDir = path.join(repo, 'src/endpoints');
    const displacedDir = path.join(repo, 'src/endpoints-displaced');
    const candidateBase = `.stable-diffusion.js.ci-staged-${txId}.tmp`;

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'after-candidate-create') {
          // Displace parent directory immediately after candidate allocation
          fs.renameSync(endpointsDir, displacedDir);
          fs.mkdirSync(endpointsDir, { recursive: true });
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'parent-directory-replaced');

    // Journal stays BACKUP_CREATED
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');

    // Candidate artifact was created in the descriptor-anchored (displaced) directory and is PRESERVED
    const preservedCandidate = path.join(displacedDir, candidateBase);
    assert.equal(fs.existsSync(preservedCandidate), true);

    // No candidate exists in the substituted new directory
    assert.equal(fs.existsSync(path.join(endpointsDir, candidateBase)), false);
  });

  // 7.3C Destination-parent substitution before final journal advancement
  test('detects parent substitution before journal advancement and preserves candidate in displaced directory', async () => {
    const repo = setupDisposableRepo('f1-parent-sub-before-advance-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const endpointsDir = path.join(repo, 'src/endpoints');
    const displacedDir = path.join(repo, 'src/endpoints-displaced');
    const candidateBase = `.stable-diffusion.js.ci-staged-${txId}.tmp`;

    const res = await stageDestinationCandidate({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook: (stage) => {
        if (stage === 'before-journal-advancement') {
          fs.renameSync(endpointsDir, displacedDir);
          fs.mkdirSync(endpointsDir, { recursive: true });
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'parent-directory-replaced');
    assert.equal(res.stage, 'final-parent-reauth');

    // Journal remains BACKUP_CREATED
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');

    // Candidate artifact is preserved in displaced directory
    assert.equal(fs.existsSync(path.join(displacedDir, candidateBase)), true);
    // No candidate in new endpointsDir
    assert.equal(fs.existsSync(path.join(endpointsDir, candidateBase)), false);
  });
});

describe('D01-P3B-2C-F1: Separate Synchronization Failure Isolation', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping sync failure tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  // 7.4A Candidate file data synchronization failure
  test('candidate data synchronization failure returns sync-candidate-file with uncertain durability', async () => {
    const repo = setupDisposableRepo('f1-sync-candidate-file-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    let armed = false;
    let injected = false;
    const origFsyncSync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd, ...args) => {
        if (armed) {
          armed = false;
          injected = true;
          const err = new Error('Simulated EIO during candidate data sync');
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
        faultHook: (stage) => {
          if (stage === 'sync-candidate-file') {
            armed = true;
          }
        },
      });

      assert.equal(injected, true, 'fsyncSync injection should have been reached');
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'sync-candidate-file');
      assert.equal(res.uncertain, true);

      // Journal remains in BACKUP_CREATED
      assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
      // Candidate file preserved on disk
      assert.equal(fs.existsSync(candidatePath), true);
    } finally {
      fs.fsyncSync = origFsyncSync;
    }
  });

  // 7.4B Candidate mode metadata synchronization failure
  test('candidate mode synchronization failure returns sync-candidate-mode with uncertain durability', async () => {
    const repo = setupDisposableRepo('f1-sync-candidate-mode-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    let armed = false;
    let injected = false;
    const origFsyncSync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd, ...args) => {
        if (armed) {
          armed = false;
          injected = true;
          const err = new Error('Simulated EIO during candidate mode sync');
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
        faultHook: (stage) => {
          if (stage === 'sync-candidate-mode') {
            armed = true;
          }
        },
      });

      assert.equal(injected, true, 'fsyncSync injection should have been reached');
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'sync-candidate-mode');
      assert.equal(res.uncertain, true);

      assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
      assert.equal(fs.existsSync(candidatePath), true);
    } finally {
      fs.fsyncSync = origFsyncSync;
    }
  });

  // 7.4C Destination parent directory synchronization failure
  test('destination-parent directory synchronization failure returns sync-destination-parent with uncertain durability', async () => {
    const repo = setupDisposableRepo('f1-sync-dest-parent-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    let armed = false;
    let injected = false;
    const origFsyncSync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd, ...args) => {
        if (armed) {
          armed = false;
          injected = true;
          const err = new Error('Simulated EIO during parent directory sync');
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
        faultHook: (stage) => {
          if (stage === 'sync-destination-parent') {
            armed = true;
          }
        },
      });

      assert.equal(injected, true, 'fsyncSync injection should have been reached');
      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'sync-destination-parent');
      assert.equal(res.uncertain, true);

      assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
      assert.equal(fs.existsSync(candidatePath), true);
    } finally {
      fs.fsyncSync = origFsyncSync;
    }
  });

  test('deliberate faultHook exception during sync propagates as crash simulation', async () => {
    const repo = setupDisposableRepo('f1-sync-fault-propagate-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    let caught = null;
    try {
      await stageDestinationCandidate({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
        faultHook: (stage) => {
          if (stage === 'sync-candidate-file') {
            const err = new Error('Intentional crash at candidate sync');
            throw err;
          }
        },
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Expected faultHook exception to propagate');
    assert.equal(caught._isFault, true);
    assert.match(caught.message, /Intentional crash at candidate sync/);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });
});

describe('D01-P3B-2C-F1: Journal Publication Failure Boundary & Uncertainty', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping journal publication boundary tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  // 7.5A Pre-publication failure
  test('pre-publication failure leaves journal in BACKUP_CREATED and candidate preserved without uncertainty', async () => {
    const repo = setupDisposableRepo('f1-journal-pre-pub-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    let injected = false;
    const origWriteSync = fs.writeSync;
    try {
      fs.writeSync = (fd, ...args) => {
        const data = args[0];
        if (typeof data === 'string' && data.includes('READY_TO_SWAP')) {
          injected = true;
          const err = new Error('Simulated ENOSPC writing temp journal');
          err.code = 'ENOSPC';
          throw err;
        }
        return origWriteSync(fd, ...args);
      };

      const res = await stageDestinationCandidate({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(injected, true, 'Pre-publication journal write injection must fire');
      assert.equal(res.ok, false);
      assert.equal(res.stage, 'pre-rename');
      assert.equal(res.uncertain, false);

      // Journal remains in BACKUP_CREATED
      assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
      // Candidate preserved on disk
      assert.equal(fs.existsSync(candidatePath), true);
    } finally {
      fs.writeSync = origWriteSync;
    }
  });

  // 7.5B Post-publication synchronization failure
  test('post-publication directory fsync failure reports durability uncertainty with READY_TO_SWAP on disk', async () => {
    const repo = setupDisposableRepo('f1-journal-post-pub-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);

    let inPostRename = false;
    const origRenameSync = fs.renameSync;
    const origFsyncSync = fs.fsyncSync;
    try {
      fs.renameSync = (...args) => {
        const ret = origRenameSync.apply(fs, args);
        const [src, dst] = args;
        if (typeof dst === 'string' && dst.endsWith('journal.json')) {
          inPostRename = true;
        }
        return ret;
      };

      fs.fsyncSync = (fd, ...args) => {
        if (inPostRename) {
          inPostRename = false;
          const err = new Error('Simulated directory fsync failure after journal publication');
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
      assert.equal(res.stage, 'post-rename');
      assert.equal(res.uncertain, true);

      // Journal on disk visibly contains READY_TO_SWAP
      const diskJournal = inspectJournal(repo);
      assert.equal(diskJournal.journal.phase, 'READY_TO_SWAP');
      // Candidate remains preserved on disk
      assert.equal(fs.existsSync(candidatePath), true);
    } finally {
      fs.renameSync = origRenameSync;
      fs.fsyncSync = origFsyncSync;
    }
  });
});

describe('D01-P3B-2C-F1: Fault Propagation and Descriptors Cleanup', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping fault propagation tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  // 7.6 Fault hook exception propagation
  test('deliberate _isFault error inside faultHook propagates without being caught and closes open descriptors', async () => {
    const repo = setupDisposableRepo('f1-fault-propagate-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const openedFds = new Set();
    const closedFds = new Set();
    const origOpenSync = fs.openSync;
    const origCloseSync = fs.closeSync;

    fs.openSync = function (...args) {
      const fd = origOpenSync.apply(fs, args);
      openedFds.add(fd);
      return fd;
    };
    fs.closeSync = function (fd) {
      closedFds.add(fd);
      return origCloseSync.apply(fs, arguments);
    };

    try {
      let caughtErr = null;
      try {
        await stageDestinationCandidate({
          repoRoot: repo,
          txId,
          op: 'apply',
          lease,
          faultHook: (stage) => {
            if (stage === 'after-candidate-create') {
              const err = new Error('Simulated process crash');
              err._isFault = true;
              throw err;
            }
          },
        });
      } catch (err) {
        caughtErr = err;
      }

      assert.ok(caughtErr, 'Expected fault exception to propagate');
      assert.equal(caughtErr._isFault, true);
      assert.match(caughtErr.message, /Simulated process crash/);

      // Verify all opened descriptors were closed
      const unclosed = Array.from(openedFds).filter((fd) => !closedFds.has(fd));
      assert.equal(unclosed.length, 0, `Expected all descriptors to be closed, but found unclosed fds: ${unclosed.join(', ')}`);
    } finally {
      fs.openSync = origOpenSync;
      fs.closeSync = origCloseSync;
    }
  });
});

describe('D01-P3B-2C-F1: Descriptor Safety and Closure Verification (Section 6)', () => {
  if (!authenticStock || !authenticPatched) {
    test.skip('Skipping descriptor safety tests (authentic stock or patched content unavailable)', () => {});
    return;
  }

  function trackDescriptors(fn, hooks = {}) {
    let allocCounter = 0;
    const openedList = [];
    const closedList = [];
    const activeAllocations = new Map();
    const origOpenSync = fs.openSync;
    const origCloseSync = fs.closeSync;
    const origFstatSync = fs.fstatSync;
    const origFsyncSync = fs.fsyncSync;
    const origWriteSync = fs.writeSync;

    fs.openSync = function (...args) {
      if (typeof hooks.onOpen === 'function') {
        hooks.onOpen(...args);
      }
      const fd = origOpenSync.apply(fs, args);
      const alloc = { id: ++allocCounter, fd, path: args[0], flags: args[1], mode: args[2] };
      openedList.push(alloc);
      if (!activeAllocations.has(fd)) {
        activeAllocations.set(fd, []);
      }
      activeAllocations.get(fd).push(alloc);
      if (typeof hooks.onOpenSuccess === 'function') {
        hooks.onOpenSuccess(alloc, ...args);
      }
      return fd;
    };

    fs.closeSync = function (fd) {
      const active = activeAllocations.get(fd);
      if (active && active.length > 0) {
        const closed = active.pop();
        closedList.push(closed);
      }
      if (typeof hooks.onClose === 'function') {
        hooks.onClose(fd);
      }
      return origCloseSync.apply(fs, arguments);
    };

    if (typeof hooks.onFstat === 'function') {
      fs.fstatSync = function (fd, ...args) {
        return hooks.onFstat(fd, origFstatSync, ...args);
      };
    }

    if (typeof hooks.onFsync === 'function') {
      fs.fsyncSync = function (fd, ...args) {
        return hooks.onFsync(fd, origFsyncSync, ...args);
      };
    }

    if (typeof hooks.onWrite === 'function') {
      fs.writeSync = function (fd, ...args) {
        return hooks.onWrite(fd, origWriteSync, ...args);
      };
    }

    return Promise.resolve()
      .then(fn)
      .finally(() => {
        fs.openSync = origOpenSync;
        fs.closeSync = origCloseSync;
        if (typeof hooks.onFstat === 'function') fs.fstatSync = origFstatSync;
        if (typeof hooks.onFsync === 'function') fs.fsyncSync = origFsyncSync;
        if (typeof hooks.onWrite === 'function') fs.writeSync = origWriteSync;
      })
      .then((res) => {
        const unclosed = Array.from(activeAllocations.values()).flat();
        return {
          res,
          unclosed,
          openedList,
          closedList,
        };
      });
  }

  test('descriptor safety: invalid parent descriptor closes descriptor', async () => {
    const repo = setupDisposableRepo('f1-desc-invalid-parent-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const endpointsDir = path.join(repo, 'src/endpoints');
    let parentFd = null;

    const { res, unclosed, openedList } = await trackDescriptors(
      async () => {
        return await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      },
      {
        onOpenSuccess: (alloc) => {
          if (typeof alloc.path === 'string' && path.resolve(alloc.path) === path.resolve(endpointsDir)) {
            parentFd = alloc.fd;
          }
        },
        onFstat: (fd, origFstatSync, ...args) => {
          const s = origFstatSync(fd, ...args);
          if (parentFd !== null && fd === parentFd) {
            return Object.create(s, {
              isDirectory: { value: () => false, enumerable: true },
            });
          }
          return s;
        },
      }
    );

    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid-parent-dir');
    assert.ok(openedList.length > 0);
    assert.equal(unclosed.length, 0);
  });

  test('descriptor safety: cross-device mismatch closes descriptor', async () => {
    const repo = setupDisposableRepo('f1-desc-cross-device-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const endpointsDir = path.join(repo, 'src/endpoints');
    let parentFd = null;
    let injected = false;

    const { res, unclosed, openedList } = await trackDescriptors(
      async () => {
        return await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      },
      {
        onOpenSuccess: (alloc) => {
          if (typeof alloc.path === 'string' && path.resolve(alloc.path) === path.resolve(endpointsDir)) {
            parentFd = alloc.fd;
          }
        },
        onFstat: (fd, origFstatSync, ...args) => {
          const s = origFstatSync(fd, ...args);
          if (parentFd !== null && fd === parentFd) {
            injected = true;
            return Object.create(s, {
              dev: { value: s.dev + 9999, enumerable: true },
            });
          }
          return s;
        },
      }
    );

    assert.equal(injected, true, 'Cross-device mismatch injection must fire');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'cross-device-unsupported');
    assert.ok(openedList.length > 0);
    assert.equal(unclosed.length, 0);
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
  });

  test('descriptor safety: candidate allocation failure closes parent descriptor', async () => {
    const repo = setupDisposableRepo('f1-desc-cand-alloc-fail-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    const endpointsDir = path.join(repo, 'src/endpoints');
    let injected = false;

    const { res, unclosed, openedList } = await trackDescriptors(
      async () => {
        return await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      },
      {
        onOpen: (p) => {
          if (typeof p === 'string' && p.startsWith('/proc/self/fd/')) {
            injected = true;
            const err = new Error('Simulated candidate open failure');
            err.code = 'EACCES';
            throw err;
          }
        },
      }
    );

    assert.equal(injected, true, 'Candidate allocation injection must fire');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsupported-platform');
    const parentOpened = openedList.filter(
      (a) => typeof a.path === 'string' && path.resolve(a.path) === path.resolve(endpointsDir)
    );
    assert.equal(parentOpened.length, 1, 'Parent directory descriptor must have been opened');
    assert.equal(unclosed.length, 0, 'All opened descriptors must be closed');
    assert.equal(inspectJournal(repo).journal.phase, 'BACKUP_CREATED');
    const candidatePath = path.join(repo, `src/endpoints/.stable-diffusion.js.ci-staged-${txId}.tmp`);
    assert.equal(fs.existsSync(candidatePath), false);
  });

  test('descriptor safety: candidate write failure closes all descriptors', async () => {
    const repo = setupDisposableRepo('f1-desc-write-fail-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    let injected = false;

    const { res, unclosed, openedList } = await trackDescriptors(
      async () => {
        return await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
      },
      {
        onWrite: (fd, origWriteSync, ...args) => {
          injected = true;
          const err = new Error('Simulated write failure');
          err.code = 'EIO';
          throw err;
        },
      }
    );

    assert.equal(injected, true, 'Candidate write injection must fire');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'EIO');
    assert.ok(openedList.length > 0);
    assert.equal(unclosed.length, 0);
  });

  test('descriptor safety: candidate synchronization failure closes all descriptors', async () => {
    const repo = setupDisposableRepo('f1-desc-cand-sync-fail-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    let armed = false;
    let injected = false;

    const { res, unclosed, openedList } = await trackDescriptors(
      async () => {
        return await stageDestinationCandidate({
          repoRoot: repo,
          txId,
          op: 'apply',
          lease,
          faultHook: (stage) => {
            if (stage === 'sync-candidate-file') {
              armed = true;
            }
          },
        });
      },
      {
        onFsync: (fd, origFsyncSync, ...args) => {
          if (armed) {
            armed = false;
            injected = true;
            const err = new Error('Simulated candidate fsync failure');
            err.code = 'EIO';
            throw err;
          }
          return origFsyncSync(fd, ...args);
        },
      }
    );

    assert.equal(injected, true, 'Candidate fsync injection must fire');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'EIO');
    assert.ok(openedList.length > 0);
    assert.equal(unclosed.length, 0);
  });

  test('descriptor safety: parent directory synchronization failure closes all descriptors', async () => {
    const repo = setupDisposableRepo('f1-desc-parent-sync-fail-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });
    let armed = false;
    let injected = false;

    const { res, unclosed, openedList } = await trackDescriptors(
      async () => {
        return await stageDestinationCandidate({
          repoRoot: repo,
          txId,
          op: 'apply',
          lease,
          faultHook: (stage) => {
            if (stage === 'sync-destination-parent') {
              armed = true;
            }
          },
        });
      },
      {
        onFsync: (fd, origFsyncSync, ...args) => {
          if (armed) {
            armed = false;
            injected = true;
            const err = new Error('Simulated parent directory fsync failure');
            err.code = 'EIO';
            throw err;
          }
          return origFsyncSync(fd, ...args);
        },
      }
    );

    assert.equal(injected, true, 'Parent fsync injection must fire');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'EIO');
    assert.ok(openedList.length > 0);
    assert.equal(unclosed.length, 0);
  });

  test('descriptor safety: successful completion closes all descriptors', async () => {
    const repo = setupDisposableRepo('f1-desc-success-');
    const { txId, lease } = setupAuthenticBackupCreatedTx({ repo });

    const { res, unclosed, openedList } = await trackDescriptors(async () => {
      return await stageDestinationCandidate({ repoRoot: repo, txId, op: 'apply', lease });
    });

    assert.equal(res.ok, true);
    assert.ok(openedList.length > 0);
    assert.equal(unclosed.length, 0);
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

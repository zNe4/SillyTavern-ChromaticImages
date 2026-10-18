import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acquireLock,
  generateTxId,
  LOCK_SCHEMA_VERSION,
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  inspectJournal,
} from '../src/patch-installer/journal.js';

import {
  inspectTransactionState,
} from '../src/patch-installer/transaction-state.js';

import {
  checkInstallationPreflight,
} from '../src/patch-installer/inspect.js';

import {
  prepareIsolatedPatch,
  computeSha256,
  computeGitBlobSha,
  readLiveSourceFile,
} from '../src/patch-installer/staging.js';

import { verifyPatchManifest } from '../scripts/verify-sillytavern-patches.mjs';

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
      // ignore
    }
  }
});

function createTempDir(prefix = 'ci-staging-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

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

function setupDisposableRepo(prefix = 'disposable-st-repo-') {
  const repoDir = createTempDir(prefix);
  child_process.execFileSync('git', ['init', '-q'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  child_process.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  // Minimal SillyTavern authenticity markers
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// mock server entry\n');

  // Directory layout
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });

  return repoDir;
}

const manifest = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'));
const stockSha = manifest.patches.runtime.original.sha256;
const stockBlob = manifest.patches.runtime.original.gitBlobSha;
const patchedSha = manifest.patches.runtime.expected.sha256;
const patchedBlob = manifest.patches.runtime.expected.gitBlobSha;
const authenticStock = getVerifiedAuthenticStockContent(manifest);

describe('P3B-2A: Isolated Patch Preparation Primitive (staging.js)', () => {
  test('computeSha256 and computeGitBlobSha produce standard cryptographic digests', () => {
    const data = Buffer.from('hello world\n');
    assert.equal(computeSha256(data), 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447');
    assert.equal(computeGitBlobSha(data), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
  });

  test('readLiveSourceFile reads and verifies descriptor identity and bounds', () => {
    const repo = setupDisposableRepo('read-source-');
    const testFile = path.join(repo, 'src/endpoints/test.js');
    const content = Buffer.from('console.log("hello");\n');
    fs.writeFileSync(testFile, content);

    const res = readLiveSourceFile(testFile);
    assert.equal(res.buffer.equals(content), true);
    assert.equal(res.sha256, computeSha256(content));
    assert.equal(res.gitBlobSha, computeGitBlobSha(content));
    assert.equal(res.stat.isFile(), true);
  });

  test('readLiveSourceFile rejects symlinks and missing files', () => {
    const repo = setupDisposableRepo('read-symlink-');
    const realFile = path.join(repo, 'real.js');
    fs.writeFileSync(realFile, 'data');
    const linkFile = path.join(repo, 'link.js');
    fs.symlinkSync(realFile, linkFile);

    assert.throws(() => {
      readLiveSourceFile(linkFile);
    }, /symbolic link/);

    assert.throws(() => {
      readLiveSourceFile(path.join(repo, 'missing.js'));
    }, /does not exist/);
  });

  test('readLiveSourceFile fails closed when O_NOFOLLOW is unsupported', () => {
    assert.throws(() => {
      readLiveSourceFile('/tmp/any', { _testConstants: {} });
    }, /O_NOFOLLOW/);
  });

  test('prepareIsolatedPatch validates required parameters and fails closed', async () => {
    const resNoArgs = await prepareIsolatedPatch({});
    assert.equal(resNoArgs.ok, false);
    assert.equal(resNoArgs.code, 'invalid-arguments');

    const resBadOp = await prepareIsolatedPatch({
      repoRoot: '/tmp',
      txId: 'ci-tx-1-a',
      op: 'invalid',
      lease: {},
    });
    assert.equal(resBadOp.ok, false);
    assert.equal(resBadOp.code, 'invalid-operation');
  });

  test('prepareIsolatedPatch verifies lock ownership and lease capability', async () => {
    const repo = setupDisposableRepo('staging-lock-auth-');
    const txId = generateTxId();
    const otherTxId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Calling with non-matching txId fails closed
    const resMismatch = await prepareIsolatedPatch({
      repoRoot: repo,
      txId: otherTxId,
      op: 'apply',
      lease,
    });
    assert.equal(resMismatch.ok, false);
    assert.equal(resMismatch.code, 'lease-tx-mismatch');
  });

  test('prepareIsolatedPatch requires journal strictly in phase LOCKED', async () => {
    const repo = setupDisposableRepo('staging-phase-auth-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // No journal on disk
    const resNoJournal = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(resNoJournal.ok, false);
    assert.equal(resNoJournal.code, 'invalid-journal');
  });

  test('prepareIsolatedPatch refuses legacy journal containing stagedPath', async () => {
    const repo = setupDisposableRepo('staging-legacy-refusal-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });

    // Manually create legacy journal with stagedPath on disk
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

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'legacy-schema');
    assert.match(res.error, /legacy journals containing "stagedPath" are refused/);
  });

  test('prepareIsolatedPatch rejects pre-existing transaction staging directory collision', async () => {
    const repo = setupDisposableRepo('staging-collision-');
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

    // Create pre-existing transaction directory in staging
    const preExistingDir = path.join(repo, '.ci-patch/staging', txId);
    fs.mkdirSync(preExistingDir, { recursive: true });
    const sentinelFile = path.join(preExistingDir, 'sentinel.txt');
    fs.writeFileSync(sentinelFile, 'precious-evidence');

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'staging-collision');

    // Verify sentinel was preserved
    assert.ok(fs.existsSync(sentinelFile));
    assert.equal(fs.readFileSync(sentinelFile, 'utf8'), 'precious-evidence');
  });

  test('prepareIsolatedPatch fails closed when live target source does not match expected initial SHA', async () => {
    const repo = setupDisposableRepo('staging-modified-src-');
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

    // Write modified / conflicting content to live target
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, 'console.log("modified-unsupported");\n');

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'initial-sha256-mismatch');
  });

  if (authenticStock) {
    test('prepareIsolatedPatch executes forward patch application (apply) cleanly with authentic stock bytes', async () => {
      const repo = setupDisposableRepo('staging-forward-apply-');
      const txId = generateTxId();

      // Write authentic stock source to live target
      const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
      fs.writeFileSync(liveTarget, authenticStock);
      child_process.execFileSync('git', ['add', '.'], { cwd: repo });
      child_process.execFileSync('git', ['commit', '-q', '-m', 'Initial authentic commit'], { cwd: repo });

      const headBefore = child_process.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const statusBefore = child_process.execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.equal(statusBefore, '');

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

      const prepRes = await prepareIsolatedPatch({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(prepRes.ok, true);
      assert.equal(prepRes.isolatedStagedPath, `.ci-patch/staging/${txId}/stable-diffusion.js`);
      assert.equal(prepRes.journal?.phase, 'ISOLATED_PREPARED');
      assert.equal(prepRes.sha256, patchedSha);
      assert.equal(prepRes.gitBlobSha, patchedBlob);

      // Verify on-disk staged file
      const absStaged = path.join(repo, prepRes.isolatedStagedPath);
      assert.ok(fs.existsSync(absStaged));
      const stagedStat = fs.statSync(absStaged);
      assert.equal(stagedStat.mode & 0o777, 0o600);
      const stagedBuf = fs.readFileSync(absStaged);
      assert.equal(computeSha256(stagedBuf), patchedSha);
      assert.equal(computeGitBlobSha(stagedBuf), patchedBlob);

      // Verify live target was NEVER modified!
      const liveContent = fs.readFileSync(liveTarget);
      assert.equal(computeSha256(liveContent), stockSha);
      assert.equal(computeGitBlobSha(liveContent), stockBlob);

      // Verify git repository state was not touched
      const headAfter = child_process.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      assert.equal(headAfter, headBefore);
    });

    test('prepareIsolatedPatch executes reverse patch application (remove) cleanly', async () => {
      const repo = setupDisposableRepo('staging-reverse-remove-');
      const txId = generateTxId();

      // First produce patched content in isolation to use as live target for remove
      const tmpDir = createTempDir('prep-patched-for-remove-');
      fs.mkdirSync(path.join(tmpDir, 'staging'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'staging/stable-diffusion.js'), authenticStock);
      const patchPath = path.resolve(path.dirname(BUNDLED_MANIFEST_PATH), manifest.patches.runtime.patchFile);
      child_process.execFileSync('git', ['--no-optional-locks', '-C', path.join(tmpDir, 'staging'), 'apply', '-p3', patchPath], {
        env: { PATH: process.env.PATH, GIT_DIR: '/dev/null', GIT_WORK_TREE: path.join(tmpDir, 'staging') },
      });
      const patchedContent = fs.readFileSync(path.join(tmpDir, 'staging/stable-diffusion.js'));
      assert.equal(computeSha256(patchedContent), patchedSha);

      // Write patched content to live target in repo
      const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
      fs.writeFileSync(liveTarget, patchedContent);
      child_process.execFileSync('git', ['add', '.'], { cwd: repo });
      child_process.execFileSync('git', ['commit', '-q', '-m', 'Patched commit for remove test'], { cwd: repo });

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

      const prepRes = await prepareIsolatedPatch({
        repoRoot: repo,
        txId,
        op: 'remove',
        lease,
      });

      assert.equal(prepRes.ok, true);
      assert.equal(prepRes.isolatedStagedPath, `.ci-patch/staging/${txId}/stable-diffusion.js`);
      assert.equal(prepRes.journal?.phase, 'ISOLATED_PREPARED');
      assert.equal(prepRes.sha256, stockSha);
      assert.equal(prepRes.gitBlobSha, stockBlob);

      // Verify staged file contains restored stock content
      const absStaged = path.join(repo, prepRes.isolatedStagedPath);
      const stagedBuf = fs.readFileSync(absStaged);
      assert.equal(computeSha256(stagedBuf), stockSha);
      assert.equal(computeGitBlobSha(stagedBuf), stockBlob);

      // Verify live target was NOT changed
      const liveContent = fs.readFileSync(liveTarget);
      assert.equal(computeSha256(liveContent), patchedSha);
    });

    test('interrupted staging before journal advancement reports incomplete-transaction in read-only inspection', async () => {
      const repo = setupDisposableRepo('staging-incomplete-inspect-');
      const txId = generateTxId();

      const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
      fs.writeFileSync(liveTarget, authenticStock);

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

      // Fault hook simulating abrupt interruption immediately before journal advancement
      let interrupted = false;
      const faultHook = (stage) => {
        if (stage === 'before-journal-advancement') {
          interrupted = true;
          throw new Error('Simulated process interruption before journal advancement');
        }
      };

      await assert.rejects(async () => {
        await prepareIsolatedPatch({
          repoRoot: repo,
          txId,
          op: 'apply',
          lease,
          faultHook,
        });
      }, /Simulated process interruption/);

      assert.equal(interrupted, true);

      // Verify disk inspection recognizes incomplete staging
      const txState = inspectTransactionState(repo);
      assert.equal(txState.state, 'incomplete-transaction');
      assert.equal(txState.isPending, true);
      assert.ok(txState.reasons.some((r) => r.includes('Interrupted staging preparation detected')));

      // Verify checkInstallationPreflight refuses
      const preflight = await checkInstallationPreflight({ targetDir: repo });
      assert.equal(preflight.verdict, 'refused');
      assert.equal(preflight.exitCode, 1);
      assert.equal(preflight.canApply, false);
      assert.match(preflight.reason, /incomplete-transaction/);
    });

    test('deterministic fault injection across stage boundaries maintains fail-closed invariants', async () => {
      const stageHooks = [
        'before-dir-allocation',
        'after-dir-allocation',
        'before-source-read',
        'during-source-write',
        'before-git-apply',
        'after-git-apply',
        'after-output-verification',
      ];

      for (const hookName of stageHooks) {
        const repo = setupDisposableRepo(`fault-${hookName}-`);
        const txId = generateTxId();

        const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
        fs.writeFileSync(liveTarget, authenticStock);

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

        const faultHook = (stage) => {
          if (stage === hookName) {
            throw new Error(`Fault injected at ${hookName}`);
          }
        };

        await assert.rejects(async () => {
          await prepareIsolatedPatch({
            repoRoot: repo,
            txId,
            op: 'apply',
            lease,
            faultHook,
          });
        }, new RegExp(`Fault injected at ${hookName}`));

        // Invariant 1: Live target never modified
        const currentTarget = fs.readFileSync(liveTarget);
        assert.equal(computeSha256(currentTarget), stockSha);

        // Invariant 2: Journal remains in phase LOCKED
        const jInspection = inspectJournal(repo);
        assert.equal(jInspection.journal?.phase, 'LOCKED');

        // Invariant 3: Inspection fails closed with isPending true
        const inspection = inspectTransactionState(repo);
        assert.equal(inspection.isPending, true);
      }
    });
  }
});

describe('P3B-2A-F1: Strict Filesystem Durability (Finding A)', () => {
  if (!authenticStock) {
    test.skip('Skipping authentic durability tests (authentic stock unavailable)', () => {});
    return;
  }

  test('fails closed with explicit stage error when directory synchronization fails during staging-parent creation', async () => {
    const repo = setupDisposableRepo('durability-staging-parent-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    const origFsync = fs.fsyncSync;
    try {
      let callCount = 0;
      fs.fsyncSync = (fd) => {
        callCount++;
        // Fail the first directory sync (staging-parent)
        if (callCount === 1) {
          const err = new Error('I/O error during parent sync');
          err.code = 'EIO';
          throw err;
        }
        return origFsync(fd);
      };

      const res = await prepareIsolatedPatch({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'sync-staging-parent');
      assert.match(res.error, /Filesystem synchronization failed during "staging-parent"/);

      // Journal remains strictly in phase LOCKED
      const jInspection = inspectJournal(repo);
      assert.equal(jInspection.journal?.phase, 'LOCKED');
      assert.equal(jInspection.journal?.isolatedStagedPath, undefined);
    } finally {
      fs.fsyncSync = origFsync;
    }
  });

  test('fails closed when initial staged file synchronization fails', async () => {
    const repo = setupDisposableRepo('durability-file-sync-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    const origFsync = fs.fsyncSync;
    try {
      let syncIndex = 0;
      fs.fsyncSync = (fd) => {
        syncIndex++;
        // Call 1: staging-parent, Call 2: staging-txdir-parent, Call 3: staged file fsync
        if (syncIndex === 3) {
          const err = new Error('Disk write sync failed');
          err.code = 'ENOSPC';
          throw err;
        }
        return origFsync(fd);
      };

      const res = await prepareIsolatedPatch({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'ENOSPC');
      assert.equal(res.stage, 'sync-initial-staged-file');

      // Journal remains in LOCKED
      const jInspection = inspectJournal(repo);
      assert.equal(jInspection.journal?.phase, 'LOCKED');

      // Incomplete transaction detected with isPending true
      const state = inspectTransactionState(repo);
      assert.equal(state.isPending, true);
    } finally {
      fs.fsyncSync = origFsync;
    }
  });

  test('fails closed when prepared output synchronization fails', async () => {
    const repo = setupDisposableRepo('durability-output-sync-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    const origFsync = fs.fsyncSync;
    try {
      let syncIndex = 0;
      fs.fsyncSync = (fd) => {
        syncIndex++;
        // Calls: 1: staging-parent, 2: txdir-parent, 3: initial staged file, 4: initial txdir
        // Call 5: output file fchmod/fsync
        if (syncIndex === 5) {
          const err = new Error('I/O failure during output sync');
          err.code = 'EIO';
          throw err;
        }
        return origFsync(fd);
      };

      const res = await prepareIsolatedPatch({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, false);
      assert.equal(res.code, 'EIO');
      assert.equal(res.stage, 'sync-output-file');

      // Journal remains in phase LOCKED
      const jInspection = inspectJournal(repo);
      assert.equal(jInspection.journal?.phase, 'LOCKED');
    } finally {
      fs.fsyncSync = origFsync;
    }
  });

  test('proves all required synchronizations execute successfully before journal advancement', async () => {
    const repo = setupDisposableRepo('durability-order-verification-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    const syncLog = [];
    const origFsync = fs.fsyncSync;
    try {
      fs.fsyncSync = (fd) => {
        syncLog.push(fd);
        return origFsync(fd);
      };

      const res = await prepareIsolatedPatch({
        repoRoot: repo,
        txId,
        op: 'apply',
        lease,
      });

      assert.equal(res.ok, true);
      // At least 6 fsync operations must have executed
      assert.ok(syncLog.length >= 6);
      assert.equal(res.journal?.phase, 'ISOLATED_PREPARED');
    } finally {
      fs.fsyncSync = origFsync;
    }
  });
});

describe('P3B-2A-F1: Certified Manifest and Patch Authentication (Finding B)', () => {
  test('rejects caller-supplied conflicting manifest with unauthenticated-manifest-override', async () => {
    const repo = setupDisposableRepo('manifest-override-');
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

    const tamperedManifest = {
      ...manifest,
      releaseCommit: '0000000000000000000000000000000000000000',
    };

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      manifest: tamperedManifest,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unauthenticated-manifest-override');
  });

  test('rejects caller-supplied conflicting patchPath with unauthenticated-patch-override', async () => {
    const repo = setupDisposableRepo('patchpath-override-');
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

    const unauthPath = path.join(repo, 'unauth.patch');
    fs.writeFileSync(unauthPath, 'data');

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      patchPath: unauthPath,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unauthenticated-patch-override');
  });

  test('rejects journal fingerprint mismatch against certified manifest', async () => {
    const repo = setupDisposableRepo('fp-mismatch-');
    const txId = generateTxId();
    const { lease } = acquireLock({ repoRoot: repo, txId, op: 'apply' });
    createJournal({
      repoRoot: repo,
      txId,
      op: 'apply',
      targetFile: 'src/endpoints/stable-diffusion.js',
      expectedInitialSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      expectedResultSha256: patchedSha,
      lease,
    });

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'fingerprint-mismatch');
  });
});

describe('P3B-2A-F1: Staging Path Safety & Permissions (Finding C)', () => {
  test('rejects symlinked .ci-patch/staging directory with unsafe-symlink', async () => {
    const repo = setupDisposableRepo('symlink-staging-');
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

    const externalDir = createTempDir('external-staging-target-');
    fs.symlinkSync(externalDir, path.join(repo, '.ci-patch/staging'));

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
  });

  test('rejects dangling symlink at .ci-patch/staging with unsafe-symlink', async () => {
    const repo = setupDisposableRepo('dangling-symlink-staging-');
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

    fs.symlinkSync('/tmp/nonexistent-path-for-dangling-symlink', path.join(repo, '.ci-patch/staging'));

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
  });

  test('rejects staging parent when replaced by a regular file with invalid-staging-dir', async () => {
    const repo = setupDisposableRepo('regfile-staging-');
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

    fs.writeFileSync(path.join(repo, '.ci-patch/staging'), 'not-a-directory');

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid-staging-dir');
  });

  test('rejects when targetFile parent directory is a symbolic link with unsafe-symlink', async () => {
    const repo = setupDisposableRepo('symlink-parent-target-');
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

    // Replace src/endpoints directory with a symlink to another directory
    const realEndpoints = createTempDir('real-endpoints-');
    fs.rmSync(path.join(repo, 'src/endpoints'), { recursive: true, force: true });
    fs.symlinkSync(realEndpoints, path.join(repo, 'src/endpoints'));

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
  });

  test('rejects when targetFile parent directory is missing with source-parent-missing', async () => {
    const repo = setupDisposableRepo('missing-parent-target-');
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

    fs.rmSync(path.join(repo, 'src/endpoints'), { recursive: true, force: true });

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'source-parent-missing');
  });
});

describe('P3B-2A-F2: Authenticated Patch Execution and Final Staged-File Identity', () => {
  if (!authenticStock) {
    test.skip('Skipping P3B-2A-F2 tests (authentic stock unavailable)', () => {});
    return;
  }

  test('verified descriptor and synchronized descriptor refer to the same inode identity', async () => {
    const repo = setupDisposableRepo('f2-identity-bind-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    let syncFdIno = null;
    let syncFdDev = null;
    let preStatIno = null;
    let preStatDev = null;

    const faultHook = (stage, context) => {
      if (stage === 'sync-output-file') {
        const stat = fs.fstatSync(context.stagedFd);
        syncFdIno = stat.ino;
        syncFdDev = stat.dev;
      } else if (stage === 'before-pathname-identity-check') {
        preStatIno = context.preStat.ino;
        preStatDev = context.preStat.dev;
      }
    };

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, true);
    assert.equal(res.journal?.phase, 'ISOLATED_PREPARED');

    // Verified and synchronized descriptor refer to the exact same device and inode
    assert.ok(syncFdIno !== null && syncFdIno === preStatIno);
    assert.ok(syncFdDev !== null && syncFdDev === preStatDev);

    // Staged pathname on disk matches that exact inode
    const finalStat = fs.lstatSync(path.join(repo, res.isolatedStagedPath));
    assert.equal(finalStat.ino, preStatIno);
    assert.equal(finalStat.dev, preStatDev);
  });

  test('replacing staged pathname after verification causes refusal with staged-pathname-missing', async () => {
    const repo = setupDisposableRepo('f2-pathname-deleted-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    const faultHook = (stage, context) => {
      if (stage === 'before-pathname-identity-check') {
        // Unlink the staged file before pathname identity check
        fs.unlinkSync(context.isolatedStagedFile);
      }
    };

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'staged-pathname-missing');
    assert.match(res.error, /Staged pathname missing/);

    // Journal remains strictly in phase LOCKED
    const jInspection = inspectJournal(repo);
    assert.equal(jInspection.journal?.phase, 'LOCKED');
    assert.equal(jInspection.journal?.isolatedStagedPath, undefined);
  });

  test('replacing staged pathname with a symbolic link causes refusal with unsafe-symlink', async () => {
    const repo = setupDisposableRepo('f2-pathname-symlink-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    const faultHook = (stage, context) => {
      if (stage === 'before-pathname-identity-check') {
        fs.unlinkSync(context.isolatedStagedFile);
        fs.symlinkSync(liveTarget, context.isolatedStagedFile);
      }
    };

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'unsafe-symlink');
    assert.match(res.error, /replaced by a symbolic link/);

    // Journal remains strictly in phase LOCKED
    const jInspection = inspectJournal(repo);
    assert.equal(jInspection.journal?.phase, 'LOCKED');
  });

  test('replacing staged pathname with a different regular file causes refusal with staged-identity-replaced', async () => {
    const repo = setupDisposableRepo('f2-pathname-replaced-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

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

    let replacedFile = null;
    const faultHook = (stage, context) => {
      if (stage === 'before-pathname-identity-check') {
        replacedFile = context.isolatedStagedFile;
        fs.unlinkSync(context.isolatedStagedFile);
        fs.writeFileSync(context.isolatedStagedFile, 'replaced with different file content\n');
      }
    };

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'staged-identity-replaced');
    assert.match(res.error, /inode identity changed/);

    // Journal remains strictly in phase LOCKED
    const jInspection = inspectJournal(repo);
    assert.equal(jInspection.journal?.phase, 'LOCKED');
    assert.equal(jInspection.journal?.isolatedStagedPath, undefined);

    // Transaction artifacts are preserved on disk for recovery/inspection
    assert.ok(fs.existsSync(replacedFile));
    const txState = inspectTransactionState(repo);
    assert.equal(txState.isPending, true);
  });

  test('Git subprocess failure leaves journal in LOCKED and preserves transaction artifacts without touching live repo', async () => {
    const repo = setupDisposableRepo('f2-git-fail-');
    const txId = generateTxId();
    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);
    child_process.execFileSync('git', ['add', '.'], { cwd: repo });
    child_process.execFileSync('git', ['commit', '-q', '-m', 'Initial authentic commit'], { cwd: repo });

    const headBefore = child_process.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

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

    // Cause git apply to fail by corrupting the isolated staged file before git apply
    const faultHook = (stage, context) => {
      if (stage === 'before-git-apply') {
        fs.writeFileSync(context.isolatedStagedFile, 'CORRUPTED TO FORCE GIT APPLY FAILURE\n');
      }
    };

    const res = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      faultHook,
    });

    assert.equal(res.ok, false);
    assert.equal(res.code, 'git-apply-failed');
    assert.match(res.error, /Git patch execution failed/);

    // Journal remains strictly in phase LOCKED
    const jInspection = inspectJournal(repo);
    assert.equal(jInspection.journal?.phase, 'LOCKED');

    // Live target and git repository are completely untouched
    const liveContent = fs.readFileSync(liveTarget);
    assert.equal(computeSha256(liveContent), stockSha);
    const headAfter = child_process.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore);
    const diff = child_process.execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(diff, '');
    const diffCached = child_process.execFileSync('git', ['diff', '--cached'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(diffCached, '');
  });
});


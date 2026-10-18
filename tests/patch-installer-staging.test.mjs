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

function getAuthenticStockContent() {
  const localRepo = '/home/zzzne4/SillyTavern';
  if (fs.existsSync(localRepo)) {
    try {
      return child_process.execFileSync('git', ['-C', localRepo, 'show', '06bde939f:src/endpoints/stable-diffusion.js']);
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
const authenticStock = getAuthenticStockContent();

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

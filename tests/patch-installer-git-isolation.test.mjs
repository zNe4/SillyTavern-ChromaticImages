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
} from '../src/patch-installer/lock.js';

import {
  createJournal,
  inspectJournal,
} from '../src/patch-installer/journal.js';

import {
  prepareIsolatedPatch,
  computeSha256,
  computeGitBlobSha,
} from '../src/patch-installer/staging.js';

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

function createTempDir(prefix = 'ci-git-iso-test-') {
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

function setupDisposableRepo(prefix = 'git-iso-repo-') {
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

describe('P3B-2A: Native Git Execution Isolation & Strip Invariants', () => {
  if (!authenticStock) {
    test.skip('Skipping authentic stock git isolation tests (stock content unavailable)', () => {});
    return;
  }

  test('git apply executes in total isolation: never touches or locks host repo git state', async () => {
    const repo = setupDisposableRepo('git-total-iso-');
    const txId = generateTxId();

    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    // Add a canary uncommitted file and a staged change in repo
    const canaryUntracked = path.join(repo, 'canary-untracked.txt');
    fs.writeFileSync(canaryUntracked, 'untracked-canary-content\n');

    child_process.execFileSync('git', ['add', 'src/endpoints/stable-diffusion.js', 'package.json', 'server.js'], { cwd: repo });
    child_process.execFileSync('git', ['commit', '-q', '-m', 'Initial commit with authentic stock'], { cwd: repo });

    const headBefore = child_process.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const statusBefore = child_process.execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();

    const gitDir = path.join(repo, '.git');
    const indexFile = path.join(gitDir, 'index');
    assert.ok(fs.existsSync(indexFile));
    const indexStatBefore = fs.statSync(indexFile);

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

    const prepRes = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(prepRes.ok, true);

    // Host repo git index, HEAD, and working-tree status must remain 100% untouched
    const indexStatAfter = fs.statSync(indexFile);
    assert.equal(indexStatAfter.mtimeMs, indexStatBefore.mtimeMs);
    assert.equal(indexStatAfter.size, indexStatBefore.size);

    const headAfter = child_process.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore);

    // Tracked working tree and staged index must have zero diffs
    const diffWorkTree = child_process.execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(diffWorkTree, '');
    const diffCached = child_process.execFileSync('git', ['diff', '--cached'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(diffCached, '');

    // Untracked status relative to statusBefore must only differ by the transaction directory .ci-patch/
    const statusAfter = child_process.execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((line) => !line.includes('.ci-patch'))
      .join('\n');
    assert.equal(statusAfter, statusBefore);

    // Staged path output in .ci-patch/staging/<txId> contains exact patched file
    const stagedFile = path.join(repo, prepRes.isolatedStagedPath);
    const stagedBytes = fs.readFileSync(stagedFile);
    assert.equal(computeSha256(stagedBytes), patchedSha);
    assert.equal(computeGitBlobSha(stagedBytes), patchedBlob);
  });

  test('strip level -p3 strips prefix cleanly and produces strictly a single target file without nested subdirectories', async () => {
    const repo = setupDisposableRepo('git-p3-strip-');
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

    const prepRes = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(prepRes.ok, true);

    const stagingTxDir = path.join(repo, '.ci-patch/staging', txId);
    const entries = fs.readdirSync(stagingTxDir);
    // Must contain exactly 1 entry: stable-diffusion.js (no 'src' or 'endpoints' created)
    assert.deepEqual(entries, ['stable-diffusion.js']);
  });

  test('environment scrubbing prevents host git hooks from executing during patch application', async () => {
    const repo = setupDisposableRepo('git-hook-isolation-');
    const txId = generateTxId();

    const liveTarget = path.join(repo, 'src/endpoints/stable-diffusion.js');
    fs.writeFileSync(liveTarget, authenticStock);

    // Plant a hostile hook in the repo's .git/hooks directory that would create a marker file
    const hooksDir = path.join(repo, '.git/hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookMarker = path.join(repo, 'hook-was-triggered.txt');

    const hookScript = `#!/bin/sh\necho "hook triggered" > "${hookMarker}"\nexit 1\n`;
    const hookNames = ['pre-applypatch', 'applypatch-msg', 'post-applypatch'];
    for (const name of hookNames) {
      const hookPath = path.join(hooksDir, name);
      fs.writeFileSync(hookPath, hookScript, { mode: 0o755 });
    }

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

    const prepRes = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
    });

    assert.equal(prepRes.ok, true);
    // Marker must not exist; git hooks were completely bypassed by GIT_DIR=/dev/null
    assert.equal(fs.existsSync(hookMarker), false);
  });

  test('corrupted or truncated patch fails closed with git-apply-failed and never advances journal', async () => {
    const repo = setupDisposableRepo('git-corrupt-patch-');
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

    // Create a corrupted patch file
    const corruptPatchPath = path.join(repo, 'corrupt.patch');
    fs.writeFileSync(corruptPatchPath, 'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js\ncorrupt gibberish\n@@ -1,5 +1,8 @@\n');

    const prepRes = await prepareIsolatedPatch({
      repoRoot: repo,
      txId,
      op: 'apply',
      lease,
      patchPath: corruptPatchPath,
    });

    assert.equal(prepRes.ok, false);
    assert.equal(prepRes.code, 'git-apply-failed');
    assert.match(prepRes.error, /Git patch execution failed/);

    // Journal remains in phase LOCKED
    const jInspection = inspectJournal(repo);
    assert.equal(jInspection.journal?.phase, 'LOCKED');
    assert.equal(jInspection.journal?.isolatedStagedPath, undefined);

    // Live target remains authentic stock
    const liveBytes = fs.readFileSync(liveTarget);
    assert.equal(computeSha256(liveBytes), stockSha);
  });
});

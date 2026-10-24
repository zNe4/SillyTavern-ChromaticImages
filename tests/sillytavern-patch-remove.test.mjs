import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  applyPatchToInstallation,
  removePatchFromInstallation,
} from '../src/patch-installer/apply-remove.js';
import {
  resolveStorageDirectory,
  acquireProcessLock,
  releaseProcessLock,
  computeSha256,
  BACKUPS_SUBDIR_NAME,
} from '../src/patch-installer/simple-backup.js';
import * as defaultGitOps from '../src/patch-installer/git-ops.js';
import { verifyPatchManifest } from '../scripts/verify-sillytavern-patches.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

const tempDirsToClean = [];

function createTempDir(prefix = 'ci-remove-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

const suiteIsolatedXdg = createTempDir('ci-remove-suite-xdg-');
const originalSuiteXdg = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = suiteIsolatedXdg;

after(() => {
  if (originalSuiteXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalSuiteXdg;
  }
  for (const dir of tempDirsToClean) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
});

function findLocalSillyTavernSource() {
  const candidates = [
    process.env.SILLYTAVERN_TEST_REPO,
    process.env.SILLYTAVERN_DIR,
    '/home/zzzne4/SillyTavern',
    path.resolve(REPO_ROOT, '../SillyTavern'),
  ].filter(Boolean);

  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand)) continue;
      const head = execFileSync(
        'git',
        ['-C', cand, 'rev-parse', '--verify', '06bde939fb1e9c4c8d8641d810f0a916b5bce127'],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();
      if (head) return cand;
    } catch {
      // continue
    }
  }
  return null;
}

function setupDisposableAuthenticFixture() {
  const sourceRepo = findLocalSillyTavernSource();
  if (!sourceRepo) return null;

  const fixtureDir = createTempDir('st-authentic-fixture-');
  execFileSync('git', ['clone', '--quiet', sourceRepo, fixtureDir], {
    stdio: 'ignore',
  });
  execFileSync(
    'git',
    ['-C', fixtureDir, 'checkout', '--quiet', '06bde939fb1e9c4c8d8641d810f0a916b5bce127'],
    {
      stdio: 'ignore',
    }
  );

  return fixtureDir;
}

function setupSyntheticRepo(prefix = 'st-synthetic-') {
  const repoDir = createTempDir(prefix);
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// server\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), '// dummy stock\n');

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'Initial synthetic commit'], { cwd: repoDir });

  return repoDir;
}

describe('Safe Remove Implementation (removePatchFromInstallation)', async () => {
  const manifestRes = await verifyPatchManifest(BUNDLED_MANIFEST_PATH);
  assert.equal(manifestRes.ok, true, 'Bundled manifest must be valid');
  const manifest = manifestRes.manifest;
  const certifiedReleaseCommit = manifest.releaseCommit.toLowerCase();
  const stockSha = manifest.patches.runtime.original.sha256.toLowerCase();
  const patchedSha = manifest.patches.runtime.expected.sha256.toLowerCase();
  const stockBlobSha = manifest.patches.runtime.original.gitBlobSha.toLowerCase();

  // -------------------------------------------------------------------------
  // Tier A: Authentic Pinned-Release Disposable Fixture Tests
  // -------------------------------------------------------------------------
  describe('Authentic Pinned Release (06bde939f) Disposable Fixture', () => {
    const authenticSource = findLocalSillyTavernSource();

    test('authentic pinned-release round-trip: stock → apply → patched → remove → stock', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic round-trip');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      assert.ok(fixtureRepo);
      const customStore = createTempDir('ci-store-roundtrip-');
      const targetRel = 'src/endpoints/stable-diffusion.js';
      const targetPath = path.join(fixtureRepo, targetRel);

      // --- Stage 1: Initial Clean Stock ---
      const initialBytes = fs.readFileSync(targetPath);
      const initialSha = computeSha256(initialBytes).toLowerCase();
      assert.equal(initialSha, stockSha, 'Target must initially match certified stock SHA-256');

      const initialIndex = defaultGitOps.getFileIndexStage(fixtureRepo, targetRel);
      assert.equal(initialIndex.ok, true);
      assert.equal(initialIndex.blobSha.toLowerCase(), stockBlobSha, 'Initial index blob must be stock');
      assert.equal(initialIndex.mode, '100644');
      assert.equal(initialIndex.stage, 0);

      const initialStaged = defaultGitOps.checkTargetStagedModifications(fixtureRepo, targetRel);
      assert.equal(initialStaged.ok, true);
      assert.equal(initialStaged.hasStagedChanges, false, 'No initial staged changes');

      // --- Stage 2: Forward Apply ---
      const applyResult = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      });
      assert.equal(applyResult.ok, true, `Apply must succeed: ${applyResult.reason}`);
      assert.equal(applyResult.status, 'applied');
      assert.equal(applyResult.exitCode, 0);

      // Verify intermediate patched state
      const appliedSha = computeSha256(fs.readFileSync(targetPath)).toLowerCase();
      assert.equal(appliedSha, patchedSha, 'Target must match certified patched SHA-256 after apply');

      const appliedIndex = defaultGitOps.getFileIndexStage(fixtureRepo, targetRel);
      assert.equal(appliedIndex.ok, true);
      assert.equal(appliedIndex.blobSha.toLowerCase(), stockBlobSha, 'Index blob must remain stock after apply');
      assert.equal(appliedIndex.mode, '100644');
      assert.equal(appliedIndex.stage, 0);

      const appliedStaged = defaultGitOps.checkTargetStagedModifications(fixtureRepo, targetRel);
      assert.equal(appliedStaged.hasStagedChanges, false, 'Git index must have no staged changes after apply');

      // Verify stock pre-mutation backup exists and is valid
      assert.ok(applyResult.backup);
      assert.equal(fs.existsSync(applyResult.backup.backupFilePath), true);
      assert.equal(
        computeSha256(fs.readFileSync(applyResult.backup.backupFilePath)).toLowerCase(),
        stockSha,
        'Apply backup must contain stock content'
      );

      // --- Stage 3: Reverse Remove ---
      const removeResult = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      });
      assert.equal(removeResult.ok, true, `Remove must succeed: ${removeResult.reason}`);
      assert.equal(removeResult.status, 'removed');
      assert.equal(removeResult.exitCode, 0);

      // --- Stage 4: Restored Stock State ---
      const restoredBytes = fs.readFileSync(targetPath);
      const restoredSha = computeSha256(restoredBytes).toLowerCase();
      assert.equal(restoredSha, stockSha, 'Target must exactly match certified stock SHA-256 after remove');

      // Verify Git index remains unshifted stock blob
      const restoredIndex = defaultGitOps.getFileIndexStage(fixtureRepo, targetRel);
      assert.equal(restoredIndex.ok, true);
      assert.equal(restoredIndex.blobSha.toLowerCase(), stockBlobSha, 'Index blob must remain stock after remove');
      assert.equal(restoredIndex.mode, '100644');
      assert.equal(restoredIndex.stage, 0);

      const restoredStaged = defaultGitOps.checkTargetStagedModifications(fixtureRepo, targetRel);
      assert.equal(restoredStaged.hasStagedChanges, false, 'Git index must have no staged changes after remove');

      // Verify certified HEAD is unchanged
      const restoredHead = defaultGitOps.getHeadCommit(fixtureRepo);
      assert.equal(restoredHead.ok, true);
      assert.equal(restoredHead.commit.toLowerCase(), certifiedReleaseCommit, 'HEAD must remain certified release');

      // Verify pre-removal patched backup exists and is valid
      assert.ok(removeResult.backup);
      assert.equal(fs.existsSync(removeResult.backup.backupFilePath), true);
      assert.equal(fs.existsSync(removeResult.backup.metaFilePath), true);
      const removeBackupBytes = fs.readFileSync(removeResult.backup.backupFilePath);
      assert.equal(
        computeSha256(removeBackupBytes).toLowerCase(),
        patchedSha,
        'Remove backup must contain patched content'
      );
      const removeBStat = fs.lstatSync(removeResult.backup.backupFilePath);
      assert.equal(removeBStat.mode & 0o077, 0, 'Remove backup file must have mode 0600');

      const metaContent = JSON.parse(fs.readFileSync(removeResult.backup.metaFilePath, 'utf-8'));
      assert.equal(metaContent.operation, 'remove');
      assert.equal(metaContent.sha256.toLowerCase(), patchedSha);
      assert.equal(metaContent.schemaVersion, '1.1.0');

      // Verify earlier apply stock backup was ALSO preserved
      assert.equal(fs.existsSync(applyResult.backup.backupFilePath), true, 'Stock apply backup must be preserved');

      // Verify lock was cleanly released
      const lockFile = path.join(
        customStore,
        'locks',
        `${computeSha256(fs.realpathSync(fixtureRepo)).slice(0, 12)}.lock`
      );
      assert.equal(fs.existsSync(lockFile), false, 'Operation lock must be released after completion');
    });

    test('already-removed target (stock) exits 3 without mutating or creating backup', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('ci-store-already-removed-');
      const targetPath = path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js');

      // Target is currently stock
      const initialSha = computeSha256(fs.readFileSync(targetPath)).toLowerCase();
      assert.equal(initialSha, stockSha);

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 'already-removed');
      assert.equal(result.exitCode, 3);
      assert.match(result.reason, /already matches certified stock endpoint/);

      // Target was not modified
      const postSha = computeSha256(fs.readFileSync(targetPath)).toLowerCase();
      assert.equal(postSha, stockSha);

      // No backups were created in store
      const backupsDir = path.join(customStore, 'backups');
      if (fs.existsSync(backupsDir)) {
        const files = fs.readdirSync(backupsDir);
        assert.equal(files.length, 0, 'No backups should be created when already removed');
      }
    });

    test('removal succeeds independently without any prior apply backup', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const applyStore = createTempDir('ci-store-initial-apply-');

      // First apply patch
      const applyRes = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: applyStore,
      });
      assert.equal(applyRes.status, 'applied');

      // Now remove using a completely separate and empty backup storage directory
      const freshRemoveStore = createTempDir('ci-store-independent-remove-');
      const removeRes = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: freshRemoveStore,
      });

      assert.equal(removeRes.ok, true);
      assert.equal(removeRes.status, 'removed');
      assert.equal(removeRes.exitCode, 0);

      // Verify stock restored
      const postSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(postSha, stockSha);

      // Verify patched backup was created in fresh storage
      assert.ok(removeRes.backup);
      assert.equal(fs.existsSync(removeRes.backup.backupFilePath), true);
    });

    test('preserves unrelated user modifications across removal', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('ci-store-unrelated-remove-');

      // Apply first
      await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      });

      // Introduce unrelated user modification
      const serverJsPath = path.join(fixtureRepo, 'server.js');
      fs.appendFileSync(serverJsPath, '// Unrelated modification during removal\n');

      const removeRes = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      });

      assert.equal(removeRes.ok, true);
      assert.equal(removeRes.status, 'removed');

      // Check unrelated modification is preserved
      const serverContent = fs.readFileSync(serverJsPath, 'utf-8');
      assert.match(serverContent, /\/\/ Unrelated modification during removal/);
    });

    test('double remove: subsequent remove on restored repo returns exit 3 already-removed', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('ci-store-double-remove-');

      // Apply and then remove once
      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });
      const firstRemove = await removePatchFromInstallation({ targetDir: fixtureRepo, backupDir: customStore });
      assert.equal(firstRemove.status, 'removed');

      // Second remove on already stock repo
      const secondRemove = await removePatchFromInstallation({ targetDir: fixtureRepo, backupDir: customStore });
      assert.equal(secondRemove.ok, true);
      assert.equal(secondRemove.status, 'already-removed');
      assert.equal(secondRemove.exitCode, 3);
    });
  });

  // -------------------------------------------------------------------------
  // Tier B: Refusal States and Failure Boundaries (Synthetic Repositories)
  // -------------------------------------------------------------------------
  describe('Refusal States & Failure Boundaries', () => {
    test('refuses uncertified SillyTavern HEAD revision', async () => {
      const syntheticRepo = setupSyntheticRepo('uncertified-head-remove-');
      const customStore = createTempDir('uncertified-store-remove-');

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /does not match certified release/);
    });

    test('refuses non-existent target directory with exitCode 2', async () => {
      const result = await removePatchFromInstallation({
        targetDir: '/tmp/non-existent-st-dir-1122334455',
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 2);
      assert.match(result.reason, /does not exist/);
    });

    test('refuses non-SillyTavern Git repository (missing package.json)', async () => {
      const repoDir = createTempDir('non-st-repo-remove-');
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      const customStore = createTempDir('store-remove-');

      const result = await removePatchFromInstallation({
        targetDir: repoDir,
        backupDir: customStore,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /does not appear to be an authentic SillyTavern installation/);
    });

    test('refuses unrecognized/unknown target fingerprint (neither stock nor patched)', async () => {
      const syntheticRepo = setupSyntheticRepo('unknown-fingerprint-remove-');
      const customStore = createTempDir('store-remove-');

      // Write unrecognized content
      fs.writeFileSync(
        path.join(syntheticRepo, 'src/endpoints/stable-diffusion.js'),
        '// Unrecognized custom code\n'
      );

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
        getFileIndexStage: () => ({ ok: true, exists: true, mode: '100644', stage: 0, blobSha: stockBlobSha }),
        checkTargetStagedModifications: () => ({ ok: true, hasStagedChanges: false }),
      };

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /unrecognized content SHA-256/);
    });

    test('refuses if target file is a symbolic link', async () => {
      const syntheticRepo = setupSyntheticRepo('symlink-target-remove-');
      const customStore = createTempDir('store-remove-');

      const targetPath = path.join(syntheticRepo, 'src/endpoints/stable-diffusion.js');
      const outsideFile = path.join(createTempDir('outside-remove-'), 'real.js');
      fs.writeFileSync(outsideFile, '// outside\n');
      fs.unlinkSync(targetPath);
      fs.symlinkSync(outsideFile, targetPath);

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /symbolic link/);
    });

    test('refuses if parent directory (src/endpoints) is a symbolic link', async () => {
      const syntheticRepo = setupSyntheticRepo('symlink-parent-remove-');
      const customStore = createTempDir('store-remove-');

      const realEndpoints = createTempDir('real-endpoints-remove-');
      fs.writeFileSync(path.join(realEndpoints, 'stable-diffusion.js'), '// endpoint\n');
      fs.rmSync(path.join(syntheticRepo, 'src/endpoints'), { recursive: true, force: true });
      fs.symlinkSync(realEndpoints, path.join(syntheticRepo, 'src/endpoints'));

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /parent directory .* is a symbolic link/);
    });

    test('refuses if target file has staged changes in Git index', async () => {
      const syntheticRepo = setupSyntheticRepo('staged-changes-remove-');
      const customStore = createTempDir('store-remove-');

      fs.writeFileSync(path.join(syntheticRepo, 'src/endpoints/stable-diffusion.js'), '// staged edit\n');
      execFileSync('git', ['add', 'src/endpoints/stable-diffusion.js'], { cwd: syntheticRepo });

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /(staged changes|index blob)/);
    });

    test('refuses if target file has active merge conflicts (index stage > 0)', async () => {
      const syntheticRepo = setupSyntheticRepo('merge-conflict-remove-');
      const customStore = createTempDir('store-remove-');

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
        getFileIndexStage: () => ({ ok: true, exists: true, mode: '100644', stage: 2, blobSha: stockBlobSha }),
      };

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /active merge conflicts/);
    });

    test('refuses if pending legacy .ci-patch transaction exists', async () => {
      const syntheticRepo = setupSyntheticRepo('legacy-tx-remove-');
      const customStore = createTempDir('store-remove-');

      fs.mkdirSync(path.join(syntheticRepo, '.ci-patch/lock.d'), { recursive: true });
      fs.writeFileSync(
        path.join(syntheticRepo, '.ci-patch/lock.d/owner.json'),
        JSON.stringify({ pid: 5678, hostname: 'host', txId: 'ci-tx-5678', op: 'remove' })
      );

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /legacy installer transaction is pending/);
    });

    test('refuses when operation lock is already held (concurrency refusal)', async () => {
      const syntheticRepo = setupSyntheticRepo('concurrent-lock-remove-');
      const customStore = createTempDir('store-remove-');

      const storageRes = resolveStorageDirectory({
        repoRoot: syntheticRepo,
        customOverride: customStore,
      });
      assert.equal(storageRes.ok, true);

      // Pre-acquire lock for remove
      const existingLock = acquireProcessLock(syntheticRepo, {
        lockDir: storageRes.locksDir,
        operation: 'remove',
      });
      assert.equal(existingLock.ok, true);

      const result = await removePatchFromInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'lock-refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /Exclusive operation lock is already held/);

      releaseProcessLock(existingLock);
    });
  });

  // -------------------------------------------------------------------------
  // Tier C: Failure Boundaries, TOCTOU Races & Verification Failures
  // -------------------------------------------------------------------------
  describe('Failure Boundaries, TOCTOU Races & Verification Gates', () => {
    const authenticSource = findLocalSillyTavernSource();

    test('fails closed before mutation if backup creation fails', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-backup-fail-');

      // Apply first to reach patched state
      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const targetPath = path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js');
      const preSha = computeSha256(fs.readFileSync(targetPath)).toLowerCase();
      assert.equal(preSha, patchedSha);

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          backupHooks: {
            beforeBackupFsync() {
              throw new Error('SIMULATED_DISK_FULL_DURING_REMOVE_BACKUP');
            },
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /SIMULATED_DISK_FULL_DURING_REMOVE_BACKUP/);

      // Verify backup evidence is preserved
      assert.ok(result.backup);
      assert.ok(result.backup.backupFilePath);
      assert.equal(fs.existsSync(result.backup.backupFilePath), true);

      // Target remains untouched (still patched!)
      const postSha = computeSha256(fs.readFileSync(targetPath)).toLowerCase();
      assert.equal(postSha, patchedSha, 'Target file must remain untouched when backup fails');
    });

    test('TOCTOU: refuses if target file content changes between backup and mutation', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-toctou-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          preMutationHook({ targetFilePath }) {
            // Tamper with target file right before reverse apply
            fs.writeFileSync(targetFilePath, '// tampered in race during remove\n');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /Pre-mutation revalidation failed.*target file content changed/);
      assert.ok(result.backup, 'Pre-removal patched backup must be preserved');
    });

    test('TOCTOU: refuses if repository HEAD changes between backup and mutation', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-toctou-head-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      let mockCommit = certifiedReleaseCommit;
      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: (dir) => ({ ok: true, commit: mockCommit }),
      };

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          gitOps: mockGitOps,
          preMutationHook() {
            // Shift HEAD right before mutation
            mockCommit = '1111111111111111111111111111111111111111';
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /Pre-mutation revalidation failed.*repository HEAD changed/);
    });

    test('TOCTOU: refuses if Git index changes between backup and mutation', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-toctou-index-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      let stageConflict = 0;
      const mockGitOps = {
        ...defaultGitOps,
        getFileIndexStage: (dir, file) => {
          const res = defaultGitOps.getFileIndexStage(dir, file);
          return { ...res, stage: stageConflict };
        },
      };

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          gitOps: mockGitOps,
          preMutationHook() {
            // Introduce index conflict right before mutation
            stageConflict = 1;
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /Pre-mutation revalidation failed.*Git index changed/);
    });

    test('TOCTOU: refuses if parent directory (src/endpoints) is replaced with symlink in preMutationHook', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-parent-symlink-race-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          preMutationHook({ targetFilePath }) {
            const endpointsDir = path.dirname(targetFilePath);
            const outsideDir = createTempDir('outside-endpoints-remove-race-');
            fs.copyFileSync(targetFilePath, path.join(outsideDir, 'stable-diffusion.js'));
            fs.rmSync(endpointsDir, { recursive: true, force: true });
            fs.symlinkSync(outsideDir, endpointsDir);
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /parent directory \(src\/endpoints\) was replaced with a symbolic link/);
    });

    test('reverse git apply failure during mutation fails closed and requires human inspection', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-git-fail-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const mockGitOps = {
        ...defaultGitOps,
        applyPatchWorktree: () => ({
          ok: false,
          exitCode: 1,
          stdout: '',
          stderr: 'error: patch failed: src/endpoints/stable-diffusion.js:10',
          error: 'git apply --reverse failed: simulated conflict',
          isTimeout: false,
        }),
      };

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'verification-failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.humanInspectionRequired, true);
      assert.match(result.reason, /git apply --reverse failed during mutation/);
      assert.ok(result.backup, 'Pre-removal patched backup must be preserved');
      assert.ok(result.observedFingerprints);
    });

    test('post-removal verification failure (SHA mismatch) reports diagnostic and requires human inspection', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-post-mismatch-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          postMutationHook({ targetFilePath }) {
            // Corrupt file after git apply --reverse
            fs.writeFileSync(targetFilePath, '// corrupted stock result\n');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'verification-failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.humanInspectionRequired, true);
      assert.ok(result.backup, 'Pre-removal patched backup must be preserved');
      assert.equal(fs.existsSync(result.backup.backupFilePath), true);
      assert.ok(result.observedFingerprints);
      assert.equal(result.observedFingerprints.expectedSha256, stockSha);
      assert.match(result.reason, /Post-removal verification failed/);
    });

    test('lock cleanup failure fails closed with exitCode 1 and preserves mutationOutcome removed', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-lock-replaced-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          async postMutationHook({ lockHandle }) {
            // Tamper/replace the lock right before release
            fs.unlinkSync(lockHandle.lockPath);
            fs.writeFileSync(
              lockHandle.lockPath,
              JSON.stringify({ pid: 888888, nonce: 'foreign-nonce-remove', repoHash: lockHandle.repoHash }),
              { mode: 0o600 }
            );
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'lock-cleanup-failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.mutationOutcome, 'removed');
      assert.equal(result.humanInspectionRequired, true);
      assert.match(result.reason, /lock release failed/);
      assert.ok(result.lockPath);
      assert.equal(fs.existsSync(result.lockPath), true, 'Foreign lock file must be preserved');

      // The live target was in fact restored to stock
      const postSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(postSha, stockSha);

      // Clean up foreign lock
      fs.unlinkSync(result.lockPath);
    });

    test('unexpected exception pre-mutation yields status error and exitCode 1', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-crash-pre-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          preMutationHook() {
            throw new Error('SIMULATED_PRE_REMOVAL_CRASH');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'error');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /SIMULATED_PRE_REMOVAL_CRASH/);
      assert.equal(result.humanInspectionRequired, false);

      // Target was not modified (still patched)
      const postSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(postSha, patchedSha);
    });

    test('unexpected exception post-mutation yields status verification-failed with fingerprints', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-remove-crash-post-');

      await applyPatchToInstallation({ targetDir: fixtureRepo, backupDir: customStore });

      const result = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          postMutationHook() {
            throw new Error('SIMULATED_POST_REMOVAL_CRASH');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'verification-failed');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /SIMULATED_POST_REMOVAL_CRASH/);
      assert.equal(result.humanInspectionRequired, true);
      assert.ok(result.observedFingerprints);
      assert.equal(result.observedFingerprints.stockSha256, stockSha);
    });
  });

  // -------------------------------------------------------------------------
  // Tier D: Lock Namespace Independence (D01-SP-2-R-F1)
  // -------------------------------------------------------------------------
  describe('Lock Namespace Independence (D01-SP-2-R-F1)', () => {
    const authenticSource = findLocalSillyTavernSource();

    test('Apply lock held with backupDir A → remove with backupDir B is refused (authentic)', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic lock independence test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const backupDirA = createTempDir('ci-backup-apply-held-a-');
      const backupDirB = createTempDir('ci-backup-remove-refused-b-');

      // 1. Initial apply to place the fixture in patched state using backupDir A
      const initialApply = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: backupDirA,
      });
      assert.equal(initialApply.ok, true, 'Initial apply must succeed');

      // Verify repo is patched
      const targetFile = path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js');
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), patchedSha);

      // 2. Resolve lock namespace and simulate an active process holding the 'apply' lock for this repo
      const storageA = resolveStorageDirectory({ repoRoot: fixtureRepo, backupOverride: backupDirA });
      assert.equal(storageA.ok, true);

      const heldLock = acquireProcessLock(fixtureRepo, {
        lockDir: storageA.locksDir,
        operation: 'apply',
      });
      assert.equal(heldLock.ok, true, 'Pre-acquiring exclusive operation lock must succeed');

      try {
        // 3. Attempt remove with distinct backup destination backupDir B while lock is held
        const removeResult = await removePatchFromInstallation({
          targetDir: fixtureRepo,
          backupDir: backupDirB,
        });

        // 4. Concurrency refusal: Must refuse rather than acquire another lock
        assert.equal(removeResult.ok, false);
        assert.equal(removeResult.status, 'lock-refused');
        assert.equal(removeResult.exitCode, 1);
        assert.match(removeResult.reason, /Exclusive operation lock is already held/);

        // Target file must remain untouched in patched state
        assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), patchedSha);

        // Pre-removal backup must NOT have been created in backupDir B
        const bBackups = path.join(backupDirB, BACKUPS_SUBDIR_NAME);
        if (fs.existsSync(bBackups)) {
          const filesInB = fs.readdirSync(bBackups);
          assert.equal(filesInB.length, 0, 'No backups should be created on lock refusal');
        }
      } finally {
        // 5. Release held lock
        const releaseRes = releaseProcessLock(heldLock);
        assert.equal(releaseRes.ok, true);
      }

      // 6. After releasing lock, remove with backupDir B must now succeed
      const secondRemove = await removePatchFromInstallation({
        targetDir: fixtureRepo,
        backupDir: backupDirB,
      });
      assert.equal(secondRemove.ok, true, 'Removal must succeed once lock is released');
      assert.equal(secondRemove.status, 'removed');
      assert.equal(secondRemove.exitCode, 0);

      // Target file is restored to stock
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), stockSha);

      // Backup destination B was independently selectable: pre-removal backup was stored in backupDir B
      const backupsInB = fs.readdirSync(path.join(backupDirB, BACKUPS_SUBDIR_NAME));
      assert.ok(backupsInB.some((f) => f.endsWith('.meta.json')), 'backupDir B must contain metadata');
      assert.ok(backupsInB.some((f) => f.endsWith('.bak')), 'backupDir B must contain pre-removal backup');
    });

    test('Remove lock held with backupDir B → apply with backupDir A is refused (authentic)', async (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic lock independence test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const backupDirB = createTempDir('ci-backup-remove-held-b-');
      const backupDirA = createTempDir('ci-backup-apply-refused-a-');

      const targetFile = path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js');
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), stockSha);

      // 1. Resolve lock namespace and simulate an active process holding the 'remove' lock for this repo
      const storageB = resolveStorageDirectory({ repoRoot: fixtureRepo, backupOverride: backupDirB });
      assert.equal(storageB.ok, true);

      const heldLock = acquireProcessLock(fixtureRepo, {
        lockDir: storageB.locksDir,
        operation: 'remove',
      });
      assert.equal(heldLock.ok, true, 'Pre-acquiring exclusive operation lock must succeed');

      try {
        // 2. Attempt apply with distinct backup destination backupDir A while lock is held
        const applyResult = await applyPatchToInstallation({
          targetDir: fixtureRepo,
          backupDir: backupDirA,
        });

        // 3. Concurrency refusal: Must refuse rather than acquire another lock
        assert.equal(applyResult.ok, false);
        assert.equal(applyResult.status, 'lock-refused');
        assert.equal(applyResult.exitCode, 1);
        assert.match(applyResult.reason, /Exclusive operation lock is already held/);

        // Target file must remain untouched in stock state
        assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), stockSha);

        // Pre-mutation backup must NOT have been created in backupDir A
        const aBackups = path.join(backupDirA, BACKUPS_SUBDIR_NAME);
        if (fs.existsSync(aBackups)) {
          const filesInA = fs.readdirSync(aBackups);
          assert.equal(filesInA.length, 0, 'No backups should be created on lock refusal');
        }
      } finally {
        // 4. Release held lock
        const releaseRes = releaseProcessLock(heldLock);
        assert.equal(releaseRes.ok, true);
      }

      // 5. After releasing lock, apply with backupDir A must now succeed
      const secondApply = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: backupDirA,
      });
      assert.equal(secondApply.ok, true, 'Apply must succeed once lock is released');
      assert.equal(secondApply.status, 'applied');
      assert.equal(secondApply.exitCode, 0);

      // Target file is patched
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), patchedSha);

      // Backup destination A was independently selectable: pre-mutation backup was stored in backupDir A
      const backupsInA = fs.readdirSync(path.join(backupDirA, BACKUPS_SUBDIR_NAME));
      assert.ok(backupsInA.some((f) => f.endsWith('.meta.json')), 'backupDir A must contain metadata');
      assert.ok(backupsInA.some((f) => f.endsWith('.bak')), 'backupDir A must contain pre-mutation backup');
    });

    test('deterministic synthetic lock independence: Apply lock held (backupDir A) refuses Remove (backupDir B)', async () => {
      const syntheticRepo = setupSyntheticRepo('synth-f1-apply-held-');
      const backupDirA = createTempDir('ci-synth-backup-a-');
      const backupDirB = createTempDir('ci-synth-backup-b-');

      const storageA = resolveStorageDirectory({ repoRoot: syntheticRepo, backupOverride: backupDirA });
      assert.equal(storageA.ok, true);

      const heldLock = acquireProcessLock(syntheticRepo, {
        lockDir: storageA.locksDir,
        operation: 'apply',
      });
      assert.equal(heldLock.ok, true);

      try {
        const removeResult = await removePatchFromInstallation({
          targetDir: syntheticRepo,
          backupDir: backupDirB,
        });

        assert.equal(removeResult.ok, false);
        assert.equal(removeResult.status, 'lock-refused');
        assert.equal(removeResult.exitCode, 1);
        assert.match(removeResult.reason, /Exclusive operation lock is already held/);
      } finally {
        releaseProcessLock(heldLock);
      }
    });

    test('deterministic synthetic lock independence: Remove lock held (backupDir B) refuses Apply (backupDir A)', async () => {
      const syntheticRepo = setupSyntheticRepo('synth-f1-remove-held-');
      const backupDirA = createTempDir('ci-synth-backup-a-');
      const backupDirB = createTempDir('ci-synth-backup-b-');

      const storageB = resolveStorageDirectory({ repoRoot: syntheticRepo, backupOverride: backupDirB });
      assert.equal(storageB.ok, true);

      const heldLock = acquireProcessLock(syntheticRepo, {
        lockDir: storageB.locksDir,
        operation: 'remove',
      });
      assert.equal(heldLock.ok, true);

      try {
        const applyResult = await applyPatchToInstallation({
          targetDir: syntheticRepo,
          backupDir: backupDirA,
        });

        assert.equal(applyResult.ok, false);
        assert.equal(applyResult.status, 'lock-refused');
        assert.equal(applyResult.exitCode, 1);
        assert.match(applyResult.reason, /Exclusive operation lock is already held/);
      } finally {
        releaseProcessLock(heldLock);
      }
    });
  });
});

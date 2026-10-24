import { describe, test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applyPatchToInstallation } from '../src/patch-installer/apply-remove.js';
import {
  resolveStorageDirectory,
  acquireProcessLock,
  releaseProcessLock,
  computeSha256,
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

function createTempDir(prefix = 'ci-apply-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

const suiteIsolatedXdg = createTempDir('ci-apply-suite-xdg-');
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
      const head = execFileSync('git', ['-C', cand, 'rev-parse', '--verify', '06bde939fb1e9c4c8d8641d810f0a916b5bce127'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
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
  execFileSync('git', ['-C', fixtureDir, 'checkout', '--quiet', '06bde939fb1e9c4c8d8641d810f0a916b5bce127'], {
    stdio: 'ignore',
  });

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

describe('Safe Apply Implementation (applyPatchToInstallation)', async () => {
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

    test('clean apply on authentic stock SillyTavern checkout succeeds end-to-end', (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic apply');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      assert.ok(fixtureRepo);
      const customStore = createTempDir('ci-store-apply-');

      // Pre-condition verification
      const preSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(preSha, stockSha, 'Target must initially match certified stock SHA-256');

      // Execute apply
      return applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      }).then((result) => {
        assert.equal(result.ok, true, `Apply must succeed: ${result.reason}`);
        assert.equal(result.status, 'applied');
        assert.equal(result.exitCode, 0);

        // 1. Target file content verified
        const postSha = computeSha256(
          fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
        ).toLowerCase();
        assert.equal(postSha, patchedSha, 'Target file in worktree must match certified patched SHA-256');

        // 2. Git index blob remains stock blob, mode 100644, unshifted
        const indexRes = defaultGitOps.getFileIndexStage(fixtureRepo, 'src/endpoints/stable-diffusion.js');
        assert.equal(indexRes.ok, true);
        assert.equal(indexRes.blobSha.toLowerCase(), stockBlobSha, 'Index blob must remain stock');
        assert.equal(indexRes.mode, '100644');
        assert.equal(indexRes.stage, 0);

        // 3. Git index has no staged changes
        const stagedRes = defaultGitOps.checkTargetStagedModifications(
          fixtureRepo,
          'src/endpoints/stable-diffusion.js'
        );
        assert.equal(stagedRes.ok, true);
        assert.equal(stagedRes.hasStagedChanges, false, 'Git index must have no staged changes');

        // 4. Backup file exists, mode 0600, matches stock SHA-256
        assert.ok(result.backup);
        assert.equal(fs.existsSync(result.backup.backupFilePath), true);
        assert.equal(fs.existsSync(result.backup.metaFilePath), true);
        const backupBytes = fs.readFileSync(result.backup.backupFilePath);
        assert.equal(computeSha256(backupBytes).toLowerCase(), stockSha, 'Backup content must match stock SHA');
        const bStat = fs.lstatSync(result.backup.backupFilePath);
        assert.equal(bStat.mode & 0o077, 0, 'Backup file must have mode 0600');

        // 5. Lock was safely released
        const lockFile = path.join(customStore, 'locks', `${computeSha256(fs.realpathSync(fixtureRepo)).slice(0, 12)}.lock`);
        assert.equal(fs.existsSync(lockFile), false, 'Operation lock must be released after completion');
      });
    });

    test('already-applied target is recognized and exits 3 without mutating', (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('ci-store-reapply-');

      // First apply
      return applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      }).then((firstRes) => {
        assert.equal(firstRes.status, 'applied');

        // Re-apply on already-patched repository
        return applyPatchToInstallation({
          targetDir: fixtureRepo,
          backupDir: customStore,
        }).then((secondRes) => {
          assert.equal(secondRes.ok, true);
          assert.equal(secondRes.status, 'already-applied');
          assert.equal(secondRes.exitCode, 3);
          assert.match(secondRes.reason, /already present in working tree/);

          // Content remains patched
          const postSha = computeSha256(
            fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
          ).toLowerCase();
          assert.equal(postSha, patchedSha);
        });
      });
    });

    test('preserves unrelated user modifications across apply', (t) => {
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('ci-store-unrelated-');

      // Make an unrelated modification in working tree
      const serverJsPath = path.join(fixtureRepo, 'server.js');
      fs.appendFileSync(serverJsPath, '// Unrelated user change\n');

      return applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
      }).then((result) => {
        assert.equal(result.ok, true);
        assert.equal(result.status, 'applied');

        // Check unrelated modification is preserved
        const serverContent = fs.readFileSync(serverJsPath, 'utf-8');
        assert.match(serverContent, /\/\/ Unrelated user change/);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Tier B: Refusal States and Failure Boundaries (Synthetic Repositories)
  // -------------------------------------------------------------------------
  describe('Refusal States & Failure Boundaries', () => {
    test('refuses uncertified SillyTavern HEAD revision', async () => {
      const syntheticRepo = setupSyntheticRepo('uncertified-head-');
      const customStore = createTempDir('uncertified-store-');

      const result = await applyPatchToInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /does not match certified release/);
    });

    test('refuses non-existent target directory', async () => {
      const result = await applyPatchToInstallation({
        targetDir: '/tmp/non-existent-st-dir-987654321',
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 2);
      assert.match(result.reason, /does not exist/);
    });

    test('refuses non-SillyTavern Git repository (missing package.json)', async () => {
      const repoDir = createTempDir('non-st-repo-');
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      const customStore = createTempDir('store-');

      const result = await applyPatchToInstallation({
        targetDir: repoDir,
        backupDir: customStore,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /does not appear to be an authentic SillyTavern installation/);
    });

    test('refuses if target file is a symbolic link', async () => {
      const syntheticRepo = setupSyntheticRepo('symlink-target-');
      const customStore = createTempDir('store-');

      const targetPath = path.join(syntheticRepo, 'src/endpoints/stable-diffusion.js');
      const outsideFile = path.join(createTempDir('outside-'), 'real.js');
      fs.writeFileSync(outsideFile, '// outside\n');
      fs.unlinkSync(targetPath);
      fs.symlinkSync(outsideFile, targetPath);

      // Inject certified HEAD in gitOps to reach the symlink check
      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await applyPatchToInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /symbolic link/);
    });

    test('refuses if parent directory (src/endpoints) is a symbolic link', async () => {
      const syntheticRepo = setupSyntheticRepo('symlink-parent-');
      const customStore = createTempDir('store-');

      const realEndpoints = createTempDir('real-endpoints-');
      fs.writeFileSync(path.join(realEndpoints, 'stable-diffusion.js'), '// endpoint\n');
      fs.rmSync(path.join(syntheticRepo, 'src/endpoints'), { recursive: true, force: true });
      fs.symlinkSync(realEndpoints, path.join(syntheticRepo, 'src/endpoints'));

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await applyPatchToInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /parent directory .* is a symbolic link/);
    });

    test('refuses if target file has staged changes in Git index', async () => {
      const syntheticRepo = setupSyntheticRepo('staged-changes-');
      const customStore = createTempDir('store-');

      // Make a change and stage it
      fs.writeFileSync(path.join(syntheticRepo, 'src/endpoints/stable-diffusion.js'), '// staged edit\n');
      execFileSync('git', ['add', 'src/endpoints/stable-diffusion.js'], { cwd: syntheticRepo });

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await applyPatchToInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /(staged changes|index blob)/);
    });

    test('refuses if pending legacy .ci-patch transaction exists', async () => {
      const syntheticRepo = setupSyntheticRepo('legacy-tx-');
      const customStore = createTempDir('store-');

      // Create legacy transaction lock directory
      fs.mkdirSync(path.join(syntheticRepo, '.ci-patch/lock.d'), { recursive: true });
      fs.writeFileSync(
        path.join(syntheticRepo, '.ci-patch/lock.d/owner.json'),
        JSON.stringify({ pid: 1234, hostname: 'host', txId: 'ci-tx-1234', op: 'apply' })
      );

      const mockGitOps = {
        ...defaultGitOps,
        getHeadCommit: () => ({ ok: true, commit: certifiedReleaseCommit }),
      };

      const result = await applyPatchToInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
        _testOverrides: { gitOps: mockGitOps },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /legacy installer transaction is pending/);
    });

    test('refuses when operation lock is already held (concurrency refusal)', async () => {
      const syntheticRepo = setupSyntheticRepo('concurrent-lock-');
      const customStore = createTempDir('store-');

      const storageRes = resolveStorageDirectory({
        repoRoot: syntheticRepo,
        customOverride: customStore,
      });
      assert.equal(storageRes.ok, true);

      // Pre-acquire lock to simulate concurrent runner
      const existingLock = acquireProcessLock(syntheticRepo, {
        lockDir: storageRes.locksDir,
        operation: 'apply',
      });
      assert.equal(existingLock.ok, true);

      const result = await applyPatchToInstallation({
        targetDir: syntheticRepo,
        backupDir: customStore,
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'lock-refused');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /Exclusive operation lock is already held/);

      // Clean up manually
      releaseProcessLock(existingLock);
    });

    test('fails closed before mutation if backup creation fails', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-backup-fail-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          backupHooks: {
            beforeBackupFsync() {
              throw new Error('SIMULATED_DISK_FULL_BEFORE_MUTATION');
            },
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /SIMULATED_DISK_FULL_BEFORE_MUTATION/);

      // Verify structured result includes preserved backup artifact path
      assert.ok(result.backup, 'Structured result must include backup evidence');
      assert.ok(result.backup.backupFilePath, 'Result must contain backupFilePath');
      assert.equal(fs.existsSync(result.backup.backupFilePath), true, 'Partial backup file must be preserved on disk');
      assert.equal(result.backup.metaFilePath, null, 'Metadata was not written');

      // Live target file in repository remains completely untouched stock!
      const postSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(postSha, stockSha, 'Live target file must remain unmodified on backup failure');
    });

    test('TOCTOU: refuses if target file content changes between preflight and mutation', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-toctou-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          preMutationHook({ targetFilePath }) {
            // Tamper with target file right before mutation
            fs.writeFileSync(targetFilePath, '// tampered in race\n');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.reason, /Pre-mutation revalidation failed.*target file content changed/);
    });

    test('post-mutation verification failure reports diagnostic and requires human inspection without auto rollback', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-post-mismatch-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          postMutationHook({ targetFilePath }) {
            // Corrupt file after git apply
            fs.writeFileSync(targetFilePath, '// corrupted result\n');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'verification-failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.humanInspectionRequired, true);
      assert.ok(result.backup, 'Stock backup must be preserved');
      assert.equal(fs.existsSync(result.backup.backupFilePath), true);
      assert.ok(result.observedFingerprints);
      assert.match(result.reason, /Post-application verification failed/);
    });

    test('lock cleanup failure fails closed with exitCode 1 and preserves mutationOutcome applied', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-lock-replaced-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          async postMutationHook({ lockHandle }) {
            // Tamper/replace the lock right before release
            fs.unlinkSync(lockHandle.lockPath);
            fs.writeFileSync(
              lockHandle.lockPath,
              JSON.stringify({ pid: 999999, nonce: 'foreign-nonce', repoHash: lockHandle.repoHash }),
              { mode: 0o600 }
            );
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'lock-cleanup-failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.mutationOutcome, 'applied');
      assert.equal(result.humanInspectionRequired, true);
      assert.match(result.reason, /lock release failed/);
      assert.ok(result.lockPath);
      // Ensure replaced lock file is preserved on disk
      assert.equal(fs.existsSync(result.lockPath), true, 'Foreign lock file must be preserved');

      // Live patch actually succeeded
      const postSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(postSha, patchedSha);

      // Clean up foreign lock
      fs.unlinkSync(result.lockPath);
    });

    test('TOCTOU: refuses and aborts mutation if parent directory (src/endpoints) is replaced with symlink in preMutationHook', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-parent-symlink-race-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          preMutationHook({ targetFilePath }) {
            const endpointsDir = path.dirname(targetFilePath);
            const outsideDir = createTempDir('outside-endpoints-race-');
            // Copy original file to outsideDir
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

    test('unexpected exception pre-mutation yields status error and exitCode 1', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-crash-pre-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          preMutationHook() {
            throw new Error('SIMULATED_PRE_MUTATION_CRASH');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'error');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /SIMULATED_PRE_MUTATION_CRASH/);
      assert.equal(result.humanInspectionRequired, false);

      // Target was not modified
      const postSha = computeSha256(
        fs.readFileSync(path.join(fixtureRepo, 'src/endpoints/stable-diffusion.js'))
      ).toLowerCase();
      assert.equal(postSha, stockSha);
    });

    test('unexpected exception post-mutation yields status verification-failed with fingerprints', async (t) => {
      const authenticSource = findLocalSillyTavernSource();
      if (!authenticSource) {
        t.skip('Local authentic SillyTavern source not found; skipping authentic test');
        return;
      }

      const fixtureRepo = setupDisposableAuthenticFixture();
      const customStore = createTempDir('store-crash-post-');

      const result = await applyPatchToInstallation({
        targetDir: fixtureRepo,
        backupDir: customStore,
        _testOverrides: {
          postMutationHook() {
            throw new Error('SIMULATED_POST_MUTATION_CRASH');
          },
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 'verification-failed');
      assert.equal(result.exitCode, 1);
      assert.match(result.reason, /SIMULATED_POST_MUTATION_CRASH/);
      assert.equal(result.humanInspectionRequired, true);
      assert.ok(result.observedFingerprints);
      assert.equal(result.observedFingerprints.stockSha256, stockSha);
    });
  });
});

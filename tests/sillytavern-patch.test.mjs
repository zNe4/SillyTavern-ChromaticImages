import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  classifyTargetState,
  inspectTargetInstallation,
  checkInstallationPreflight,
  computeSha256,
} from '../src/patch-installer/inspect.js';
import { parseCliArgs, main } from '../scripts/sillytavern-patch.mjs';
import { runGit } from '../src/patch-installer/git-ops.js';
import { verifyPatchManifest } from '../scripts/verify-sillytavern-patches.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_MANIFEST_PATH = path.join(
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

function createTempDir(prefix = 'ci-patch-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

describe('SillyTavern patch installer preflight (D01-P3A)', async () => {
  const manifestRes = await verifyPatchManifest(PRODUCTION_MANIFEST_PATH);
  assert.equal(manifestRes.ok, true, 'Bundled manifest must pass verification');
  const manifest = manifestRes.manifest;

  describe('Tier 1: Pure state-machine classification (classifyTargetState)', () => {
    function createBaseObservations() {
      return {
        packageValid: true,
        packageErrors: [],
        isDir: true,
        isGitRepo: true,
        isRepoRoot: true,
        isSillyTavern: true,
        targetFileExists: true,
        isTargetFileRegular: true,
        isTargetFileSymlink: false,
        isIntermediateSymlink: false,
        headCommit: manifest.releaseCommit,
        headBranch: 'release',
        indexExists: true,
        indexMode: '100644',
        indexBlobSha: manifest.patches.runtime.original.gitBlobSha,
        indexStage: 0,
        hasStagedChanges: false,
        worktreeSha256: manifest.patches.runtime.original.sha256,
        unrelatedChangesCount: 0,
        developerBranches: [],
      };
    }

    test('classifies not-installed state cleanly on stock release', () => {
      const obs = createBaseObservations();
      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'not-installed');
      assert.equal(res.targetFileState, 'original');
      assert.equal(res.isReleaseCommit, true);
    });

    test('classifies installed state cleanly when worktree has patched file and index is unshifted', () => {
      const obs = createBaseObservations();
      // Worktree matches expected patched SHA-256
      obs.worktreeSha256 = manifest.patches.runtime.expected.sha256;
      // Index remains unshifted at original stock blob
      obs.indexBlobSha = manifest.patches.runtime.original.gitBlobSha;

      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'installed');
      assert.equal(res.targetFileState, 'installed');
      assert.equal(res.isReleaseCommit, true);
    });

    test('classifies invalid-package when manifest validation failed', () => {
      const obs = createBaseObservations();
      obs.packageValid = false;
      obs.packageErrors = ['Tampered checksum'];

      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'invalid-package');
    });

    test('classifies invalid-installation on missing directory or non-repo', () => {
      const obs1 = createBaseObservations();
      obs1.isDir = false;
      assert.equal(classifyTargetState(obs1, manifest).status, 'invalid-installation');

      const obs2 = createBaseObservations();
      obs2.isGitRepo = false;
      assert.equal(classifyTargetState(obs2, manifest).status, 'invalid-installation');

      const obs3 = createBaseObservations();
      obs3.isRepoRoot = false;
      assert.equal(classifyTargetState(obs3, manifest).status, 'invalid-installation');

      const obs4 = createBaseObservations();
      obs4.isSillyTavern = false;
      assert.equal(classifyTargetState(obs4, manifest).status, 'invalid-installation');
    });

    test('classifies invalid-installation on target or parent symlinks or missing target file', () => {
      const obs1 = createBaseObservations();
      obs1.isTargetFileSymlink = true;
      assert.equal(classifyTargetState(obs1, manifest).status, 'invalid-installation');

      const obs2 = createBaseObservations();
      obs2.isIntermediateSymlink = true;
      assert.equal(classifyTargetState(obs2, manifest).status, 'invalid-installation');

      const obs3 = createBaseObservations();
      obs3.targetFileExists = false;
      assert.equal(classifyTargetState(obs3, manifest).status, 'invalid-installation');

      const obs4 = createBaseObservations();
      obs4.isTargetFileRegular = false;
      assert.equal(classifyTargetState(obs4, manifest).status, 'invalid-installation');
    });

    test('classifies unsupported-revision when HEAD commit differs, irrespective of file hash', () => {
      const obs1 = createBaseObservations();
      obs1.headCommit = '1111111111111111111111111111111111111111';
      obs1.worktreeSha256 = manifest.patches.runtime.original.sha256;
      const res1 = classifyTargetState(obs1, manifest);
      assert.equal(res1.status, 'unsupported-revision');
      assert.equal(res1.isReleaseCommit, false);
      assert.equal(res1.targetFileState, 'original');

      const obs2 = createBaseObservations();
      obs2.headCommit = '2222222222222222222222222222222222222222';
      obs2.worktreeSha256 = manifest.patches.runtime.expected.sha256;
      const res2 = classifyTargetState(obs2, manifest);
      assert.equal(res2.status, 'unsupported-revision');
      assert.equal(res2.isReleaseCommit, false);
      assert.equal(res2.targetFileState, 'installed');
    });

    test('classifies unsupported-revision with developer branch details when on M03 proxy branch', () => {
      const obs = createBaseObservations();
      obs.headCommit = manifest.sourceCommit;
      obs.developerBranches = [
        { branch: 'm03-d2b1-nanogpt-proxy', commit: manifest.sourceCommit },
      ];

      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'unsupported-revision');
      assert.equal(res.developerBranch?.branch, 'm03-d2b1-nanogpt-proxy');
      assert.match(res.reasons[0], /detected developer branch/);
    });

    test('classifies modified-or-conflicting when staged changes exist', () => {
      const obs = createBaseObservations();
      obs.hasStagedChanges = true;
      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'modified-or-conflicting');
    });

    test('classifies modified-or-conflicting when merge conflict is active (stage != 0)', () => {
      const obs = createBaseObservations();
      obs.indexStage = 2;
      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'modified-or-conflicting');
    });

    test('classifies modified-or-conflicting when index blob differs from stock release blob', () => {
      const obs = createBaseObservations();
      obs.indexBlobSha = '9999999999999999999999999999999999999999';
      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'modified-or-conflicting');
    });

    test('classifies modified-or-conflicting when working file has unrecognized content', () => {
      const obs = createBaseObservations();
      obs.worktreeSha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const res = classifyTargetState(obs, manifest);
      assert.equal(res.status, 'modified-or-conflicting');
      assert.equal(res.targetFileState, 'unknown');
    });
  });

  describe('CLI argument parsing (parseCliArgs)', () => {
    test('defaults to status command and parses target directory', () => {
      const res = parseCliArgs(['/path/to/SillyTavern']);
      assert.equal(res.command, 'status');
      assert.equal(res.targetDir, '/path/to/SillyTavern');
      assert.equal(res.json, false);
      assert.equal(res.error, null);
    });

    test('accepts explicit --status and --check commands', () => {
      const res1 = parseCliArgs(['--status', '--target', '/path/to/st']);
      assert.equal(res1.command, 'status');
      assert.equal(res1.targetDir, '/path/to/st');

      const res2 = parseCliArgs(['--check', '/path/to/st']);
      assert.equal(res2.command, 'check');
      assert.equal(res2.targetDir, '/path/to/st');
    });

    test('parses --json flag', () => {
      const res = parseCliArgs(['--check', '--json', '/path/to/st']);
      assert.equal(res.json, true);
      assert.equal(res.command, 'check');
    });

    test('rejects premature --apply and --remove with deferred message', () => {
      const resApply = parseCliArgs(['--apply', '/path/to/st']);
      assert.match(resApply.error, /deferred to D01-P3B/);

      const resRemove = parseCliArgs(['--remove', '/path/to/st']);
      assert.match(resRemove.error, /deferred to D01-P3B/);
    });

    test('rejects conflicting commands', () => {
      const res = parseCliArgs(['--status', '--check', '/path/to/st']);
      assert.match(res.error, /Conflicting commands/);
    });

    test('rejects unknown options', () => {
      const res = parseCliArgs(['--unknown-flag', '/path/to/st']);
      assert.match(res.error, /Unknown option: --unknown-flag/);
    });

    test('falls back to SILLYTAVERN_DIR environment variable if target omitted', () => {
      const oldEnv = process.env.SILLYTAVERN_DIR;
      process.env.SILLYTAVERN_DIR = '/env/path/st';
      try {
        const res = parseCliArgs(['--check']);
        assert.equal(res.targetDir, '/env/path/st');
      } finally {
        if (oldEnv === undefined) {
          delete process.env.SILLYTAVERN_DIR;
        } else {
          process.env.SILLYTAVERN_DIR = oldEnv;
        }
      }
    });
  });

  describe('Tier 2: Real Git-command testing (Disposable Repositories)', () => {
    function setupDisposableRepo(dirName = 'st-fixture-') {
      const repoDir = createTempDir(dirName);
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

      // Create SillyTavern layout
      fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
      fs.writeFileSync(path.join(repoDir, 'server.js'), '// server\n');
      fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), '// original\n');

      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: repoDir });

      return repoDir;
    }

    test('rejects non-existent directory with invalid-installation and exit code 1', async () => {
      const nonExistent = path.join(os.tmpdir(), 'non-existent-st-dir-' + Date.now());
      const res = await inspectTargetInstallation({ targetDir: nonExistent });
      assert.equal(res.status, 'invalid-installation');
      assert.equal(res.ok, false);

      const exitCode = await main([nonExistent, '--status']);
      assert.equal(exitCode, 1);
    });

    test('rejects directory that is not a Git repo', async () => {
      const emptyDir = createTempDir('empty-st-');
      const res = await inspectTargetInstallation({ targetDir: emptyDir });
      assert.equal(res.status, 'invalid-installation');
      assert.match(res.reasons[0], /not a Git repository/);
    });

    test('rejects subdirectory of a Git repo root', async () => {
      const repoDir = setupDisposableRepo();
      const subDir = path.join(repoDir, 'src');
      const res = await inspectTargetInstallation({ targetDir: subDir });
      assert.equal(res.status, 'invalid-installation');
      assert.match(res.reasons[0], /root of the SillyTavern Git repository/);
    });

    test('rejects Git repo missing SillyTavern structure', async () => {
      const repoDir = createTempDir('non-st-repo-');
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'other.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'Init'], { cwd: repoDir });

      const res = await inspectTargetInstallation({ targetDir: repoDir });
      assert.equal(res.status, 'invalid-installation');
      assert.match(res.reasons[0], /authentic SillyTavern/);
    });

    test('rejects symlink target file as invalid-installation', async () => {
      const repoDir = setupDisposableRepo();
      const targetPath = path.join(repoDir, 'src/endpoints/stable-diffusion.js');
      const realFile = path.join(repoDir, 'real.js');
      fs.writeFileSync(realFile, '// real\n');
      fs.unlinkSync(targetPath);
      fs.symlinkSync(realFile, targetPath);

      const res = await inspectTargetInstallation({ targetDir: repoDir });
      assert.equal(res.status, 'invalid-installation');
      assert.match(res.reasons[0], /symbolic link/);
    });

    test('rejects parent directory symlink as invalid-installation', async () => {
      const repoDir = createTempDir('parent-symlink-st-');
      execFileSync('git', ['init', '-q'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'package.json'), '{}');
      fs.writeFileSync(path.join(repoDir, 'server.js'), '');

      const realEndpoints = createTempDir('real-endpoints-');
      fs.writeFileSync(path.join(realEndpoints, 'stable-diffusion.js'), '');
      fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
      fs.symlinkSync(realEndpoints, path.join(repoDir, 'src/endpoints'));

      const res = await inspectTargetInstallation({ targetDir: repoDir });
      assert.equal(res.status, 'invalid-installation');
      assert.match(res.reasons[0], /parent directory contains a symbolic link/);
    });

    test('public CLI classifies ordinary temporary commit as unsupported-revision', async () => {
      const repoDir = setupDisposableRepo();
      const res = await inspectTargetInstallation({ targetDir: repoDir });
      assert.equal(res.status, 'unsupported-revision');
      assert.equal(res.isReleaseCommit, false);

      const checkRes = await checkInstallationPreflight({ targetDir: repoDir });
      assert.equal(checkRes.verdict, 'refused');
      assert.equal(checkRes.exitCode, 1);
      assert.match(checkRes.reason, /does not match certified release/);
    });

    test('reports unrelated local modifications without blocking inspection', async () => {
      const repoDir = setupDisposableRepo();
      fs.writeFileSync(path.join(repoDir, 'unrelated.txt'), 'untracked user file\n');
      fs.writeFileSync(path.join(repoDir, 'server.js'), '// user modified server\n');

      const res = await inspectTargetInstallation({ targetDir: repoDir });
      assert.equal(res.unrelatedChangesCount, 2);
    });

    test('handles path containing spaces cleanly', async () => {
      const spaceDir = createTempDir('path with spaces test-');
      const repoDir = setupDisposableRepo();
      const targetWithSpaces = path.join(spaceDir, 'SillyTavern Copy');
      fs.cpSync(repoDir, targetWithSpaces, { recursive: true });

      const res = await inspectTargetInstallation({ targetDir: targetWithSpaces });
      assert.equal(res.status, 'unsupported-revision');
      assert.equal(res.repoRoot, fs.realpathSync(targetWithSpaces));
    });

    test('strict read-only immutability verification for --status and --check', async () => {
      const repoDir = setupDisposableRepo('readonly-verify-');
      const targetFile = path.join(repoDir, 'src/endpoints/stable-diffusion.js');
      const indexFile = path.join(repoDir, '.git/index');

      // Add unrelated untracked and modified files
      fs.writeFileSync(path.join(repoDir, 'user-notes.txt'), 'notes\n');
      fs.writeFileSync(path.join(repoDir, 'server.js'), '// edited\n');

      // Capture before-snapshots
      const targetBeforeBuf = fs.readFileSync(targetFile);
      const targetBeforeSha = computeSha256(targetBeforeBuf);
      const targetBeforeMtime = fs.statSync(targetFile).mtimeMs;

      const indexBeforeBuf = fs.readFileSync(indexFile);
      const indexBeforeSha = computeSha256(indexBeforeBuf);
      const indexBeforeMtime = fs.statSync(indexFile).mtimeMs;

      const refsBeforeRes = runGit(repoDir, ['for-each-ref', '--format=%(refname)|%(objectname)']);
      const refsBeforeOut = refsBeforeRes.stdout;

      const headBeforeRes = runGit(repoDir, ['rev-parse', 'HEAD']);
      const headBeforeOut = headBeforeRes.stdout;

      const statusBeforeRes = runGit(repoDir, ['status', '--porcelain=v1']);
      const statusBeforeOut = statusBeforeRes.stdout;

      // Run status and check
      await inspectTargetInstallation({ targetDir: repoDir });
      await checkInstallationPreflight({ targetDir: repoDir });

      // Capture after-snapshots
      const targetAfterBuf = fs.readFileSync(targetFile);
      const targetAfterSha = computeSha256(targetAfterBuf);
      const targetAfterMtime = fs.statSync(targetFile).mtimeMs;

      const indexAfterBuf = fs.readFileSync(indexFile);
      const indexAfterSha = computeSha256(indexAfterBuf);
      const indexAfterMtime = fs.statSync(indexFile).mtimeMs;

      const refsAfterRes = runGit(repoDir, ['for-each-ref', '--format=%(refname)|%(objectname)']);
      const refsAfterOut = refsAfterRes.stdout;

      const headAfterRes = runGit(repoDir, ['rev-parse', 'HEAD']);
      const headAfterOut = headAfterRes.stdout;

      const statusAfterRes = runGit(repoDir, ['status', '--porcelain=v1']);
      const statusAfterOut = statusAfterRes.stdout;

      // Assert bit-for-bit identity
      assert.equal(targetAfterSha, targetBeforeSha, 'Target file SHA-256 must remain identical');
      assert.equal(targetAfterMtime, targetBeforeMtime, 'Target file mtime must remain unchanged');

      assert.equal(indexAfterSha, indexBeforeSha, '.git/index SHA-256 must remain identical');
      assert.equal(indexAfterMtime, indexBeforeMtime, '.git/index mtime must remain unchanged');

      assert.equal(refsAfterOut, refsBeforeOut, 'Git refs must remain identical');
      assert.equal(headAfterOut, headBeforeOut, 'HEAD commit must remain identical');

      assert.equal(statusAfterOut, statusBeforeOut, 'git status --porcelain must remain bit-for-bit identical');

      // Assert no Git lockfiles, temporary files, or installer metadata exist
      assert.equal(fs.existsSync(path.join(repoDir, '.git/index.lock')), false, 'No index.lock file must exist');
      assert.equal(fs.existsSync(path.join(repoDir, '.git/HEAD.lock')), false, 'No HEAD.lock file must exist');
      assert.equal(fs.existsSync(path.join(repoDir, '.ci-patch')), false, 'No .ci-patch metadata must exist');
      assert.equal(fs.existsSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js.bak')), false, 'No .bak backup file must exist');
    });

    test('CLI JSON output matches schema', async () => {
      const repoDir = setupDisposableRepo();
      let capturedOut = '';
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOut += msg + '\n';
      };

      try {
        const exitCode = await main([repoDir, '--status', '--json']);
        assert.equal(exitCode, 0);
        const parsed = JSON.parse(capturedOut);
        assert.equal(parsed.command, 'status');
        assert.equal(parsed.status, 'unsupported-revision');
        assert.equal(typeof parsed.isReleaseCommit, 'boolean');
        assert.equal(typeof parsed.unrelatedChangesCount, 'number');
        assert.equal(parsed.packageVerified, true);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('Tier 3: Authentic Pinned-Release Checkout Integration Tests', () => {
    const configuredTestRepo = process.env.SILLYTAVERN_TEST_REPO
      ? path.resolve(process.env.SILLYTAVERN_TEST_REPO)
      : null;
    let localCommitAvailable = false;
    let validatedRepoPath = null;

    if (configuredTestRepo) {
      try {
        if (fs.existsSync(configuredTestRepo) && fs.statSync(configuredTestRepo).isDirectory()) {
          const isWorktree = runGit(configuredTestRepo, ['rev-parse', '--is-inside-work-tree']);
          if (isWorktree.status === 0 && isWorktree.stdout.trim() === 'true') {
            const commitCheck = runGit(configuredTestRepo, ['rev-parse', '--verify', manifest.releaseCommit]);
            if (commitCheck.status === 0 && commitCheck.stdout.trim() === manifest.releaseCommit) {
              localCommitAvailable = true;
              validatedRepoPath = configuredTestRepo;
            }
          }
        }
      } catch {
        localCommitAvailable = false;
      }
    }

    if (!localCommitAvailable) {
      test('skipped: authentic pinned commit 06bde939f is not available locally', (t) => {
        t.skip(
          'SILLYTAVERN_TEST_REPO is not set or does not contain commit 06bde939f; skipping Tier 3 authentic integration'
        );
      });
    } else {
      test('verifies active user SillyTavern installation non-destructively as unsupported-revision', async () => {
        const res = await inspectTargetInstallation({ targetDir: validatedRepoPath });
        assert.equal(res.status, 'unsupported-revision');
        assert.equal(res.ok, true);
        assert.equal(res.isReleaseCommit, false);
      });

      test('validates authentic not-installed -> installed transition with unshifted Git index', async () => {
        const tempCloneDir = createTempDir('st-authentic-clone-');

        // Create independent clone of local SillyTavern (no worktree shared metadata)
        execFileSync('git', ['clone', '--no-hardlinks', '-q', validatedRepoPath, tempCloneDir]);
        execFileSync('git', ['checkout', '-q', manifest.releaseCommit], { cwd: tempCloneDir });

        const runtimePatchPath = path.resolve(
          REPO_ROOT,
          manifest.patches.runtime.relativePath
        );

        // Phase 1: Clean stock release -> not-installed & can-apply
        const statusRes1 = await inspectTargetInstallation({ targetDir: tempCloneDir });
        assert.equal(statusRes1.status, 'not-installed');
        assert.equal(statusRes1.targetFileState, 'original');
        assert.equal(statusRes1.isReleaseCommit, true);

        const checkRes1 = await checkInstallationPreflight({ targetDir: tempCloneDir });
        assert.equal(checkRes1.verdict, 'can-apply');
        assert.equal(checkRes1.exitCode, 0);
        assert.equal(checkRes1.canApply, true);
        assert.equal(checkRes1.alreadyApplied, false);
        assert.equal(checkRes1.dryRunPassed, true);

        // Phase 2: Apply runtime patch to working tree ONLY (no git add, index unshifted!)
        execFileSync('git', ['apply', runtimePatchPath], { cwd: tempCloneDir });

        // Phase 3: Inspect after patch application
        const statusRes2 = await inspectTargetInstallation({ targetDir: tempCloneDir });
        assert.equal(statusRes2.status, 'installed', 'Unstaged patch difference must be recognized as installed');
        assert.equal(statusRes2.targetFileState, 'installed');
        assert.equal(statusRes2.isReleaseCommit, true);
        assert.equal(statusRes2.indexBlobSha, manifest.patches.runtime.original.gitBlobSha, 'Index blob must remain unshifted');

        const checkRes2 = await checkInstallationPreflight({ targetDir: tempCloneDir });
        assert.equal(checkRes2.verdict, 'already-applied');
        assert.equal(checkRes2.exitCode, 3, 'Exit code for already-applied must be 3');
        assert.equal(checkRes2.canApply, false);
        assert.equal(checkRes2.alreadyApplied, true);

        // Phase 4: CLI main integration
        const cliStatusExit = await main([tempCloneDir, '--status']);
        assert.equal(cliStatusExit, 0);

        const cliCheckExit = await main([tempCloneDir, '--check']);
        assert.equal(cliCheckExit, 3);
      });
    }
  });
});

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
  resolveTargetDirectory,
  computeSha256,
} from '../src/patch-installer/inspect.js';
import {
  parseCliArgs,
  main,
  formatStatusOutput,
  formatCheckOutput,
  formatCheckReleaseOutput,
} from '../scripts/sillytavern-patch.mjs';
import {
  checkReleaseCompatibility,
  OFFICIAL_UPSTREAM_URL,
  OFFICIAL_UPSTREAM_BRANCH,
} from '../src/patch-installer/check-release.js';
import {
  runGit,
  runGitBinary,
  getGitObjectBytes,
  testPatchApplicability,
} from '../src/patch-installer/git-ops.js';
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

function createApplicableMockTargetContent() {
  const lines = [];
  lines.push("import fs from 'node:fs';");
  lines.push("import path from 'node:path';");
  lines.push("");
  lines.push("import express from 'express';");
  lines.push("import fetch from 'node-fetch';");

  while (lines.length < 1435) {
    lines.push('// pad');
  }

  lines.push("        if (!request.body) {");
  lines.push("            return response.sendStatus(400);");
  lines.push("        }");
  lines.push("");
  lines.push("        console.debug('NanoGPT request:', request.body);");
  lines.push("");
  lines.push("        const result = await fetch('https://nano-gpt.com/api/generate-image', {");
  lines.push("            method: 'POST',");
  lines.push("            body: JSON.stringify(request.body),");

  while (lines.length < 1467) {
    lines.push('// pad2');
  }

  lines.push("    }");
  lines.push("});");
  lines.push("");
  lines.push("const bfl = express.Router();");
  lines.push("");
  lines.push("bfl.post('/generate', async (request, response) => {");

  return lines.join('\n') + '\n';
}

function setupDisposableRepo(dirName = 'st-fixture-') {
  const repoDir = createTempDir(dirName);
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  // Create minimal SillyTavern layout
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// server\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), '// original\n');

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: repoDir });

  return repoDir;
}

function setupMockUpstreamReleaseRepo({
  prefix = 'mock-upstream-',
  targetContent = createApplicableMockTargetContent(),
  commitMessage = 'Release commit',
} = {}) {
  const repoDir = createTempDir(prefix);
  execFileSync('git', ['init', '-b', 'release', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Upstream Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'upstream@example.com'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// mock upstream server\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), targetContent);

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', commitMessage], { cwd: repoDir });

  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
  return { repoDir, headSha };
}

describe('SillyTavern patch installer preflight & manager (D01-SP-1)', async () => {
  const manifestRes = await verifyPatchManifest(PRODUCTION_MANIFEST_PATH);
  assert.equal(manifestRes.ok, true, 'Bundled manifest must pass verification');
  const manifest = manifestRes.manifest;

  // -------------------------------------------------------------------------
  // Tier 1: Pure state-machine classification (classifyTargetState)
  // -------------------------------------------------------------------------
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
      obs.worktreeSha256 = manifest.patches.runtime.expected.sha256;
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

  // -------------------------------------------------------------------------
  // Tier 2: CLI argument parsing & Target Discovery
  // -------------------------------------------------------------------------
  describe('Tier 2: CLI argument parsing & Target Discovery (parseCliArgs & resolveTargetDirectory)', () => {
    test('defaults to status command and parses positional target directory', () => {
      const res = parseCliArgs(['/path/to/SillyTavern']);
      assert.equal(res.command, 'status');
      assert.equal(res.explicitTarget, '/path/to/SillyTavern');
      assert.equal(res.targetDir, '/path/to/SillyTavern');
      assert.equal(res.json, false);
      assert.equal(res.error, null);
    });

    test('accepts explicit status, check, and check-release subcommands', () => {
      const res1 = parseCliArgs(['status', '--target', '/path/to/st']);
      assert.equal(res1.command, 'status');
      assert.equal(res1.explicitTarget, '/path/to/st');

      const res2 = parseCliArgs(['check', '/path/to/st']);
      assert.equal(res2.command, 'check');
      assert.equal(res2.explicitTarget, '/path/to/st');

      const res3 = parseCliArgs(['check-release']);
      assert.equal(res3.command, 'check-release');
      assert.equal(res3.explicitTarget, null);
    });

    test('preserves backward compatibility with --status, --check, --check-release flags', () => {
      const res1 = parseCliArgs(['--status', '--target', '/path/to/st']);
      assert.equal(res1.command, 'status');

      const res2 = parseCliArgs(['--check', '/path/to/st']);
      assert.equal(res2.command, 'check');

      const res3 = parseCliArgs(['--check-release']);
      assert.equal(res3.command, 'check-release');
    });

    test('parses --json flag', () => {
      const res = parseCliArgs(['check', '--json', '/path/to/st']);
      assert.equal(res.json, true);
      assert.equal(res.command, 'check');
    });

    test('parses active apply and remove subcommands and aliases', () => {
      const resApply = parseCliArgs(['apply', '/path/to/st']);
      assert.equal(resApply.command, 'apply');
      assert.equal(resApply.explicitTarget, '/path/to/st');
      assert.equal(resApply.error, null);

      const resRemove = parseCliArgs(['remove', '/path/to/st']);
      assert.equal(resRemove.command, 'remove');
      assert.equal(resRemove.explicitTarget, '/path/to/st');
      assert.equal(resRemove.error, null);

      const resApplyFlag = parseCliArgs(['--apply', '/path/to/st']);
      assert.equal(resApplyFlag.command, 'apply');
      assert.equal(resApplyFlag.explicitTarget, '/path/to/st');
      assert.equal(resApplyFlag.error, null);

      const resRemoveFlag = parseCliArgs(['--remove', '/path/to/st']);
      assert.equal(resRemoveFlag.command, 'remove');
      assert.equal(resRemoveFlag.explicitTarget, '/path/to/st');
      assert.equal(resRemoveFlag.error, null);
    });

    test('rejects conflicting commands', () => {
      const res1 = parseCliArgs(['status', 'check', '/path/to/st']);
      assert.match(res1.error, /Conflicting commands/);

      const res2 = parseCliArgs(['--status', '--check', '/path/to/st']);
      assert.match(res2.error, /Conflicting commands/);
    });

    test('rejects unknown options', () => {
      const res = parseCliArgs(['--unknown-flag', '/path/to/st']);
      assert.match(res.error, /Unknown option: --unknown-flag/);
    });

    test('strict precedence: explicit target failure never falls back to SILLYTAVERN_DIR or sibling', () => {
      const nonExistent = path.join(os.tmpdir(), 'definitely-nonexistent-dir-' + Date.now());
      const oldEnv = process.env.SILLYTAVERN_DIR;
      process.env.SILLYTAVERN_DIR = '/tmp'; // even if valid dir
      try {
        const res = resolveTargetDirectory({ explicitTarget: nonExistent });
        assert.equal(res.ok, false);
        assert.equal(res.targetDir, null);
        assert.equal(res.source, 'explicit');
        assert.match(res.error, /Explicitly specified target directory does not exist/);
      } finally {
        if (oldEnv === undefined) delete process.env.SILLYTAVERN_DIR;
        else process.env.SILLYTAVERN_DIR = oldEnv;
      }
    });

    test('CLI main() rejects invalid explicit target with exit code 2 and resolution error', async () => {
      const nonExistent = path.join(os.tmpdir(), 'non-existent-st-dir-' + Date.now());
      assert.equal(await main(['status', nonExistent]), 2);
      assert.equal(await main(['check', '--target', nonExistent]), 2);
      assert.equal(await main([nonExistent]), 2);
    });

    test('explicit target validation: rejects empty or whitespace-only target without fallback to sibling or env', () => {
      const parentDir = createTempDir('empty-target-sibling-test-');
      const mockPkgRoot = path.join(parentDir, 'ChromaticImages-Patch');
      const mockSiblingSt = path.join(parentDir, 'SillyTavern');
      fs.mkdirSync(mockPkgRoot);
      fs.mkdirSync(mockSiblingSt);

      const oldEnv = process.env.SILLYTAVERN_DIR;
      process.env.SILLYTAVERN_DIR = mockSiblingSt; // Even with valid env and sibling present
      try {
        const resEmpty = resolveTargetDirectory({ explicitTarget: '', packageRoot: mockPkgRoot });
        assert.equal(resEmpty.ok, false);
        assert.equal(resEmpty.targetDir, null);
        assert.equal(resEmpty.source, 'explicit');
        assert.match(resEmpty.error, /Target directory cannot be empty or whitespace-only/);

        const resSpaces = resolveTargetDirectory({ explicitTarget: '   ', packageRoot: mockPkgRoot });
        assert.equal(resSpaces.ok, false);
        assert.equal(resSpaces.targetDir, null);
        assert.equal(resSpaces.source, 'explicit');
        assert.match(resSpaces.error, /Target directory cannot be empty or whitespace-only/);
      } finally {
        if (oldEnv === undefined) delete process.env.SILLYTAVERN_DIR;
        else process.env.SILLYTAVERN_DIR = oldEnv;
      }
    });

    test('CLI main() rejects empty or whitespace-only explicit target with exit code 2 even if valid sibling exists', async () => {
      const parentDir = createTempDir('cli-sibling-empty-target-test-');
      const mockPkgRoot = path.join(parentDir, 'ChromaticImages-Patch');
      const mockSiblingSt = path.join(parentDir, 'SillyTavern');
      fs.mkdirSync(mockPkgRoot);
      fs.mkdirSync(mockSiblingSt);

      // Verify --target "" and positional ""
      assert.equal(await main(['status', '--target', '']), 2);
      assert.equal(await main(['status', '--target', '   ']), 2);
      assert.equal(await main(['status', '']), 2);
      assert.equal(await main(['status', '   ']), 2);
      assert.equal(await main(['check', '--target', '']), 2);
      assert.equal(await main(['check', '']), 2);
    });

    test('target discovery: invalid SILLYTAVERN_DIR fails without fallback to sibling', () => {
      const nonExistent = path.join(os.tmpdir(), 'nonexistent-env-dir-' + Date.now());
      const parentDir = createTempDir('parent-sibling-test2-');
      const mockPkgRoot = path.join(parentDir, 'ChromaticImages-Patch');
      const mockSiblingSt = path.join(parentDir, 'SillyTavern');
      fs.mkdirSync(mockPkgRoot);
      fs.mkdirSync(mockSiblingSt);

      const oldEnv = process.env.SILLYTAVERN_DIR;
      process.env.SILLYTAVERN_DIR = nonExistent;
      try {
        const res = resolveTargetDirectory({ explicitTarget: null, packageRoot: mockPkgRoot });
        assert.equal(res.ok, false);
        assert.equal(res.targetDir, null);
        assert.match(res.error, /SILLYTAVERN_DIR points to non-existent or invalid directory/);
      } finally {
        if (oldEnv === undefined) delete process.env.SILLYTAVERN_DIR;
        else process.env.SILLYTAVERN_DIR = oldEnv;
      }
    });

    test('target discovery: falls back to valid SILLYTAVERN_DIR if explicit target omitted', () => {
      const testDir = createTempDir('env-st-target-');
      const oldEnv = process.env.SILLYTAVERN_DIR;
      process.env.SILLYTAVERN_DIR = testDir;
      try {
        const res = resolveTargetDirectory({ explicitTarget: null });
        assert.equal(res.ok, true);
        assert.equal(res.targetDir, fs.realpathSync(testDir));
        assert.equal(res.source, 'env');
      } finally {
        if (oldEnv === undefined) delete process.env.SILLYTAVERN_DIR;
        else process.env.SILLYTAVERN_DIR = oldEnv;
      }
    });

    test('target discovery: auto-discovers sibling SillyTavern directory when target and env omitted', () => {
      const parentDir = createTempDir('parent-sibling-test-');
      const mockPkgRoot = path.join(parentDir, 'ChromaticImages-Patch');
      const mockSiblingSt = path.join(parentDir, 'SillyTavern');
      fs.mkdirSync(mockPkgRoot);
      fs.mkdirSync(mockSiblingSt);

      const oldEnv = process.env.SILLYTAVERN_DIR;
      delete process.env.SILLYTAVERN_DIR;
      try {
        const res = resolveTargetDirectory({ explicitTarget: null, packageRoot: mockPkgRoot });
        assert.equal(res.ok, true);
        assert.equal(res.targetDir, fs.realpathSync(mockSiblingSt));
        assert.equal(res.source, 'sibling');
      } finally {
        if (oldEnv !== undefined) process.env.SILLYTAVERN_DIR = oldEnv;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tier 3: Real Git-command testing (Disposable Repositories)
  // -------------------------------------------------------------------------
  describe('Tier 3: Real Git-command testing (Disposable Repositories)', () => {
    test('inspectTargetInstallation rejects non-existent directory with invalid-installation', async () => {
      const nonExistent = path.join(os.tmpdir(), 'non-existent-st-dir-' + Date.now());
      const res = await inspectTargetInstallation({ targetDir: nonExistent });
      assert.equal(res.status, 'invalid-installation');
      assert.equal(res.ok, false);
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

    test('detects legacy .ci-patch transaction artifacts and surfaces blocking status without collapsing', async () => {
      const repoDir = setupDisposableRepo('legacy-ci-patch-');
      const ciPatchDir = path.join(repoDir, '.ci-patch');
      fs.mkdirSync(ciPatchDir, { recursive: true });
      // Create orphaned foreign artifact inside .ci-patch
      fs.writeFileSync(path.join(ciPatchDir, 'orphan.txt'), 'legacy artifact data');

      const inspection = await inspectTargetInstallation({ targetDir: repoDir });
      assert.equal(inspection.transaction.state, 'foreign-content');
      assert.equal(inspection.transaction.isPending, true);
      assert.equal(inspection.transactionBlocking, true);

      // Preflight check must refuse immediately
      const preflight = await checkInstallationPreflight({ targetDir: repoDir });
      assert.equal(preflight.verdict, 'refused');
      assert.equal(preflight.exitCode, 1);
      assert.equal(preflight.canApply, false);
      assert.match(preflight.reason, /installer transaction is pending or ambiguous/);
    });

    test('strict read-only immutability verification for status and check', async () => {
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

    test('CLI JSON output matches schema for status and check', async () => {
      const repoDir = setupDisposableRepo();
      let capturedOut = '';
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOut += msg + '\n';
      };

      try {
        const exitCode = await main(['status', repoDir, '--json']);
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

    test('apply and remove commands reject invalid explicit targets with exit code 2 via CLI main()', async () => {
      const nonExistent = path.join(os.tmpdir(), `nonexistent-st-explicit-${Date.now()}`);
      const exitApply = await main(['apply', '--target', nonExistent]);
      assert.equal(exitApply, 2);

      const exitRemove = await main(['remove', '--target', nonExistent]);
      assert.equal(exitRemove, 2);

      const exitApplyEmpty = await main(['apply', '--target', '']);
      assert.equal(exitApplyEmpty, 2);

      const exitRemoveEmpty = await main(['remove', '--target', '']);
      assert.equal(exitRemoveEmpty, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Tier 4: Isolated Release Compatibility Checks (check-release)
  // -------------------------------------------------------------------------
  describe('Tier 4: Isolated Release Compatibility Checks (check-release)', () => {
    test('check-release with clean applicability on uncertified fixture returns applies-unverified (exit 3)', async () => {
      const { repoDir, headSha } = setupMockUpstreamReleaseRepo({
        prefix: 'mock-upstream-clean-',
        commitMessage: 'Uncertified upstream commit with matching hunks',
      });

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
      });

      assert.equal(res.ok, true);
      assert.equal(res.classification, 'applies-unverified');
      assert.equal(res.exitCode, 3);
      assert.equal(res.isCertified, false);
      assert.equal(res.isTestOverride, true);
      assert.equal(res.dryRunPassed, true);
      assert.equal(res.fetchedCommit, headSha.toLowerCase());
      assert.match(res.reason, /Patch applies cleanly to upstream release/);
    });

    test('check-release with conflicting patch returns incompatible (exit 1)', async () => {
      const conflictingContent = '// Totally incompatible file that does not match patch context\n';
      const { repoDir, headSha } = setupMockUpstreamReleaseRepo({
        prefix: 'mock-upstream-conflict-',
        targetContent: conflictingContent,
        commitMessage: 'Incompatible release commit',
      });

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'incompatible');
      assert.equal(res.exitCode, 1);
      assert.equal(res.isCertified, false);
      assert.equal(res.dryRunPassed, false);
      assert.equal(res.fetchedCommit, headSha.toLowerCase());
      assert.match(res.reason, /Patch application rejected/);
    });

    test('check-release with network / Git failure returns unknown (exit 4, not incompatible)', async () => {
      const nonExistentUrl = 'file://' + path.join(os.tmpdir(), 'non-existent-remote-repo-' + Date.now());

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: nonExistentUrl, branch: 'release' },
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 4);
      assert.equal(res.isCertified, false);
      assert.match(res.reason, /Network or Git error fetching upstream release/);
    });

    test('check-release with tampered manifest returns unknown (exit 2)', async () => {
      const tamperedDir = createTempDir('tampered-manifest-');
      const tamperedManifest = path.join(tamperedDir, 'manifest.json');
      // Tampered JSON missing required fields
      fs.writeFileSync(tamperedManifest, JSON.stringify({ schemaVersion: '0.0.1' }));

      const res = await checkReleaseCompatibility({
        manifestPath: tamperedManifest,
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 2);
      assert.equal(res.isCertified, false);
      assert.match(res.reason, /Package verification failed/);
    });

    test('test-injected upstream never produces official certified verdict even if commit and content match', async () => {
      // Create fixture repository with manifest release commit
      const { repoDir } = setupMockUpstreamReleaseRepo({
        prefix: 'mock-upstream-match-',
        commitMessage: 'Mock matching commit',
      });

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
      });

      // Even if content or commit matched, isCertified MUST be false because it is a test injection
      assert.equal(res.isCertified, false, 'Test-injected upstream must never produce official isCertified=true');
      assert.notEqual(res.classification, 'certified', 'Test-injected upstream must never produce official classification=certified');
      assert.equal(res.isTestOverride, true);
    });

    test('check-release CLI main() produces structured output and exits with stable code', async () => {
      const { repoDir } = setupMockUpstreamReleaseRepo({
        prefix: 'mock-cli-check-release-',
      });

      let capturedOut = '';
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOut += msg + '\n';
      };

      try {
        const exitCode = await main([
          'check-release',
          '--json',
          '--test-upstream-url',
          repoDir,
          '--test-upstream-branch',
          'release',
        ]);

        assert.equal(exitCode, 3, 'applies-unverified must exit 3');
        const parsed = JSON.parse(capturedOut);
        assert.equal(parsed.command, 'check-release');
        assert.equal(parsed.classification, 'applies-unverified');
        assert.equal(parsed.isCertified, false);
        assert.equal(parsed.isTestOverride, true);
      } finally {
        console.log = originalLog;
      }
    });

    test('check-release read-only immutability: target repos and fixtures are not mutated', async () => {
      const { repoDir, headSha } = setupMockUpstreamReleaseRepo({
        prefix: 'immutability-check-release-',
      });

      const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
      const statusBefore = execFileSync('git', ['status', '--porcelain=v1'], { cwd: repoDir, encoding: 'utf-8' }).trim();

      await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
      });

      const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
      const statusAfter = execFileSync('git', ['status', '--porcelain=v1'], { cwd: repoDir, encoding: 'utf-8' }).trim();

      assert.equal(headAfter, headBefore, 'Upstream repo HEAD must remain unchanged');
      assert.equal(statusAfter, statusBefore, 'Upstream repo working tree must remain unchanged');
      assert.equal(headAfter, headSha);
    });

    test('check-release with absent target file in upstream commit returns incompatible (exit 1)', async () => {
      const repoDir = createTempDir('mock-upstream-missing-file-');
      execFileSync('git', ['init', '-b', 'release', '-q'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Upstream Test'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'upstream@example.com'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-q', '-m', 'Commit without target file'], { cwd: repoDir });

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'incompatible');
      assert.equal(res.exitCode, 1);
      assert.equal(res.isCertified, false);
      assert.equal(res.dryRunPassed, null);
      assert.match(res.reason, /does not exist in upstream release/);
    });

    test('getGitObjectBytes distinguishes authoritative absence from execution/environmental failure', () => {
      const repoDir = setupDisposableRepo('blob-test-');

      // Authoritative absence (path does not exist in HEAD)
      const missingRes = getGitObjectBytes(repoDir, 'HEAD:non-existent-file.js');
      assert.equal(missingRes.ok, false);
      assert.equal(missingRes.notFound, true);
      assert.equal(missingRes.isEnvError, false);

      // Environmental error (directory is not a git repo or invalid git invocation)
      const nonRepoDir = createTempDir('non-repo-blob-');
      const envRes = getGitObjectBytes(nonRepoDir, 'HEAD:server.js');
      assert.equal(envRes.ok, false);
      assert.equal(envRes.notFound, false);
      assert.equal(envRes.isEnvError, true);
    });

    test('testPatchApplicability distinguishes established conflict from environmental error', () => {
      const repoDir = setupDisposableRepo('apply-test-');
      const runtimePatchPath = path.resolve(REPO_ROOT, manifest.patches.runtime.relativePath);

      // Case 1: Conflict on incompatible target content
      fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), '// conflict incompatible content\n');
      const conflictRes = testPatchApplicability(repoDir, runtimePatchPath);
      assert.equal(conflictRes.ok, false);
      assert.equal(conflictRes.isConflict, true);
      assert.equal(conflictRes.isEnvError, false);
      assert.equal(conflictRes.exitCode, 1);

      // Case 2: Environmental error (non-existent patch file)
      const nonExistentPatch = path.join(os.tmpdir(), 'non-existent-patch-' + Date.now());
      const envRes = testPatchApplicability(repoDir, nonExistentPatch);
      assert.equal(envRes.ok, false);
      assert.equal(envRes.isConflict, false);
      assert.equal(envRes.isEnvError, true);
    });

    test('check-release returns unknown (exit 4) on filesystem error creating disposable directory', async () => {
      const invalidBase = path.join('/dev/null', 'cannot-create-dir');
      const res = await checkReleaseCompatibility({
        disposableBaseDir: invalidBase,
      });
      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 4);
      assert.match(res.reason, /Failed to create disposable temporary directory/);
    });

    test('checkReleaseCompatibility cleans up disposable temporary directory upon completion', async () => {
      const baseDir = createTempDir('cleanup-base-');
      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'upstream-cleanup-' });

      const entriesBefore = fs.readdirSync(baseDir);
      assert.equal(entriesBefore.length, 0);

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
        disposableBaseDir: baseDir,
      });

      assert.equal(res.ok, true);
      assert.equal(res.classification, 'applies-unverified');
      assert.equal(res.exitCode, 3);

      const entriesAfter = fs.readdirSync(baseDir);
      assert.equal(entriesAfter.length, 0, 'Disposable temporary directory must be cleaned up on completion');
    });

    test('cleanup safeguard: temporary-directory identity mismatch aborts cleanup, preserves artifact, and fails closed with unknown (exit 4)', async () => {
      const baseDir = createTempDir('identity-mismatch-base-');
      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'identity-mismatch-upstream-' });
      let preservedDir = null;

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
        disposableBaseDir: baseDir,
        _onBeforeCleanup: (tmpDir) => {
          preservedDir = tmpDir;
          // Recreate tmpDir with a new inode
          fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.mkdirSync(tmpDir);
          fs.writeFileSync(path.join(tmpDir, 'preserved-evidence.txt'), 'inode changed');
        },
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 4);
      assert.equal(res.isCertified, false);
      assert.match(res.reason, /Cleanup safeguard failure: .*identity mismatch/i);
      assert.equal(fs.existsSync(preservedDir), true, 'Artifact must be preserved when identity changes');
      assert.equal(fs.existsSync(path.join(preservedDir, 'preserved-evidence.txt')), true);
    });

    test('cleanup safeguard: symlink substitution before cleanup aborts removal, preserves symlink, and fails closed with unknown (exit 4)', async () => {
      const baseDir = createTempDir('symlink-sub-base-');
      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'symlink-sub-upstream-' });
      let preservedDir = null;

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
        disposableBaseDir: baseDir,
        _onBeforeCleanup: (tmpDir) => {
          preservedDir = tmpDir;
          fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.symlinkSync(os.tmpdir(), tmpDir);
        },
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 4);
      assert.equal(res.isCertified, false);
      assert.match(res.reason, /Cleanup safeguard failure: .*symbolic link/i);
      assert.equal(fs.lstatSync(preservedDir).isSymbolicLink(), true, 'Symlink must be preserved without deletion');
    });

    test('cleanup safeguard: ownership mismatch via dependency injection aborts removal, preserves artifact, and fails closed with unknown (exit 4)', async () => {
      const baseDir = createTempDir('owner-mismatch-base-');
      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'owner-mismatch-upstream-' });

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
        disposableBaseDir: baseDir,
        _getuid: () => 99999, // Injected mismatched process UID
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 4);
      assert.equal(res.isCertified, false);
      assert.match(res.reason, /Cleanup safeguard failure: .*ownership mismatch/i);

      // Verify that the disposable directory was preserved
      const entriesAfter = fs.readdirSync(baseDir);
      assert.equal(entriesAfter.length, 1, 'Temporary directory must be preserved on ownership mismatch');
    });

    test('cleanup safeguard: cleanup deletion failure preserves artifact and fails closed with unknown (exit 4)', async () => {
      const baseDir = createTempDir('deletion-fail-base-');
      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'deletion-fail-upstream-' });

      const res = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
        disposableBaseDir: baseDir,
        _rmSync: () => {
          throw new Error('EACCES: permission denied, unlink');
        },
      });

      assert.equal(res.ok, false);
      assert.equal(res.classification, 'unknown');
      assert.equal(res.exitCode, 4);
      assert.equal(res.isCertified, false);
      assert.match(res.reason, /Cleanup safeguard failure: .*EACCES/i);

      const entriesAfter = fs.readdirSync(baseDir);
      assert.equal(entriesAfter.length, 1, 'Temporary directory must remain preserved on deletion failure');
    });

    test('structured result schema: every execution path returns complete structured result with documented exit code', async () => {
      function assertStructuredSchema(result, expectedCode, expectedClassification) {
        assert.notEqual(result, undefined, 'Result must not be undefined (no bare return in finally)');
        assert.notEqual(result, null, 'Result must not be null');
        assert.equal(typeof result.ok, 'boolean');
        assert.equal(typeof result.classification, 'string');
        assert.equal(typeof result.exitCode, 'number');
        assert.equal(typeof result.isCertified, 'boolean');
        assert.equal(typeof result.isTestOverride, 'boolean');
        assert.equal(typeof result.upstreamSource, 'string');
        assert.equal(typeof result.upstreamUrl, 'string');
        assert.equal(typeof result.upstreamBranch, 'string');
        assert.equal(typeof result.targetFile, 'string');
        assert.equal(typeof result.reason, 'string');
        assert.equal(Array.isArray(result.errors), true);

        assert.equal(result.exitCode, expectedCode);
        assert.equal(result.classification, expectedClassification);
        assert.equal([0, 1, 2, 3, 4].includes(result.exitCode), true);
        assert.equal(['certified', 'applies-unverified', 'incompatible', 'unknown'].includes(result.classification), true);
      }

      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'schema-test-upstream-' });

      // Path 1: clean applicability (applies-unverified, exit 3)
      const resClean = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
      });
      assertStructuredSchema(resClean, 3, 'applies-unverified');

      // Path 2: invalid manifest path (unknown, exit 2)
      const resBadManifest = await checkReleaseCompatibility({
        manifestPath: '/nonexistent-manifest.json',
      });
      assertStructuredSchema(resBadManifest, 2, 'unknown');

      // Path 3: network / Git fetch failure (unknown, exit 4)
      const resBadFetch = await checkReleaseCompatibility({
        _testUpstream: { url: 'file:///nonexistent-remote-repo-' + Date.now(), branch: 'release' },
      });
      assertStructuredSchema(resBadFetch, 4, 'unknown');

      // Path 4: cleanup failure (unknown, exit 4)
      const resCleanupErr = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: 'release' },
        _rmSync: () => {
          throw new Error('Injected cleanup fault');
        },
      });
      assertStructuredSchema(resCleanupErr, 4, 'unknown');

      // Path 5: invalid test upstream configuration (unknown, exit 2)
      const resBadTestUpstream = await checkReleaseCompatibility({
        _testUpstream: { url: '-v' },
      });
      assertStructuredSchema(resBadTestUpstream, 2, 'unknown');
    });

    test('upstream argument validation: rejects standalone --test-upstream-branch without --test-upstream-url', async () => {
      const parsed = parseCliArgs(['check-release', '--test-upstream-branch', 'feature']);
      assert.match(parsed.error, /Option --test-upstream-branch cannot be used without --test-upstream-url/i);

      const exitCode = await main(['check-release', '--test-upstream-branch', 'feature']);
      assert.equal(exitCode, 2);
    });

    test('upstream argument validation: rejects option-like or malformed values for test upstream URL and branch', async () => {
      // Option-like URL
      const resUrlOpt = parseCliArgs(['check-release', '--test-upstream-url', '-v']);
      assert.match(resUrlOpt.error, /Invalid option-like or malformed value for --test-upstream-url/i);
      assert.equal(await main(['check-release', '--test-upstream-url', '--upload-pack=evil']), 2);

      // Option-like branch
      const resBranchOpt = parseCliArgs(['check-release', '--test-upstream-url', '/path/to/repo', '--test-upstream-branch', '-b']);
      assert.match(resBranchOpt.error, /Invalid option-like or malformed value for --test-upstream-branch/i);
      assert.equal(await main(['check-release', '--test-upstream-url', '/path/to/repo', '--test-upstream-branch', '--foo']), 2);

      // Malformed branch (spaces, traversal, invalid ref characters)
      const resBranchBad = parseCliArgs(['check-release', '--test-upstream-url', '/path/to/repo', '--test-upstream-branch', 'bad..branch']);
      assert.match(resBranchBad.error, /Invalid option-like or malformed value for --test-upstream-branch/i);

      // Programmatic validation in checkReleaseCompatibility
      const progRes1 = await checkReleaseCompatibility({
        _testUpstream: { url: '-v' },
      });
      assert.equal(progRes1.ok, false);
      assert.equal(progRes1.exitCode, 2);
      assert.match(progRes1.reason, /Invalid test-upstream URL/i);

      const progRes2 = await checkReleaseCompatibility({
        _testUpstream: { url: '/path/to/repo', branch: 'bad branch with spaces' },
      });
      assert.equal(progRes2.ok, false);
      assert.equal(progRes2.exitCode, 2);
      assert.match(progRes2.reason, /Invalid test-upstream branch/i);

      const progRes3 = await checkReleaseCompatibility({
        _testUpstream: { branch: 'release' }, // Missing URL
      });
      assert.equal(progRes3.ok, false);
      assert.equal(progRes3.exitCode, 2);
      assert.match(progRes3.reason, /cannot be empty or whitespace-only/i);
    });

    test('test-upstream validation: rejects empty or whitespace-only URL and branch without falling back to defaults', async () => {
      const { repoDir } = setupMockUpstreamReleaseRepo({ prefix: 'empty-test-upstream-' });

      // Empty URL in CLI
      const resEmptyUrl = parseCliArgs(['check-release', '--test-upstream-url', '']);
      assert.match(resEmptyUrl.error, /cannot be empty or whitespace-only/i);
      assert.equal(await main(['check-release', '--test-upstream-url', '']), 2);

      const resSpacesUrl = parseCliArgs(['check-release', '--test-upstream-url', '   ']);
      assert.match(resSpacesUrl.error, /cannot be empty or whitespace-only/i);
      assert.equal(await main(['check-release', '--test-upstream-url', '   ']), 2);

      // Empty branch in CLI
      const resEmptyBranch = parseCliArgs(['check-release', '--test-upstream-url', repoDir, '--test-upstream-branch', '']);
      assert.match(resEmptyBranch.error, /cannot be empty or whitespace-only/i);
      assert.equal(await main(['check-release', '--test-upstream-url', repoDir, '--test-upstream-branch', '']), 2);

      const resSpacesBranch = parseCliArgs(['check-release', '--test-upstream-url', repoDir, '--test-upstream-branch', '   ']);
      assert.match(resSpacesBranch.error, /cannot be empty or whitespace-only/i);
      assert.equal(await main(['check-release', '--test-upstream-url', repoDir, '--test-upstream-branch', '   ']), 2);

      // Programmatic checkReleaseCompatibility validation
      const progEmptyUrl = await checkReleaseCompatibility({
        _testUpstream: { url: '' },
      });
      assert.equal(progEmptyUrl.ok, false);
      assert.equal(progEmptyUrl.exitCode, 2);
      assert.match(progEmptyUrl.reason, /cannot be empty or whitespace-only/i);

      const progSpacesUrl = await checkReleaseCompatibility({
        _testUpstream: { url: '   ' },
      });
      assert.equal(progSpacesUrl.ok, false);
      assert.equal(progSpacesUrl.exitCode, 2);
      assert.match(progSpacesUrl.reason, /cannot be empty or whitespace-only/i);

      const progEmptyBranch = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: '' },
      });
      assert.equal(progEmptyBranch.ok, false);
      assert.equal(progEmptyBranch.exitCode, 2);
      assert.match(progEmptyBranch.reason, /cannot be empty or whitespace-only/i);

      const progSpacesBranch = await checkReleaseCompatibility({
        _testUpstream: { url: repoDir, branch: '   ' },
      });
      assert.equal(progSpacesBranch.ok, false);
      assert.equal(progSpacesBranch.exitCode, 2);
      assert.match(progSpacesBranch.reason, /cannot be empty or whitespace-only/i);
    });
  });

  // -------------------------------------------------------------------------
  // Tier 5: Authentic Pinned-Release Checkout Integration Tests
  // -------------------------------------------------------------------------
  describe('Tier 5: Authentic Pinned-Release Checkout Integration Tests', () => {
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
          'SILLYTAVERN_TEST_REPO is not set or does not contain commit 06bde939f; skipping Tier 5 authentic integration'
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
        const cliStatusExit = await main(['status', tempCloneDir]);
        assert.equal(cliStatusExit, 0);

        const cliCheckExit = await main(['check', tempCloneDir]);
        assert.equal(cliCheckExit, 3);
      });
    }
  });
});

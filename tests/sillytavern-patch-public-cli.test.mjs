import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseCliArgs,
  formatApplyOutput,
  formatRemoveOutput,
  main,
} from '../scripts/sillytavern-patch.mjs';
import { resolveTargetDirectory } from '../src/patch-installer/inspect.js';
import { computeSha256 } from '../src/patch-installer/simple-backup.js';
import { applyPatchToInstallation } from '../src/patch-installer/apply-remove.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/sillytavern-patch.mjs');
const BASH_WRAPPER_PATH = path.join(REPO_ROOT, 'ci-patch.sh');

const CERTIFIED_RELEASE_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const CERTIFIED_STOCK_SHA256 = '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43';
const CERTIFIED_PATCHED_SHA256 = '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6';
const CERTIFIED_STOCK_BLOB = '077c2f961b528afa10376a7cc20a62132cf9fcd8';

const trackedFixtures = new Map();

function createTempDir(prefix = 'ci-pubcli-test-', testLabel = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedFixtures.set(dir, { verified: false, testLabel, reportedPreservation: false });
  return dir;
}

function markFixtureVerified(dir) {
  const entry = trackedFixtures.get(dir);
  if (entry) {
    entry.verified = true;
  }
}

function cleanupVerifiedFixtures() {
  for (const [dir, meta] of trackedFixtures.entries()) {
    if (meta.verified) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        trackedFixtures.delete(dir);
      } catch {
        // ignore
      }
    } else if (!meta.reportedPreservation) {
      console.error(`[PRESERVED FAILURE EVIDENCE] Unverified or ambiguous fixture preserved for inspection: ${dir} (${meta.testLabel || 'unlabeled'})`);
      meta.reportedPreservation = true;
    }
  }
}

const savedEnv = {
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  CI_LOCK_DIR: process.env.CI_LOCK_DIR,
  CI_BACKUP_DIR: process.env.CI_BACKUP_DIR,
  SILLYTAVERN_DIR: process.env.SILLYTAVERN_DIR,
};

let suiteIsolatedXdg;

before(() => {
  // Separate suiteIsolatedXdg from tracked per-test fixtures to avoid premature cleanup in afterEach()
  suiteIsolatedXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pubcli-suite-xdg-'));
});

beforeEach(() => {
  delete process.env.CI_LOCK_DIR;
  delete process.env.CI_BACKUP_DIR;
  delete process.env.SILLYTAVERN_DIR;
  process.env.XDG_DATA_HOME = suiteIsolatedXdg;
});

afterEach(() => {
  cleanupVerifiedFixtures();
});

after(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  cleanupVerifiedFixtures();

  // If unverified or ambiguous fixtures were preserved during the suite run, also preserve suiteIsolatedXdg
  const hasPreservedEvidence = Array.from(trackedFixtures.values()).some((m) => !m.verified);
  if (hasPreservedEvidence) {
    console.error(`[PRESERVED FAILURE EVIDENCE] Suite-level XDG preserved for inspection: ${suiteIsolatedXdg} (suite-xdg)`);
  } else {
    try {
      if (fs.existsSync(suiteIsolatedXdg)) {
        fs.rmSync(suiteIsolatedXdg, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
});

function findLocalSillyTavernSource() {
  const candidates = [
    process.env.SILLYTAVERN_TEST_REPO,
    path.resolve(REPO_ROOT, './SillyTavern'),
    '/home/zzzne4/SillyTavern',
    path.resolve(REPO_ROOT, '../SillyTavern'),
  ].filter(Boolean);

  for (const cand of candidates) {
    try {
      if (!fs.existsSync(cand)) continue;
      const head = execFileSync('git', ['-C', cand, 'rev-parse', '--verify', CERTIFIED_RELEASE_COMMIT], {
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

function setupDisposableAuthenticFixture(testLabel = 'authentic-fixture') {
  const sourceRepo = findLocalSillyTavernSource();
  assert.ok(
    sourceRepo,
    `Authentic SillyTavern pinned release (${CERTIFIED_RELEASE_COMMIT}) fixture source is required for public CLI acceptance.`
  );

  const fixtureDir = createTempDir('st-pubcli-authentic-', testLabel);
  execFileSync('git', ['clone', '--no-hardlinks', '--quiet', sourceRepo, fixtureDir], {
    stdio: 'ignore',
  });
  execFileSync('git', ['-C', fixtureDir, 'checkout', '--quiet', CERTIFIED_RELEASE_COMMIT], {
    stdio: 'ignore',
  });

  // Verify independent authentic clone properties
  const head = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  assert.equal(head, CERTIFIED_RELEASE_COMMIT, 'Disposable clone must have exact certified HEAD');

  const endpointPath = path.join(fixtureDir, 'src/endpoints/stable-diffusion.js');
  assert.ok(fs.existsSync(endpointPath), 'Disposable clone must contain stock endpoint file');
  const endpointSha = computeSha256(fs.readFileSync(endpointPath)).toLowerCase();
  assert.equal(endpointSha, CERTIFIED_STOCK_SHA256, 'Stock endpoint file must match certified stock SHA-256');

  const lsFiles = execFileSync('git', ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'], { encoding: 'utf-8' });
  assert.match(lsFiles, new RegExp(`100644 ${CERTIFIED_STOCK_BLOB} 0`), 'Git index entry must match certified stock blob');

  const alternatesPath = path.join(fixtureDir, '.git/objects/info/alternates');
  assert.equal(fs.existsSync(alternatesPath), false, 'Clone must have no .git/objects/info/alternates dependency');

  assert.notEqual(
    fs.realpathSync(fixtureDir),
    fs.realpathSync(sourceRepo),
    'Disposable clone must be physically distinct from source repository'
  );

  return fixtureDir;
}

function setupSyntheticRepo(prefix = 'st-pubcli-synth-', testLabel = 'synth-repo') {
  const repoDir = createTempDir(prefix, testLabel);
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
  fs.writeFileSync(path.join(repoDir, 'server.js'), '// mock server\n');
  fs.mkdirSync(path.join(repoDir, 'src/endpoints'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/endpoints/stable-diffusion.js'), '// mock endpoint\n');

  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit', '-q'], { cwd: repoDir });

  return repoDir;
}

describe('D01-SP-2-V3 Public CLI Integration (scripts/sillytavern-patch.mjs & ci-patch.sh)', () => {
  // -------------------------------------------------------------------------
  // Tier 1: Argument Parsing, Aliases, Precedence & Early --json Contract
  // -------------------------------------------------------------------------
  describe('Tier 1: Argument Parsing, Aliases & Option Ordering', () => {
    test('parses apply and remove commands with explicit and positional targets', () => {
      const parsedApply = parseCliArgs(['apply', '--target', '/path/to/st']);
      assert.equal(parsedApply.command, 'apply');
      assert.equal(parsedApply.explicitTarget, '/path/to/st');
      assert.equal(parsedApply.error, null);

      const parsedRemove = parseCliArgs(['remove', '/path/to/st']);
      assert.equal(parsedRemove.command, 'remove');
      assert.equal(parsedRemove.explicitTarget, '/path/to/st');
      assert.equal(parsedRemove.error, null);
    });

    test('parses --apply and --remove backward compatibility aliases', () => {
      const parsedApplyFlag = parseCliArgs(['--apply', '/path/to/st']);
      assert.equal(parsedApplyFlag.command, 'apply');
      assert.equal(parsedApplyFlag.explicitTarget, '/path/to/st');
      assert.equal(parsedApplyFlag.error, null);

      const parsedRemoveFlag = parseCliArgs(['--remove', '--target', '/path/to/st']);
      assert.equal(parsedRemoveFlag.command, 'remove');
      assert.equal(parsedRemoveFlag.explicitTarget, '/path/to/st');
      assert.equal(parsedRemoveFlag.error, null);
    });

    test('detects conflicting commands and preserves json flag', () => {
      const conflict1 = parseCliArgs(['apply', 'remove', '--json']);
      assert.equal(conflict1.json, true);
      assert.match(conflict1.error, /Conflicting commands: apply and remove/);

      const conflict2 = parseCliArgs(['--status', '--apply', '--json']);
      assert.equal(conflict2.json, true);
      assert.match(conflict2.error, /Conflicting commands: status and apply/);

      const conflict3 = parseCliArgs(['check', 'remove', '--json']);
      assert.equal(conflict3.json, true);
      assert.match(conflict3.error, /Conflicting commands: check and remove/);
    });

    test('rejects upstream-test options for mutation commands regardless of argument order', () => {
      // apply before options
      const res1 = parseCliArgs(['apply', '--test-upstream-url', 'https://example.com/st']);
      assert.match(res1.error, /Option --test-upstream-url\/--test-upstream-branch is not permitted for command: apply/);

      // options before apply
      const res2 = parseCliArgs(['--test-upstream-url', 'https://example.com/st', 'apply']);
      assert.match(res2.error, /Option --test-upstream-url\/--test-upstream-branch is not permitted for command: apply/);

      // remove before options
      const res3 = parseCliArgs(['remove', '--test-upstream-branch', 'feature']);
      assert.match(res3.error, /Option --test-upstream-url\/--test-upstream-branch is not permitted for command: remove/);

      // options before remove
      const res4 = parseCliArgs(['--test-upstream-branch', 'feature', 'remove']);
      assert.match(res4.error, /Option --test-upstream-url\/--test-upstream-branch is not permitted for command: remove/);

      // default command (status) rejects upstream-test args
      const res5 = parseCliArgs(['--test-upstream-url', 'https://example.com/st']);
      assert.match(res5.error, /Option --test-upstream-url\/--test-upstream-branch is not permitted for command: status/);

      // check-release allows upstream-test args
      const res6 = parseCliArgs(['check-release', '--test-upstream-url', 'https://example.com/st']);
      assert.equal(res6.error, null);
      assert.equal(res6.command, 'check-release');
      assert.equal(res6.testUpstream?.url, 'https://example.com/st');
    });

    test('pre-scans --json so early argument/syntax errors emit valid JSON on stdout', async () => {
      const origLog = console.log;
      let loggedOutput = '';
      console.log = (msg) => { loggedOutput += msg + '\n'; };

      try {
        // Conflicting commands with --json at end
        loggedOutput = '';
        const exitConflict = await main(['apply', 'remove', '--json']);
        assert.equal(exitConflict, 2);
        const parsedConflict = JSON.parse(loggedOutput.trim());
        assert.equal(parsedConflict.ok, false);
        assert.equal(parsedConflict.exitCode, 2);
        assert.match(parsedConflict.reason, /Conflicting commands/);

        // Unknown option with --json
        loggedOutput = '';
        const exitUnknown = await main(['apply', '--invalid-option-xyz', '--json']);
        assert.equal(exitUnknown, 2);
        const parsedUnknown = JSON.parse(loggedOutput.trim());
        assert.equal(parsedUnknown.ok, false);
        assert.equal(parsedUnknown.exitCode, 2);
        assert.match(parsedUnknown.reason, /Unknown option/);

        // Upstream-test flag on apply with --json
        loggedOutput = '';
        const exitUpstream = await main(['apply', '--test-upstream-url', 'http://example.com', '--json']);
        assert.equal(exitUpstream, 2);
        const parsedUpstream = JSON.parse(loggedOutput.trim());
        assert.equal(parsedUpstream.ok, false);
        assert.equal(parsedUpstream.exitCode, 2);
        assert.match(parsedUpstream.reason, /not permitted for command: apply/);

        // Invalid target directory with --json
        loggedOutput = '';
        const nonExistent = path.join(os.tmpdir(), `nonexistent-dir-${Date.now()}`);
        const exitTarget = await main(['apply', '--target', nonExistent, '--json']);
        assert.equal(exitTarget, 2);
        const parsedTarget = JSON.parse(loggedOutput.trim());
        assert.equal(parsedTarget.ok, false);
        assert.equal(parsedTarget.exitCode, 2);
        assert.match(parsedTarget.reason, /does not exist or is not a directory/);
      } finally {
        console.log = origLog;
      }
    });

    test('pure resolveTargetDirectory verifies absent-sibling behavior without touching real installations', () => {
      const isolatedDir = createTempDir('isolated-pkg-root-', 'tier1-isolated-pkg');
      const res = resolveTargetDirectory({
        explicitTarget: null,
        packageRoot: isolatedDir,
      });
      assert.equal(res.ok, true);
      assert.equal(res.targetDir, null);
      assert.equal(res.source, 'none');
      markFixtureVerified(isolatedDir);
    });

    test('--help displays human-readable help and exits 0 immediately without target resolution', async () => {
      const origLog = console.log;
      let loggedOutput = '';
      console.log = (msg) => { loggedOutput += msg + '\n'; };

      try {
        const exitCode = await main(['apply', '--help']);
        assert.equal(exitCode, 0);
        assert.match(loggedOutput, /Chromatic Images — SillyTavern Patch Manager \(SP-2\)/);
        assert.match(loggedOutput, /COMMANDS:/);
        assert.match(loggedOutput, /apply\s+Safely apply hardened proxy patch/);
        assert.match(loggedOutput, /remove\s+Safely remove hardened proxy patch/);
      } finally {
        console.log = origLog;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tier 2: Formatters & Diagnostic Integrity (Pure Unit Tests)
  // -------------------------------------------------------------------------
  describe('Tier 2: Output Formatters & Diagnostic Integrity', () => {
    test('formatApplyOutput renders applied result with backup details', () => {
      const sampleResult = {
        ok: true,
        status: 'applied',
        exitCode: 0,
        reason: 'Runtime patch applied and verified successfully in working tree; Git index remains unshifted.',
        targetDir: '/tmp/st-repo',
        repoRoot: '/tmp/st-repo',
        targetFile: 'src/endpoints/stable-diffusion.js',
        worktreeSha256: CERTIFIED_PATCHED_SHA256,
        expectedSha256: CERTIFIED_PATCHED_SHA256,
        backup: {
          ok: true,
          backupFilePath: '/tmp/backups/sd.bak',
          metaFilePath: '/tmp/backups/sd.meta.json',
          sha256: CERTIFIED_STOCK_SHA256,
        },
      };

      const text = formatApplyOutput(sampleResult, 'explicit');
      assert.match(text, /\[Chromatic Images\] SillyTavern Patch Application/);
      assert.match(text, /Status:\s+APPLIED/);
      assert.match(text, /Exit Code:\s+0/);
      assert.match(text, /Backup File:\s+\/tmp\/backups\/sd\.bak/);
      assert.match(text, /Backup Metadata:\s+\/tmp\/backups\/sd\.meta\.json/);
    });

    test('formatRemoveOutput renders removed result with backup details', () => {
      const sampleResult = {
        ok: true,
        status: 'removed',
        exitCode: 0,
        reason: 'Runtime patch reversed and verified successfully in working tree; Git index remains unshifted.',
        targetDir: '/tmp/st-repo',
        repoRoot: '/tmp/st-repo',
        targetFile: 'src/endpoints/stable-diffusion.js',
        worktreeSha256: CERTIFIED_STOCK_SHA256,
        expectedSha256: CERTIFIED_STOCK_SHA256,
        backup: {
          ok: true,
          backupFilePath: '/tmp/backups/sd.patched.bak',
          metaFilePath: '/tmp/backups/sd.patched.meta.json',
          sha256: CERTIFIED_PATCHED_SHA256,
        },
      };

      const text = formatRemoveOutput(sampleResult, 'explicit');
      assert.match(text, /\[Chromatic Images\] SillyTavern Patch Removal/);
      assert.match(text, /Status:\s+REMOVED/);
      assert.match(text, /Exit Code:\s+0/);
      assert.match(text, /Backup File:\s+\/tmp\/backups\/sd\.patched\.bak/);
    });

    test('formatters render prominent warning on humanInspectionRequired without destructive advice', () => {
      const ambiguousResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: 'Post-application verification failed: SHA-256 mismatch',
        targetDir: '/tmp/st-repo',
        repoRoot: '/tmp/st-repo',
        targetFile: 'src/endpoints/stable-diffusion.js',
        humanInspectionRequired: true,
        backup: {
          backupFilePath: '/tmp/backups/sd.stock.bak',
          metaFilePath: '/tmp/backups/sd.meta.json',
        },
        observedFingerprints: {
          worktreeSha256: 'deadbeef1234',
          expectedSha256: CERTIFIED_PATCHED_SHA256,
          stockSha256: CERTIFIED_STOCK_SHA256,
        },
      };

      const text = formatApplyOutput(ambiguousResult);
      assert.match(text, /\[WARNING\] Human inspection required!/);
      assert.match(text, /DO NOT run git checkout, git reset, or git clean/);
      assert.match(text, /Observed Fingerprints:/);
      assert.match(text, /Worktree SHA:\s+deadbeef1234/);
      assert.match(text, /Verified Pre-Mutation Backup:\s+\/tmp\/backups\/sd\.stock\.bak/);
    });

    test('formatters render lock diagnostics truthfully on lock failure or cleanup error', () => {
      const lockFail = {
        ok: false,
        status: 'lock-refused',
        exitCode: 1,
        reason: 'Exclusive operation lock could not be acquired',
        lockPath: '/tmp/locks/st.lock',
        existingLock: { pid: 98765, hostname: 'testhost', operation: 'apply' },
      };

      const text = formatApplyOutput(lockFail);
      assert.match(text, /Lock File:\s+\/tmp\/locks\/st\.lock/);
      assert.match(text, /Existing Lock:\s+pid=98765, host=testhost, op=apply/);
    });

    test('formatters safely handle sparse or malformed result objects without throwing', () => {
      assert.doesNotThrow(() => formatApplyOutput({}));
      assert.doesNotThrow(() => formatRemoveOutput({}));
      assert.doesNotThrow(() => formatApplyOutput({ status: 'error', reason: 'sparse' }));
    });
  });

  // -------------------------------------------------------------------------
  // Tier 3: Safety Gates & Refusals (Synthetic Repositories & Authentic Staged)
  // -------------------------------------------------------------------------
  describe('Tier 3: Safety Gates & Refusals', () => {
    test('rejects public CI_LOCK_DIR overrides before target resolution with exit code 2', async () => {
      const origEnv = process.env.CI_LOCK_DIR;

      try {
        const origLog = console.log;
        const origErr = console.error;
        let loggedOutput = '';
        let loggedError = '';
        console.log = (msg) => { loggedOutput += msg + '\n'; };
        console.error = (msg) => { loggedError += msg + '\n'; };

        try {
          // 1. apply with CI_LOCK_DIR set and non-existent target with --json
          // Proves CI_LOCK_DIR check runs BEFORE target directory resolution
          process.env.CI_LOCK_DIR = '/tmp/unauthorized-lock-namespace';
          loggedOutput = '';
          const nonExistentTarget = path.join(os.tmpdir(), `nonexistent-target-${Date.now()}`);
          const exitApply = await main(['apply', '--target', nonExistentTarget, '--json']);
          assert.equal(exitApply, 2);
          const parsedApply = JSON.parse(loggedOutput.trim());
          assert.equal(parsedApply.ok, false);
          assert.equal(parsedApply.status, 'refused');
          assert.equal(parsedApply.exitCode, 2);
          assert.match(parsedApply.reason, /Environment variable CI_LOCK_DIR is not permitted for public mutation commands/);

          // 2. remove with empty string CI_LOCK_DIR="" and explicitly nonexistent target with --json
          // Proves empty string CI_LOCK_DIR is rejected before target resolution without targetless discovery
          process.env.CI_LOCK_DIR = '';
          loggedOutput = '';
          const nonExistentTargetRemove = path.join(os.tmpdir(), `nonexistent-target-remove-${Date.now()}`);
          const exitRemove = await main(['remove', '--target', nonExistentTargetRemove, '--json']);
          assert.equal(exitRemove, 2);
          const parsedRemove = JSON.parse(loggedOutput.trim());
          assert.equal(parsedRemove.ok, false);
          assert.equal(parsedRemove.status, 'refused');
          assert.equal(parsedRemove.exitCode, 2);
          assert.match(parsedRemove.reason, /Environment variable CI_LOCK_DIR is not permitted for public mutation commands/);

          // 3. Text output mode for apply with CI_LOCK_DIR set
          process.env.CI_LOCK_DIR = '/tmp/unauthorized-lock-namespace';
          loggedError = '';
          const exitText = await main(['apply', '--target', nonExistentTarget]);
          assert.equal(exitText, 2);
          assert.match(loggedError, /Environment variable CI_LOCK_DIR is not permitted for public mutation commands/);

          // 4. Read-only commands (status, check, check-release) are NOT rejected by CI_LOCK_DIR
          process.env.CI_LOCK_DIR = '/tmp/unauthorized-lock-namespace';
          loggedOutput = '';
          const synth = setupSyntheticRepo('st-synth-readonly-lock-', 'tier3-readonly-lock');
          const exitStatus = await main(['status', '--target', synth, '--json']);
          // status does not reject on CI_LOCK_DIR; it runs inspection (exit 0)
          assert.equal(exitStatus, 0);
          const parsedStatus = JSON.parse(loggedOutput.trim());
          assert.equal(parsedStatus.command, 'status');
          assert.equal(parsedStatus.exitCode, 0);
          markFixtureVerified(synth);
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
      } finally {
        if (origEnv === undefined) delete process.env.CI_LOCK_DIR;
        else process.env.CI_LOCK_DIR = origEnv;
      }
    });

    test('refuses uncertified revision with exit code 1 via CLI main()', async () => {
      const syntheticRepo = setupSyntheticRepo('st-synth-uncertified-', 'tier3-uncertified');
      const origLog = console.log;
      let loggedOutput = '';
      console.log = (msg) => { loggedOutput += msg + '\n'; };

      try {
        const exitCode = await main(['apply', '--target', syntheticRepo, '--json']);
        assert.equal(exitCode, 1);
        const parsed = JSON.parse(loggedOutput.trim());
        assert.equal(parsed.ok, false);
        assert.equal(parsed.exitCode, 1);
        assert.equal(parsed.status, 'refused');
        assert.match(parsed.reason, /does not match certified release/);
        markFixtureVerified(syntheticRepo);
      } finally {
        console.log = origLog;
      }
    });

    test('refuses if staged changes exist on target file with exit code 1 using authentic pinned fixture', async () => {
      const fixtureDir = setupDisposableAuthenticFixture('tier3-staged-authentic');
      const targetFile = path.join(fixtureDir, 'src/endpoints/stable-diffusion.js');
      const originalStockBytes = fs.readFileSync(targetFile);
      assert.equal(computeSha256(originalStockBytes).toLowerCase(), CERTIFIED_STOCK_SHA256);

      // Modify and stage only the endpoint file
      const stagedContent = '// staged changes in the Git index for test\n';
      fs.writeFileSync(targetFile, stagedContent, 'utf-8');
      execFileSync('git', ['-C', fixtureDir, 'add', 'src/endpoints/stable-diffusion.js']);

      // Record exact staged index entry before the refused operation
      const stagedIndexBefore = execFileSync(
        'git',
        ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'],
        { encoding: 'utf-8' }
      ).trim();

      const origLog = console.log;
      let loggedOutput = '';
      console.log = (msg) => { loggedOutput += msg + '\n'; };

      try {
        const exitCode = await main(['apply', '--target', fixtureDir, '--json']);
        assert.equal(exitCode, 1);
        const parsed = JSON.parse(loggedOutput.trim());
        assert.equal(parsed.ok, false);
        assert.equal(parsed.status, 'refused');
        assert.equal(parsed.exitCode, 1);
        assert.match(parsed.reason, /Git index blob .* does not match stock release blob|staged changes in the Git index/i);

        // HEAD and staged content unchanged
        const head = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
        assert.equal(head, CERTIFIED_RELEASE_COMMIT);
        assert.equal(fs.readFileSync(targetFile, 'utf-8'), stagedContent);

        // Staged status and exact index entry in git remain unchanged
        const diffCached = execFileSync('git', ['-C', fixtureDir, 'diff', '--cached', '--name-only'], { encoding: 'utf-8' }).trim();
        assert.equal(diffCached, 'src/endpoints/stable-diffusion.js');
        const stagedIndexAfter = execFileSync(
          'git',
          ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'],
          { encoding: 'utf-8' }
        ).trim();
        assert.equal(stagedIndexAfter, stagedIndexBefore, 'Staged Git index entry must be identical before and after refused operation');

        // No mutation, no backup, no lock
        assert.equal(parsed.mutationOutcome, null);
        assert.equal(parsed.backup, null);
        const backupsDir = path.join(suiteIsolatedXdg, 'chromatic-images/backups');
        assert.ok(!fs.existsSync(backupsDir) || fs.readdirSync(backupsDir).length === 0, 'No backup artifacts should be created');
        const locksDir = path.join(suiteIsolatedXdg, 'chromatic-images/locks');
        assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0, 'No lock file should remain');

        // Mark verified for ordinary cleanup without destructive git reset
        markFixtureVerified(fixtureDir);
      } finally {
        console.log = origLog;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tier 4: Public Entry-Point Coverage (Node CLI & Bash Wrapper)
  // -------------------------------------------------------------------------
  describe('Tier 4: Public Entry-Point Coverage (Node CLI & Bash Wrapper)', () => {
    test('Node CLI: complete lifecycle (stock -> applied -> already-applied -> removed -> already-removed)', () => {
      const fixtureDir = setupDisposableAuthenticFixture('node-cli-lifecycle');
      const targetFile = path.join(fixtureDir, 'src/endpoints/stable-diffusion.js');
      const initialBytes = fs.readFileSync(targetFile);
      assert.equal(computeSha256(initialBytes).toLowerCase(), CERTIFIED_STOCK_SHA256);

      // Genuinely modified, already tracked SillyTavern file
      const trackedFile = path.join(fixtureDir, 'package.json');
      const trackedOriginal = fs.readFileSync(trackedFile, 'utf-8');
      const trackedModified = trackedOriginal + '\n/* node-user-tracked-modification */\n';
      fs.writeFileSync(trackedFile, trackedModified, 'utf-8');
      const trackedExpectedSha = computeSha256(trackedModified);

      // Separate untracked file
      const untrackedFile = path.join(fixtureDir, 'node-untracked-user.txt');
      const untrackedContent = 'node-untracked-user-note\n';
      fs.writeFileSync(untrackedFile, untrackedContent, 'utf-8');
      const untrackedExpectedSha = computeSha256(untrackedContent);

      const privateXdg = createTempDir('ci-pubcli-node-xdg-', 'node-cli-xdg');
      const locksDir = path.join(privateXdg, 'chromatic-images/locks');
      const backupsDir = path.join(privateXdg, 'chromatic-images/backups');

      // 1. apply on stock -> exit 0 (applied)
      const resApply1 = spawnSync(
        process.execPath,
        [CLI_SCRIPT_PATH, 'apply', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resApply1.status, 0);
      const jsonApply1 = JSON.parse(resApply1.stdout.trim());
      assert.equal(jsonApply1.ok, true);
      assert.equal(jsonApply1.status, 'applied');
      assert.equal(jsonApply1.exitCode, 0);
      assert.equal(jsonApply1.worktreeSha256, CERTIFIED_PATCHED_SHA256);

      // Post-apply working tree & index
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_PATCHED_SHA256);
      const head1 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head1, CERTIFIED_RELEASE_COMMIT);
      const indexApply = execFileSync('git', ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'], { encoding: 'utf-8' });
      assert.match(indexApply, new RegExp(`100644 ${CERTIFIED_STOCK_BLOB} 0`));

      // Lock cleanup
      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0, 'Locks must be cleaned up on success');

      // Backup verification: stock content, permissions 0600, descriptor schema
      assert.ok(jsonApply1.backup?.backupFilePath);
      assert.ok(fs.existsSync(jsonApply1.backup.backupFilePath));
      assert.equal(computeSha256(fs.readFileSync(jsonApply1.backup.backupFilePath)).toLowerCase(), CERTIFIED_STOCK_SHA256);
      assert.equal(jsonApply1.backup.sha256.toLowerCase(), CERTIFIED_STOCK_SHA256);
      assert.equal(fs.statSync(jsonApply1.backup.backupFilePath).mode & 0o777, 0o600);

      const metaPathApply = jsonApply1.backup.metaFilePath || jsonApply1.backup.descriptorFilePath;
      assert.ok(metaPathApply && fs.existsSync(metaPathApply));
      assert.equal(fs.statSync(metaPathApply).mode & 0o777, 0o600);
      const metaApply = JSON.parse(fs.readFileSync(metaPathApply, 'utf-8'));
      assert.equal(metaApply.schemaVersion, '1.1.0');
      assert.equal(metaApply.operation, 'apply');
      assert.equal(metaApply.sha256.toLowerCase(), CERTIFIED_STOCK_SHA256);
      assert.equal(metaApply.targetFile, 'src/endpoints/stable-diffusion.js');

      // Backup counts
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 1);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 1);

      // Tracked & untracked file preservation
      assert.equal(fs.readFileSync(trackedFile, 'utf-8'), trackedModified);
      assert.equal(computeSha256(fs.readFileSync(trackedFile)), trackedExpectedSha);
      assert.equal(fs.readFileSync(untrackedFile, 'utf-8'), untrackedContent);
      assert.equal(computeSha256(fs.readFileSync(untrackedFile)), untrackedExpectedSha);

      // 2. apply on patched -> exit 3 (already-applied)
      const resApply2 = spawnSync(
        process.execPath,
        [CLI_SCRIPT_PATH, 'apply', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resApply2.status, 3);
      const jsonApply2 = JSON.parse(resApply2.stdout.trim());
      assert.equal(jsonApply2.ok, true);
      assert.equal(jsonApply2.status, 'already-applied');
      assert.equal(jsonApply2.exitCode, 3);
      assert.equal(jsonApply2.backup, null);

      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_PATCHED_SHA256);
      const head2 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head2, CERTIFIED_RELEASE_COMMIT);
      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0);

      // Idempotent backup count: no new backups created
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 1);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 1);

      // Tracked & untracked preservation
      assert.equal(fs.readFileSync(trackedFile, 'utf-8'), trackedModified);
      assert.equal(fs.readFileSync(untrackedFile, 'utf-8'), untrackedContent);

      // 3. remove on patched -> exit 0 (removed)
      const resRemove1 = spawnSync(
        process.execPath,
        [CLI_SCRIPT_PATH, 'remove', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resRemove1.status, 0);
      const jsonRemove1 = JSON.parse(resRemove1.stdout.trim());
      assert.equal(jsonRemove1.ok, true);
      assert.equal(jsonRemove1.status, 'removed');
      assert.equal(jsonRemove1.exitCode, 0);
      assert.equal(jsonRemove1.worktreeSha256, CERTIFIED_STOCK_SHA256);

      // Post-remove working tree & index
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);
      const head3 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head3, CERTIFIED_RELEASE_COMMIT);
      const indexRemove = execFileSync('git', ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'], { encoding: 'utf-8' });
      assert.match(indexRemove, new RegExp(`100644 ${CERTIFIED_STOCK_BLOB} 0`));

      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0);

      // Backup verification: patched content, permissions 0600, descriptor schema
      assert.ok(jsonRemove1.backup?.backupFilePath);
      assert.ok(fs.existsSync(jsonRemove1.backup.backupFilePath));
      assert.equal(computeSha256(fs.readFileSync(jsonRemove1.backup.backupFilePath)).toLowerCase(), CERTIFIED_PATCHED_SHA256);
      assert.equal(jsonRemove1.backup.sha256.toLowerCase(), CERTIFIED_PATCHED_SHA256);
      assert.equal(fs.statSync(jsonRemove1.backup.backupFilePath).mode & 0o777, 0o600);

      const metaPathRemove = jsonRemove1.backup.metaFilePath || jsonRemove1.backup.descriptorFilePath;
      assert.ok(metaPathRemove && fs.existsSync(metaPathRemove));
      assert.equal(fs.statSync(metaPathRemove).mode & 0o777, 0o600);
      const metaRemove = JSON.parse(fs.readFileSync(metaPathRemove, 'utf-8'));
      assert.equal(metaRemove.schemaVersion, '1.1.0');
      assert.equal(metaRemove.operation, 'remove');
      assert.equal(metaRemove.sha256.toLowerCase(), CERTIFIED_PATCHED_SHA256);
      assert.equal(metaRemove.targetFile, 'src/endpoints/stable-diffusion.js');

      // Backup counts: now exactly 2
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 2);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 2);

      // Tracked & untracked preservation
      assert.equal(fs.readFileSync(trackedFile, 'utf-8'), trackedModified);
      assert.equal(computeSha256(fs.readFileSync(trackedFile)), trackedExpectedSha);
      assert.equal(fs.readFileSync(untrackedFile, 'utf-8'), untrackedContent);
      assert.equal(computeSha256(fs.readFileSync(untrackedFile)), untrackedExpectedSha);

      // 4. remove on stock -> exit 3 (already-removed)
      const resRemove2 = spawnSync(
        process.execPath,
        [CLI_SCRIPT_PATH, 'remove', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resRemove2.status, 3);
      const jsonRemove2 = JSON.parse(resRemove2.stdout.trim());
      assert.equal(jsonRemove2.ok, true);
      assert.equal(jsonRemove2.status, 'already-removed');
      assert.equal(jsonRemove2.exitCode, 3);
      assert.equal(jsonRemove2.backup, null);

      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);
      const head4 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head4, CERTIFIED_RELEASE_COMMIT);
      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0);

      // Idempotent backup count: strictly unchanged at 2
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 2);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 2);

      // Final Git porcelain status check
      const statusPorcelain = execFileSync('git', ['-C', fixtureDir, 'status', '--porcelain'], { encoding: 'utf-8' });
      assert.match(statusPorcelain, /^ M package\.json$/m);
      assert.match(statusPorcelain, /^\?\? node-untracked-user\.txt$/m);
      assert.doesNotMatch(statusPorcelain, /stable-diffusion\.js/);

      // 5. Human text mode apply
      const resText = spawnSync(
        process.execPath,
        [CLI_SCRIPT_PATH, 'apply', '--target', fixtureDir],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resText.status, 0);
      assert.match(resText.stdout, /\[Chromatic Images\] SillyTavern Patch Application/);
      assert.match(resText.stdout, /Status:\s+APPLIED/);

      markFixtureVerified(fixtureDir);
      markFixtureVerified(privateXdg);
    });

    test('Bash wrapper: complete lifecycle (stock -> applied -> already-applied -> removed -> already-removed)', () => {
      const fixtureDir = setupDisposableAuthenticFixture('bash-cli-lifecycle');
      const targetFile = path.join(fixtureDir, 'src/endpoints/stable-diffusion.js');
      const initialBytes = fs.readFileSync(targetFile);
      assert.equal(computeSha256(initialBytes).toLowerCase(), CERTIFIED_STOCK_SHA256);

      // Genuinely modified, already tracked SillyTavern file
      const trackedFile = path.join(fixtureDir, 'server.js');
      const trackedOriginal = fs.readFileSync(trackedFile, 'utf-8');
      const trackedModified = trackedOriginal + '\n/* bash-user-tracked-modification */\n';
      fs.writeFileSync(trackedFile, trackedModified, 'utf-8');
      const trackedExpectedSha = computeSha256(trackedModified);

      // Separate untracked file
      const untrackedFile = path.join(fixtureDir, 'bash-untracked-user.log');
      const untrackedContent = 'bash-untracked-user-note\n';
      fs.writeFileSync(untrackedFile, untrackedContent, 'utf-8');
      const untrackedExpectedSha = computeSha256(untrackedContent);

      const privateXdg = createTempDir('ci-pubcli-bash-xdg-', 'bash-cli-xdg');
      const locksDir = path.join(privateXdg, 'chromatic-images/locks');
      const backupsDir = path.join(privateXdg, 'chromatic-images/backups');

      // 1. apply on stock -> exit 0 (applied)
      const resApply1 = spawnSync(
        BASH_WRAPPER_PATH,
        ['apply', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resApply1.status, 0);
      const jsonApply1 = JSON.parse(resApply1.stdout.trim());
      assert.equal(jsonApply1.ok, true);
      assert.equal(jsonApply1.status, 'applied');
      assert.equal(jsonApply1.exitCode, 0);
      assert.equal(jsonApply1.worktreeSha256, CERTIFIED_PATCHED_SHA256);

      // Post-apply working tree & index
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_PATCHED_SHA256);
      const head1 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head1, CERTIFIED_RELEASE_COMMIT);
      const indexApply = execFileSync('git', ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'], { encoding: 'utf-8' });
      assert.match(indexApply, new RegExp(`100644 ${CERTIFIED_STOCK_BLOB} 0`));

      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0, 'Locks must be cleaned up on success');

      // Backup verification: stock content, permissions 0600, descriptor schema
      assert.ok(jsonApply1.backup?.backupFilePath);
      assert.ok(fs.existsSync(jsonApply1.backup.backupFilePath));
      assert.equal(computeSha256(fs.readFileSync(jsonApply1.backup.backupFilePath)).toLowerCase(), CERTIFIED_STOCK_SHA256);
      assert.equal(jsonApply1.backup.sha256.toLowerCase(), CERTIFIED_STOCK_SHA256);
      assert.equal(fs.statSync(jsonApply1.backup.backupFilePath).mode & 0o777, 0o600);

      const metaPathApply = jsonApply1.backup.metaFilePath || jsonApply1.backup.descriptorFilePath;
      assert.ok(metaPathApply && fs.existsSync(metaPathApply));
      assert.equal(fs.statSync(metaPathApply).mode & 0o777, 0o600);
      const metaApply = JSON.parse(fs.readFileSync(metaPathApply, 'utf-8'));
      assert.equal(metaApply.schemaVersion, '1.1.0');
      assert.equal(metaApply.operation, 'apply');
      assert.equal(metaApply.sha256.toLowerCase(), CERTIFIED_STOCK_SHA256);
      assert.equal(metaApply.targetFile, 'src/endpoints/stable-diffusion.js');

      // Backup counts
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 1);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 1);

      // Tracked & untracked file preservation
      assert.equal(fs.readFileSync(trackedFile, 'utf-8'), trackedModified);
      assert.equal(computeSha256(fs.readFileSync(trackedFile)), trackedExpectedSha);
      assert.equal(fs.readFileSync(untrackedFile, 'utf-8'), untrackedContent);
      assert.equal(computeSha256(fs.readFileSync(untrackedFile)), untrackedExpectedSha);

      // 2. apply on patched -> exit 3 (already-applied)
      const resApply2 = spawnSync(
        BASH_WRAPPER_PATH,
        ['apply', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resApply2.status, 3);
      const jsonApply2 = JSON.parse(resApply2.stdout.trim());
      assert.equal(jsonApply2.ok, true);
      assert.equal(jsonApply2.status, 'already-applied');
      assert.equal(jsonApply2.exitCode, 3);

      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_PATCHED_SHA256);
      const head2 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head2, CERTIFIED_RELEASE_COMMIT);
      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0);

      // Idempotent backup count
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 1);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 1);

      // 3. remove on patched -> exit 0 (removed)
      const resRemove1 = spawnSync(
        BASH_WRAPPER_PATH,
        ['remove', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resRemove1.status, 0);
      const jsonRemove1 = JSON.parse(resRemove1.stdout.trim());
      assert.equal(jsonRemove1.ok, true);
      assert.equal(jsonRemove1.status, 'removed');
      assert.equal(jsonRemove1.exitCode, 0);
      assert.equal(jsonRemove1.worktreeSha256, CERTIFIED_STOCK_SHA256);

      // Post-remove working tree & index
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);
      const head3 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head3, CERTIFIED_RELEASE_COMMIT);
      const indexRemove = execFileSync('git', ['-C', fixtureDir, 'ls-files', '-s', 'src/endpoints/stable-diffusion.js'], { encoding: 'utf-8' });
      assert.match(indexRemove, new RegExp(`100644 ${CERTIFIED_STOCK_BLOB} 0`));

      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0);

      // Backup verification: patched content, permissions 0600, descriptor schema
      assert.ok(jsonRemove1.backup?.backupFilePath);
      assert.ok(fs.existsSync(jsonRemove1.backup.backupFilePath));
      assert.equal(computeSha256(fs.readFileSync(jsonRemove1.backup.backupFilePath)).toLowerCase(), CERTIFIED_PATCHED_SHA256);
      assert.equal(jsonRemove1.backup.sha256.toLowerCase(), CERTIFIED_PATCHED_SHA256);
      assert.equal(fs.statSync(jsonRemove1.backup.backupFilePath).mode & 0o777, 0o600);

      const metaPathRemove = jsonRemove1.backup.metaFilePath || jsonRemove1.backup.descriptorFilePath;
      assert.ok(metaPathRemove && fs.existsSync(metaPathRemove));
      assert.equal(fs.statSync(metaPathRemove).mode & 0o777, 0o600);
      const metaRemove = JSON.parse(fs.readFileSync(metaPathRemove, 'utf-8'));
      assert.equal(metaRemove.schemaVersion, '1.1.0');
      assert.equal(metaRemove.operation, 'remove');
      assert.equal(metaRemove.sha256.toLowerCase(), CERTIFIED_PATCHED_SHA256);
      assert.equal(metaRemove.targetFile, 'src/endpoints/stable-diffusion.js');

      // Backup counts: now exactly 2
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 2);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 2);

      // 4. remove on stock -> exit 3 (already-removed)
      const resRemove2 = spawnSync(
        BASH_WRAPPER_PATH,
        ['remove', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resRemove2.status, 3);
      const jsonRemove2 = JSON.parse(resRemove2.stdout.trim());
      assert.equal(jsonRemove2.ok, true);
      assert.equal(jsonRemove2.status, 'already-removed');
      assert.equal(jsonRemove2.exitCode, 3);

      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);
      const head4 = execFileSync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      assert.equal(head4, CERTIFIED_RELEASE_COMMIT);
      assert.ok(!fs.existsSync(locksDir) || fs.readdirSync(locksDir).length === 0);

      // Idempotent backup count: strictly unchanged at 2
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.bak')).length, 2);
      assert.equal(fs.readdirSync(backupsDir).filter((f) => f.endsWith('.meta.json')).length, 2);

      // Final Git porcelain status check
      const statusPorcelain = execFileSync('git', ['-C', fixtureDir, 'status', '--porcelain'], { encoding: 'utf-8' });
      assert.match(statusPorcelain, /^ M server\.js$/m);
      assert.match(statusPorcelain, /^\?\? bash-untracked-user\.log$/m);
      assert.doesNotMatch(statusPorcelain, /stable-diffusion\.js/);

      // 5. Human text mode remove
      const resText = spawnSync(
        BASH_WRAPPER_PATH,
        ['remove', '--target', fixtureDir],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );
      assert.equal(resText.status, 3);
      assert.match(resText.stdout, /\[Chromatic Images\] SillyTavern Patch Removal/);
      assert.match(resText.stdout, /Status:\s+ALREADY-REMOVED/);

      markFixtureVerified(fixtureDir);
      markFixtureVerified(privateXdg);
    });

    test('foreign-lock refusal preserves lock file and target fixture without mutation', () => {
      const fixtureDir = setupDisposableAuthenticFixture('foreign-lock-fixture');
      const privateXdg = createTempDir('ci-pubcli-lock-xdg-', 'foreign-lock-xdg');

      const targetFile = path.join(fixtureDir, 'src/endpoints/stable-diffusion.js');
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);

      const repoHash = computeSha256(fs.realpathSync(fixtureDir)).slice(0, 12);
      const locksDir = path.join(privateXdg, 'chromatic-images/locks');
      fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
      const lockPath = path.join(locksDir, `${repoHash}.lock`);
      const lockContent = {
        lockVersion: 1,
        pid: 999999,
        nonce: 'foreign-audit-nonce',
        operation: 'apply',
        repoRoot: fs.realpathSync(fixtureDir),
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockContent, null, 2), { mode: 0o600 });

      const resLockFail = spawnSync(
        process.execPath,
        [CLI_SCRIPT_PATH, 'apply', '--target', fixtureDir, '--json'],
        {
          env: { ...process.env, XDG_DATA_HOME: privateXdg },
          encoding: 'utf-8',
        }
      );

      assert.equal(resLockFail.status, 1);
      const jsonLockFail = JSON.parse(resLockFail.stdout.trim());
      assert.equal(jsonLockFail.ok, false);
      assert.equal(jsonLockFail.status, 'lock-refused');
      assert.equal(jsonLockFail.exitCode, 1);

      // Verify lock file was preserved and NOT unlinked
      assert.ok(fs.existsSync(lockPath), 'Lock evidence must be preserved on lock refusal');
      const preservedLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      assert.equal(preservedLock.nonce, 'foreign-audit-nonce');

      // Verify fixture was preserved
      assert.ok(fs.existsSync(targetFile), 'Target fixture must remain intact');
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);

      // Deliberately preserve foreign-lock refusal fixture, lock file, and private storage for examination
      // Do not unlink the foreign lock or mark fixtures as verified
      console.log(`[PRESERVED FOREIGN LOCK EVIDENCE] Target fixture: ${fixtureDir}`);
      console.log(`[PRESERVED FOREIGN LOCK EVIDENCE] Private lock/XDG directory: ${privateXdg}`);
      console.log(`[PRESERVED FOREIGN LOCK EVIDENCE] Foreign lock file: ${lockPath}`);
    });

    test('post-mutation verification failure preserves pre-mutation backup, descriptor, and unrolled target', async () => {
      const fixtureDir = setupDisposableAuthenticFixture('post-mutation-fault-fixture');
      const privateXdg = createTempDir('ci-pubcli-fault-xdg-', 'post-mutation-fault-xdg');

      const targetFile = path.join(fixtureDir, 'src/endpoints/stable-diffusion.js');
      assert.equal(computeSha256(fs.readFileSync(targetFile)).toLowerCase(), CERTIFIED_STOCK_SHA256);

      // Execute applyPatchToInstallation directly with simulated postMutationHook that tampers with target file
      const resFault = await applyPatchToInstallation({
        targetDir: fixtureDir,
        backupDir: privateXdg,
        _testOverrides: {
          postMutationHook({ targetFilePath }) {
            fs.writeFileSync(targetFilePath, '// simulated-target-corruption-post-mutation\n');
          },
        },
      });

      assert.equal(resFault.ok, false);
      assert.equal(resFault.status, 'verification-failed');
      assert.equal(resFault.exitCode, 1);
      assert.equal(resFault.humanInspectionRequired, true);

      // Pre-mutation backup and descriptor must be preserved on disk with 0600 permissions
      assert.ok(resFault.backup?.backupFilePath);
      assert.ok(fs.existsSync(resFault.backup.backupFilePath));
      assert.equal(fs.statSync(resFault.backup.backupFilePath).mode & 0o777, 0o600);
      assert.equal(computeSha256(fs.readFileSync(resFault.backup.backupFilePath)).toLowerCase(), CERTIFIED_STOCK_SHA256);

      assert.ok(resFault.backup?.metaFilePath);
      assert.ok(fs.existsSync(resFault.backup.metaFilePath));
      assert.equal(fs.statSync(resFault.backup.metaFilePath).mode & 0o777, 0o600);
      const metaFault = JSON.parse(fs.readFileSync(resFault.backup.metaFilePath, 'utf-8'));
      assert.equal(metaFault.schemaVersion, '1.1.0');
      assert.equal(metaFault.operation, 'apply');
      assert.equal(metaFault.sha256.toLowerCase(), CERTIFIED_STOCK_SHA256);

      // Target file remains in corrupted state — NO automatic rollback
      assert.equal(fs.readFileSync(targetFile, 'utf-8'), '// simulated-target-corruption-post-mutation\n');

      // Human readable format output renders prominent warning
      const textOutput = formatApplyOutput(resFault);
      assert.match(textOutput, /Human inspection required/);
      assert.match(textOutput, /DO NOT run git checkout, git reset, or git clean/);

      // A deliberately ambiguous post-mutation fixture must remain available for inspection.
      // Print the actual preservation paths to stdout and do NOT mark verified or clean up.
      console.log(`[PRESERVED AMBIGUOUS EVIDENCE] Target fixture: ${fixtureDir}`);
      console.log(`[PRESERVED AMBIGUOUS EVIDENCE] Backup/XDG directory: ${privateXdg}`);
      console.log(`[PRESERVED AMBIGUOUS EVIDENCE] Corrupted endpoint: ${targetFile}`);
      console.log(`[PRESERVED AMBIGUOUS EVIDENCE] Pre-mutation backup: ${resFault.backup?.backupFilePath}`);
      console.log(`[PRESERVED AMBIGUOUS EVIDENCE] Backup metadata: ${resFault.backup?.metaFilePath}`);
    });
  });
});

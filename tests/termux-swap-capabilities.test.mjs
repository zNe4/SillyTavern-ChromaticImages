import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  runTermuxSwapCapabilityProbe,
  parseCliArgs,
  PROBE_PREFIX,
} from '../scripts/check-termux-swap-capabilities.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROBE_SCRIPT_PATH = path.resolve(__dirname, '../scripts/check-termux-swap-capabilities.mjs');

const tempDirsToClean = [];
after(() => {
  for (const d of tempDirsToClean) {
    try {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors on test exit
    }
  }
});

function createTempFixtureDir(prefix = 'ci-termux-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

function getOpenFdCount() {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

describe('Termux Swap Capability Probe (D01-P3B-2D-2-A)', () => {
  test('1. Programmatic execution succeeds on supported Linux platform', async () => {
    const fixtureDir = createTempFixtureDir('probe-success-');
    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });

    assert.equal(res.ok, true, `Probe should succeed: ${res.error}`);
    assert.equal(res.cleanupSucceeded, true, 'Probe directory should be cleaned up');
    assert.equal(res.failedStage, null, 'No failed stage on success');
    assert.equal(res.error, null, 'No error on success');
    assert.equal(res.platform, 'linux');

    // Validate all 13 capability flags
    const caps = res.capabilities;
    assert.equal(caps.oNoFollow, true);
    assert.equal(caps.oNonBlock, true);
    assert.equal(caps.oDirectory, true);
    assert.equal(caps.directoryDescriptorOpen, true);
    assert.equal(caps.procfsDescriptorAnchoring, true);
    assert.equal(caps.descriptorFileCreation, true);
    assert.equal(caps.fileDataFsync, true);
    assert.equal(caps.fileMetadataFsync, true);
    assert.equal(caps.descriptorAnchoredRename, true);
    assert.equal(caps.directoryFsync, true);
    assert.equal(caps.inodeContinuityPreserved, true);
    assert.equal(caps.modePreserved, true);
    assert.equal(caps.candidateConsumed, true);

    // Verify probeDir no longer exists
    assert.ok(res.probeDir && !fs.existsSync(res.probeDir), 'Probe directory must be cleaned up on disk');
  });

  test('2. CLI execution with --json produces valid JSON matching schema', () => {
    const output = child_process.execFileSync(
      process.execPath,
      [PROBE_SCRIPT_PATH, '--json'],
      { encoding: 'utf8' }
    );

    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(output);
    }, 'Output must be valid JSON');

    assert.equal(typeof parsed.ok, 'boolean');
    assert.equal(typeof parsed.platform, 'string');
    assert.equal(typeof parsed.arch, 'string');
    assert.equal(typeof parsed.nodeVersion, 'string');
    assert.equal(typeof parsed.capabilities, 'object');
    assert.equal(typeof parsed.cleanupSucceeded, 'boolean');
    assert.equal(typeof parsed.summary, 'string');

    // In a supported Linux environment, ok must be true
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cleanupSucceeded, true);
    assert.equal(parsed.failedStage, null);
    assert.equal(parsed.error, null);
  });

  test('3. CLI execution in default human-readable mode exits 0 on success', () => {
    const res = child_process.spawnSync(
      process.execPath,
      [PROBE_SCRIPT_PATH],
      { encoding: 'utf8' }
    );

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /--- Chromatic Images: Termux Swap Capability Probe ---/);
    assert.match(res.stdout, /Cleanup Succeeded: ✔ Yes/);
    assert.match(res.stdout, /All mandatory Android\/Termux filesystem swap capabilities were successfully validated/);
  });

  test('4. CLI argument parser and help flag handling', () => {
    // --help
    const helpRes = child_process.spawnSync(
      process.execPath,
      [PROBE_SCRIPT_PATH, '--help'],
      { encoding: 'utf8' }
    );
    assert.equal(helpRes.status, 0);
    assert.match(helpRes.stdout, /USAGE:/);
    assert.match(helpRes.stdout, /--json/);

    // -h
    const hRes = child_process.spawnSync(
      process.execPath,
      [PROBE_SCRIPT_PATH, '-h'],
      { encoding: 'utf8' }
    );
    assert.equal(hRes.status, 0);
    assert.match(hRes.stdout, /USAGE:/);

    // Unknown option rejects with status 1
    const badRes = child_process.spawnSync(
      process.execPath,
      [PROBE_SCRIPT_PATH, '--invalid-option'],
      { encoding: 'utf8' }
    );
    assert.equal(badRes.status, 1);
    assert.match(badRes.stderr, /Unknown option: --invalid-option/);

    // Direct unit test of parseCliArgs
    assert.deepEqual(parseCliArgs(['--json']), { json: true, help: false, error: null });
    assert.deepEqual(parseCliArgs(['--help']), { json: false, help: true, error: null });
    assert.deepEqual(parseCliArgs(['-h']), { json: false, help: true, error: null });
    assert.equal(parseCliArgs(['--unknown']).error, 'Unknown option: --unknown');
  });

  test('5. Missing O_NOFOLLOW capability fails closed', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-onofollow-');
    const fakeConstants = { ...fs.constants, O_NOFOLLOW: 0 };

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      constants: fakeConstants,
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'missing-onofollow');
    assert.equal(res.capabilities.oNoFollow, false);
    assert.match(res.error, /O_NOFOLLOW/);
  });

  test('6. Missing O_NONBLOCK capability fails closed', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-ononblock-');
    const fakeConstants = { ...fs.constants, O_NONBLOCK: 0 };

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      constants: fakeConstants,
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'missing-ononblock');
    assert.equal(res.capabilities.oNonBlock, false);
    assert.match(res.error, /O_NONBLOCK/);
  });

  test('7. Missing O_DIRECTORY capability fails closed', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-odirectory-');
    const fakeConstants = { ...fs.constants, O_DIRECTORY: 0 };

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      constants: fakeConstants,
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'missing-odirectory');
    assert.equal(res.capabilities.oDirectory, false);
    assert.match(res.error, /O_DIRECTORY/);
  });

  test('8. Missing procfs directory fails closed', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-procfs-');

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      procDir: '/nonexistent/proc/self/fd',
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'procfs-unavailable');
    assert.equal(res.capabilities.procfsDescriptorAnchoring, false);
    assert.match(res.error, /Procfs descriptor directory/);
  });

  test('9. Inode continuity and content verification', async () => {
    const fixtureDir = createTempFixtureDir('probe-inode-continuity-');
    let capturedCandIno = null;
    let capturedInitialTargetIno = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-candidate-create') {
          capturedCandIno = ctx.candidateIno;
        } else if (stage === 'after-initial-target-closed') {
          capturedInitialTargetIno = ctx.initialTargetIno;
        }
      },
    });

    assert.equal(res.ok, true);
    assert.ok(capturedCandIno !== null, 'Candidate inode should be captured');
    assert.ok(capturedInitialTargetIno !== null, 'Target inode should be captured');
    assert.notEqual(capturedCandIno, capturedInitialTargetIno, 'Initial candidate and target must have different inodes');
    assert.equal(res.capabilities.inodeContinuityPreserved, true);
    assert.equal(res.capabilities.modePreserved, true);
    assert.equal(res.capabilities.candidateConsumed, true);
  });

  test('10. Directory fsync actually attempted and executed', async () => {
    const fixtureDir = createTempFixtureDir('probe-fsync-');
    let fsyncBeforeCalled = false;
    let fsyncAfterCalled = false;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'after-rename-before-dir-fsync') {
          fsyncBeforeCalled = true;
        } else if (stage === 'after-dir-fsync') {
          fsyncAfterCalled = true;
        }
      },
    });

    assert.equal(res.ok, true);
    assert.equal(fsyncBeforeCalled, true, 'Boundary before directory fsync reached');
    assert.equal(fsyncAfterCalled, true, 'Boundary after directory fsync reached');
    assert.equal(res.capabilities.directoryFsync, true);
  });

  test('11. Zero descriptor leaks on successful execution', async () => {
    const fixtureDir = createTempFixtureDir('probe-fd-leak-success-');
    const startFds = getOpenFdCount();

    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);

    const endFds = getOpenFdCount();
    if (startFds !== null && endFds !== null) {
      assert.equal(endFds, startFds, `Descriptor count must not leak: start=${startFds}, end=${endFds}`);
    }
  });

  test('12. Zero descriptor leaks on failure paths', async () => {
    const fixtureDir = createTempFixtureDir('probe-fd-leak-fail-');
    const startFds = getOpenFdCount();

    // Injected failure after directory open
    const res1 = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'after-directory-open') {
          throw new Error('Simulated failure while parent descriptor is held');
        }
      },
    });
    assert.equal(res1.ok, false);
    assert.equal(res1.failedStage, 'unexpected-exception');

    const midFds = getOpenFdCount();
    if (startFds !== null && midFds !== null) {
      assert.equal(midFds, startFds, `Parent fd must close on failure: start=${startFds}, mid=${midFds}`);
    }

    // Injected failure after candidate open
    const res2 = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'after-candidate-create') {
          throw new Error('Simulated failure while candidate descriptor is held');
        }
      },
    });
    assert.equal(res2.ok, false);

    const endFds = getOpenFdCount();
    if (startFds !== null && endFds !== null) {
      assert.equal(endFds, startFds, `Candidate fd must close on failure: start=${startFds}, end=${endFds}`);
    }
  });

  test('13. No modification of pre-existing files outside probe directory', async () => {
    const fixtureDir = createTempFixtureDir('probe-isolation-');
    const canaryFile = path.join(fixtureDir, 'canary-user-file.txt');
    const canaryContent = 'pre-existing authentic user data\n';
    fs.writeFileSync(canaryFile, canaryContent, 'utf8');

    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);

    // Verify canary is intact and untouched
    assert.ok(fs.existsSync(canaryFile), 'Canary file outside probe directory must remain present');
    assert.equal(fs.readFileSync(canaryFile, 'utf8'), canaryContent, 'Canary content must not be modified');
  });

  test('14. No residual temporary artifacts after successful execution', async () => {
    const fixtureDir = createTempFixtureDir('probe-no-residue-');
    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);
    assert.equal(res.cleanupSucceeded, true);

    const entries = fs.readdirSync(fixtureDir);
    const probeEntries = entries.filter((e) => e.startsWith(PROBE_PREFIX));
    assert.equal(probeEntries.length, 0, `No probe directories should remain: found ${probeEntries.join(', ')}`);
  });

  test('15. Safe cleanup refuses recursive deletion if directory identity changed', async () => {
    const fixtureDir = createTempFixtureDir('probe-cleanup-safety-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          // Simulate probe directory replacement: rename original, substitute with different directory
          const backupDir = `${capturedProbeDir}.renamed`;
          fs.renameSync(capturedProbeDir, backupDir);
          fs.mkdirSync(capturedProbeDir); // newly created directory with different inode
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.equal(res.cleanupSucceeded, false);
    assert.match(res.error, /probe directory identity changed/);

    // Verify cleanup was refused and the substituted directory was preserved
    assert.ok(fs.existsSync(capturedProbeDir), 'Substituted directory must be preserved on safety refusal');

    // Clean up our simulated test directories
    try {
      fs.rmSync(capturedProbeDir, { recursive: true, force: true });
      if (fs.existsSync(`${capturedProbeDir}.renamed`)) {
        fs.rmSync(`${capturedProbeDir}.renamed`, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  test('16. Inaccessible or invalid baseDir fails closed', async () => {
    const res = await runTermuxSwapCapabilityProbe({ baseDir: '/nonexistent/base/dir/path' });
    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'base-dir-inaccessible');
    assert.match(res.error, /inaccessible/);

    const res2 = await runTermuxSwapCapabilityProbe({ baseDir: null });
    assert.equal(res2.ok, false);
    assert.equal(res2.failedStage, 'invalid-base-dir');
  });

  test('17. Candidate inode continuity failure is detected if rename does not retain inode', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-inode-check-');

    // Inject fault before rename: replace candidate with file having different inode
    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'before-rename') {
          // unlink candidate and create a fresh one to give it a different inode
          fs.unlinkSync(ctx.procCandidatePath);
          fs.writeFileSync(ctx.procCandidatePath, 'modified-candidate\n');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.ok(
      res.failedStage === 'pre-rename-inode-mismatch' || res.failedStage === 'inode-continuity-broken',
      `Expected pre-rename or continuity failure, got: ${res.failedStage}`
    );
  });
});

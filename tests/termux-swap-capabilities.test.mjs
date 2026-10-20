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
  isValidOpenConstant,
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

describe('Termux Swap Capability Probe (D01-P3B-2D-2-A / F1 Hardening)', () => {
  // --------------------------------------------------------------------------
  // Core Baseline & CLI Regressions
  // --------------------------------------------------------------------------
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

  // --------------------------------------------------------------------------
  // F1-A: Descriptor Closure Failures
  // --------------------------------------------------------------------------
  test('5. F1-A: Descriptor closure failure during normal flow prevents ok: true and reports diagnostic', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-close-cand-');

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'close-candidate') {
          throw new Error('Simulated EIO closing candidate descriptor');
        }
      },
    });

    assert.equal(res.ok, false, 'Probe must not succeed when descriptor closure fails');
    assert.equal(res.failedStage, 'descriptor-cleanup-failed');
    assert.match(res.error, /candidate/);
    assert.match(res.error, /Simulated EIO closing candidate descriptor/);
  });

  test('6. F1-A: Directory descriptor closure failure in finally prevents ok: true', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-close-parent-');

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'close-destination-parent') {
          throw new Error('Simulated EBADF closing parent directory descriptor');
        }
      },
    });

    assert.equal(res.ok, false, 'Probe must not succeed when parent descriptor closure fails');
    assert.equal(res.failedStage, 'descriptor-cleanup-failed');
    assert.match(res.error, /destination-parent/);
    assert.match(res.error, /Simulated EBADF/);
  });

  test('7. F1-A: Original operation error is preserved when a second error occurs in descriptor cleanup', async () => {
    const fixtureDir = createTempFixtureDir('probe-dual-fail-');

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'after-candidate-create') {
          throw new Error('Simulated primary operational failure');
        } else if (stage === 'close-destination-parent') {
          throw new Error('Simulated secondary close failure');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'unexpected-exception', 'Primary operational stage must be preserved');
    assert.match(res.error, /Simulated primary operational failure/, 'Primary error must be preserved');
    assert.match(res.error, /Descriptor cleanup error/, 'Secondary cleanup error must be appended');
    assert.match(res.error, /destination-parent/);
  });

  test('8. F1-A: Zero descriptor leaks on successful execution', async () => {
    const fixtureDir = createTempFixtureDir('probe-fd-leak-success-');
    const startFds = getOpenFdCount();

    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);

    const endFds = getOpenFdCount();
    if (startFds !== null && endFds !== null) {
      assert.equal(endFds, startFds, `Descriptor count must not leak: start=${startFds}, end=${endFds}`);
    }
  });

  test('9. F1-A: Zero descriptor leaks on failure paths', async () => {
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

  // --------------------------------------------------------------------------
  // F1-B: Owned-Artifact Cleanup Safety
  // --------------------------------------------------------------------------
  test('10. F1-B: Unrecognized foreign file in probe directory causes cleanup refusal and artifact preservation', async () => {
    const fixtureDir = createTempFixtureDir('probe-foreign-file-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          // Plant unexpected foreign file inside probe directory before cleanup runs
          fs.writeFileSync(path.join(capturedProbeDir, 'foreign-unrecognized-artifact.txt'), 'danger\n');
        }
      },
    });

    assert.equal(res.ok, false, 'Probe must not succeed when cleanup fails');
    assert.equal(res.cleanupSucceeded, false, 'Cleanup must not be reported as succeeded');
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /unrecognized foreign artifact detected/);
    assert.match(res.error, /foreign-unrecognized-artifact\.txt/);

    // Verify foreign file was preserved on disk
    const foreignPath = path.join(capturedProbeDir, 'foreign-unrecognized-artifact.txt');
    assert.ok(fs.existsSync(foreignPath), 'Foreign artifact must be preserved on disk');
  });

  test('11. F1-B: Foreign subdirectory in probe directory causes cleanup refusal and directory preservation', async () => {
    const fixtureDir = createTempFixtureDir('probe-foreign-subdir-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          // Plant foreign subdirectory inside probe directory
          fs.mkdirSync(path.join(capturedProbeDir, 'foreign-subfolder'));
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.cleanupSucceeded, false);
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /unrecognized foreign artifact/);

    const subPath = path.join(capturedProbeDir, 'foreign-subfolder');
    assert.ok(fs.existsSync(subPath), 'Foreign subdirectory must be preserved');
  });

  test('12. F1-B: Substituted target file with foreign inode causes cleanup refusal', async () => {
    const fixtureDir = createTempFixtureDir('probe-target-inode-sub-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          // Replace target.txt with a newly created file having a different inode
          const targetPath = path.join(capturedProbeDir, 'target.txt');
          fs.unlinkSync(targetPath);
          fs.writeFileSync(targetPath, 'substituted-content\n');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.cleanupSucceeded, false);
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /target\.txt inode .* matches neither/);

    const targetPath = path.join(capturedProbeDir, 'target.txt');
    assert.ok(fs.existsSync(targetPath), 'Substituted target must be preserved');
  });

  test('13. F1-B: Safe cleanup refuses recursive deletion if directory identity changed', async () => {
    const fixtureDir = createTempFixtureDir('probe-cleanup-safety-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          // Substitute probe directory
          const backupDir = `${capturedProbeDir}.renamed`;
          fs.renameSync(capturedProbeDir, backupDir);
          fs.mkdirSync(capturedProbeDir); // new directory with different inode
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.equal(res.cleanupSucceeded, false);
    assert.match(res.error, /probe directory identity changed/);

    // Verify cleanup was refused and the substituted directory was preserved
    assert.ok(fs.existsSync(capturedProbeDir), 'Substituted directory must be preserved on safety refusal');

    try {
      fs.rmSync(capturedProbeDir, { recursive: true, force: true });
      if (fs.existsSync(`${capturedProbeDir}.renamed`)) {
        fs.rmSync(`${capturedProbeDir}.renamed`, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  test('14. F1-B: No residual temporary probe directories after successful execution', async () => {
    const fixtureDir = createTempFixtureDir('probe-no-residue-');
    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);
    assert.equal(res.cleanupSucceeded, true);

    const entries = fs.readdirSync(fixtureDir);
    const probeEntries = entries.filter((e) => e.startsWith(PROBE_PREFIX));
    assert.equal(probeEntries.length, 0, `No probe directories should remain: found ${probeEntries.join(', ')}`);
  });

  test('15. F1-B: No modification of pre-existing files outside probe directory', async () => {
    const fixtureDir = createTempFixtureDir('probe-isolation-');
    const canaryFile = path.join(fixtureDir, 'canary-user-file.txt');
    const canaryContent = 'pre-existing authentic user data\n';
    fs.writeFileSync(canaryFile, canaryContent, 'utf8');

    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);

    assert.ok(fs.existsSync(canaryFile), 'Canary file outside probe directory must remain present');
    assert.equal(fs.readFileSync(canaryFile, 'utf8'), canaryContent, 'Canary content must not be modified');
  });

  // --------------------------------------------------------------------------
  // F1-C: Capability Constants & I/O Validation
  // --------------------------------------------------------------------------
  test('16. F1-C: isValidOpenConstant unit tests across invalid inputs', () => {
    // Valid non-zero integers
    assert.equal(isValidOpenConstant(1), true);
    assert.equal(isValidOpenConstant(128), true);
    assert.equal(isValidOpenConstant(-1), true);

    // Zero
    assert.equal(isValidOpenConstant(0), false);

    // Missing / null / undefined
    assert.equal(isValidOpenConstant(undefined), false);
    assert.equal(isValidOpenConstant(null), false);

    // Non-finite (NaN, Infinity)
    assert.equal(isValidOpenConstant(NaN), false);
    assert.equal(isValidOpenConstant(Infinity), false);
    assert.equal(isValidOpenConstant(-Infinity), false);

    // Fractional
    assert.equal(isValidOpenConstant(1.5), false);
    assert.equal(isValidOpenConstant(0.001), false);

    // Non-numeric
    assert.equal(isValidOpenConstant('128'), false);
    assert.equal(isValidOpenConstant({}), false);
    assert.equal(isValidOpenConstant([]), false);
    assert.equal(isValidOpenConstant(true), false);
  });

  test('17. F1-C: Non-finite, zero, or fractional constants fail closed for O_NOFOLLOW', async () => {
    const fixtureDir = createTempFixtureDir('probe-bad-onofollow-');
    const invalidValues = [0, NaN, Infinity, 1.5, '128', null, undefined];

    for (const val of invalidValues) {
      const fakeConstants = { ...fs.constants, O_NOFOLLOW: val };
      const res = await runTermuxSwapCapabilityProbe({
        baseDir: fixtureDir,
        constants: fakeConstants,
      });
      assert.equal(res.ok, false, `Expected failure for O_NOFOLLOW = ${val}`);
      assert.equal(res.failedStage, 'missing-onofollow');
      assert.match(res.error, /O_NOFOLLOW/);
    }
  });

  test('18. F1-C: Non-finite, zero, or fractional constants fail closed for O_NONBLOCK', async () => {
    const fixtureDir = createTempFixtureDir('probe-bad-ononblock-');
    const invalidValues = [0, NaN, -Infinity, 2.7, 'nonblock', null, undefined];

    for (const val of invalidValues) {
      const fakeConstants = { ...fs.constants, O_NONBLOCK: val };
      const res = await runTermuxSwapCapabilityProbe({
        baseDir: fixtureDir,
        constants: fakeConstants,
      });
      assert.equal(res.ok, false, `Expected failure for O_NONBLOCK = ${val}`);
      assert.equal(res.failedStage, 'missing-ononblock');
      assert.match(res.error, /O_NONBLOCK/);
    }
  });

  test('19. F1-C: Non-finite, zero, or fractional constants fail closed for O_DIRECTORY', async () => {
    const fixtureDir = createTempFixtureDir('probe-bad-odirectory-');
    const invalidValues = [0, NaN, Infinity, 3.14, 'directory', null, undefined];

    for (const val of invalidValues) {
      const fakeConstants = { ...fs.constants, O_DIRECTORY: val };
      const res = await runTermuxSwapCapabilityProbe({
        baseDir: fixtureDir,
        constants: fakeConstants,
      });
      assert.equal(res.ok, false, `Expected failure for O_DIRECTORY = ${val}`);
      assert.equal(res.failedStage, 'missing-odirectory');
      assert.match(res.error, /O_DIRECTORY/);
    }
  });

  test('20. F1-C: Candidate short write failure is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-cand-short-write-');
    const origWriteSync = fs.writeSync;

    try {
      let callCount = 0;
      fs.writeSync = function (fd, buf, offset, length, pos) {
        callCount++;
        // On first write call for candidate, return 0 to trigger short write failure
        if (callCount === 1) {
          return 0;
        }
        return origWriteSync.apply(this, arguments);
      };

      const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
      assert.equal(res.ok, false);
      assert.equal(res.failedStage, 'candidate-short-write');
      assert.match(res.error, /Short write copying candidate data/);
    } finally {
      fs.writeSync = origWriteSync;
    }
  });

  test('21. F1-C: Target short write failure is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-target-short-write-');
    const origWriteSync = fs.writeSync;

    try {
      let targetWriteIntercepted = false;
      fs.writeSync = function (fd, buf, offset, length, pos) {
        // Intercept target write by checking buffer content
        if (Buffer.isBuffer(buf) && buf.toString().includes('initial-target') && !targetWriteIntercepted) {
          targetWriteIntercepted = true;
          return 0;
        }
        return origWriteSync.apply(this, arguments);
      };

      const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
      assert.equal(res.ok, false);
      assert.equal(res.failedStage, 'target-short-write');
      assert.match(res.error, /Short write copying target data/);
    } finally {
      fs.writeSync = origWriteSync;
    }
  });

  test('22. F1-C: Target short read (unexpected EOF) is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-short-read-');
    const origReadSync = fs.readSync;

    try {
      let readIntercepted = false;
      fs.readSync = function (fd, buf, offset, length, pos) {
        if (!readIntercepted) {
          readIntercepted = true;
          return 0; // return 0 when bytes expected
        }
        return origReadSync.apply(this, arguments);
      };

      const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
      assert.equal(res.ok, false);
      assert.equal(res.failedStage, 'target-short-read');
      assert.match(res.error, /Unexpected EOF reading target/);
    } finally {
      fs.readSync = origReadSync;
    }
  });

  test('23. F1-C: Target concurrent expansion during readback is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-concurrent-expand-');
    const origReadSync = fs.readSync;

    try {
      fs.readSync = function (fd, buf, offset, length, pos) {
        // When checking 1 extra byte beyond expected size, simulate concurrent expansion by returning 1
        if (length === 1 && offset === 0 && pos > 0) {
          buf[0] = 0x41;
          return 1;
        }
        return origReadSync.apply(this, arguments);
      };

      const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
      assert.equal(res.ok, false);
      assert.equal(res.failedStage, 'target-concurrent-expansion');
      assert.match(res.error, /Target file expanded concurrently/);
    } finally {
      fs.readSync = origReadSync;
    }
  });

  // --------------------------------------------------------------------------
  // Missing Procfs & Directory Inode / Identity Checks
  // --------------------------------------------------------------------------
  test('24. Missing procfs directory fails closed', async () => {
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

  test('25. Inode continuity and content verification', async () => {
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

  test('26. Directory fsync actually attempted and executed', async () => {
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

  test('27. Inaccessible or invalid baseDir fails closed', async () => {
    const res = await runTermuxSwapCapabilityProbe({ baseDir: '/nonexistent/base/dir/path' });
    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'base-dir-inaccessible');
    assert.match(res.error, /inaccessible/);

    const res2 = await runTermuxSwapCapabilityProbe({ baseDir: null });
    assert.equal(res2.ok, false);
    assert.equal(res2.failedStage, 'invalid-base-dir');
  });

  test('28. Candidate inode continuity failure is detected if rename does not retain inode', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-inode-check-');

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

import { describe, test, after, beforeEach, afterEach } from 'node:test';
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
let currentTestContext = null;
const failedTestContexts = new Set();
let anyTestFailedInSuite = false;

beforeEach((t) => {
  currentTestContext = t;
});

afterEach((t) => {
  if (t.error || t.passed === false) {
    failedTestContexts.add(t);
    anyTestFailedInSuite = true;
  }
  currentTestContext = null;
});

function failClosedCleanupDir(entry) {
  const {
    path: dirPath,
    dev: expectedDev,
    ino: expectedIno,
    uid: expectedUid,
    testContext,
    testName,
    trackedArtifacts,
  } = entry;

  const testFailed = testContext
    ? (failedTestContexts.has(testContext) || Boolean(testContext.error))
    : anyTestFailedInSuite;

  if (testFailed) {
    if (fs.existsSync(dirPath)) {
      console.error(`[evidence-preservation] Retaining artifact from failed test "${testName}": ${dirPath}`);
    }
    return false;
  }

  if (
    typeof expectedDev !== 'number' ||
    typeof expectedIno !== 'number' ||
    typeof expectedUid !== 'number'
  ) {
    if (fs.existsSync(dirPath)) {
      console.error(
        `[evidence-preservation] Refusing cleanup: incomplete recorded identity/ownership for artifact "${dirPath}" (dev: ${expectedDev}, ino: ${expectedIno}, uid: ${expectedUid})`
      );
    }
    return false;
  }

  let stat;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return true;
    }
    console.error(`[evidence-preservation] Unable to stat artifact "${dirPath}": ${err.message}`);
    return false;
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    console.error(`[evidence-preservation] Refusing cleanup: artifact "${dirPath}" is a symbolic link or not a directory`);
    return false;
  }

  if (stat.dev !== expectedDev || stat.ino !== expectedIno) {
    console.error(
      `[evidence-preservation] Refusing cleanup: artifact "${dirPath}" identity mismatch (dev: ${stat.dev} vs ${expectedDev}, ino: ${stat.ino} vs ${expectedIno})`
    );
    return false;
  }

  if (stat.uid !== expectedUid) {
    console.error(
      `[evidence-preservation] Refusing cleanup: artifact "${dirPath}" ownership mismatch (uid: ${stat.uid} vs ${expectedUid})`
    );
    return false;
  }

  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    console.error(
      `[evidence-preservation] Refusing cleanup: artifact "${dirPath}" process uid mismatch (uid: ${stat.uid} vs ${process.getuid()})`
    );
    return false;
  }

  const itemsToClean = [];
  function scanTree(currentDir) {
    let names;
    try {
      names = fs.readdirSync(currentDir);
    } catch (readErr) {
      return { reason: `cannot readdir (${readErr.message})`, path: currentDir };
    }

    for (const name of names) {
      const itemPath = path.join(currentDir, name);
      let itemStat;
      try {
        itemStat = fs.lstatSync(itemPath);
      } catch (statErr) {
        return { reason: `cannot lstat (${statErr.message})`, path: itemPath };
      }

      const tracked = trackedArtifacts?.get(itemPath);
      if (!tracked) {
        return { reason: 'unrecognized or untracked artifact', path: itemPath };
      }

      if (itemStat.dev !== tracked.dev || itemStat.ino !== tracked.ino) {
        return { reason: `identity mismatch (dev: ${itemStat.dev} vs ${tracked.dev}, ino: ${itemStat.ino} vs ${tracked.ino})`, path: itemPath };
      }
      if (typeof tracked.uid === 'number' && itemStat.uid !== tracked.uid) {
        return { reason: `ownership mismatch (uid: ${itemStat.uid} vs ${tracked.uid})`, path: itemPath };
      }
      if (typeof process.getuid === 'function' && itemStat.uid !== process.getuid()) {
        return { reason: `process uid mismatch (uid: ${itemStat.uid} vs ${process.getuid()})`, path: itemPath };
      }
      if (itemStat.isSymbolicLink() !== Boolean(tracked.isSymbolicLink)) {
        return { reason: 'symbolic link type mismatch', path: itemPath };
      }

      if (itemStat.isDirectory()) {
        const nestedErr = scanTree(itemPath);
        if (nestedErr) return nestedErr;
      }

      itemsToClean.push({
        path: itemPath,
        isDirectory: itemStat.isDirectory(),
        isSymbolicLink: itemStat.isSymbolicLink(),
        expectedDev: tracked.dev,
        expectedIno: tracked.ino,
      });
    }
    return null;
  }

  const problem = scanTree(dirPath);
  if (problem) {
    console.error(
      `[evidence-preservation] Refusing cleanup: unexpected or unverified artifact (${problem.reason}) at "${problem.path}"`
    );
    return false;
  }

  // Fail-closed leaf-to-root deletion:
  for (const item of itemsToClean) {
    if (item.isDirectory) continue;
    let currentItemStat;
    try {
      currentItemStat = fs.lstatSync(item.path);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      console.error(`[evidence-preservation] Unable to stat item before deletion "${item.path}": ${err.message}`);
      return false;
    }
    if (currentItemStat.dev !== item.expectedDev || currentItemStat.ino !== item.expectedIno) {
      console.error(`[evidence-preservation] Identity changed immediately before unlinking "${item.path}"`);
      return false;
    }
    fs.unlinkSync(item.path);
  }

  for (const item of itemsToClean) {
    if (!item.isDirectory) continue;
    let currentDirStat;
    try {
      currentDirStat = fs.lstatSync(item.path);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      console.error(`[evidence-preservation] Unable to stat dir before deletion "${item.path}": ${err.message}`);
      return false;
    }
    if (currentDirStat.dev !== item.expectedDev || currentDirStat.ino !== item.expectedIno) {
      console.error(`[evidence-preservation] Identity changed immediately before rmdir "${item.path}"`);
      return false;
    }
    fs.rmdirSync(item.path);
  }

  let finalStat;
  try {
    finalStat = fs.lstatSync(dirPath);
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    console.error(`[evidence-preservation] Unable to stat root dir before final rmdir "${dirPath}": ${err.message}`);
    return false;
  }
  if (finalStat.dev !== expectedDev || finalStat.ino !== expectedIno) {
    console.error(`[evidence-preservation] Identity changed immediately before final rmdir "${dirPath}"`);
    return false;
  }
  fs.rmdirSync(dirPath);
  return true;
}

after(() => {
  for (const entry of tempDirsToClean) {
    try {
      failClosedCleanupDir(entry);
    } catch (cleanupErr) {
      console.error(`[evidence-preservation] Controlled cleanup error for "${entry.path}": ${cleanupErr.message}`);
    }
  }
});

function createTempFixtureDir(prefix = 'ci-termux-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let dev = null;
  let ino = null;
  let uid = null;
  try {
    const stat = fs.lstatSync(dir);
    dev = stat.dev;
    ino = stat.ino;
    uid = typeof stat.uid === 'number' ? stat.uid : null;
  } catch {
    // If initial stat fails, record nulls
  }
  tempDirsToClean.push({
    path: dir,
    dev,
    ino,
    uid,
    testContext: currentTestContext,
    testName: currentTestContext?.name || '(unknown test)',
    trackedArtifacts: new Map(),
  });
  return dir;
}

function getOpenFdCount() {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

describe('Termux Swap Capability Probe (D01-P3B-2D-2-A / F3 Hardening)', () => {
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
  // F3: Phase-Aware Target Ownership
  // --------------------------------------------------------------------------
  test('5. F3: External hard link target.txt before rename fails target creation, refuses unowned cleanup, and preserves artifact', async () => {
    const fixtureDir = createTempFixtureDir('probe-f3-hardlink-target-');
    let capturedProbeDir = null;
    let candIno = null;
    const expectedCandidateContent = 'ci-termux-probe-candidate-payload\n';

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'after-candidate-closed') {
          // At after-candidate-closed, create target.txt as a hard link to candidate.tmp
          const candidatePath = path.join(capturedProbeDir, 'candidate.tmp');
          const targetPath = path.join(capturedProbeDir, 'target.txt');
          candIno = fs.lstatSync(candidatePath).ino;
          fs.linkSync(candidatePath, targetPath);
        }
      },
    });

    // 1. Probe O_CREAT | O_EXCL target creation must fail
    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'create-initial-target');

    // 2. Cleanup must NOT classify external hard link as an owned renamed target
    assert.equal(res.cleanupSucceeded, false);
    assert.match(res.error, /target\.txt was not registered as probe-owned prior to rename/);

    // 3. target.txt must remain present with unchanged inode and contents
    const targetPath = path.join(capturedProbeDir, 'target.txt');
    assert.ok(fs.existsSync(targetPath), 'External hard link target.txt must be preserved on disk');
    const targetStat = fs.lstatSync(targetPath);
    assert.equal(targetStat.ino, candIno, 'target.txt inode must match candidate inode');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), expectedCandidateContent, 'target.txt content must remain unchanged');

    // 4. candidate.tmp must also remain present and unlinked
    const candidatePath = path.join(capturedProbeDir, 'candidate.tmp');
    assert.ok(fs.existsSync(candidatePath), 'candidate.tmp must be preserved on disk');
    const candidateStat = fs.lstatSync(candidatePath);
    assert.equal(candidateStat.ino, candIno, 'candidate.tmp inode must match original candidate inode');
  });

  test('6. F3: Uncertain rename outcome preserves ambiguous target artifact without unlinking', async () => {
    const fixtureDir = createTempFixtureDir('probe-f3-uncertain-rename-');
    let capturedProbeDir = null;
    let candIno = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-rename') {
          candIno = ctx.candidateIno;
          // Simulate rename failure/uncertainty where rename threw
          // Even if target.txt has candidate inode, unconfirmed rename must not clean it up
          fs.renameSync(ctx.procCandidatePath, ctx.procTargetPath);
          throw new Error('Simulated rename syscall failure');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.cleanupSucceeded, false);
    assert.match(res.error, /target\.txt was not registered as probe-owned prior to rename/);

    const targetPath = path.join(capturedProbeDir, 'target.txt');
    assert.ok(fs.existsSync(targetPath), 'Ambiguous target.txt must be preserved on disk');
    assert.equal(fs.lstatSync(targetPath).ino, candIno, 'target.txt retained candidate inode');
  });

  test('7. F3: Genuine resulting target after normal confirmed rename is cleaned up without residue', async () => {
    const fixtureDir = createTempFixtureDir('probe-f3-confirmed-rename-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        }
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.cleanupSucceeded, true);
    assert.equal(res.capabilities.descriptorAnchoredRename, true);
    assert.equal(res.capabilities.candidateConsumed, true);
    assert.equal(res.capabilities.inodeContinuityPreserved, true);

    assert.ok(!fs.existsSync(capturedProbeDir), 'Probe directory must be cleaned up');
  });

  // --------------------------------------------------------------------------
  // F2-A: Proven Artifact Ownership and Directory Disappearance
  // --------------------------------------------------------------------------
  test('8. F2-A: Unexpected candidate.tmp present before creation causes failure, unowned cleanup refusal, and preservation', async () => {
    const fixtureDir = createTempFixtureDir('probe-unowned-candidate-');
    let capturedProbeDir = null;
    let foreignIno = null;
    const foreignContent = 'foreign-unowned-candidate-payload\n';

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
          // Plant unexpected candidate.tmp before the probe attempts O_CREAT | O_EXCL creation
          const candPath = path.join(capturedProbeDir, 'candidate.tmp');
          fs.writeFileSync(candPath, foreignContent, 'utf8');
          foreignIno = fs.lstatSync(candPath).ino;
        }
      },
    });

    // 1. Probe O_EXCL creation must fail
    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'create-candidate-file');

    // 2. Cleanup must refuse to delete unowned candidate.tmp
    assert.equal(res.cleanupSucceeded, false);
    assert.match(res.error, /candidate\.tmp was not registered as probe-owned/);

    // 3. Foreign file must remain present with original content and inode
    const candPath = path.join(capturedProbeDir, 'candidate.tmp');
    assert.ok(fs.existsSync(candPath), 'Unexpected candidate.tmp must be preserved on disk');
    const postStat = fs.lstatSync(candPath);
    assert.equal(postStat.ino, foreignIno, 'Preserved file inode must match initial creation');
    assert.equal(fs.readFileSync(candPath, 'utf8'), foreignContent, 'Preserved file content must remain unchanged');
  });

  test('9. F2-A: Unexpected directory disappearance before cleanup reports failure rather than success', async () => {
    const fixtureDir = createTempFixtureDir('probe-disappeared-dir-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          // Simulate directory moved/disappeared before cleanup runs
          const movedDir = `${capturedProbeDir}.moved`;
          fs.renameSync(capturedProbeDir, movedDir);
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.cleanupSucceeded, false, 'Disappeared directory must NOT be reported as cleanupSucceeded');
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /probe directory unexpectedly disappeared/);

    // Clean up moved test dir
    try {
      fs.rmSync(`${capturedProbeDir}.moved`, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('10. F2-A: Substituted target.txt with foreign inode causes cleanup refusal and artifact preservation', async () => {
    const fixtureDir = createTempFixtureDir('probe-target-inode-sub-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          const targetPath = path.join(capturedProbeDir, 'target.txt');
          const originalTargetStat = fs.lstatSync(targetPath);

          // Create a separate substitute file while original target still exists
          const substitutePath = path.join(capturedProbeDir, 'substitute-target.tmp');
          fs.writeFileSync(substitutePath, 'substituted-content\n');
          const substituteStat = fs.lstatSync(substitutePath);

          // Atomically replace target pathname
          fs.renameSync(substitutePath, targetPath);

          // Verify distinct inode identities
          const currentTargetStat = fs.lstatSync(targetPath);
          assert.ok(
            originalTargetStat.dev !== currentTargetStat.dev || originalTargetStat.ino !== currentTargetStat.ino,
            'Substituted target must possess a distinct inode identity from original target'
          );
          assert.equal(currentTargetStat.ino, substituteStat.ino);
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.cleanupSucceeded, false);
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /target\.txt was not registered as probe-owned/);

    const targetPath = path.join(capturedProbeDir, 'target.txt');
    assert.ok(fs.existsSync(targetPath), 'Substituted target must be preserved');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'substituted-content\n');
  });

  test('11. F2-A: Unrecognized foreign file in probe directory causes cleanup refusal and artifact preservation', async () => {
    const fixtureDir = createTempFixtureDir('probe-foreign-file-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
          fs.writeFileSync(path.join(capturedProbeDir, 'foreign-unrecognized-artifact.txt'), 'danger\n');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.cleanupSucceeded, false);
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /unrecognized foreign artifact detected/);
    assert.match(res.error, /foreign-unrecognized-artifact\.txt/);

    const foreignPath = path.join(capturedProbeDir, 'foreign-unrecognized-artifact.txt');
    assert.ok(fs.existsSync(foreignPath), 'Foreign artifact must be preserved on disk');
  });

  test('12. F2-A: Safe cleanup refuses deletion if directory identity changed', async () => {
    const fixtureDir = createTempFixtureDir('probe-cleanup-safety-');
    let capturedProbeDir = null;

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'after-probe-dir-create') {
          capturedProbeDir = ctx.probeDir;
        } else if (stage === 'before-cleanup') {
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

  // --------------------------------------------------------------------------
  // F2-B: Correct Close-Fault Behavior (Descriptor Safety Across Hook Failures)
  // --------------------------------------------------------------------------
  test('13. F2-B: Pre-close hook failure on candidate descriptor still performs closeSync without fd leak', async () => {
    const fixtureDir = createTempFixtureDir('probe-close-fault-cand-');
    const startFds = getOpenFdCount();

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'close-candidate') {
          throw new Error('Simulated fault hook exception before closing candidate descriptor');
        }
      },
    });

    assert.equal(res.ok, false, 'Probe must fail when close hook throws');
    assert.equal(res.failedStage, 'descriptor-cleanup-failed');
    assert.match(res.error, /candidate/);
    assert.match(res.error, /Simulated fault hook exception/);

    // Verify descriptor count before and after: candidate descriptor was ACTUALLY closed!
    const endFds = getOpenFdCount();
    if (startFds !== null && endFds !== null) {
      assert.equal(endFds, startFds, `Candidate fd must be closed despite hook error: start=${startFds}, end=${endFds}`);
    }
  });

  test('14. F2-B: Pre-close hook failure on parent descriptor in finally still performs closeSync without fd leak', async () => {
    const fixtureDir = createTempFixtureDir('probe-close-fault-parent-');
    const startFds = getOpenFdCount();

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'close-destination-parent') {
          throw new Error('Simulated fault hook exception before closing parent descriptor');
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'descriptor-cleanup-failed');
    assert.match(res.error, /destination-parent/);

    const endFds = getOpenFdCount();
    if (startFds !== null && endFds !== null) {
      assert.equal(endFds, startFds, `Parent fd must be closed despite hook error: start=${startFds}, end=${endFds}`);
    }
  });

  test('15. F2-B: Primary operational failure is preserved alongside secondary close failure', async () => {
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

  test('16. F2-B: Zero descriptor leaks on normal execution and operational failures', async () => {
    const fixtureDir = createTempFixtureDir('probe-fd-leaks-');
    const startFds = getOpenFdCount();

    const res1 = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res1.ok, true);

    const midFds = getOpenFdCount();
    if (startFds !== null && midFds !== null) {
      assert.equal(midFds, startFds, `Zero leaks on success: start=${startFds}, mid=${midFds}`);
    }

    const res2 = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage) => {
        if (stage === 'after-directory-open') {
          throw new Error('Simulated mid-operation crash');
        }
      },
    });
    assert.equal(res2.ok, false);

    const endFds = getOpenFdCount();
    if (startFds !== null && endFds !== null) {
      assert.equal(endFds, startFds, `Zero leaks on operational failure: start=${startFds}, end=${endFds}`);
    }
  });

  // --------------------------------------------------------------------------
  // F2-C: Hardened Finalization Errors (before-artifact-cleanup hook)
  // --------------------------------------------------------------------------
  test('17. F2-C: Thrown before-artifact-cleanup hook does not reject promise and reports structured diagnostic', async () => {
    const fixtureDir = createTempFixtureDir('probe-cleanup-hook-throw-');
    let capturedProbeDir = null;

    // Must resolve, NOT reject
    let res;
    await assert.doesNotReject(async () => {
      res = await runTermuxSwapCapabilityProbe({
        baseDir: fixtureDir,
        faultHook: (stage, ctx) => {
          if (stage === 'after-probe-dir-create') {
            capturedProbeDir = ctx.probeDir;
          } else if (stage === 'before-artifact-cleanup') {
            throw new Error('Simulated fault hook crash during artifact cleanup inspection');
          }
        },
      });
    }, 'Probe must not reject promise when cleanup hook throws');

    assert.equal(res.ok, false, 'Probe must report ok: false');
    assert.equal(res.cleanupSucceeded, false, 'cleanupSucceeded must be false');
    assert.equal(res.failedStage, 'cleanup-safety-violation');
    assert.match(res.error, /Fault hook failed during before-artifact-cleanup/);
    assert.match(res.error, /Simulated fault hook crash/);

    // Verify probeDir and its contents were preserved conservatively
    assert.ok(fs.existsSync(capturedProbeDir), 'Probe directory must be preserved on cleanup failure');
  });

  // --------------------------------------------------------------------------
  // F1-C: Capability Constants & I/O Validation
  // --------------------------------------------------------------------------
  test('18. F1-C: isValidOpenConstant unit tests across invalid inputs', () => {
    assert.equal(isValidOpenConstant(1), true);
    assert.equal(isValidOpenConstant(128), true);
    assert.equal(isValidOpenConstant(-1), true);
    assert.equal(isValidOpenConstant(0), false);
    assert.equal(isValidOpenConstant(undefined), false);
    assert.equal(isValidOpenConstant(null), false);
    assert.equal(isValidOpenConstant(NaN), false);
    assert.equal(isValidOpenConstant(Infinity), false);
    assert.equal(isValidOpenConstant(-Infinity), false);
    assert.equal(isValidOpenConstant(1.5), false);
    assert.equal(isValidOpenConstant(0.001), false);
    assert.equal(isValidOpenConstant('128'), false);
    assert.equal(isValidOpenConstant({}), false);
    assert.equal(isValidOpenConstant([]), false);
    assert.equal(isValidOpenConstant(true), false);
  });

  test('19. F1-C: Non-finite, zero, or fractional constants fail closed for O_NOFOLLOW', async () => {
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

  test('20. F1-C: Non-finite, zero, or fractional constants fail closed for O_NONBLOCK', async () => {
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

  test('21. F1-C: Non-finite, zero, or fractional constants fail closed for O_DIRECTORY', async () => {
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

  test('22. F1-C: Candidate short write failure is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-cand-short-write-');
    const origWriteSync = fs.writeSync;

    try {
      let callCount = 0;
      fs.writeSync = function (fd, buf, offset, length, pos) {
        callCount++;
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

  test('23. F1-C: Target short write failure is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-target-short-write-');
    const origWriteSync = fs.writeSync;

    try {
      let targetWriteIntercepted = false;
      fs.writeSync = function (fd, buf, offset, length, pos) {
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

  test('24. F1-C: Target short read (unexpected EOF) is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-short-read-');
    const origReadSync = fs.readSync;

    try {
      let readIntercepted = false;
      fs.readSync = function (fd, buf, offset, length, pos) {
        if (!readIntercepted) {
          readIntercepted = true;
          return 0;
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

  test('25. F1-C: Target concurrent expansion during readback is caught and reported', async () => {
    const fixtureDir = createTempFixtureDir('probe-concurrent-expand-');
    const origReadSync = fs.readSync;

    try {
      fs.readSync = function (fd, buf, offset, length, pos) {
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
  test('26. Missing procfs directory fails closed', async () => {
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

  test('27. Inode continuity and content verification', async () => {
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

  test('28. Directory fsync actually attempted and executed', async () => {
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

  test('29. Inaccessible or invalid baseDir fails closed', async () => {
    const res = await runTermuxSwapCapabilityProbe({ baseDir: '/nonexistent/base/dir/path' });
    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'base-dir-inaccessible');
    assert.match(res.error, /inaccessible/);

    const res2 = await runTermuxSwapCapabilityProbe({ baseDir: null });
    assert.equal(res2.ok, false);
    assert.equal(res2.failedStage, 'invalid-base-dir');
  });

  test('30. Candidate inode continuity failure is detected if rename does not retain inode', async () => {
    const fixtureDir = createTempFixtureDir('probe-fail-inode-check-');

    const res = await runTermuxSwapCapabilityProbe({
      baseDir: fixtureDir,
      faultHook: (stage, ctx) => {
        if (stage === 'before-rename') {
          const origCandStat = fs.lstatSync(ctx.procCandidatePath);

          // Preallocate a distinct substitute file while original candidate still exists
          const substituteCandidatePath = path.join(fixtureDir, 'substitute-candidate.tmp');
          fs.writeFileSync(substituteCandidatePath, 'modified-candidate\n');
          const substituteStat = fs.lstatSync(substituteCandidatePath);

          assert.ok(
            substituteStat.dev !== origCandStat.dev || substituteStat.ino !== origCandStat.ino,
            'Substitute candidate must possess a distinct inode identity'
          );

          // Atomically replace candidate pathname with the preallocated substitute
          fs.renameSync(substituteCandidatePath, ctx.procCandidatePath);
        }
      },
    });

    assert.equal(res.ok, false);
    assert.equal(res.failedStage, 'inode-continuity-broken');
    assert.match(res.error, /Target inode after rename .* does not match pre-rename candidate inode/);
  });

  test('31. No modification of pre-existing files outside probe directory', async () => {
    const fixtureDir = createTempFixtureDir('probe-isolation-');
    const canaryFile = path.join(fixtureDir, 'canary-user-file.txt');
    const canaryContent = 'pre-existing authentic user data\n';
    fs.writeFileSync(canaryFile, canaryContent, 'utf8');

    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);

    assert.ok(fs.existsSync(canaryFile), 'Canary file outside probe directory must remain present');
    assert.equal(fs.readFileSync(canaryFile, 'utf8'), canaryContent, 'Canary content must not be modified');
  });

  test('32. No residual temporary probe directories after successful execution', async () => {
    const fixtureDir = createTempFixtureDir('probe-no-residue-');
    const res = await runTermuxSwapCapabilityProbe({ baseDir: fixtureDir });
    assert.equal(res.ok, true);
    assert.equal(res.cleanupSucceeded, true);

    const entries = fs.readdirSync(fixtureDir);
    const probeEntries = entries.filter((e) => e.startsWith(PROBE_PREFIX));
    assert.equal(probeEntries.length, 0, `No probe directories should remain: found ${probeEntries.join(', ')}`);
  });
});

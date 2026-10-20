#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PROBE_PREFIX = '.ci-termux-probe-';

/**
 * Validate device identifier.
 * @param {unknown} val
 * @returns {boolean}
 */
function isValidDeviceIdentifier(val) {
  if (typeof val === 'bigint') return val >= 0n;
  if (typeof val !== 'number') return false;
  return Number.isFinite(val) && Number.isInteger(val) && val >= 0;
}

/**
 * Validate inode identifier.
 * @param {unknown} val
 * @returns {boolean}
 */
function isValidInodeIdentifier(val) {
  if (typeof val === 'bigint') return val > 0n;
  if (typeof val !== 'number') return false;
  return Number.isFinite(val) && Number.isInteger(val) && val > 0;
}

/**
 * Parse CLI arguments for the capability probe.
 *
 * @param {string[]} argv
 * @returns {{ json: boolean, help: boolean, error: string | null }}
 */
export function parseCliArgs(argv) {
  let json = false;
  let help = false;
  let error = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      error = `Unknown option: ${arg}`;
      break;
    }
  }

  return { json, help, error };
}

/**
 * Execute the standalone Android/Termux filesystem swap capability probe.
 * Operates strictly within a newly created disposable directory under options.baseDir (default: os.homedir()).
 * Never accesses or modifies actual SillyTavern files.
 *
 * @param {object} [options]
 * @param {string} [options.baseDir=os.homedir()] - Base directory for the disposable probe folder
 * @param {object} [options.constants=fs.constants] - Platform fs.constants override for testing
 * @param {string} [options.procDir='/proc/self/fd'] - Procfs directory override for testing
 * @param {(stage: string, context?: object) => void} [options.faultHook=null] - Fault injection hook for testing
 * @returns {Promise<{
 *   ok: boolean,
 *   platform: string,
 *   arch: string,
 *   nodeVersion: string,
 *   capabilities: {
 *     oNoFollow: boolean,
 *     oNonBlock: boolean,
 *     oDirectory: boolean,
 *     directoryDescriptorOpen: boolean,
 *     procfsDescriptorAnchoring: boolean,
 *     descriptorFileCreation: boolean,
 *     fileDataFsync: boolean,
 *     fileMetadataFsync: boolean,
 *     descriptorAnchoredRename: boolean,
 *     directoryFsync: boolean,
 *     inodeContinuityPreserved: boolean,
 *     modePreserved: boolean,
 *     candidateConsumed: boolean,
 *   },
 *   probeDir: string | null,
 *   failedStage: string | null,
 *   error: string | null,
 *   cleanupSucceeded: boolean,
 *   summary: string,
 * }>}
 */
export async function runTermuxSwapCapabilityProbe(options = {}) {
  const {
    baseDir = os.homedir(),
    constants = fs.constants,
    procDir = '/proc/self/fd',
    faultHook = null,
  } = options;

  const runFault = (stage, ctx) => {
    if (typeof faultHook === 'function') {
      faultHook(stage, ctx);
    }
  };

  const capabilities = {
    oNoFollow: false,
    oNonBlock: false,
    oDirectory: false,
    directoryDescriptorOpen: false,
    procfsDescriptorAnchoring: false,
    descriptorFileCreation: false,
    fileDataFsync: false,
    fileMetadataFsync: false,
    descriptorAnchoredRename: false,
    directoryFsync: false,
    inodeContinuityPreserved: false,
    modePreserved: false,
    candidateConsumed: false,
  };

  let probeDir = null;
  let initialDev = null;
  let initialIno = null;
  let parentFd = null;
  let candidateFd = null;
  let targetFd = null;
  let readFd = null;
  let cleanupSucceeded = false;
  let cleanupError = null;

  const result = {
    ok: false,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    capabilities,
    probeDir: null,
    failedStage: null,
    error: null,
    cleanupSucceeded: false,
    summary: '',
  };

  function fail(stage, errorMsg) {
    result.ok = false;
    result.failedStage = stage;
    result.error = errorMsg;
    result.summary = `Capability probe failed at stage "${stage}": ${errorMsg}`;
    return result;
  }

  try {
    runFault('before-probe-start');

    // 1. Platform and Node.js version check
    if (process.platform !== 'linux' && process.platform !== 'android') {
      return fail(
        'platform-check',
        `Unsupported platform "${process.platform}": Termux swap requires Linux / Android kernel with procfs`
      );
    }

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
      return fail(
        'node-version-check',
        `Node.js version ${process.version} is unsupported: Node.js 18.0.0 or higher is required`
      );
    }

    // 2. Real platform constants check
    if (!constants || typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
      return fail(
        'missing-onofollow',
        'fs.constants.O_NOFOLLOW is missing, non-numeric, or zero'
      );
    }
    capabilities.oNoFollow = true;

    if (typeof constants.O_NONBLOCK !== 'number' || constants.O_NONBLOCK === 0) {
      return fail(
        'missing-ononblock',
        'fs.constants.O_NONBLOCK is missing, non-numeric, or zero'
      );
    }
    capabilities.oNonBlock = true;

    if (typeof constants.O_DIRECTORY !== 'number' || constants.O_DIRECTORY === 0) {
      return fail(
        'missing-odirectory',
        'fs.constants.O_DIRECTORY is missing, non-numeric, or zero'
      );
    }
    capabilities.oDirectory = true;

    runFault('after-constants-check');

    // 3. Create disposable probe directory under baseDir
    if (!baseDir || typeof baseDir !== 'string') {
      return fail('invalid-base-dir', 'Base directory path must be a non-empty string');
    }

    let baseStat;
    try {
      baseStat = fs.statSync(baseDir);
    } catch (err) {
      return fail('base-dir-inaccessible', `Base directory "${baseDir}" is inaccessible: ${err.message}`);
    }
    if (!baseStat.isDirectory()) {
      return fail('base-dir-not-directory', `Base directory "${baseDir}" is not a directory`);
    }

    try {
      probeDir = fs.mkdtempSync(path.join(baseDir, PROBE_PREFIX));
      result.probeDir = probeDir;
    } catch (err) {
      return fail('create-probe-dir', `Failed to create disposable probe directory under "${baseDir}": ${err.message}`);
    }

    // Capture initial directory identity
    const initialStat = fs.lstatSync(probeDir);
    if (!initialStat.isDirectory() || initialStat.isSymbolicLink()) {
      return fail('probe-dir-invalid', 'Created probe directory is not a directory or is a symbolic link');
    }
    if (!isValidDeviceIdentifier(initialStat.dev) || !isValidInodeIdentifier(initialStat.ino)) {
      return fail('probe-dir-invalid-identity', 'Created probe directory lacks usable device or inode identity');
    }
    initialDev = initialStat.dev;
    initialIno = initialStat.ino;

    runFault('after-probe-dir-create', { probeDir, initialDev, initialIno });

    // 4. Open directory descriptor with O_RDONLY | O_DIRECTORY | O_NOFOLLOW
    try {
      parentFd = fs.openSync(
        probeDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
    } catch (err) {
      return fail('open-directory-descriptor', `Failed to open probe directory descriptor: ${err.message}`);
    }

    // 5. Directory descriptor identity verification
    const parentStat = fs.fstatSync(parentFd);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      return fail('parent-descriptor-not-directory', 'Directory descriptor is not a directory or is a symbolic link');
    }
    if (parentStat.dev !== initialDev || parentStat.ino !== initialIno) {
      return fail('parent-descriptor-identity-mismatch', 'Directory descriptor identity does not match created directory');
    }
    capabilities.directoryDescriptorOpen = true;

    runFault('after-directory-open', { parentFd, parentStat });

    // 6. Access to /proc/self/fd/<parentFd>/
    let procAvailable = false;
    try {
      procAvailable = fs.existsSync(procDir);
    } catch {
      procAvailable = false;
    }
    if (!procAvailable) {
      return fail('procfs-unavailable', `Procfs descriptor directory "${procDir}" is unavailable`);
    }

    const parentProcDir = path.join(procDir, String(parentFd));
    let parentProcStat;
    try {
      parentProcStat = fs.statSync(parentProcDir);
    } catch (err) {
      return fail('procfs-descriptor-unavailable', `Descriptor path "${parentProcDir}" cannot be accessed: ${err.message}`);
    }
    if (!parentProcStat.isDirectory()) {
      return fail('procfs-descriptor-not-directory', `Procfs descriptor path "${parentProcDir}" is not a directory`);
    }
    if (parentProcStat.dev !== initialDev || parentProcStat.ino !== initialIno) {
      return fail('procfs-descriptor-identity-mismatch', 'Procfs descriptor path resolves to unexpected directory identity');
    }
    capabilities.procfsDescriptorAnchoring = true;

    runFault('after-procfs-check', { parentProcDir });

    // 7. Descriptor-anchored file creation using O_CREAT | O_EXCL | O_NOFOLLOW (0600)
    const procCandidatePath = path.join(parentProcDir, 'candidate.tmp');
    try {
      candidateFd = fs.openSync(
        procCandidatePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
    } catch (err) {
      return fail('create-candidate-file', `Descriptor-anchored candidate creation failed: ${err.message}`);
    }

    const candInitialStat = fs.fstatSync(candidateFd);
    if (!candInitialStat.isFile() || candInitialStat.isSymbolicLink()) {
      return fail('candidate-not-regular-file', 'Created candidate descriptor is not a regular file');
    }
    if ((candInitialStat.mode & 0o777) !== 0o600) {
      return fail(
        'candidate-unexpected-initial-mode',
        `Candidate initial mode expected 0600, observed 0${(candInitialStat.mode & 0o777).toString(8)}`
      );
    }
    if (candInitialStat.size !== 0) {
      return fail('candidate-not-empty', `Candidate created non-empty (size: ${candInitialStat.size})`);
    }
    if (candInitialStat.nlink !== 1) {
      return fail('candidate-unexpected-nlink', `Candidate link count expected 1, observed ${candInitialStat.nlink}`);
    }
    if (candInitialStat.dev !== parentStat.dev) {
      return fail('candidate-cross-device', 'Candidate created on different filesystem device than directory');
    }
    const candidateIno = candInitialStat.ino;
    capabilities.descriptorFileCreation = true;

    runFault('after-candidate-create', { candidateFd, candidateIno });

    // 8. Candidate data writing and fsyncSync(candidateFd)
    const candidateContent = Buffer.from('ci-termux-probe-candidate-payload\n', 'utf8');
    try {
      fs.writeSync(candidateFd, candidateContent, 0, candidateContent.length, 0);
      fs.fsyncSync(candidateFd);
    } catch (err) {
      return fail('candidate-data-fsync', `Writing candidate data or fsyncSync failed: ${err.message}`);
    }
    capabilities.fileDataFsync = true;

    runFault('after-candidate-write', { candidateFd });

    // 9. fchmodSync(candidateFd, 0o644) followed by metadata fsyncSync
    try {
      fs.fchmodSync(candidateFd, 0o644);
      fs.fsyncSync(candidateFd);
    } catch (err) {
      return fail('candidate-metadata-fsync', `fchmodSync to 0644 or metadata fsyncSync failed: ${err.message}`);
    }

    const candPostChmodStat = fs.fstatSync(candidateFd);
    if ((candPostChmodStat.mode & 0o777) !== 0o644) {
      return fail(
        'candidate-mode-not-updated',
        `Candidate mode expected 0644 after fchmodSync, observed 0${(candPostChmodStat.mode & 0o777).toString(8)}`
      );
    }
    capabilities.fileMetadataFsync = true;

    // Close candidate descriptor
    fs.closeSync(candidateFd);
    candidateFd = null;

    runFault('after-candidate-closed');

    // 10. Creating an independent disposable initial target
    const procTargetPath = path.join(parentProcDir, 'target.txt');
    try {
      targetFd = fs.openSync(
        procTargetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644
      );
    } catch (err) {
      return fail('create-initial-target', `Descriptor-anchored initial target creation failed: ${err.message}`);
    }

    const initialTargetContent = Buffer.from('ci-termux-probe-initial-target-payload\n', 'utf8');
    try {
      fs.writeSync(targetFd, initialTargetContent, 0, initialTargetContent.length, 0);
      fs.fsyncSync(targetFd);
    } catch (err) {
      return fail('initial-target-fsync', `Writing initial target or fsyncSync failed: ${err.message}`);
    }

    const targetInitialStat = fs.fstatSync(targetFd);
    const initialTargetIno = targetInitialStat.ino;
    fs.closeSync(targetFd);
    targetFd = null;

    runFault('after-initial-target-closed', { initialTargetIno });

    // 11. Recording candidate and target inode identities
    if (candidateIno === initialTargetIno) {
      return fail('inode-identity-collision', 'Candidate and initial target unexpectedly share the same inode number');
    }

    // Verify candidate and target stats before rename
    const preRenameCandStat = fs.statSync(procCandidatePath);
    const preRenameTargetStat = fs.statSync(procTargetPath);
    if (preRenameCandStat.ino !== candidateIno || preRenameTargetStat.ino !== initialTargetIno) {
      return fail('pre-rename-inode-mismatch', 'File inodes before rename do not match creation identities');
    }

    runFault('before-rename', { procCandidatePath, procTargetPath, candidateIno, initialTargetIno });

    // 12. Descriptor-anchored replacement using fs.renameSync
    try {
      fs.renameSync(procCandidatePath, procTargetPath);
    } catch (err) {
      return fail('descriptor-anchored-rename', `Descriptor-anchored fs.renameSync failed: ${err.message}`);
    }
    capabilities.descriptorAnchoredRename = true;

    runFault('after-rename-before-dir-fsync');

    // 13. Parent-directory fsyncSync(parentFd)
    try {
      fs.fsyncSync(parentFd);
    } catch (err) {
      return fail('parent-directory-fsync', `Parent directory fsyncSync failed: ${err.message}`);
    }
    capabilities.directoryFsync = true;

    runFault('after-dir-fsync');

    // 14. Post-rename verification through retained parent descriptor
    try {
      readFd = fs.openSync(
        procTargetPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (err) {
      return fail('open-target-post-rename', `Failed to open target post-rename through parent descriptor: ${err.message}`);
    }

    const postRenameTargetStat = fs.fstatSync(readFd);
    if (!postRenameTargetStat.isFile() || postRenameTargetStat.isSymbolicLink()) {
      return fail('target-not-regular-post-rename', 'Post-rename target is not a regular file');
    }

    // 15. Inode continuity and content verification
    if (postRenameTargetStat.ino !== candidateIno) {
      return fail(
        'inode-continuity-broken',
        `Target inode after rename (${postRenameTargetStat.ino}) does not match pre-rename candidate inode (${candidateIno})`
      );
    }
    capabilities.inodeContinuityPreserved = true;

    if ((postRenameTargetStat.mode & 0o777) !== 0o644) {
      return fail(
        'target-mode-mismatch-post-rename',
        `Target mode after rename expected 0644, observed 0${(postRenameTargetStat.mode & 0o777).toString(8)}`
      );
    }
    capabilities.modePreserved = true;

    const readBuf = Buffer.alloc(postRenameTargetStat.size);
    fs.readSync(readFd, readBuf, 0, postRenameTargetStat.size, 0);
    if (!readBuf.equals(candidateContent)) {
      return fail('target-content-mismatch-post-rename', 'Target content after rename does not match candidate content');
    }

    fs.closeSync(readFd);
    readFd = null;

    runFault('after-post-rename-read-verification');

    // 16. Absence of the original candidate pathname
    let candidateStillExists = false;
    try {
      fs.lstatSync(procCandidatePath);
      candidateStillExists = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return fail('candidate-absence-check', `Failed to verify candidate absence via procfs: ${err.message}`);
      }
    }
    if (candidateStillExists) {
      return fail('candidate-not-consumed', 'Candidate pathname still exists via procfs after renameSync');
    }

    const absCandidatePath = path.join(probeDir, 'candidate.tmp');
    let absCandStillExists = false;
    try {
      fs.lstatSync(absCandidatePath);
      absCandStillExists = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return fail('candidate-absence-check-fs', `Failed to verify candidate absence via filesystem: ${err.message}`);
      }
    }
    if (absCandStillExists) {
      return fail('candidate-not-consumed-fs', 'Candidate pathname still exists on filesystem after renameSync');
    }
    capabilities.candidateConsumed = true;

    runFault('before-cleanup');

    // All capabilities succeeded!
    result.ok = true;
    result.summary = 'All mandatory Android/Termux filesystem swap capabilities were successfully validated.';
    return result;
  } catch (err) {
    return fail('unexpected-exception', `Unexpected exception during capability probe: ${err.message}`);
  } finally {
    // 17. Closure of all open descriptors
    if (readFd !== null) {
      try {
        fs.closeSync(readFd);
      } catch {
        // ignore
      }
      readFd = null;
    }
    if (candidateFd !== null) {
      try {
        fs.closeSync(candidateFd);
      } catch {
        // ignore
      }
      candidateFd = null;
    }
    if (targetFd !== null) {
      try {
        fs.closeSync(targetFd);
      } catch {
        // ignore
      }
      targetFd = null;
    }
    if (parentFd !== null) {
      try {
        fs.closeSync(parentFd);
      } catch {
        // ignore
      }
      parentFd = null;
    }

    // 18. Safe cleanup of the newly created probe directory
    if (probeDir && initialDev !== null && initialIno !== null) {
      let cleanupStat = null;
      try {
        cleanupStat = fs.lstatSync(probeDir);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          cleanupSucceeded = true;
        } else {
          cleanupError = `Failed to lstat probe directory before cleanup: ${err.message}`;
        }
      }

      if (cleanupStat) {
        if (!cleanupStat.isDirectory() || cleanupStat.isSymbolicLink()) {
          cleanupError = 'Refusing cleanup: probe directory is no longer a directory or was replaced by a symbolic link';
        } else if (cleanupStat.dev !== initialDev || cleanupStat.ino !== initialIno) {
          cleanupError = `Refusing cleanup: probe directory identity changed (expected dev=${initialDev}, ino=${initialIno}; observed dev=${cleanupStat.dev}, ino=${cleanupStat.ino})`;
        } else {
          try {
            fs.rmSync(probeDir, { recursive: true, force: true });
            cleanupSucceeded = true;
          } catch (rmErr) {
            cleanupError = `Failed to remove probe directory: ${rmErr.message}`;
          }
        }
      }
    }

    result.cleanupSucceeded = cleanupSucceeded;
    if (cleanupError) {
      if (result.ok) {
        result.ok = false;
        result.failedStage = 'cleanup-safety-violation';
        result.error = cleanupError;
        result.summary = `Capability probe passed operations but cleanup failed: ${cleanupError}`;
      } else {
        result.error = `${result.error || ''}; Cleanup error: ${cleanupError}`.trim();
      }
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  if (cliArgs.help) {
    process.stdout.write(`
Chromatic Images — Termux Filesystem Swap Capability Probe (D01-P3B-2D-2-A)

USAGE:
  node scripts/check-termux-swap-capabilities.mjs [OPTIONS]

OPTIONS:
  --json      Emit output in machine-readable JSON format
  --help, -h  Display this help text

DESCRIPTION:
  Validates whether the current environment (Android Termux or Linux) supports
  the exact POSIX descriptor anchoring, nonblocking access, descriptor-anchored
  rename, directory synchronization, and inode continuity required for atomic
  target replacement. Operates strictly inside a disposable directory under $HOME.
`.trim() + '\n');
    process.exit(0);
  }

  if (cliArgs.error) {
    process.stderr.write(`Error: ${cliArgs.error}\nRun with --help for usage information.\n`);
    process.exit(1);
  }

  runTermuxSwapCapabilityProbe().then((res) => {
    if (cliArgs.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      process.stdout.write(`\n--- Chromatic Images: Termux Swap Capability Probe ---\n`);
      process.stdout.write(`Platform:     ${res.platform} (${res.arch})\n`);
      process.stdout.write(`Node Version: ${res.nodeVersion}\n\n`);
      process.stdout.write(`Capabilities Check Ledger:\n`);
      for (const [k, v] of Object.entries(res.capabilities)) {
        const mark = v ? '✔' : '✖';
        process.stdout.write(`  [${mark}] ${k}\n`);
      }
      process.stdout.write(`\nCleanup Succeeded: ${res.cleanupSucceeded ? '✔ Yes' : '✖ No'}\n`);
      process.stdout.write(`\nSummary: ${res.summary}\n`);
      if (res.error) {
        process.stdout.write(`Error:   ${res.error}\n`);
      }
      process.stdout.write(`------------------------------------------------------\n\n`);
    }

    process.exit(res.ok && res.cleanupSucceeded ? 0 : 1);
  }).catch((err) => {
    process.stderr.write(`Fatal error during probe execution: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultGitOps from './git-ops.js';
import {
  resolveStorageDirectory,
  createPreMutationBackup,
  acquireProcessLock,
  verifyLockOwnership,
  releaseProcessLock,
  computeSha256,
} from './simple-backup.js';
import { resolveTargetDirectory } from './inspect.js';
import { inspectTransactionState } from './transaction-state.js';
import { verifyPatchManifest } from '../../scripts/verify-sillytavern-patches.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

/**
 * Internal orchestrator to safely apply the runtime patch to a SillyTavern installation.
 *
 * Requirements:
 * - Verified manifest and runtime patch.
 * - Exact certified SillyTavern HEAD (06bde939fb1e9c4c8d8641d810f0a916b5bce127).
 * - Original target SHA-256 and index blob/mode.
 * - No staged changes or merge conflicts affecting the target.
 * - Safe target path and no pending legacy .ci-patch transaction.
 * - Successful forward git apply --check.
 * - Successfully created and verified stock backup in user-local storage.
 * - Complete pre-mutation revalidation immediately before mutation, including lock ownership
 *   and intermediate directory symlink checks (src and src/endpoints).
 * - Worktree-only mutation with git apply.
 * - Post-application patched SHA-256 verification and unchanged target index identity.
 * - Fail closed on error; report observed fingerprints and require human inspection without auto rollback.
 * - Lock cleanup failure fails closed and never produces exit code 0 or successful verdict.
 *
 * @param {object} options
 * @param {string} [options.targetDir] - SillyTavern repository path
 * @param {string} [options.backupDir] - Optional explicit backup directory override
 * @param {string} [options.lockDir] - Optional explicit operation lock directory override
 * @param {object} [options._testOverrides] - Test-only dependency injection
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'applied' | 'already-applied' | 'refused' | 'lock-refused' | 'lock-cleanup-failed' | 'verification-failed' | 'error',
 *   exitCode: number,
 *   reason: string,
 *   targetDir?: string,
 *   repoRoot?: string,
 *   targetFile?: string,
 *   backup?: object|null,
 *   worktreeSha256?: string|null,
 *   expectedSha256?: string,
 *   mutationOutcome?: string,
 *   observedFingerprints?: {
 *     worktreeSha256: string|null,
 *     expectedSha256: string,
 *     stockSha256: string
 *   },
 *   humanInspectionRequired?: boolean,
 *   lockPath?: string,
 *   existingLock?: object|null,
 *   lockCleanupError?: string|null
 * }>}
 */
export async function applyPatchToInstallation(options = {}) {
  const gitOps = options._testOverrides?.gitOps || defaultGitOps;
  const manifestPath = options._testOverrides?.manifestPath || BUNDLED_MANIFEST_PATH;
  const rawTargetDir = options.targetDir;

  // 1. Resolve target directory with strict precedence rules
  const targetResolution = resolveTargetDirectory({ explicitTarget: rawTargetDir });
  if (!targetResolution.ok || !targetResolution.targetDir) {
    return {
      ok: false,
      status: 'refused',
      exitCode: 2,
      reason: targetResolution.error || 'Target SillyTavern directory is required',
    };
  }
  const resolvedTargetDir = targetResolution.targetDir;

  // 2. Validate Git repo root and SillyTavern authenticity
  let repoRoot;
  try {
    const rootRes = gitOps.getGitRepoRoot(resolvedTargetDir);
    if (!rootRes.ok || !rootRes.root) {
      return {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: rootRes.error || 'Target directory is not a Git repository',
      };
    }
    repoRoot = fs.realpathSync(rootRes.root);
    if (resolvedTargetDir !== repoRoot) {
      return {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target directory must be the root of the SillyTavern Git repository',
      };
    }

    const hasPkgJson = fs.existsSync(path.join(repoRoot, 'package.json'));
    const hasServerJs =
      fs.existsSync(path.join(repoRoot, 'server.js')) ||
      fs.existsSync(path.join(repoRoot, 'src/server-main.js'));
    if (!hasPkgJson || !hasServerJs) {
      return {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target directory does not appear to be an authentic SillyTavern installation',
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'refused',
      exitCode: 1,
      reason: `Failed to validate SillyTavern installation: ${err.message}`,
    };
  }

  // 3. Resolve user-local storage directory
  const storageRes = resolveStorageDirectory({
    repoRoot,
    backupOverride: options.backupDir,
    lockOverride: options.lockDir || options._testOverrides?.lockDir || null,
  });
  if (!storageRes.ok) {
    return {
      ok: false,
      status: 'refused',
      exitCode: 1,
      reason: storageRes.error || 'Failed to initialize safe backup storage directory',
    };
  }

  // 4. Acquire exclusive operation lock for this repository
  const lockRes = acquireProcessLock(repoRoot, {
    lockDir: storageRes.locksDir,
    operation: 'apply',
  });
  if (!lockRes.ok) {
    return {
      ok: false,
      status: 'lock-refused',
      exitCode: 1,
      reason: lockRes.error || 'Exclusive operation lock could not be acquired',
      lockPath: lockRes.lockPath,
      existingLock: lockRes.existingLock || null,
    };
  }
  const lockHandle = lockRes;

  let backupRecord = null;
  let mutationStarted = false;
  let operationResult = null;
  let caughtException = null;

  let targetFilePath = null;
  let targetRelFile = 'src/endpoints/stable-diffusion.js';
  let stockSha256 = '';
  let expectedPatchedSha = '';

  try {
    // 5. Verify patch package manifest
    const pkgResult = await verifyPatchManifest(manifestPath);
    if (!pkgResult.ok) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Patch package verification failed: ${pkgResult.errors.join('; ')}`,
      };
      return finalizeOperation(operationResult);
    }
    const manifest = pkgResult.manifest;
    const certifiedReleaseCommit = manifest.releaseCommit.toLowerCase();
    const runtimePatchRel = manifest.patches.runtime.patchFile;
    const runtimePatchPath = path.resolve(path.dirname(manifestPath), runtimePatchRel);
    if (!fs.existsSync(runtimePatchPath)) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Runtime patch file is missing: "${runtimePatchPath}"`,
      };
      return finalizeOperation(operationResult);
    }

    targetRelFile = manifest.patches.runtime.targetFile;
    targetFilePath = path.resolve(repoRoot, targetRelFile);
    stockSha256 = manifest.patches.runtime.original.sha256.toLowerCase();
    expectedPatchedSha = manifest.patches.runtime.expected.sha256.toLowerCase();
    const stockBlobSha = manifest.patches.runtime.original.gitBlobSha.toLowerCase();

    // 6. Confinement and initial symlink safety checks
    if (!targetFilePath.startsWith(repoRoot + path.sep)) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target file path escapes repository root',
      };
      return finalizeOperation(operationResult);
    }

    const srcDir = path.resolve(repoRoot, 'src');
    const srcEndpointsDir = path.resolve(repoRoot, 'src/endpoints');
    try {
      if (fs.existsSync(srcDir) && fs.lstatSync(srcDir).isSymbolicLink()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Target file parent directory (src) is a symbolic link',
        };
        return finalizeOperation(operationResult);
      }
      if (fs.existsSync(srcEndpointsDir) && fs.lstatSync(srcEndpointsDir).isSymbolicLink()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Target file parent directory (src/endpoints) is a symbolic link',
        };
        return finalizeOperation(operationResult);
      }
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Failed to inspect parent directory: ${err.message}`,
      };
      return finalizeOperation(operationResult);
    }

    // 7. Check target file existence and type
    if (!fs.existsSync(targetFilePath)) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} does not exist`,
      };
      return finalizeOperation(operationResult);
    }
    const tStat = fs.lstatSync(targetFilePath);
    if (tStat.isSymbolicLink()) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} is a symbolic link, which is not permitted`,
      };
      return finalizeOperation(operationResult);
    }
    if (!tStat.isFile()) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} is not a regular file`,
      };
      return finalizeOperation(operationResult);
    }

    // 8. Legacy transaction state check
    const txState = inspectTransactionState(repoRoot);
    if (txState && txState.isPending) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Operation refused: legacy installer transaction is pending or ambiguous (${txState.state}): ${txState.reasons.join('; ')}`,
      };
      return finalizeOperation(operationResult);
    }

    // 9. Exact certified SillyTavern HEAD check
    const headRes = gitOps.getHeadCommit(repoRoot);
    if (!headRes.ok || !headRes.commit) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Failed to determine HEAD commit: ${headRes.error}`,
      };
      return finalizeOperation(operationResult);
    }
    const observedHeadCommit = headRes.commit.toLowerCase();
    if (observedHeadCommit !== certifiedReleaseCommit) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `HEAD commit (${observedHeadCommit}) does not match certified release ${certifiedReleaseCommit}`,
      };
      return finalizeOperation(operationResult);
    }

    // 10. Git index checks: mode 100644, stage 0, stock blob, no staged changes
    const indexRes = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (!indexRes.ok || !indexRes.exists) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} is not tracked in the Git index`,
      };
      return finalizeOperation(operationResult);
    }
    if (indexRes.mode !== '100644') {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file has unexpected index mode: ${indexRes.mode} (expected 100644)`,
      };
      return finalizeOperation(operationResult);
    }
    if (indexRes.stage !== 0) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file has active merge conflicts (index stage ${indexRes.stage})`,
      };
      return finalizeOperation(operationResult);
    }
    if ((indexRes.blobSha || '').toLowerCase() !== stockBlobSha) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file Git index blob (${indexRes.blobSha}) does not match stock release blob (${stockBlobSha})`,
      };
      return finalizeOperation(operationResult);
    }

    const stagedRes = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (!stagedRes.ok || stagedRes.hasStagedChanges) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target file has staged changes in the Git index',
      };
      return finalizeOperation(operationResult);
    }

    // 11. Worktree fingerprint check
    const currentBytes = fs.readFileSync(targetFilePath);
    const currentSha = computeSha256(currentBytes).toLowerCase();

    // Already-applied detection
    if (currentSha === expectedPatchedSha) {
      operationResult = {
        ok: true,
        status: 'already-applied',
        exitCode: 3,
        reason: 'Hardened proxy patch is already present in working tree with expected fingerprint; patch application is already satisfied.',
        targetDir: resolvedTargetDir,
        repoRoot,
        targetFile: targetRelFile,
        worktreeSha256: currentSha,
        expectedSha256: expectedPatchedSha,
      };
      return finalizeOperation(operationResult);
    }

    // Must match stock original
    if (currentSha !== stockSha256) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file in working tree has unrecognized content SHA-256 (${currentSha}); expected stock original (${stockSha256})`,
      };
      return finalizeOperation(operationResult);
    }

    // 12. Patch applicability dry-run
    const dryRun = gitOps.testPatchApplicability(repoRoot, runtimePatchPath);
    if (!dryRun.ok) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Patch applicability dry-run failed: ${dryRun.error}`,
      };
      return finalizeOperation(operationResult);
    }

    // 13. Create & verify pre-mutation backup
    try {
      backupRecord = createPreMutationBackup({
        repoRoot,
        targetFilePath,
        expectedSha256: stockSha256,
        operation: 'apply',
        backupDir: storageRes.backupsDir,
        targetMode: '0644',
        _testHooks: options._testOverrides?.backupHooks,
      });
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Failed to create pre-mutation backup: ${err.message}`,
        backup: err.backupFilePath ? {
          backupFilePath: err.backupFilePath,
          metaFilePath: err.metaFilePath || null,
        } : null,
      };
      return finalizeOperation(operationResult);
    }

    // 14. Synchronous pre-mutation TOCTOU revalidation gate
    if (typeof options._testOverrides?.preMutationHook === 'function') {
      await options._testOverrides.preMutationHook({
        repoRoot,
        targetFilePath,
        srcDir,
        srcEndpointsDir,
        lockHandle,
      });
    }

    const recheckHead = gitOps.getHeadCommit(repoRoot);
    if (!recheckHead.ok || recheckHead.commit.toLowerCase() !== certifiedReleaseCommit) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: repository HEAD changed between preflight and mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckIndex = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (
      !recheckIndex.ok ||
      recheckIndex.mode !== '100644' ||
      recheckIndex.stage !== 0 ||
      (recheckIndex.blobSha || '').toLowerCase() !== stockBlobSha
    ) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: Git index changed between preflight and mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckStaged = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (!recheckStaged.ok || recheckStaged.hasStagedChanges) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: staged changes detected on target file before mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // Complete intermediate directory revalidation (src and src/endpoints)
    try {
      const recheckSrc = fs.lstatSync(srcDir);
      if (recheckSrc.isSymbolicLink() || !recheckSrc.isDirectory()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Pre-mutation revalidation failed: parent directory (src) was replaced with a symbolic link or non-directory',
          backup: backupRecord,
        };
        return finalizeOperation(operationResult);
      }
      const recheckEndpoints = fs.lstatSync(srcEndpointsDir);
      if (recheckEndpoints.isSymbolicLink() || !recheckEndpoints.isDirectory()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Pre-mutation revalidation failed: parent directory (src/endpoints) was replaced with a symbolic link or non-directory',
          backup: backupRecord,
        };
        return finalizeOperation(operationResult);
      }
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Pre-mutation revalidation failed: could not inspect parent directories: ${err.message}`,
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // Target file revalidation
    const recheckStat = fs.lstatSync(targetFilePath);
    if (recheckStat.isSymbolicLink() || !recheckStat.isFile()) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: target file is no longer a regular file or was replaced with a symbolic link',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // Recheck containment of resolved target path
    const realTargetAfterRecheck = fs.realpathSync(targetFilePath);
    if (
      realTargetAfterRecheck === repoRoot ||
      !realTargetAfterRecheck.startsWith(repoRoot + path.sep)
    ) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: target file path resolves outside the repository root',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckBytes = fs.readFileSync(targetFilePath);
    const recheckSha = computeSha256(recheckBytes).toLowerCase();
    if (recheckSha !== stockSha256) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Pre-mutation revalidation failed: target file content changed between preflight and mutation (SHA-256: ${recheckSha})`,
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckTx = inspectTransactionState(repoRoot);
    if (recheckTx && recheckTx.isPending) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: pending legacy transaction detected before mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const lockOwnership = verifyLockOwnership(lockHandle);
    if (!lockOwnership.ok) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Pre-mutation revalidation failed: lock ownership check failed (${lockOwnership.error})`,
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // 15. Apply patch to working tree only (mutation begins here)
    mutationStarted = true;
    const applyRes = gitOps.applyPatchWorktree(repoRoot, runtimePatchPath);

    if (typeof options._testOverrides?.postMutationHook === 'function') {
      await options._testOverrides.postMutationHook({
        repoRoot,
        targetFilePath,
        lockHandle,
      });
    }

    if (!applyRes.ok) {
      let observedPostSha = null;
      try {
        observedPostSha = computeSha256(fs.readFileSync(targetFilePath)).toLowerCase();
      } catch {
        // ignore
      }
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: `git apply failed during mutation: ${applyRes.error}`,
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: observedPostSha,
          expectedSha256: expectedPatchedSha,
          stockSha256,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    // 16. Post-application verification
    let postBytes;
    try {
      postBytes = fs.readFileSync(targetFilePath);
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: `Failed to read target file after patch application: ${err.message}`,
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: null,
          expectedSha256: expectedPatchedSha,
          stockSha256,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    const postSha = computeSha256(postBytes).toLowerCase();
    if (postSha !== expectedPatchedSha) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: `Post-application verification failed: target file SHA-256 (${postSha}) does not match expected patched SHA-256 (${expectedPatchedSha})`,
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: expectedPatchedSha,
          stockSha256,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    // Confirm that the Git index remains completely clean and unshifted
    const postIndexRes = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (
      !postIndexRes.ok ||
      (postIndexRes.blobSha || '').toLowerCase() !== stockBlobSha ||
      postIndexRes.mode !== '100644' ||
      postIndexRes.stage !== 0
    ) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: 'Post-application verification failed: Git index was modified or shifted during patch application',
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: expectedPatchedSha,
          stockSha256,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    const postStagedRes = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (!postStagedRes.ok || postStagedRes.hasStagedChanges) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: 'Post-application verification failed: Git index contains staged changes after patch application',
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: expectedPatchedSha,
          stockSha256,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    operationResult = {
      ok: true,
      status: 'applied',
      exitCode: 0,
      reason: 'Runtime patch applied and verified successfully in working tree; Git index remains unshifted.',
      targetDir: resolvedTargetDir,
      repoRoot,
      targetFile: targetRelFile,
      backup: backupRecord,
      worktreeSha256: postSha,
      expectedSha256: expectedPatchedSha,
    };
    return finalizeOperation(operationResult);
  } catch (err) {
    caughtException = err;
    return finalizeOperation(null);
  }

  // 17. Finalization and lock-release fail-closed gate
  function finalizeOperation(opResult) {
    let lockReleaseError = null;
    if (lockHandle) {
      const releaseRes = releaseProcessLock(lockHandle);
      if (!releaseRes.ok) {
        lockReleaseError = releaseRes.error;
      }
    }

    // Handle unexpected exceptions caught during execution
    if (caughtException) {
      if (!mutationStarted) {
        return {
          ok: false,
          status: 'error',
          exitCode: 1,
          reason: `Unexpected pre-mutation failure: ${caughtException.message}`,
          backup: backupRecord,
          humanInspectionRequired: false,
          lockCleanupError: lockReleaseError || null,
        };
      } else {
        let observedSha = null;
        try {
          if (targetFilePath && fs.existsSync(targetFilePath)) {
            observedSha = computeSha256(fs.readFileSync(targetFilePath)).toLowerCase();
          }
        } catch {
          // ignore
        }
        return {
          ok: false,
          status: 'verification-failed',
          exitCode: 1,
          reason: `Unexpected failure during/after mutation: ${caughtException.message}`,
          backup: backupRecord,
          observedFingerprints: {
            worktreeSha256: observedSha,
            expectedSha256: expectedPatchedSha,
            stockSha256,
          },
          humanInspectionRequired: true,
          lockCleanupError: lockReleaseError || null,
        };
      }
    }

    // Lock-release failure must fail closed: never return exit code 0 or successful verdict
    if (lockReleaseError) {
      return {
        ok: false,
        status: 'lock-cleanup-failed',
        exitCode: 1,
        reason: `Operation finished (${opResult?.status || 'unknown'}), but lock release failed: ${lockReleaseError}`,
        mutationOutcome: opResult?.status || 'unknown',
        targetDir: opResult?.targetDir || resolvedTargetDir,
        repoRoot: opResult?.repoRoot || repoRoot,
        targetFile: opResult?.targetFile || targetRelFile,
        backup: backupRecord || opResult?.backup || null,
        worktreeSha256: opResult?.worktreeSha256 || null,
        expectedSha256: opResult?.expectedSha256,
        lockPath: lockHandle?.lockPath || null,
        humanInspectionRequired: true,
      };
    }

    return opResult;
  }
}

/**
 * Internal orchestrator to safely remove (reverse) the runtime patch from a SillyTavern installation.
 *
 * Requirements:
 * - Verified manifest and runtime patch.
 * - Exact certified SillyTavern HEAD (06bde939fb1e9c4c8d8641d810f0a916b5bce127).
 * - Target working-tree SHA-256 equal to certified patched fingerprint (16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6).
 * - Git index containing certified stock blob (077c2f961b528afa10376a7cc20a62132cf9fcd8), stage 0, mode 100644.
 * - No staged changes or merge conflicts affecting the target.
 * - Safe target path and intermediate directories; no pending legacy .ci-patch transaction.
 * - If already matching stock fingerprint, return already-removed, exit code 3, without mutation or backup creation.
 * - Successful reverse dry-run: git apply --reverse --check.
 * - Successfully created and verified pre-removal patched backup in user-local storage (operation: 'remove').
 * - Complete pre-mutation revalidation immediately before mutation, including lock ownership,
 *   patched content SHA-256, intermediate directory symlink checks, and index status.
 * - Worktree-only mutation with git apply --reverse.
 * - Post-removal stock SHA-256 verification, unchanged HEAD, and unchanged target index identity.
 * - Fail closed on error; report observed fingerprints and require human inspection without auto rollback.
 * - Lock cleanup failure fails closed and never produces exit code 0 or successful verdict.
 *
 * @param {object} options
 * @param {string} [options.targetDir] - SillyTavern repository path
 * @param {string} [options.backupDir] - Optional explicit backup directory override
 * @param {string} [options.lockDir] - Optional explicit operation lock directory override
 * @param {object} [options._testOverrides] - Test-only dependency injection
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'removed' | 'already-removed' | 'refused' | 'lock-refused' | 'lock-cleanup-failed' | 'verification-failed' | 'error',
 *   exitCode: number,
 *   reason: string,
 *   targetDir?: string,
 *   repoRoot?: string,
 *   targetFile?: string,
 *   backup?: object|null,
 *   worktreeSha256?: string|null,
 *   expectedSha256?: string,
 *   mutationOutcome?: string,
 *   observedFingerprints?: {
 *     worktreeSha256: string|null,
 *     expectedSha256: string,
 *     stockSha256: string,
 *     patchedSha256: string
 *   },
 *   humanInspectionRequired?: boolean,
 *   lockPath?: string,
 *   existingLock?: object|null,
 *   lockCleanupError?: string|null
 * }>}
 */
export async function removePatchFromInstallation(options = {}) {
  const gitOps = options._testOverrides?.gitOps || defaultGitOps;
  const manifestPath = options._testOverrides?.manifestPath || BUNDLED_MANIFEST_PATH;
  const rawTargetDir = options.targetDir;

  // 1. Resolve target directory with strict precedence rules
  const targetResolution = resolveTargetDirectory({ explicitTarget: rawTargetDir });
  if (!targetResolution.ok || !targetResolution.targetDir) {
    return {
      ok: false,
      status: 'refused',
      exitCode: 2,
      reason: targetResolution.error || 'Target SillyTavern directory is required',
    };
  }
  const resolvedTargetDir = targetResolution.targetDir;

  // 2. Validate Git repo root and SillyTavern authenticity
  let repoRoot;
  try {
    const rootRes = gitOps.getGitRepoRoot(resolvedTargetDir);
    if (!rootRes.ok || !rootRes.root) {
      return {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: rootRes.error || 'Target directory is not a Git repository',
      };
    }
    repoRoot = fs.realpathSync(rootRes.root);
    if (resolvedTargetDir !== repoRoot) {
      return {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target directory must be the root of the SillyTavern Git repository',
      };
    }

    const hasPkgJson = fs.existsSync(path.join(repoRoot, 'package.json'));
    const hasServerJs =
      fs.existsSync(path.join(repoRoot, 'server.js')) ||
      fs.existsSync(path.join(repoRoot, 'src/server-main.js'));
    if (!hasPkgJson || !hasServerJs) {
      return {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target directory does not appear to be an authentic SillyTavern installation',
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 'refused',
      exitCode: 1,
      reason: `Failed to validate SillyTavern installation: ${err.message}`,
    };
  }

  // 3. Resolve user-local storage directory
  const storageRes = resolveStorageDirectory({
    repoRoot,
    backupOverride: options.backupDir,
    lockOverride: options.lockDir || options._testOverrides?.lockDir || null,
  });
  if (!storageRes.ok) {
    return {
      ok: false,
      status: 'refused',
      exitCode: 1,
      reason: storageRes.error || 'Failed to initialize safe backup storage directory',
    };
  }

  // 4. Acquire exclusive operation lock for this repository
  const lockRes = acquireProcessLock(repoRoot, {
    lockDir: storageRes.locksDir,
    operation: 'remove',
  });
  if (!lockRes.ok) {
    return {
      ok: false,
      status: 'lock-refused',
      exitCode: 1,
      reason: lockRes.error || 'Exclusive operation lock could not be acquired',
      lockPath: lockRes.lockPath,
      existingLock: lockRes.existingLock || null,
    };
  }
  const lockHandle = lockRes;

  let backupRecord = null;
  let mutationStarted = false;
  let operationResult = null;
  let caughtException = null;

  let targetFilePath = null;
  let targetRelFile = 'src/endpoints/stable-diffusion.js';
  let stockSha256 = '';
  let expectedPatchedSha = '';

  try {
    // 5. Verify patch package manifest
    const pkgResult = await verifyPatchManifest(manifestPath);
    if (!pkgResult.ok) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Patch package verification failed: ${pkgResult.errors.join('; ')}`,
      };
      return finalizeOperation(operationResult);
    }
    const manifest = pkgResult.manifest;
    const certifiedReleaseCommit = manifest.releaseCommit.toLowerCase();
    const runtimePatchRel = manifest.patches.runtime.patchFile;
    const runtimePatchPath = path.resolve(path.dirname(manifestPath), runtimePatchRel);
    if (!fs.existsSync(runtimePatchPath)) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Runtime patch file is missing: "${runtimePatchPath}"`,
      };
      return finalizeOperation(operationResult);
    }

    targetRelFile = manifest.patches.runtime.targetFile;
    targetFilePath = path.resolve(repoRoot, targetRelFile);
    stockSha256 = manifest.patches.runtime.original.sha256.toLowerCase();
    expectedPatchedSha = manifest.patches.runtime.expected.sha256.toLowerCase();
    const stockBlobSha = manifest.patches.runtime.original.gitBlobSha.toLowerCase();

    // 6. Confinement and initial symlink safety checks
    if (!targetFilePath.startsWith(repoRoot + path.sep)) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target file path escapes repository root',
      };
      return finalizeOperation(operationResult);
    }

    const srcDir = path.resolve(repoRoot, 'src');
    const srcEndpointsDir = path.resolve(repoRoot, 'src/endpoints');
    try {
      if (fs.existsSync(srcDir) && fs.lstatSync(srcDir).isSymbolicLink()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Target file parent directory (src) is a symbolic link',
        };
        return finalizeOperation(operationResult);
      }
      if (fs.existsSync(srcEndpointsDir) && fs.lstatSync(srcEndpointsDir).isSymbolicLink()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Target file parent directory (src/endpoints) is a symbolic link',
        };
        return finalizeOperation(operationResult);
      }
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Failed to inspect parent directory: ${err.message}`,
      };
      return finalizeOperation(operationResult);
    }

    // 7. Check target file existence and type
    if (!fs.existsSync(targetFilePath)) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} does not exist`,
      };
      return finalizeOperation(operationResult);
    }
    const tStat = fs.lstatSync(targetFilePath);
    if (tStat.isSymbolicLink()) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} is a symbolic link, which is not permitted`,
      };
      return finalizeOperation(operationResult);
    }
    if (!tStat.isFile()) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} is not a regular file`,
      };
      return finalizeOperation(operationResult);
    }

    // 8. Legacy transaction state check
    const txState = inspectTransactionState(repoRoot);
    if (txState && txState.isPending) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Operation refused: legacy installer transaction is pending or ambiguous (${txState.state}): ${txState.reasons.join('; ')}`,
      };
      return finalizeOperation(operationResult);
    }

    // 9. Exact certified SillyTavern HEAD check
    const headRes = gitOps.getHeadCommit(repoRoot);
    if (!headRes.ok || !headRes.commit) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Failed to determine HEAD commit: ${headRes.error}`,
      };
      return finalizeOperation(operationResult);
    }
    const observedHeadCommit = headRes.commit.toLowerCase();
    if (observedHeadCommit !== certifiedReleaseCommit) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `HEAD commit (${observedHeadCommit}) does not match certified release ${certifiedReleaseCommit}`,
      };
      return finalizeOperation(operationResult);
    }

    // 10. Git index checks: mode 100644, stage 0, stock blob, no staged changes
    const indexRes = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (!indexRes.ok || !indexRes.exists) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file ${targetRelFile} is not tracked in the Git index`,
      };
      return finalizeOperation(operationResult);
    }
    if (indexRes.mode !== '100644') {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file has unexpected index mode: ${indexRes.mode} (expected 100644)`,
      };
      return finalizeOperation(operationResult);
    }
    if (indexRes.stage !== 0) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file has active merge conflicts (index stage ${indexRes.stage})`,
      };
      return finalizeOperation(operationResult);
    }
    if ((indexRes.blobSha || '').toLowerCase() !== stockBlobSha) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file Git index blob (${indexRes.blobSha}) does not match stock release blob (${stockBlobSha})`,
      };
      return finalizeOperation(operationResult);
    }

    const stagedRes = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (!stagedRes.ok || stagedRes.hasStagedChanges) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Target file has staged changes in the Git index',
      };
      return finalizeOperation(operationResult);
    }

    // 11. Worktree fingerprint check
    const currentBytes = fs.readFileSync(targetFilePath);
    const currentSha = computeSha256(currentBytes).toLowerCase();

    // Already-removed detection: target already matches stock
    if (currentSha === stockSha256) {
      operationResult = {
        ok: true,
        status: 'already-removed',
        exitCode: 3,
        reason: 'Target file in working tree already matches certified stock endpoint; patch removal is already satisfied.',
        targetDir: resolvedTargetDir,
        repoRoot,
        targetFile: targetRelFile,
        worktreeSha256: currentSha,
        expectedSha256: stockSha256,
      };
      return finalizeOperation(operationResult);
    }

    // Must match patched fingerprint to proceed with removal
    if (currentSha !== expectedPatchedSha) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Target file in working tree has unrecognized content SHA-256 (${currentSha}); expected patched endpoint (${expectedPatchedSha})`,
      };
      return finalizeOperation(operationResult);
    }

    // 12. Reverse patch applicability dry-run: git apply --reverse --check
    const dryRun = gitOps.testPatchApplicability(repoRoot, runtimePatchPath, { reverse: true });
    if (!dryRun.ok) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Reverse patch applicability dry-run failed: ${dryRun.error}`,
      };
      return finalizeOperation(operationResult);
    }

    // 13. Create & verify pre-mutation backup of the patched endpoint (operation: 'remove')
    try {
      backupRecord = createPreMutationBackup({
        repoRoot,
        targetFilePath,
        expectedSha256: expectedPatchedSha,
        operation: 'remove',
        backupDir: storageRes.backupsDir,
        targetMode: '0644',
        _testHooks: options._testOverrides?.backupHooks,
      });
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Failed to create pre-mutation backup: ${err.message}`,
        backup: err.backupFilePath ? {
          backupFilePath: err.backupFilePath,
          metaFilePath: err.metaFilePath || null,
        } : null,
      };
      return finalizeOperation(operationResult);
    }

    // 14. Synchronous pre-mutation TOCTOU revalidation gate
    if (typeof options._testOverrides?.preMutationHook === 'function') {
      await options._testOverrides.preMutationHook({
        repoRoot,
        targetFilePath,
        srcDir,
        srcEndpointsDir,
        lockHandle,
      });
    }

    const recheckHead = gitOps.getHeadCommit(repoRoot);
    if (!recheckHead.ok || recheckHead.commit.toLowerCase() !== certifiedReleaseCommit) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: repository HEAD changed between preflight and mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckIndex = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (
      !recheckIndex.ok ||
      recheckIndex.mode !== '100644' ||
      recheckIndex.stage !== 0 ||
      (recheckIndex.blobSha || '').toLowerCase() !== stockBlobSha
    ) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: Git index changed between preflight and mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckStaged = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (!recheckStaged.ok || recheckStaged.hasStagedChanges) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: staged changes detected on target file before mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // Intermediate directory revalidation
    try {
      const recheckSrc = fs.lstatSync(srcDir);
      if (recheckSrc.isSymbolicLink() || !recheckSrc.isDirectory()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Pre-mutation revalidation failed: parent directory (src) was replaced with a symbolic link or non-directory',
          backup: backupRecord,
        };
        return finalizeOperation(operationResult);
      }
      const recheckEndpoints = fs.lstatSync(srcEndpointsDir);
      if (recheckEndpoints.isSymbolicLink() || !recheckEndpoints.isDirectory()) {
        operationResult = {
          ok: false,
          status: 'refused',
          exitCode: 1,
          reason: 'Pre-mutation revalidation failed: parent directory (src/endpoints) was replaced with a symbolic link or non-directory',
          backup: backupRecord,
        };
        return finalizeOperation(operationResult);
      }
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Pre-mutation revalidation failed: could not inspect parent directories: ${err.message}`,
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // Target file revalidation
    const recheckStat = fs.lstatSync(targetFilePath);
    if (recheckStat.isSymbolicLink() || !recheckStat.isFile()) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: target file is no longer a regular file or was replaced with a symbolic link',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const realTargetAfterRecheck = fs.realpathSync(targetFilePath);
    if (
      realTargetAfterRecheck === repoRoot ||
      !realTargetAfterRecheck.startsWith(repoRoot + path.sep)
    ) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: target file path resolves outside the repository root',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckBytes = fs.readFileSync(targetFilePath);
    const recheckSha = computeSha256(recheckBytes).toLowerCase();
    if (recheckSha !== expectedPatchedSha) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Pre-mutation revalidation failed: target file content changed between preflight and mutation (SHA-256: ${recheckSha})`,
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const recheckTx = inspectTransactionState(repoRoot);
    if (recheckTx && recheckTx.isPending) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: 'Pre-mutation revalidation failed: pending legacy transaction detected before mutation',
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    const lockOwnership = verifyLockOwnership(lockHandle);
    if (!lockOwnership.ok) {
      operationResult = {
        ok: false,
        status: 'refused',
        exitCode: 1,
        reason: `Pre-mutation revalidation failed: lock ownership check failed (${lockOwnership.error})`,
        backup: backupRecord,
      };
      return finalizeOperation(operationResult);
    }

    // 15. Apply patch in reverse to working tree only (mutation begins here)
    mutationStarted = true;
    const removeRes = gitOps.applyPatchWorktree(repoRoot, runtimePatchPath, { reverse: true });

    if (typeof options._testOverrides?.postMutationHook === 'function') {
      await options._testOverrides.postMutationHook({
        repoRoot,
        targetFilePath,
        lockHandle,
      });
    }

    if (!removeRes.ok) {
      let observedPostSha = null;
      try {
        observedPostSha = computeSha256(fs.readFileSync(targetFilePath)).toLowerCase();
      } catch {
        // ignore
      }
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: `git apply --reverse failed during mutation: ${removeRes.error}`,
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: observedPostSha,
          expectedSha256: stockSha256,
          stockSha256,
          patchedSha256: expectedPatchedSha,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    // 16. Post-removal verification
    let postBytes;
    try {
      postBytes = fs.readFileSync(targetFilePath);
    } catch (err) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: `Failed to read target file after reverse patch application: ${err.message}`,
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: null,
          expectedSha256: stockSha256,
          stockSha256,
          patchedSha256: expectedPatchedSha,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    const postSha = computeSha256(postBytes).toLowerCase();
    if (postSha !== stockSha256) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: `Post-removal verification failed: target file SHA-256 (${postSha}) does not match expected stock SHA-256 (${stockSha256})`,
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: stockSha256,
          stockSha256,
          patchedSha256: expectedPatchedSha,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    // Confirm Git index remains unshifted (matches stockBlobSha, mode 100644, stage 0)
    const postIndexRes = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (
      !postIndexRes.ok ||
      (postIndexRes.blobSha || '').toLowerCase() !== stockBlobSha ||
      postIndexRes.mode !== '100644' ||
      postIndexRes.stage !== 0
    ) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: 'Post-removal verification failed: Git index was modified or shifted during patch removal',
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: stockSha256,
          stockSha256,
          patchedSha256: expectedPatchedSha,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    const postStagedRes = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (!postStagedRes.ok || postStagedRes.hasStagedChanges) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: 'Post-removal verification failed: Git index contains staged changes after patch removal',
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: stockSha256,
          stockSha256,
          patchedSha256: expectedPatchedSha,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    // Confirm certified HEAD has not changed
    const postHeadRes = gitOps.getHeadCommit(repoRoot);
    if (!postHeadRes.ok || postHeadRes.commit.toLowerCase() !== certifiedReleaseCommit) {
      operationResult = {
        ok: false,
        status: 'verification-failed',
        exitCode: 1,
        reason: 'Post-removal verification failed: repository HEAD changed during patch removal',
        backup: backupRecord,
        observedFingerprints: {
          worktreeSha256: postSha,
          expectedSha256: stockSha256,
          stockSha256,
          patchedSha256: expectedPatchedSha,
        },
        humanInspectionRequired: true,
      };
      return finalizeOperation(operationResult);
    }

    operationResult = {
      ok: true,
      status: 'removed',
      exitCode: 0,
      reason: 'Runtime patch reversed and verified successfully in working tree; Git index remains unshifted.',
      targetDir: resolvedTargetDir,
      repoRoot,
      targetFile: targetRelFile,
      backup: backupRecord,
      worktreeSha256: postSha,
      expectedSha256: stockSha256,
    };
    return finalizeOperation(operationResult);
  } catch (err) {
    caughtException = err;
    return finalizeOperation(null);
  }

  // 17. Finalization and lock-release fail-closed gate
  function finalizeOperation(opResult) {
    let lockReleaseError = null;
    if (lockHandle) {
      const releaseRes = releaseProcessLock(lockHandle);
      if (!releaseRes.ok) {
        lockReleaseError = releaseRes.error;
      }
    }

    // Handle unexpected exceptions caught during execution
    if (caughtException) {
      if (!mutationStarted) {
        return {
          ok: false,
          status: 'error',
          exitCode: 1,
          reason: `Unexpected pre-mutation failure: ${caughtException.message}`,
          backup: backupRecord,
          humanInspectionRequired: false,
          lockCleanupError: lockReleaseError || null,
        };
      } else {
        let observedSha = null;
        try {
          if (targetFilePath && fs.existsSync(targetFilePath)) {
            observedSha = computeSha256(fs.readFileSync(targetFilePath)).toLowerCase();
          }
        } catch {
          // ignore
        }
        return {
          ok: false,
          status: 'verification-failed',
          exitCode: 1,
          reason: `Unexpected failure during/after mutation: ${caughtException.message}`,
          backup: backupRecord,
          observedFingerprints: {
            worktreeSha256: observedSha,
            expectedSha256: stockSha256,
            stockSha256,
            patchedSha256: expectedPatchedSha,
          },
          humanInspectionRequired: true,
          lockCleanupError: lockReleaseError || null,
        };
      }
    }

    // Lock-release failure must fail closed: never return exit code 0 or successful verdict
    if (lockReleaseError) {
      return {
        ok: false,
        status: 'lock-cleanup-failed',
        exitCode: 1,
        reason: `Operation finished (${opResult?.status || 'unknown'}), but lock release failed: ${lockReleaseError}`,
        mutationOutcome: opResult?.status || 'unknown',
        targetDir: opResult?.targetDir || resolvedTargetDir,
        repoRoot: opResult?.repoRoot || repoRoot,
        targetFile: opResult?.targetFile || targetRelFile,
        backup: backupRecord || opResult?.backup || null,
        worktreeSha256: opResult?.worktreeSha256 || null,
        expectedSha256: opResult?.expectedSha256,
        lockPath: lockHandle?.lockPath || null,
        humanInspectionRequired: true,
      };
    }

    return opResult;
  }
}

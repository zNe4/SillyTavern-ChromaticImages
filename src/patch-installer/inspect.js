import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as defaultGitOps from './git-ops.js';
import { verifyPatchManifest } from '../../scripts/verify-sillytavern-patches.mjs';
import { inspectTransactionState } from './transaction-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

/**
 * Compute SHA-256 lowercase hex digest.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Pure state classifier.
 * Evaluates observed environment and Git identity against authoritative manifest metadata.
 *
 * @param {object} observations
 * @param {object} manifest
 * @returns {{
 *   status: 'not-installed' | 'installed' | 'unsupported-revision' | 'modified-or-conflicting' | 'invalid-installation' | 'invalid-package',
 *   targetFileState: 'original' | 'installed' | 'unknown' | 'missing' | 'unsafe',
 *   isReleaseCommit: boolean,
 *   developerBranch: { branch: string, commit: string } | null,
 *   reasons: string[]
 * }}
 */
export function classifyTargetState(observations, manifest) {
  const reasons = [];

  // 1. Package verification check
  if (!observations || !observations.packageValid) {
    const pkgErrors = observations?.packageErrors?.length
      ? observations.packageErrors
      : ['Patch distribution package integrity verification failed'];
    return {
      status: 'invalid-package',
      targetFileState: 'unknown',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: pkgErrors,
    };
  }

  // 2. Directory and Git repository validity
  if (!observations.isDir) {
    return {
      status: 'invalid-installation',
      targetFileState: 'missing',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target path does not exist or is not a directory'],
    };
  }

  if (!observations.isGitRepo) {
    return {
      status: 'invalid-installation',
      targetFileState: 'missing',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target directory is not a Git repository'],
    };
  }

  if (!observations.isRepoRoot) {
    return {
      status: 'invalid-installation',
      targetFileState: 'missing',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target directory must be the root of the SillyTavern Git repository'],
    };
  }

  if (!observations.isSillyTavern) {
    return {
      status: 'invalid-installation',
      targetFileState: 'missing',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target directory does not appear to be an authentic SillyTavern installation'],
    };
  }

  if (observations.isIntermediateSymlink) {
    return {
      status: 'invalid-installation',
      targetFileState: 'unsafe',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target file parent directory contains a symbolic link'],
    };
  }

  if (observations.isTargetFileSymlink) {
    return {
      status: 'invalid-installation',
      targetFileState: 'unsafe',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target file is a symbolic link, which is not permitted'],
    };
  }

  if (
    observations.transaction?.state === 'unsafe-symlink' ||
    observations.transaction?.state === 'inspection-error'
  ) {
    return {
      status: 'invalid-installation',
      targetFileState: 'unsafe',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: observations.transaction.reasons.length > 0
        ? observations.transaction.reasons
        : [
            observations.transaction.state === 'unsafe-symlink'
              ? 'Installer directory (.ci-patch) contains a symbolic link'
              : 'Failed to safely inspect installer transaction state (.ci-patch)',
          ],
    };
  }

  if (!observations.targetFileExists) {
    return {
      status: 'invalid-installation',
      targetFileState: 'missing',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: [`Target file ${manifest.patches.runtime.targetFile} is missing`],
    };
  }

  if (!observations.isTargetFileRegular) {
    return {
      status: 'invalid-installation',
      targetFileState: 'unsafe',
      isReleaseCommit: false,
      developerBranch: null,
      reasons: ['Target file is not a regular file'],
    };
  }

  // Determine working-file fingerprint
  let targetFileState = 'unknown';
  const normOriginalSha = (manifest.patches.runtime.original.sha256 || '').toLowerCase();
  const normExpectedSha = (manifest.patches.runtime.expected.sha256 || '').toLowerCase();
  const observedSha = (observations.worktreeSha256 || '').toLowerCase();

  if (observedSha === normOriginalSha) {
    targetFileState = 'original';
  } else if (observedSha === normExpectedSha) {
    targetFileState = 'installed';
  }

  // Developer branch detection
  let detectedDeveloperBranch = null;
  const normSourceCommit = (manifest.sourceCommit || '').toLowerCase();
  if (Array.isArray(observations.developerBranches)) {
    for (const b of observations.developerBranches) {
      const bCommit = (b.commit || '').toLowerCase();
      const bName = b.branch || '';
      if (
        bCommit === normSourceCommit ||
        /^(m03-|d01-|.*nanogpt-proxy)/i.test(bName)
      ) {
        if (!detectedDeveloperBranch || bCommit === normSourceCommit) {
          detectedDeveloperBranch = { branch: bName, commit: bCommit };
        }
      }
    }
  }

  // 3. Pinned release revision check
  const normReleaseCommit = (manifest.releaseCommit || '').toLowerCase();
  const observedHead = (observations.headCommit || '').toLowerCase();
  const isReleaseCommit = Boolean(observedHead && observedHead === normReleaseCommit);

  if (!isReleaseCommit) {
    const devNote = detectedDeveloperBranch
      ? ` (detected developer branch "${detectedDeveloperBranch.branch}" at commit ${detectedDeveloperBranch.commit.slice(0, 9)})`
      : '';
    reasons.push(
      `HEAD commit (${observedHead || 'unknown'}) does not match certified release ${manifest.releaseCommit}${devNote}`
    );
    return {
      status: 'unsupported-revision',
      targetFileState,
      isReleaseCommit: false,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  // 4. On pinned release: Git index and modification inspection
  if (!observations.indexExists) {
    reasons.push('Target file is not tracked in the Git index');
    return {
      status: 'modified-or-conflicting',
      targetFileState,
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  if (observations.indexMode !== '100644') {
    reasons.push(
      `Target file has unexpected index mode: ${observations.indexMode} (expected 100644)`
    );
    return {
      status: 'invalid-installation',
      targetFileState: 'unsafe',
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  if (observations.indexStage !== 0) {
    reasons.push(
      `Target file has active merge conflicts (index stage ${observations.indexStage})`
    );
    return {
      status: 'modified-or-conflicting',
      targetFileState,
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  if (observations.hasStagedChanges) {
    reasons.push('Target file has staged changes in the Git index');
    return {
      status: 'modified-or-conflicting',
      targetFileState,
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  const normOriginalBlob = (manifest.patches.runtime.original.gitBlobSha || '').toLowerCase();
  const observedIndexBlob = (observations.indexBlobSha || '').toLowerCase();
  if (observedIndexBlob !== normOriginalBlob) {
    reasons.push(
      `Target file Git index blob (${observedIndexBlob}) does not match stock release blob (${normOriginalBlob})`
    );
    return {
      status: 'modified-or-conflicting',
      targetFileState,
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  // 5. Index is clean stock original. Evaluate working tree:
  if (targetFileState === 'original') {
    reasons.push(
      'Target file matches stock release original; runtime patch is not installed'
    );
    return {
      status: 'not-installed',
      targetFileState: 'original',
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  if (targetFileState === 'installed') {
    reasons.push(
      'Target file matches expected hardened proxy fingerprint in working tree; Git index remains unshifted'
    );
    return {
      status: 'installed',
      targetFileState: 'installed',
      isReleaseCommit: true,
      developerBranch: detectedDeveloperBranch,
      reasons,
    };
  }

  // Working file has unrecognized modifications
  reasons.push(
    `Target file in working tree has unrecognized content SHA-256 (${observedSha})`
  );
  return {
    status: 'modified-or-conflicting',
    targetFileState: 'unknown',
    isReleaseCommit: true,
    developerBranch: detectedDeveloperBranch,
    reasons,
  };
}

/**
 * Perform full read-only inspection of a target SillyTavern installation.
 * @param {object} options
 * @param {string} options.targetDir - Path to SillyTavern repository
 * @returns {Promise<{
 *   ok: boolean,
 *   status: string,
 *   targetDir: string,
 *   repoRoot: string|null,
 *   headCommit: string|null,
 *   headBranch: string|null,
 *   isReleaseCommit: boolean,
 *   targetFile: string,
 *   targetFilePath: string|null,
 *   targetFileState: string,
 *   worktreeSha256: string|null,
 *   indexBlobSha: string|null,
 *   indexMode: string|null,
 *   indexStage: number|null,
 *   hasTargetStagedChanges: boolean,
 *   unrelatedChangesCount: number,
 *   developerBranch: { branch: string, commit: string } | null,
 *   packageVerified: boolean,
 *   runtimePatchPath: string|null,
 *   reasons: string[],
 *   manifest: object|null
 * }>}
 */
export async function inspectTargetInstallation(options = {}) {
  const gitOps = defaultGitOps;
  const rawTargetDir = options.targetDir || '';

  // 1. Verify distribution package manifest exclusively from bundled package
  let manifest = null;
  let packageValid = false;
  const packageErrors = [];
  let runtimePatchPath = null;

  const pkgResult = await verifyPatchManifest(BUNDLED_MANIFEST_PATH);
  if (pkgResult.ok) {
    manifest = pkgResult.manifest;
    packageValid = true;
    runtimePatchPath = path.resolve(
      path.dirname(BUNDLED_MANIFEST_PATH),
      manifest.patches.runtime.patchFile
    );
  } else {
    packageValid = false;
    packageErrors.push(...pkgResult.errors);
    manifest = pkgResult.manifest;
  }

  const targetRelFile = manifest?.patches?.runtime?.targetFile || 'src/endpoints/stable-diffusion.js';

  // 2. Target directory validation
  let isDir = false;
  let targetDir = rawTargetDir;
  try {
    if (rawTargetDir && fs.existsSync(rawTargetDir)) {
      const stat = fs.statSync(rawTargetDir);
      isDir = stat.isDirectory();
      if (isDir) {
        targetDir = fs.realpathSync(rawTargetDir);
      }
    }
  } catch {
    isDir = false;
  }

  // 3. Git repo root resolution
  let isGitRepo = false;
  let isRepoRoot = false;
  let repoRoot = null;
  let isSillyTavern = false;

  if (isDir) {
    const rootRes = gitOps.getGitRepoRoot(targetDir);
    if (rootRes.ok && rootRes.root) {
      isGitRepo = true;
      try {
        const canonicalRepoRoot = fs.realpathSync(rootRes.root);
        repoRoot = canonicalRepoRoot;
        isRepoRoot = targetDir === canonicalRepoRoot;
      } catch {
        isRepoRoot = false;
      }

      if (isRepoRoot && repoRoot) {
        // Authenticity checks: package.json and server.js or src/server-main.js
        const hasPkgJson = fs.existsSync(path.join(repoRoot, 'package.json'));
        const hasServerJs =
          fs.existsSync(path.join(repoRoot, 'server.js')) ||
          fs.existsSync(path.join(repoRoot, 'src/server-main.js'));
        isSillyTavern = hasPkgJson && hasServerJs;
      }
    }
  }

  // 4. Target file filesystem inspection
  let targetFileExists = false;
  let isTargetFileRegular = false;
  let isTargetFileSymlink = false;
  let isIntermediateSymlink = false;
  let targetFilePath = null;
  let worktreeSha256 = null;

  if (isRepoRoot && repoRoot) {
    targetFilePath = path.resolve(repoRoot, targetRelFile);

    // Confinement check: target file must reside inside repoRoot
    if (targetFilePath.startsWith(repoRoot + path.sep)) {
      // Check intermediate directories
      const srcDir = path.resolve(repoRoot, 'src');
      const srcEndpointsDir = path.resolve(repoRoot, 'src/endpoints');
      try {
        if (fs.existsSync(srcDir) && fs.lstatSync(srcDir).isSymbolicLink()) {
          isIntermediateSymlink = true;
        }
        if (fs.existsSync(srcEndpointsDir) && fs.lstatSync(srcEndpointsDir).isSymbolicLink()) {
          isIntermediateSymlink = true;
        }
      } catch {
        // ignore
      }

      if (!isIntermediateSymlink) {
        try {
          if (fs.existsSync(targetFilePath)) {
            targetFileExists = true;
            const lstat = fs.lstatSync(targetFilePath);
            isTargetFileSymlink = lstat.isSymbolicLink();
            isTargetFileRegular = lstat.isFile() && !isTargetFileSymlink;

            if (isTargetFileRegular) {
              const buf = fs.readFileSync(targetFilePath);
              worktreeSha256 = computeSha256(buf);
            }
          }
        } catch {
          targetFileExists = false;
        }
      }
    } else {
      isIntermediateSymlink = true; // escaped root
    }
  }

  // 5. Git identity queries
  let headCommit = null;
  let headBranch = null;
  let indexExists = false;
  let indexMode = null;
  let indexBlobSha = null;
  let indexStage = null;
  let hasStagedChanges = false;
  let unrelatedChangesCount = 0;
  let developerBranches = [];

  if (isRepoRoot && repoRoot) {
    const headRes = gitOps.getHeadCommit(repoRoot);
    if (headRes.ok) headCommit = headRes.commit;

    const branchRes = gitOps.getHeadBranch(repoRoot);
    if (branchRes.ok) headBranch = branchRes.branch;

    const indexRes = gitOps.getFileIndexStage(repoRoot, targetRelFile);
    if (indexRes.ok) {
      indexExists = indexRes.exists;
      indexMode = indexRes.mode;
      indexBlobSha = indexRes.blobSha;
      indexStage = indexRes.stage;
    }

    const stagedRes = gitOps.checkTargetStagedModifications(repoRoot, targetRelFile);
    if (stagedRes.ok) {
      hasStagedChanges = stagedRes.hasStagedChanges;
    }

    const unrelatedRes = gitOps.getUnrelatedModifications(repoRoot, targetRelFile);
    if (unrelatedRes.ok) {
      unrelatedChangesCount = unrelatedRes.unrelatedCount;
    }

    const devBranchesRes = gitOps.listLocalDeveloperBranches(repoRoot);
    if (devBranchesRes.ok) {
      developerBranches = devBranchesRes.branches;
    }
  }

  // 6. Transaction state inspection
  let transaction = {
    state: 'none',
    hasLock: false,
    hasJournal: false,
    isPending: false,
    lock: null,
    journal: null,
    foreignEntries: [],
    reasons: [],
  };

  if (isRepoRoot && repoRoot) {
    transaction = inspectTransactionState(repoRoot);
  }

  const observations = {
    packageValid,
    packageErrors,
    isDir,
    isGitRepo,
    isRepoRoot,
    isSillyTavern,
    targetFileExists,
    isTargetFileRegular,
    isTargetFileSymlink,
    isIntermediateSymlink,
    headCommit,
    headBranch,
    indexExists,
    indexMode,
    indexBlobSha,
    indexStage,
    hasStagedChanges,
    worktreeSha256,
    unrelatedChangesCount,
    developerBranches,
    transaction,
  };

  const classification = classifyTargetState(observations, manifest || {});

  return {
    ok: classification.status !== 'invalid-installation' && classification.status !== 'invalid-package',
    status: classification.status,
    transaction,
    transactionBlocking: Boolean(transaction && transaction.isPending),
    targetDir,
    repoRoot,
    headCommit,
    headBranch,
    isReleaseCommit: classification.isReleaseCommit,
    targetFile: targetRelFile,
    targetFilePath,
    targetFileState: classification.targetFileState,
    worktreeSha256,
    indexBlobSha,
    indexMode,
    indexStage,
    hasTargetStagedChanges: hasStagedChanges,
    unrelatedChangesCount,
    developerBranch: classification.developerBranch,
    packageVerified: packageValid,
    runtimePatchPath,
    reasons: classification.reasons,
    manifest,
  };
}

/**
 * Resolve target SillyTavern directory according to strict precedence rules:
 * 1. Explicit target (if provided): must exist and be a directory; fails immediately if invalid without fallback.
 * 2. SILLYTAVERN_DIR environment variable (if set): must exist and be a directory; fails if invalid.
 * 3. Package-relative sibling directory (Parent/SillyTavern).
 *
 * @param {object} [options]
 * @param {string|null} [options.explicitTarget]
 * @param {string} [options.baseDir]
 * @param {string} [options.packageRoot]
 * @returns {{
 *   ok: boolean,
 *   targetDir: string|null,
 *   source: 'explicit' | 'env' | 'sibling' | 'none',
 *   error: string|null
 * }}
 */
export function resolveTargetDirectory(options = {}) {
  const explicitTarget = options.explicitTarget ?? null;
  const baseDir = options.baseDir || process.cwd();
  const pkgRoot = options.packageRoot || REPO_ROOT;

  // 1. Explicit target takes absolute precedence without fallback
  if (explicitTarget !== null && typeof explicitTarget === 'string') {
    if (explicitTarget.trim() === '') {
      return {
        ok: false,
        targetDir: null,
        source: 'explicit',
        error: 'Target directory cannot be empty or whitespace-only',
      };
    }
    const candidate = path.resolve(baseDir, explicitTarget.trim());
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return {
          ok: true,
          targetDir: fs.realpathSync(candidate),
          source: 'explicit',
          error: null,
        };
      }
    } catch {
      // fall through
    }
    return {
      ok: false,
      targetDir: null,
      source: 'explicit',
      error: `Explicitly specified target directory does not exist or is not a directory: "${explicitTarget}"`,
    };
  }

  // 2. SILLYTAVERN_DIR environment variable
  const envTarget = process.env.SILLYTAVERN_DIR;
  if (envTarget && typeof envTarget === 'string' && envTarget.trim() !== '') {
    const candidate = path.resolve(baseDir, envTarget.trim());
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return {
          ok: true,
          targetDir: candidate,
          source: 'env',
          error: null,
        };
      }
    } catch {
      // fall through
    }
    return {
      ok: false,
      targetDir: null,
      source: 'env',
      error: `Environment variable SILLYTAVERN_DIR points to non-existent or invalid directory: "${envTarget}"`,
    };
  }

  // 3. Package-relative sibling directory (Parent/SillyTavern)
  try {
    const siblingCandidate = path.resolve(pkgRoot, '../SillyTavern');
    if (fs.existsSync(siblingCandidate) && fs.statSync(siblingCandidate).isDirectory()) {
      return {
        ok: true,
        targetDir: siblingCandidate,
        source: 'sibling',
        error: null,
      };
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    targetDir: null,
    source: 'none',
    error: null,
  };
}

/**
 * Perform read-only preflight check for patch installation.
 * @param {object} options
 * @returns {Promise<{
 *   ok: boolean,
 *   verdict: 'can-apply' | 'already-applied' | 'refused',
 *   exitCode: number,
 *   canApply: boolean,
 *   alreadyApplied: boolean,
 *   reason: string,
 *   dryRunPassed: boolean|null,
 *   inspection: object
 * }>}
 */
export async function checkInstallationPreflight(options = {}) {
  const gitOps = defaultGitOps;
  const inspection = await inspectTargetInstallation(options);

  // If transaction metadata is pending or ambiguous: refuse immediately
  if (inspection.transaction && inspection.transaction.isPending) {
    const txState = inspection.transaction.state;
    const txReasonStr =
      inspection.transaction.reasons.length > 0
        ? inspection.transaction.reasons.join('; ')
        : `Transaction state is "${txState}"`;
    return {
      ok: false,
      verdict: 'refused',
      exitCode: 1,
      canApply: false,
      alreadyApplied: false,
      reason: `Operation refused: installer transaction is pending or ambiguous (${txState}): ${txReasonStr}`,
      dryRunPassed: null,
      inspection,
    };
  }

  // If already installed:
  if (inspection.status === 'installed') {
    return {
      ok: true,
      verdict: 'already-applied',
      exitCode: 3,
      canApply: false,
      alreadyApplied: true,
      reason: 'Hardened proxy patch is already present in working tree with expected fingerprint; patch application is already satisfied.',
      dryRunPassed: null,
      inspection,
    };
  }

  // If not installed: run patch dry-run
  if (inspection.status === 'not-installed') {
    if (!inspection.runtimePatchPath || !fs.existsSync(inspection.runtimePatchPath)) {
      return {
        ok: false,
        verdict: 'refused',
        exitCode: 1,
        canApply: false,
        alreadyApplied: false,
        reason: 'Runtime patch file is missing or not resolved',
        dryRunPassed: false,
        inspection,
      };
    }

    const dryRun = gitOps.testPatchApplicability(inspection.repoRoot, inspection.runtimePatchPath);
    if (dryRun.ok) {
      return {
        ok: true,
        verdict: 'can-apply',
        exitCode: 0,
        canApply: true,
        alreadyApplied: false,
        reason: 'Ready for installation: pinned release matches, target is stock original, and patch applies cleanly.',
        dryRunPassed: true,
        inspection,
      };
    }

    // Dry-run failed, but inspection.status remains truthfully 'not-installed'
    return {
      ok: false,
      verdict: 'refused',
      exitCode: 1,
      canApply: false,
      alreadyApplied: false,
      reason: `Patch applicability dry-run failed: ${dryRun.error}`,
      dryRunPassed: false,
      inspection,
    };
  }

  // All other states: refused without running patch dry-run
  return {
    ok: false,
    verdict: 'refused',
    exitCode: 1,
    canApply: false,
    alreadyApplied: false,
    reason: inspection.reasons.join('; ') || `Target is in state "${inspection.status}"`,
    dryRunPassed: null,
    inspection,
  };
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runGit,
  getGitObjectBytes,
  resolveGitRev,
  testPatchApplicability,
} from './git-ops.js';
import { verifyPatchManifest } from '../../scripts/verify-sillytavern-patches.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

export const BUNDLED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

export const OFFICIAL_UPSTREAM_REPO = 'SillyTavern/SillyTavern';
export const OFFICIAL_UPSTREAM_URL = 'https://github.com/SillyTavern/SillyTavern.git';
export const OFFICIAL_UPSTREAM_BRANCH = 'release';

/**
 * Compute SHA-256 lowercase hex digest.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeSha256(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute standard Git blob SHA-1 lowercase hex digest.
 * Format: "blob <size>\0<bytes>"
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeGitBlobSha(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto
    .createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

/**
 * Perform a strictly read-only compatibility check against upstream SillyTavern release.
 *
 * Classifications:
 * - 'certified': Exact manifest-certified release commit and expected source identity from official upstream.
 * - 'applies-unverified': Patch passes applicability check in isolated fixture, but revision is uncertified or test-injected.
 * - 'incompatible': Patch application is rejected or target requirements conflict.
 * - 'unknown': Network, Git, filesystem, timeout, or verification errors prevent a reliable conclusion.
 *
 * Exit codes:
 * - 0: certified
 * - 1: incompatible
 * - 2: manifest / package / usage error
 * - 3: applies-unverified
 * - 4: unknown
 *
 * @param {object} [options]
 * @param {string} [options.manifestPath]
 * @param {number} [options.timeoutMs=20000]
 * @param {string} [options.disposableBaseDir=os.tmpdir()]
 * @param {{ url: string, branch?: string }|null} [options._testUpstream] - Test-only fixture injection
 * @returns {Promise<{
 *   ok: boolean,
 *   classification: 'certified' | 'applies-unverified' | 'incompatible' | 'unknown',
 *   exitCode: number,
 *   isCertified: boolean,
 *   isTestOverride: boolean,
 *   upstreamSource: 'official' | 'test-fixture',
 *   upstreamUrl: string,
 *   upstreamBranch: string,
 *   fetchedCommit: string|null,
 *   isReleaseCommit: boolean,
 *   targetFile: string,
 *   targetBlobSha: string|null,
 *   targetSha256: string|null,
 *   dryRunPassed: boolean|null,
 *   reason: string,
 *   errors: string[],
 * }>}
 */
export async function checkReleaseCompatibility(options = {}) {
  const manifestPath = options.manifestPath || BUNDLED_MANIFEST_PATH;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 20000;
  const disposableBaseDir = options.disposableBaseDir || os.tmpdir();
  const testUpstream = options._testUpstream || null;
  const onBeforeCleanup = typeof options._onBeforeCleanup === 'function' ? options._onBeforeCleanup : null;
  const getUid = typeof options._getuid === 'function'
    ? options._getuid
    : (typeof process.getuid === 'function' ? () => process.getuid() : null);
  const rmSync = typeof options._rmSync === 'function' ? options._rmSync : fs.rmSync;

  // Validate testUpstream if provided
  if (testUpstream !== null && typeof testUpstream === 'object') {
    if (!testUpstream.url || typeof testUpstream.url !== 'string' || testUpstream.url.trim() === '') {
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 2,
        isCertified: false,
        isTestOverride: true,
        upstreamSource: 'test-fixture',
        upstreamUrl: String(testUpstream.url || ''),
        upstreamBranch: String(testUpstream.branch || OFFICIAL_UPSTREAM_BRANCH),
        fetchedCommit: null,
        isReleaseCommit: false,
        targetFile: 'src/endpoints/stable-diffusion.js',
        targetBlobSha: null,
        targetSha256: null,
        dryRunPassed: null,
        reason: 'Option --test-upstream-url cannot be empty or whitespace-only',
        errors: ['Option --test-upstream-url cannot be empty or whitespace-only'],
      };
    }

    const testUrl = testUpstream.url.trim();
    if (testUrl.startsWith('-') || /[\x00-\x1f\x7f]/.test(testUrl)) {
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 2,
        isCertified: false,
        isTestOverride: true,
        upstreamSource: 'test-fixture',
        upstreamUrl: testUrl,
        upstreamBranch: String(testUpstream.branch || OFFICIAL_UPSTREAM_BRANCH),
        fetchedCommit: null,
        isReleaseCommit: false,
        targetFile: 'src/endpoints/stable-diffusion.js',
        targetBlobSha: null,
        targetSha256: null,
        dryRunPassed: null,
        reason: `Invalid test-upstream URL: "${testUrl}" (option-like or contains control characters)`,
        errors: [`Invalid test-upstream URL: "${testUrl}"`],
      };
    }

    if (testUpstream.branch !== undefined && testUpstream.branch !== null) {
      if (typeof testUpstream.branch !== 'string' || testUpstream.branch.trim() === '') {
        return {
          ok: false,
          classification: 'unknown',
          exitCode: 2,
          isCertified: false,
          isTestOverride: true,
          upstreamSource: 'test-fixture',
          upstreamUrl: testUrl,
          upstreamBranch: String(testUpstream.branch ?? ''),
          fetchedCommit: null,
          isReleaseCommit: false,
          targetFile: 'src/endpoints/stable-diffusion.js',
          targetBlobSha: null,
          targetSha256: null,
          dryRunPassed: null,
          reason: 'Option --test-upstream-branch cannot be empty or whitespace-only',
          errors: ['Option --test-upstream-branch cannot be empty or whitespace-only'],
        };
      }
      const testBranch = testUpstream.branch.trim();
      if (
        testBranch.startsWith('-') ||
        /[\x00-\x20\x7f ~^:?*[\\]|\.\.|@\{|\/\.|\.lock$|^\/|\/$/.test(testBranch)
      ) {
        return {
          ok: false,
          classification: 'unknown',
          exitCode: 2,
          isCertified: false,
          isTestOverride: true,
          upstreamSource: 'test-fixture',
          upstreamUrl: testUrl,
          upstreamBranch: testBranch,
          fetchedCommit: null,
          isReleaseCommit: false,
          targetFile: 'src/endpoints/stable-diffusion.js',
          targetBlobSha: null,
          targetSha256: null,
          dryRunPassed: null,
          reason: `Invalid test-upstream branch: "${testBranch}" (option-like or invalid git ref name)`,
          errors: [`Invalid test-upstream branch: "${testBranch}"`],
        };
      }
    }
  }

  const isTestOverride = Boolean(testUpstream && testUpstream.url);
  const upstreamSource = isTestOverride ? 'test-fixture' : 'official';
  const upstreamUrl = isTestOverride ? testUpstream.url.trim() : OFFICIAL_UPSTREAM_URL;
  const upstreamBranch = isTestOverride ? (testUpstream.branch ? String(testUpstream.branch).trim() : OFFICIAL_UPSTREAM_BRANCH) : OFFICIAL_UPSTREAM_BRANCH;

  // 1. Verify bundled package manifest and runtime patch file
  const pkgResult = await verifyPatchManifest(manifestPath);
  if (!pkgResult.ok) {
    return {
      ok: false,
      classification: 'unknown',
      exitCode: 2,
      isCertified: false,
      isTestOverride,
      upstreamSource,
      upstreamUrl,
      upstreamBranch,
      fetchedCommit: null,
      isReleaseCommit: false,
      targetFile: 'src/endpoints/stable-diffusion.js',
      targetBlobSha: null,
      targetSha256: null,
      dryRunPassed: null,
      reason: `Package verification failed: ${pkgResult.errors.join('; ')}`,
      errors: pkgResult.errors,
    };
  }

  const manifest = pkgResult.manifest;
  const targetRelFile = manifest.patches?.runtime?.targetFile || 'src/endpoints/stable-diffusion.js';
  const runtimePatchPath = path.resolve(path.dirname(manifestPath), manifest.patches.runtime.patchFile);

  if (!fs.existsSync(runtimePatchPath)) {
    return {
      ok: false,
      classification: 'unknown',
      exitCode: 2,
      isCertified: false,
      isTestOverride,
      upstreamSource,
      upstreamUrl,
      upstreamBranch,
      fetchedCommit: null,
      isReleaseCommit: false,
      targetFile: targetRelFile,
      targetBlobSha: null,
      targetSha256: null,
      dryRunPassed: null,
      reason: `Runtime patch file not found: ${runtimePatchPath}`,
      errors: [`Runtime patch file not found: ${runtimePatchPath}`],
    };
  }

  // 2. Prepare isolated disposable environment
  let tmpDir = null;
  let initialDev = null;
  let initialIno = null;
  let initialUid = null;
  let canonicalTmp = null;
  let canonicalBase = null;

  try {
    tmpDir = fs.mkdtempSync(path.join(disposableBaseDir, 'ci-release-check-'));
    const initialLstat = fs.lstatSync(tmpDir);
    initialDev = initialLstat.dev;
    initialIno = initialLstat.ino;
    initialUid = initialLstat.uid;
    canonicalTmp = fs.realpathSync(tmpDir);
    canonicalBase = fs.realpathSync(disposableBaseDir);

    // Exact containment: disposable directory must be an immediate child of base directory
    if (path.dirname(canonicalTmp) !== canonicalBase) {
      throw new Error(`Disposable directory escapes base directory: "${canonicalTmp}" not in "${canonicalBase}"`);
    }
  } catch (err) {
    return {
      ok: false,
      classification: 'unknown',
      exitCode: 4,
      isCertified: false,
      isTestOverride,
      upstreamSource,
      upstreamUrl,
      upstreamBranch,
      fetchedCommit: null,
      isReleaseCommit: false,
      targetFile: targetRelFile,
      targetBlobSha: null,
      targetSha256: null,
      dryRunPassed: null,
      reason: `Failed to create disposable temporary directory: ${err.message}`,
      errors: [err.message],
    };
  }

  const performOperation = () => {
    // 3. Initialize isolated disposable repo
    const initRes = runGit(tmpDir, ['init', '-q']);
    if (initRes.status !== 0) {
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 4,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit: null,
        isReleaseCommit: false,
        targetFile: targetRelFile,
        targetBlobSha: null,
        targetSha256: null,
        dryRunPassed: null,
        reason: `Failed to initialize isolated git repository: ${initRes.stderr || initRes.error?.message}`,
        errors: [initRes.stderr || initRes.error?.message || 'git init failed'],
      };
    }

    // 4. Fetch upstream release commit in a single race-free command
    const fetchArgs = [
      'fetch',
      '--depth=1',
      '--no-tags',
      '--no-recurse-submodules',
      upstreamUrl,
      `refs/heads/${upstreamBranch}`,
    ];
    const fetchRes = runGit(tmpDir, fetchArgs, { timeout: timeoutMs });
    if (fetchRes.status !== 0) {
      const fetchErr = fetchRes.error?.message || fetchRes.stderr.trim() || 'git fetch failed';
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 4,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit: null,
        isReleaseCommit: false,
        targetFile: targetRelFile,
        targetBlobSha: null,
        targetSha256: null,
        dryRunPassed: null,
        reason: `Network or Git error fetching upstream release from ${upstreamUrl}: ${fetchErr}`,
        errors: [fetchErr],
      };
    }

    // 5. Authoritative fetched commit resolution
    const revRes = resolveGitRev(tmpDir, 'FETCH_HEAD');
    if (!revRes.ok || !revRes.commit) {
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 4,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit: null,
        isReleaseCommit: false,
        targetFile: targetRelFile,
        targetBlobSha: null,
        targetSha256: null,
        dryRunPassed: null,
        reason: `Failed to resolve fetched upstream commit: ${revRes.error}`,
        errors: [revRes.error],
      };
    }

    const fetchedCommit = revRes.commit.toLowerCase();
    const manifestReleaseCommit = (manifest.releaseCommit || '').toLowerCase();
    const isReleaseCommit = fetchedCommit === manifestReleaseCommit;

    // 6. Extract raw target blob bytes from the fetched commit
    const blobRes = getGitObjectBytes(tmpDir, `FETCH_HEAD:${targetRelFile}`, { timeout: timeoutMs });
    if (!blobRes.ok || !blobRes.buffer) {
      if (blobRes.notFound) {
        return {
          ok: false,
          classification: 'incompatible',
          exitCode: 1,
          isCertified: false,
          isTestOverride,
          upstreamSource,
          upstreamUrl,
          upstreamBranch,
          fetchedCommit,
          isReleaseCommit,
          targetFile: targetRelFile,
          targetBlobSha: null,
          targetSha256: null,
          dryRunPassed: null,
          reason: `Target file ${targetRelFile} does not exist in upstream release ${fetchedCommit.slice(0, 9)}: ${blobRes.error}`,
          errors: [blobRes.error],
        };
      }

      // Any Git execution failure, timeout, permissions failure, or environmental error
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 4,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit,
        isReleaseCommit,
        targetFile: targetRelFile,
        targetBlobSha: null,
        targetSha256: null,
        dryRunPassed: null,
        reason: `Failed to read target file from upstream release ${fetchedCommit.slice(0, 9)}: ${blobRes.error}`,
        errors: [blobRes.error],
      };
    }

    const targetBuffer = blobRes.buffer;
    const targetSha256 = computeSha256(targetBuffer).toLowerCase();
    const targetBlobSha = computeGitBlobSha(targetBuffer).toLowerCase();

    const expectedSha256 = (manifest.patches.runtime.original.sha256 || '').toLowerCase();
    const expectedBlobSha = (manifest.patches.runtime.original.gitBlobSha || '').toLowerCase();

    const fingerprintsMatch = targetSha256 === expectedSha256 && targetBlobSha === expectedBlobSha;

    // 7. Official Certification Check:
    // Requires: exact commit match, exact fingerprints, official upstream (no test override)
    if (isReleaseCommit && fingerprintsMatch && !isTestOverride) {
      return {
        ok: true,
        classification: 'certified',
        exitCode: 0,
        isCertified: true,
        isTestOverride: false,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit,
        isReleaseCommit: true,
        targetFile: targetRelFile,
        targetBlobSha,
        targetSha256,
        dryRunPassed: null,
        reason: `Exact manifest-certified release (${fetchedCommit.slice(0, 9)}) and expected source identity from official upstream.`,
        errors: [],
      };
    }

    // 8. If uncertified or test-injected: prepare isolated applicability fixture
    const fixtureDir = path.join(tmpDir, 'applicability-fixture');
    try {
      fs.mkdirSync(fixtureDir, { recursive: true });

      const fixInit = runGit(fixtureDir, ['init', '-q']);
      if (fixInit.status !== 0) {
        return {
          ok: false,
          classification: 'unknown',
          exitCode: 4,
          isCertified: false,
          isTestOverride,
          upstreamSource,
          upstreamUrl,
          upstreamBranch,
          fetchedCommit,
          isReleaseCommit,
          targetFile: targetRelFile,
          targetBlobSha,
          targetSha256,
          dryRunPassed: null,
          reason: `Failed to initialize applicability test fixture: ${fixInit.stderr || fixInit.error?.message}`,
          errors: [fixInit.stderr || fixInit.error?.message || 'fixture init failed'],
        };
      }

      runGit(fixtureDir, ['config', 'user.name', 'Test']);
      runGit(fixtureDir, ['config', 'user.email', 'test@example.com']);

      // Write minimal structure and raw target file into fixture
      fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
      const targetDestPath = path.join(fixtureDir, targetRelFile);
      fs.mkdirSync(path.dirname(targetDestPath), { recursive: true });
      fs.writeFileSync(targetDestPath, targetBuffer);
    } catch (fsErr) {
      return {
        ok: false,
        classification: 'unknown',
        exitCode: 4,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit,
        isReleaseCommit,
        targetFile: targetRelFile,
        targetBlobSha,
        targetSha256,
        dryRunPassed: null,
        reason: `Filesystem error preparing applicability fixture: ${fsErr.message}`,
        errors: [fsErr.message],
      };
    }

    // Run patch applicability dry-run
    const applyRes = testPatchApplicability(fixtureDir, runtimePatchPath, { timeout: 10000 });

    if (applyRes.ok) {
      const overrideNote = isTestOverride ? ' (test-injected upstream source; cannot produce official certification)' : '';
      return {
        ok: true,
        classification: 'applies-unverified',
        exitCode: 3,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit,
        isReleaseCommit,
        targetFile: targetRelFile,
        targetBlobSha,
        targetSha256,
        dryRunPassed: true,
        reason: `Patch applies cleanly to upstream release (${fetchedCommit.slice(0, 9)}), but this revision has not passed independent acceptance${overrideNote}.`,
        errors: [],
      };
    }

    if (applyRes.isConflict) {
      return {
        ok: false,
        classification: 'incompatible',
        exitCode: 1,
        isCertified: false,
        isTestOverride,
        upstreamSource,
        upstreamUrl,
        upstreamBranch,
        fetchedCommit,
        isReleaseCommit,
        targetFile: targetRelFile,
        targetBlobSha,
        targetSha256,
        dryRunPassed: false,
        reason: `Patch application rejected against upstream release (${fetchedCommit.slice(0, 9)}): ${applyRes.error}`,
        errors: [applyRes.error],
      };
    }

    // Environmental / Git failure during patch test
    return {
      ok: false,
      classification: 'unknown',
      exitCode: 4,
      isCertified: false,
      isTestOverride,
      upstreamSource,
      upstreamUrl,
      upstreamBranch,
      fetchedCommit,
      isReleaseCommit,
      targetFile: targetRelFile,
      targetBlobSha,
      targetSha256,
      dryRunPassed: null,
      reason: `Failed to execute patch applicability check: ${applyRes.error}`,
      errors: [applyRes.error],
    };
  };

  let opResult = null;
  try {
    opResult = performOperation();
  } catch (unexpectedErr) {
    opResult = {
      ok: false,
      classification: 'unknown',
      exitCode: 4,
      isCertified: false,
      isTestOverride,
      upstreamSource,
      upstreamUrl,
      upstreamBranch,
      fetchedCommit: null,
      isReleaseCommit: false,
      targetFile: targetRelFile,
      targetBlobSha: null,
      targetSha256: null,
      dryRunPassed: null,
      reason: `Unexpected operational error: ${unexpectedErr.message}`,
      errors: [unexpectedErr.message],
    };
  } finally {
    // 9. Hardened, identity-verified cleanup of disposable directory
    if (tmpDir && canonicalTmp && canonicalBase) {
      let cleanupError = null;

      if (onBeforeCleanup) {
        try {
          onBeforeCleanup(tmpDir);
        } catch (hookErr) {
          cleanupError = `Pre-cleanup hook failed: ${hookErr.message}`;
        }
      }

      if (!cleanupError) {
        try {
          const currentLstat = fs.lstatSync(tmpDir);
          const currentProcessUid = getUid ? getUid() : null;

          // 1. Must be a directory, not a symbolic link
          if (!currentLstat.isDirectory() || currentLstat.isSymbolicLink()) {
            cleanupError = `Temporary directory is a symbolic link or not a directory; artifact preserved at "${tmpDir}" without removal.`;
          } else if (currentLstat.dev !== initialDev || currentLstat.ino !== initialIno) {
            // 2. Identity continuity (device and inode must match initial creation)
            cleanupError = `Temporary directory identity mismatch (dev: ${currentLstat.dev} vs ${initialDev}, ino: ${currentLstat.ino} vs ${initialIno}); artifact preserved at "${tmpDir}" without removal.`;
          } else if (
            currentLstat.uid !== initialUid ||
            (typeof currentProcessUid === 'number' && currentLstat.uid !== currentProcessUid)
          ) {
            // 3. Ownership continuity
            cleanupError = `Temporary directory ownership mismatch (uid: ${currentLstat.uid} vs expected initial: ${initialUid}, process: ${currentProcessUid}); artifact preserved at "${tmpDir}" without removal.`;
          } else {
            // 4. Exact canonical path and containment re-verification
            const currentReal = fs.realpathSync(tmpDir);
            if (currentReal !== canonicalTmp || path.dirname(currentReal) !== canonicalBase) {
              cleanupError = `Temporary directory path or containment altered (escapes "${canonicalBase}"); artifact preserved at "${tmpDir}" without removal.`;
            } else {
              // 5. Safe removal of verified disposable directory
              rmSync(currentReal, { recursive: true, force: true });
            }
          }
        } catch (err) {
          cleanupError = `Failed to safely clean up temporary directory "${tmpDir}": ${err.message}`;
        }
      }

      if (cleanupError) {
        opResult = {
          ok: false,
          classification: 'unknown',
          exitCode: 4,
          isCertified: false,
          isTestOverride,
          upstreamSource,
          upstreamUrl,
          upstreamBranch,
          fetchedCommit: opResult?.fetchedCommit ?? null,
          isReleaseCommit: opResult?.isReleaseCommit ?? false,
          targetFile: targetRelFile,
          targetBlobSha: opResult?.targetBlobSha ?? null,
          targetSha256: opResult?.targetSha256 ?? null,
          dryRunPassed: null,
          reason: `Cleanup safeguard failure: ${cleanupError}`,
          errors: [...(opResult?.errors || []), cleanupError],
        };
      }
    }
  }

  return opResult;
}

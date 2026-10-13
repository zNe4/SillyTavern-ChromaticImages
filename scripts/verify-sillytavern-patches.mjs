#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_SCHEMA_VERSION = '1.0.0';
export const EXPECTED_REPOSITORY = 'SillyTavern/SillyTavern';
export const EXPECTED_RELEASE_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const EXPECTED_SOURCE_COMMIT = 'e735bc386e4523fb0220404e84910e00cf10a468';

export const EXPECTED_PATCH_SPECS = Object.freeze({
  runtime: Object.freeze({
    patchFile: 'runtime.patch',
    relativePath: 'patches/sillytavern/release-06bde939f/runtime.patch',
    targetFile: 'src/endpoints/stable-diffusion.js',
  }),
  tests: Object.freeze({
    patchFile: 'tests.patch',
    relativePath: 'patches/sillytavern/release-06bde939f/tests.patch',
    targetFile: 'tests/stable-diffusion.test.js',
  }),
});

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'targetRepository',
  'supportedBranch',
  'releaseCommit',
  'sourceCommit',
  'sourceCommitShort',
  'compatibilityScope',
  'capabilities',
  'patches',
  'cumulative',
]);

const ALLOWED_SCOPE_KEYS = new Set([
  'guarantee',
  'disclaimer',
  'endUserRequirement',
]);

const ALLOWED_PATCH_KEYS = new Set([
  'patchFile',
  'relativePath',
  'sha256',
  'sizeBytes',
  'targetFile',
  'original',
  'expected',
]);

const HEX_40_REGEX = /^[0-9a-f]{40}$/i;
const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

/**
 * Compute lowercase hex SHA-256 digest of a Buffer or string.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validate that a target path is strictly safe and canonically normalized:
 * - Must be non-empty string
 * - Must not contain null bytes or control characters
 * - Must reject Windows drive letters (e.g. C:, c:/, C:\) on all platforms
 * - Must not contain backslashes
 * - Must not start with / or end with /
 * - Must not contain redundant separators (//) or . segments
 * - Must reject every .. segment before normalization
 * - Must match path.posix.normalize() exactly
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isSafeRelativePath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    return false;
  }
  // Reject null bytes and ASCII control characters
  if (/[\x00-\x1f\x7f]/.test(targetPath)) {
    return false;
  }
  // Reject Windows drive-letter syntax (e.g. C:, c:/, C:\) on any platform
  if (/^[a-zA-Z]:/.test(targetPath)) {
    return false;
  }
  // Reject backslashes (POSIX forward slashes required)
  if (targetPath.includes('\\')) {
    return false;
  }
  // Reject leading slash (absolute) or trailing slash
  if (targetPath.startsWith('/') || targetPath.endsWith('/')) {
    return false;
  }
  // Split into raw segments before any normalization
  const segments = targetPath.split('/');
  for (const seg of segments) {
    // Empty segment (redundant slashes e.g. //), current dir '.', or parent traversal '..'
    if (seg === '' || seg === '.' || seg === '..') {
      return false;
    }
  }
  // Must match canonical POSIX normalization
  if (path.posix.normalize(targetPath) !== targetPath) {
    return false;
  }
  return true;
}

/**
 * Validate the structure and fields of a patch manifest.
 * @param {unknown} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifestStructure(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['Manifest must be a non-null JSON object'] };
  }

  // Reject unknown top-level properties
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`Unknown top-level property "${key}" in manifest`);
    }
  }

  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(
      `Unsupported or invalid "schemaVersion": expected "${SUPPORTED_SCHEMA_VERSION}", got "${manifest.schemaVersion}"`
    );
  }

  if (manifest.targetRepository !== EXPECTED_REPOSITORY) {
    errors.push(
      `Invalid "targetRepository": expected "${EXPECTED_REPOSITORY}", got "${manifest.targetRepository}"`
    );
  }

  if (manifest.supportedBranch !== 'release') {
    errors.push(`Invalid "supportedBranch": expected "release", got "${manifest.supportedBranch}"`);
  }

  if (typeof manifest.releaseCommit !== 'string' || !HEX_40_REGEX.test(manifest.releaseCommit)) {
    errors.push('Invalid "releaseCommit": expected 40-character hex SHA');
  } else if (manifest.releaseCommit !== EXPECTED_RELEASE_COMMIT) {
    errors.push(
      `Unexpected "releaseCommit": expected "${EXPECTED_RELEASE_COMMIT}", got "${manifest.releaseCommit}"`
    );
  }

  if (typeof manifest.sourceCommit !== 'string' || !HEX_40_REGEX.test(manifest.sourceCommit)) {
    errors.push('Invalid "sourceCommit": expected 40-character hex SHA');
  } else if (manifest.sourceCommit !== EXPECTED_SOURCE_COMMIT) {
    errors.push(
      `Unexpected "sourceCommit": expected "${EXPECTED_SOURCE_COMMIT}", got "${manifest.sourceCommit}"`
    );
  }

  if (manifest.sourceCommitShort !== undefined) {
    if (typeof manifest.sourceCommitShort !== 'string' || !manifest.sourceCommitShort.trim()) {
      errors.push('Invalid "sourceCommitShort": expected non-empty string');
    } else if (manifest.sourceCommit && !manifest.sourceCommit.startsWith(manifest.sourceCommitShort)) {
      errors.push('Mismatch between "sourceCommitShort" and "sourceCommit"');
    }
  }

  if (!manifest.compatibilityScope || typeof manifest.compatibilityScope !== 'object' || Array.isArray(manifest.compatibilityScope)) {
    errors.push('Missing or invalid "compatibilityScope" object');
  } else {
    for (const key of Object.keys(manifest.compatibilityScope)) {
      if (!ALLOWED_SCOPE_KEYS.has(key)) {
        errors.push(`Unknown property "${key}" in "compatibilityScope"`);
      }
    }
    if (manifest.compatibilityScope.guarantee !== 'pinned-release-only') {
      errors.push(
        `Invalid "compatibilityScope.guarantee": expected "pinned-release-only", got "${manifest.compatibilityScope.guarantee}"`
      );
    }
    if (typeof manifest.compatibilityScope.disclaimer !== 'string' || !manifest.compatibilityScope.disclaimer.trim()) {
      errors.push('Missing "compatibilityScope.disclaimer" string');
    }
    if (typeof manifest.compatibilityScope.endUserRequirement !== 'string' || !manifest.compatibilityScope.endUserRequirement.trim()) {
      errors.push('Missing "compatibilityScope.endUserRequirement" string');
    }
  }

  if (!manifest.capabilities || typeof manifest.capabilities !== 'object' || Array.isArray(manifest.capabilities)) {
    errors.push('Missing or invalid "capabilities" object');
  } else {
    for (const routeType of ['normalized', 'compatibility']) {
      const cap = manifest.capabilities[routeType];
      if (!cap || typeof cap !== 'object' || Array.isArray(cap)) {
        errors.push(`Missing "capabilities.${routeType}" object`);
      } else {
        if (!Array.isArray(cap.routes) || cap.routes.length === 0) {
          errors.push(`Missing or empty routes array in "capabilities.${routeType}"`);
        } else {
          for (const route of cap.routes) {
            if (!route || typeof route !== 'object' || typeof route.method !== 'string' || typeof route.path !== 'string') {
              errors.push(`Malformed route descriptor in "capabilities.${routeType}"`);
            }
          }
        }
        if (cap.markerHeader !== 'x-st-nanogpt-proxy') {
          errors.push(`Invalid markerHeader in "capabilities.${routeType}": expected "x-st-nanogpt-proxy"`);
        }
        const expectedMarker = routeType === 'normalized' ? 'v1' : 'v1-compat';
        if (cap.markerValue !== expectedMarker) {
          errors.push(`Invalid markerValue in "capabilities.${routeType}": expected "${expectedMarker}"`);
        }
      }
    }
  }

  if (!manifest.patches || typeof manifest.patches !== 'object' || Array.isArray(manifest.patches)) {
    errors.push('Missing or invalid "patches" object');
  } else {
    for (const key of Object.keys(manifest.patches)) {
      if (key !== 'runtime' && key !== 'tests') {
        errors.push(`Unknown patch entry "${key}" in "patches" (only "runtime" and "tests" permitted)`);
      }
    }

    for (const patchType of ['runtime', 'tests']) {
      const p = manifest.patches[patchType];
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(`Missing "patches.${patchType}" object`);
        continue;
      }

      for (const prop of Object.keys(p)) {
        if (!ALLOWED_PATCH_KEYS.has(prop)) {
          errors.push(`Unknown property "${prop}" in "patches.${patchType}"`);
        }
      }

      const expectedSpec = EXPECTED_PATCH_SPECS[patchType];

      if (p.patchFile !== expectedSpec.patchFile) {
        errors.push(
          `Invalid patchFile in "patches.${patchType}": expected "${expectedSpec.patchFile}", got "${p.patchFile}"`
        );
      }
      if (!isSafeRelativePath(p.patchFile)) {
        errors.push(`Unsafe patchFile path in "patches.${patchType}": "${p.patchFile}"`);
      }

      if (p.relativePath !== expectedSpec.relativePath) {
        errors.push(
          `Invalid relativePath in "patches.${patchType}": expected "${expectedSpec.relativePath}", got "${p.relativePath}"`
        );
      }
      if (!isSafeRelativePath(p.relativePath)) {
        errors.push(`Unsafe relativePath in "patches.${patchType}": "${p.relativePath}"`);
      } else if (path.posix.basename(p.relativePath) !== p.patchFile) {
        errors.push(
          `Inconsistent relativePath in "patches.${patchType}": basename does not match patchFile "${p.patchFile}"`
        );
      }

      if (!HEX_64_REGEX.test(p.sha256 || '')) {
        errors.push(`Invalid sha256 checksum in "patches.${patchType}"`);
      }

      if (typeof p.sizeBytes !== 'number' || !Number.isSafeInteger(p.sizeBytes) || p.sizeBytes <= 0) {
        errors.push(`Invalid sizeBytes in "patches.${patchType}": expected positive safe integer`);
      }

      if (p.targetFile !== expectedSpec.targetFile) {
        errors.push(
          `Invalid targetFile in "patches.${patchType}": expected "${expectedSpec.targetFile}", got "${p.targetFile}"`
        );
      }
      if (!isSafeRelativePath(p.targetFile)) {
        errors.push(`Unsafe targetFile path in "patches.${patchType}": "${p.targetFile}"`);
      }

      if (!p.original || typeof p.original !== 'object' || Array.isArray(p.original) ||
          !HEX_40_REGEX.test(p.original.gitBlobSha || '') || !HEX_64_REGEX.test(p.original.sha256 || '')) {
        errors.push(`Invalid original blob/sha256 fingerprints in "patches.${patchType}"`);
      }
      if (!p.expected || typeof p.expected !== 'object' || Array.isArray(p.expected) ||
          !HEX_40_REGEX.test(p.expected.gitBlobSha || '') || !HEX_64_REGEX.test(p.expected.sha256 || '')) {
        errors.push(`Invalid expected blob/sha256 fingerprints in "patches.${patchType}"`);
      }
    }
  }

  if (!manifest.cumulative || typeof manifest.cumulative !== 'object' || Array.isArray(manifest.cumulative)) {
    errors.push('Missing or invalid "cumulative" object');
  } else if (!HEX_64_REGEX.test(manifest.cumulative.sha256 || '')) {
    errors.push('Missing or invalid "cumulative.sha256" checksum');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Verify deterministic scope, allowed operations, target paths, declared byte size, and Git blob headers of patch content.
 * @param {Buffer} patchBuffer
 * @param {object} patchSpec
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyPatchContent(patchBuffer, patchSpec) {
  const errors = [];

  // 1. Verify byte size matches declared sizeBytes
  if (typeof patchSpec.sizeBytes === 'number' && patchBuffer.length !== patchSpec.sizeBytes) {
    errors.push(
      `File size mismatch for ${patchSpec.targetFile}: declared ${patchSpec.sizeBytes} bytes, actual ${patchBuffer.length} bytes`
    );
  }

  // 2. Verify SHA-256 matches declared sha256
  const actualSha256 = computeSha256(patchBuffer);
  if (actualSha256.toLowerCase() !== (patchSpec.sha256 || '').toLowerCase()) {
    errors.push(
      `Checksum mismatch for ${patchSpec.targetFile}: expected ${patchSpec.sha256}, got ${actualSha256}`
    );
  }

  const patchText = patchBuffer.toString('utf-8');
  const lines = patchText.split('\n');

  const diffGitLines = [];
  const indexLines = [];
  const origFileLines = [];
  const destFileLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      diffGitLines.push({ line, index: i });
    } else if (line.startsWith('index ')) {
      indexLines.push({ line, index: i });
    } else if (line.startsWith('--- ')) {
      origFileLines.push({ line, index: i });
    } else if (line.startsWith('+++ ')) {
      destFileLines.push({ line, index: i });
    } else if (line.startsWith('new file mode ')) {
      errors.push(`Forbidden new file operation in patch: ${line}`);
    } else if (line.startsWith('deleted file mode ')) {
      errors.push(`Forbidden deleted file operation in patch: ${line}`);
    } else if (line.startsWith('Binary files ')) {
      errors.push(`Forbidden binary difference in patch: ${line}`);
    } else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      errors.push(`Forbidden file rename operation in patch: ${line}`);
    } else if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      errors.push(`Forbidden file copy operation in patch: ${line}`);
    }
  }

  if (diffGitLines.length !== 1) {
    errors.push(`Expected exactly 1 "diff --git" header, found ${diffGitLines.length}`);
  } else {
    const expectedDiffHeader = `diff --git a/${patchSpec.targetFile} b/${patchSpec.targetFile}`;
    if (diffGitLines[0].line !== expectedDiffHeader) {
      errors.push(`Unexpected diff target in header: expected "${expectedDiffHeader}", got "${diffGitLines[0].line}"`);
    }
  }

  if (origFileLines.length !== 1) {
    errors.push(`Expected exactly 1 "---" header, found ${origFileLines.length}`);
  } else {
    const expectedOrig = `--- a/${patchSpec.targetFile}`;
    if (origFileLines[0].line !== expectedOrig) {
      errors.push(`Unexpected "---" target: expected "${expectedOrig}", got "${origFileLines[0].line}"`);
    }
  }

  if (destFileLines.length !== 1) {
    errors.push(`Expected exactly 1 "+++" header, found ${destFileLines.length}`);
  } else {
    const expectedDest = `+++ b/${patchSpec.targetFile}`;
    if (destFileLines[0].line !== expectedDest) {
      errors.push(`Unexpected "+++" target: expected "${expectedDest}", got "${destFileLines[0].line}"`);
    }
  }

  if (indexLines.length !== 1) {
    errors.push(`Expected exactly 1 "index" header, found ${indexLines.length}`);
  } else {
    // Format: index <origBlob>..<destBlob> <mode>
    const match = indexLines[0].line.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: ([0-7]+))?$/i);
    if (!match) {
      errors.push(`Malformed "index" header: "${indexLines[0].line}"`);
    } else {
      const [, shortOrig, shortDest] = match;
      if (!patchSpec.original || !patchSpec.original.gitBlobSha || !patchSpec.original.gitBlobSha.toLowerCase().startsWith(shortOrig.toLowerCase())) {
        errors.push(`Original blob prefix mismatch: header "${shortOrig}" is not a prefix of declared "${patchSpec.original?.gitBlobSha}"`);
      }
      if (!patchSpec.expected || !patchSpec.expected.gitBlobSha || !patchSpec.expected.gitBlobSha.toLowerCase().startsWith(shortDest.toLowerCase())) {
        errors.push(`Expected blob prefix mismatch: header "${shortDest}" is not a prefix of declared "${patchSpec.expected?.gitBlobSha}"`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Verify a full patch manifest and its referenced patch files.
 * @param {string} manifestPath - Path to manifest.json file
 * @returns {Promise<{ ok: boolean, manifest: object, errors: string[] }>}
 */
export async function verifyPatchManifest(manifestPath) {
  const errors = [];
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, manifest: null, errors: [`Manifest file not found: ${manifestPath}`] };
  }

  let manifestText;
  try {
    manifestText = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    return { ok: false, manifest: null, errors: [`Failed to read manifest file: ${err.message}`] };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    return { ok: false, manifest: null, errors: [`Manifest JSON parse error: ${err.message}`] };
  }

  const structureValidation = validateManifestStructure(manifest);
  if (!structureValidation.ok) {
    return { ok: false, manifest, errors: structureValidation.errors };
  }

  const manifestDir = path.dirname(path.resolve(manifestPath));

  let runtimeBuffer = null;
  let testsBuffer = null;

  for (const patchType of ['runtime', 'tests']) {
    const patchSpec = manifest.patches[patchType];
    const resolvedPatchPath = path.resolve(manifestDir, patchSpec.patchFile);

    // Robust containment check: ensure resolvedPatchPath is strictly inside manifestDir
    const relativeFromManifestDir = path.relative(manifestDir, resolvedPatchPath);
    if (relativeFromManifestDir.startsWith('..') || path.isAbsolute(relativeFromManifestDir) || relativeFromManifestDir === '') {
      errors.push(`Patch file path "${patchSpec.patchFile}" escapes manifest directory`);
      continue;
    }

    if (!fs.existsSync(resolvedPatchPath)) {
      errors.push(`Patch file not found for ${patchType}: ${resolvedPatchPath}`);
      continue;
    }

    let buffer;
    try {
      buffer = fs.readFileSync(resolvedPatchPath);
    } catch (err) {
      errors.push(`Failed to read patch file for ${patchType}: ${err.message}`);
      continue;
    }

    if (patchType === 'runtime') runtimeBuffer = buffer;
    if (patchType === 'tests') testsBuffer = buffer;

    const contentValidation = verifyPatchContent(buffer, patchSpec);
    if (!contentValidation.ok) {
      errors.push(...contentValidation.errors);
    }
  }

  if (runtimeBuffer && testsBuffer) {
    const cumulativeBuffer = Buffer.concat([runtimeBuffer, testsBuffer]);
    const cumulativeSha256 = computeSha256(cumulativeBuffer);
    if (cumulativeSha256.toLowerCase() !== manifest.cumulative.sha256.toLowerCase()) {
      errors.push(`Cumulative patch checksum mismatch: expected ${manifest.cumulative.sha256}, got ${cumulativeSha256}`);
    }
  }

  return {
    ok: errors.length === 0,
    manifest,
    errors,
  };
}

/**
 * CLI Entry point
 */
async function main() {
  const targetManifest = process.argv[2] || 'patches/sillytavern/release-06bde939f/manifest.json';
  console.log(`[Chromatic Images] Verifying SillyTavern patch distribution artifacts...`);
  console.log(`  Manifest: ${targetManifest}`);

  const result = await verifyPatchManifest(targetManifest);
  if (!result.ok) {
    console.error(`\n[FAIL] Patch verification failed with ${result.errors.length} error(s):`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const { manifest } = result;
  console.log(`\n[PASS] Patch manifest and distribution artifacts verified successfully.`);
  console.log(`  Repository:       ${manifest.targetRepository}`);
  console.log(`  Supported Branch: ${manifest.supportedBranch}`);
  console.log(`  Release Commit:   ${manifest.releaseCommit}`);
  console.log(`  Source Commit:    ${manifest.sourceCommit}`);
  console.log(`  Runtime Patch:    ${manifest.patches.runtime.patchFile} (${manifest.patches.runtime.sizeBytes} bytes)`);
  console.log(`    SHA-256:        ${manifest.patches.runtime.sha256}`);
  console.log(`    Target File:    ${manifest.patches.runtime.targetFile}`);
  console.log(`    Relative Path:  ${manifest.patches.runtime.relativePath}`);
  console.log(`  Tests Patch:      ${manifest.patches.tests.patchFile} (${manifest.patches.tests.sizeBytes} bytes)`);
  console.log(`    SHA-256:        ${manifest.patches.tests.sha256}`);
  console.log(`    Target File:    ${manifest.patches.tests.targetFile}`);
  console.log(`    Relative Path:  ${manifest.patches.tests.relativePath}`);
  console.log(`  Cumulative SHA:   ${manifest.cumulative.sha256}`);
  console.log(`  End User Scope:   ${manifest.compatibilityScope.endUserRequirement}`);
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectExecution) {
  main().catch((err) => {
    console.error(`[FATAL] Unexpected error:`, err);
    process.exit(1);
  });
}

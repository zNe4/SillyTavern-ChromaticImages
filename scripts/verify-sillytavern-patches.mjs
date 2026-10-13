#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Compute lowercase hex SHA-256 digest of a Buffer or string.
 * @param {Buffer|string} data
 * @returns {string}
 */
export function computeSha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Validate that a target path is strictly safe and normalized:
 * - Must be non-empty string
 * - Must not start with / or \
 * - Must not contain .. segments
 * - Must use forward slashes
 * @param {string} targetPath
 * @returns {boolean}
 */
export function isSafeRelativePath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    return false;
  }
  if (path.isAbsolute(targetPath) || targetPath.startsWith('/') || targetPath.startsWith('\\')) {
    return false;
  }
  const normalized = path.normalize(targetPath);
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized.includes('\\..\\')) {
    return false;
  }
  if (targetPath.includes('\\')) {
    return false;
  }
  return true;
}

const HEX_40_REGEX = /^[0-9a-f]{40}$/i;
const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

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

  if (typeof manifest.schemaVersion !== 'string' || !manifest.schemaVersion.trim()) {
    errors.push('Missing or invalid "schemaVersion" string');
  }

  if (typeof manifest.targetRepository !== 'string' || !manifest.targetRepository.trim()) {
    errors.push('Missing or invalid "targetRepository" string');
  }

  if (manifest.supportedBranch !== 'release') {
    errors.push(`Invalid "supportedBranch": expected "release", got "${manifest.supportedBranch}"`);
  }

  if (!HEX_40_REGEX.test(manifest.releaseCommit || '')) {
    errors.push('Invalid "releaseCommit": expected 40-character hex SHA');
  }

  if (!HEX_40_REGEX.test(manifest.sourceCommit || '')) {
    errors.push('Invalid "sourceCommit": expected 40-character hex SHA');
  }

  if (!manifest.compatibilityScope || typeof manifest.compatibilityScope !== 'object') {
    errors.push('Missing or invalid "compatibilityScope" object');
  } else {
    if (typeof manifest.compatibilityScope.disclaimer !== 'string' || !manifest.compatibilityScope.disclaimer.trim()) {
      errors.push('Missing "compatibilityScope.disclaimer" string');
    }
    if (typeof manifest.compatibilityScope.endUserRequirement !== 'string' || !manifest.compatibilityScope.endUserRequirement.trim()) {
      errors.push('Missing "compatibilityScope.endUserRequirement" string');
    }
  }

  if (!manifest.capabilities || typeof manifest.capabilities !== 'object') {
    errors.push('Missing or invalid "capabilities" object');
  } else {
    for (const routeType of ['normalized', 'compatibility']) {
      const cap = manifest.capabilities[routeType];
      if (!cap || typeof cap !== 'object') {
        errors.push(`Missing "capabilities.${routeType}" object`);
      } else {
        if (!Array.isArray(cap.routes) || cap.routes.length === 0) {
          errors.push(`Missing or empty routes array in "capabilities.${routeType}"`);
        }
        if (typeof cap.markerHeader !== 'string' || !cap.markerHeader) {
          errors.push(`Missing markerHeader in "capabilities.${routeType}"`);
        }
        if (typeof cap.markerValue !== 'string' || !cap.markerValue) {
          errors.push(`Missing markerValue in "capabilities.${routeType}"`);
        }
      }
    }
  }

  if (!manifest.patches || typeof manifest.patches !== 'object') {
    errors.push('Missing or invalid "patches" object');
  } else {
    for (const patchType of ['runtime', 'tests']) {
      const p = manifest.patches[patchType];
      if (!p || typeof p !== 'object') {
        errors.push(`Missing "patches.${patchType}" object`);
        continue;
      }

      if (!isSafeRelativePath(p.patchFile)) {
        errors.push(`Unsafe or invalid patchFile path in "patches.${patchType}": "${p.patchFile}"`);
      }
      if (!HEX_64_REGEX.test(p.sha256 || '')) {
        errors.push(`Invalid sha256 checksum in "patches.${patchType}"`);
      }
      if (!isSafeRelativePath(p.targetFile)) {
        errors.push(`Unsafe or invalid targetFile path in "patches.${patchType}": "${p.targetFile}"`);
      }

      if (!p.original || !HEX_40_REGEX.test(p.original.gitBlobSha || '') || !HEX_64_REGEX.test(p.original.sha256 || '')) {
        errors.push(`Invalid original blob/sha256 fingerprints in "patches.${patchType}"`);
      }
      if (!p.expected || !HEX_40_REGEX.test(p.expected.gitBlobSha || '') || !HEX_64_REGEX.test(p.expected.sha256 || '')) {
        errors.push(`Invalid expected blob/sha256 fingerprints in "patches.${patchType}"`);
      }
    }
  }

  if (!manifest.cumulative || !HEX_64_REGEX.test(manifest.cumulative.sha256 || '')) {
    errors.push('Missing or invalid "cumulative.sha256" checksum');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Verify deterministic scope, allowed operations, target paths, and Git blob headers of patch content.
 * @param {Buffer} patchBuffer
 * @param {object} patchSpec
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function verifyPatchContent(patchBuffer, patchSpec) {
  const errors = [];
  const actualSha256 = computeSha256(patchBuffer);
  if (actualSha256.toLowerCase() !== patchSpec.sha256.toLowerCase()) {
    errors.push(`Checksum mismatch for ${patchSpec.targetFile}: expected ${patchSpec.sha256}, got ${actualSha256}`);
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
      if (!patchSpec.original.gitBlobSha.toLowerCase().startsWith(shortOrig.toLowerCase())) {
        errors.push(`Original blob prefix mismatch: header "${shortOrig}" is not a prefix of declared "${patchSpec.original.gitBlobSha}"`);
      }
      if (!patchSpec.expected.gitBlobSha.toLowerCase().startsWith(shortDest.toLowerCase())) {
        errors.push(`Expected blob prefix mismatch: header "${shortDest}" is not a prefix of declared "${patchSpec.expected.gitBlobSha}"`);
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

    // Guard against directory traversal escaping the expected directory
    if (!resolvedPatchPath.startsWith(manifestDir)) {
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
  console.log(`  Tests Patch:      ${manifest.patches.tests.patchFile} (${manifest.patches.tests.sizeBytes} bytes)`);
  console.log(`    SHA-256:        ${manifest.patches.tests.sha256}`);
  console.log(`    Target File:    ${manifest.patches.tests.targetFile}`);
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

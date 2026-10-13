import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSha256,
  isSafeRelativePath,
  validateManifestStructure,
  verifyPatchContent,
  verifyPatchManifest,
} from '../scripts/verify-sillytavern-patches.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'patches/sillytavern/release-06bde939f/manifest.json'
);

describe('verify-sillytavern-patches tooling', () => {
  describe('production artifacts verification', () => {
    test('validates production release-06bde939f manifest and patches end-to-end', async () => {
      const result = await verifyPatchManifest(PRODUCTION_MANIFEST_PATH);
      assert.equal(result.ok, true, `Verification failed with errors: ${result.errors.join(', ')}`);
      assert.equal(result.errors.length, 0);
      assert.equal(result.manifest.supportedBranch, 'release');
      assert.equal(
        result.manifest.releaseCommit,
        '06bde939fb1e9c4c8d8641d810f0a916b5bce127'
      );
      assert.equal(
        result.manifest.sourceCommit,
        'e735bc386e4523fb0220404e84910e00cf10a468'
      );
      assert.equal(
        result.manifest.cumulative.sha256,
        '1996fc6d41861635670ea2d762639b6602f9d0ee105bcfa4f01a80153306a479'
      );
    });
  });

  describe('isSafeRelativePath', () => {
    test('accepts safe relative paths', () => {
      assert.equal(isSafeRelativePath('runtime.patch'), true);
      assert.equal(isSafeRelativePath('src/endpoints/stable-diffusion.js'), true);
      assert.equal(isSafeRelativePath('tests/stable-diffusion.test.js'), true);
    });

    test('rejects absolute paths', () => {
      assert.equal(isSafeRelativePath('/etc/passwd'), false);
      assert.equal(isSafeRelativePath('/src/endpoints/foo.js'), false);
      assert.equal(isSafeRelativePath('\\windows\\path'), false);
    });

    test('rejects directory traversal', () => {
      assert.equal(isSafeRelativePath('../outside.patch'), false);
      assert.equal(isSafeRelativePath('patches/../../secret'), false);
      assert.equal(isSafeRelativePath('a/b/../../../c'), false);
    });

    test('rejects backslashes and non-string inputs', () => {
      assert.equal(isSafeRelativePath('src\\endpoints\\foo.js'), false);
      assert.equal(isSafeRelativePath(''), false);
      assert.equal(isSafeRelativePath('   '), false);
      assert.equal(isSafeRelativePath(null), false);
      assert.equal(isSafeRelativePath(123), false);
    });
  });

  describe('validateManifestStructure', () => {
    function createValidSampleManifest() {
      return {
        schemaVersion: '1.0.0',
        targetRepository: 'SillyTavern/SillyTavern',
        supportedBranch: 'release',
        releaseCommit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127',
        sourceCommit: 'e735bc386e4523fb0220404e84910e00cf10a468',
        compatibilityScope: {
          disclaimer: 'Pinned tested revision only.',
          endUserRequirement: 'Runtime patch only.',
        },
        capabilities: {
          normalized: {
            routes: [{ method: 'GET', path: '/api/sd/nanogpt/images' }],
            markerHeader: 'x-st-nanogpt-proxy',
            markerValue: 'v1',
          },
          compatibility: {
            routes: [{ method: 'GET', path: '/api/sd/nanogpt/images/generations' }],
            markerHeader: 'x-st-nanogpt-proxy',
            markerValue: 'v1-compat',
          },
        },
        patches: {
          runtime: {
            patchFile: 'runtime.patch',
            sha256: 'f4c2e96a6a51e88de8517f4f36e23e104b6e0d42934fb27ad6cddc2fcd03ea3b',
            targetFile: 'src/endpoints/stable-diffusion.js',
            original: {
              gitBlobSha: '077c2f961b528afa10376a7cc20a62132cf9fcd8',
              sha256: '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43',
            },
            expected: {
              gitBlobSha: 'e8bcfb652520450951268bd7521fdc6eae1aa2b6',
              sha256: '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6',
            },
          },
          tests: {
            patchFile: 'tests.patch',
            sha256: '8f948b50cf249cb9e5f2f3cfdbc37c5e07a1a2dc31ebeaee65952d507fc6f6cf',
            targetFile: 'tests/stable-diffusion.test.js',
            original: {
              gitBlobSha: '6a33571d8fbb1a71e56aec51f6c3db30d18eb2d8',
              sha256: 'c185b4559be6e5aa9487cbd42f351ba2bd2ee8158b11c8f67ad4b4dabc4cba93',
            },
            expected: {
              gitBlobSha: '3bd7bab7006fd1e138f74dcdd132e16a17f79933',
              sha256: 'cc2f40c4a83e66c947591bcfeba36150f4d4205d990522cc6d3e84aa724f3dfe',
            },
          },
        },
        cumulative: {
          sha256: '1996fc6d41861635670ea2d762639b6602f9d0ee105bcfa4f01a80153306a479',
        },
      };
    }

    test('accepts valid manifest object', () => {
      const res = validateManifestStructure(createValidSampleManifest());
      assert.equal(res.ok, true);
      assert.equal(res.errors.length, 0);
    });

    test('rejects non-object or null input', () => {
      assert.equal(validateManifestStructure(null).ok, false);
      assert.equal(validateManifestStructure([]).ok, false);
      assert.equal(validateManifestStructure('string').ok, false);
    });

    test('rejects unsupported branch', () => {
      const manifest = createValidSampleManifest();
      manifest.supportedBranch = 'staging';
      const res = validateManifestStructure(manifest);
      assert.equal(res.ok, false);
      assert.match(res.errors[0], /Invalid "supportedBranch"/);
    });

    test('rejects non-40-hex commit SHAs', () => {
      const manifest = createValidSampleManifest();
      manifest.releaseCommit = '06bde939f'; // too short
      const res = validateManifestStructure(manifest);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Invalid "releaseCommit"/);
    });

    test('rejects missing compatibility scope disclaimer', () => {
      const manifest = createValidSampleManifest();
      delete manifest.compatibilityScope.disclaimer;
      const res = validateManifestStructure(manifest);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /compatibilityScope\.disclaimer/);
    });

    test('rejects missing or invalid capability markers', () => {
      const manifest = createValidSampleManifest();
      delete manifest.capabilities.normalized;
      const res = validateManifestStructure(manifest);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /capabilities\.normalized/);
    });

    test('rejects path traversal in patch target file', () => {
      const manifest = createValidSampleManifest();
      manifest.patches.runtime.targetFile = '../etc/passwd';
      const res = validateManifestStructure(manifest);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Unsafe or invalid targetFile/);
    });

    test('rejects invalid blob or checksum fingerprints', () => {
      const manifest = createValidSampleManifest();
      manifest.patches.runtime.original.gitBlobSha = 'invalid-hex';
      const res = validateManifestStructure(manifest);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Invalid original blob/);
    });
  });

  describe('verifyPatchContent', () => {
    function createSampleSpec() {
      return {
        patchFile: 'runtime.patch',
        sha256: '', // populated in test
        targetFile: 'src/endpoints/stable-diffusion.js',
        original: {
          gitBlobSha: '077c2f961b528afa10376a7cc20a62132cf9fcd8',
          sha256: '15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43',
        },
        expected: {
          gitBlobSha: 'e8bcfb652520450951268bd7521fdc6eae1aa2b6',
          sha256: '16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6',
        },
      };
    }

    test('accepts valid patch content and blob prefixes', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'index 077c2f961..e8bcfb652 100644',
        '--- a/src/endpoints/stable-diffusion.js',
        '+++ b/src/endpoints/stable-diffusion.js',
        '@@ -1,1 +1,2 @@',
        ' line1',
        '+added',
      ].join('\n');

      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, true);
      assert.equal(res.errors.length, 0);
    });

    test('rejects tampered checksum', () => {
      const buf = Buffer.from('some patch content', 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = '0000000000000000000000000000000000000000000000000000000000000000';

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Checksum mismatch/);
    });

    test('rejects unexpected target file in diff header', () => {
      const patchText = [
        'diff --git a/unexpected.js b/unexpected.js',
        'index 077c2f961..e8bcfb652 100644',
        '--- a/unexpected.js',
        '+++ b/unexpected.js',
        '@@ -1,1 +1,2 @@',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Unexpected diff target in header/);
    });

    test('rejects multiple diff --git headers in single patch', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'index 077c2f961..e8bcfb652 100644',
        '--- a/src/endpoints/stable-diffusion.js',
        '+++ b/src/endpoints/stable-diffusion.js',
        '@@ -1,1 +1,2 @@',
        'diff --git a/src/second-file.js b/src/second-file.js',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Expected exactly 1 "diff --git" header/);
    });

    test('rejects forbidden patch operations: new file mode', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'new file mode 100644',
        'index 0000000..e8bcfb652',
        '--- /dev/null',
        '+++ b/src/endpoints/stable-diffusion.js',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Forbidden new file operation/);
    });

    test('rejects forbidden patch operations: deleted file mode', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'deleted file mode 100644',
        'index 077c2f961..0000000',
        '--- a/src/endpoints/stable-diffusion.js',
        '+++ /dev/null',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Forbidden deleted file operation/);
    });

    test('rejects forbidden patch operations: binary differences', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'index 077c2f961..e8bcfb652 100644',
        'Binary files a/src/endpoints/stable-diffusion.js and b/src/endpoints/stable-diffusion.js differ',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Forbidden binary difference/);
    });

    test('rejects original blob prefix mismatch', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'index 999999999..e8bcfb652 100644',
        '--- a/src/endpoints/stable-diffusion.js',
        '+++ b/src/endpoints/stable-diffusion.js',
        '@@ -1,1 +1,2 @@',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Original blob prefix mismatch/);
    });

    test('rejects expected blob prefix mismatch', () => {
      const patchText = [
        'diff --git a/src/endpoints/stable-diffusion.js b/src/endpoints/stable-diffusion.js',
        'index 077c2f961..999999999 100644',
        '--- a/src/endpoints/stable-diffusion.js',
        '+++ b/src/endpoints/stable-diffusion.js',
        '@@ -1,1 +1,2 @@',
      ].join('\n');
      const buf = Buffer.from(patchText, 'utf-8');
      const spec = createSampleSpec();
      spec.sha256 = computeSha256(buf);

      const res = verifyPatchContent(buf, spec);
      assert.equal(res.ok, false);
      assert.match(res.errors.join('; '), /Expected blob prefix mismatch/);
    });
  });

  describe('verifyPatchManifest error handling', () => {
    test('rejects nonexistent manifest path', async () => {
      const res = await verifyPatchManifest('/path/to/nonexistent/manifest.json');
      assert.equal(res.ok, false);
      assert.match(res.errors[0], /Manifest file not found/);
    });
  });
});

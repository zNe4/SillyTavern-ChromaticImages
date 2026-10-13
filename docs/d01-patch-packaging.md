# D01-P2B: Distribution Artifacts and Patch Packaging

> Distribution packaging specification, offline verification tooling, and release compatibility evidence for SillyTavern proxy patches.
> Date: 2026-10-13

---

## 1. Context and Objective

Chromatic Images utilizes server-side proxy routes in SillyTavern to provide secure, privacy-hardened communication with NanoGPT image generation APIs without exposing raw API keys in browser JavaScript and without logging roleplay scene prompts or character reference image payloads to server debug consoles.

Because upstream stock SillyTavern does not yet include these dedicated proxy routes, Chromatic Images packages versioned, cryptographically verified patch artifacts to enable downstream deployment.

The D01-P2A milestone hardened and verified the proxy implementation against pinned stock SillyTavern release `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, achieving 77/77 passing focused tests and 485/485 passing full unit tests.

The **D01-P2B** mission packages this accepted source difference into:
1. A **runtime-only patch** (`runtime.patch`) targeting `src/endpoints/stable-diffusion.js`.
2. An optional **developer test patch** (`tests.patch`) targeting `tests/stable-diffusion.test.js`.
3. A declarative, versioned **compatibility manifest** (`manifest.json`).
4. Reproducible **offline verification tooling** (`scripts/verify-sillytavern-patches.mjs` and `tests/verify-sillytavern-patches.test.mjs`).

> [!IMPORTANT]
> **Scope boundary:** D01-P2B is strictly limited to packaging and offline verification. It does **not** implement an installer, does not modify active SillyTavern installations, does not execute paid requests, and does not provide an automated patch applicator (which is deferred to D01-P3).

---

## 2. Baselines and Commit Identity

| Repository | Canonical Identifier | Tested Baseline / Revision |
|---|---|---|
| **Chromatic Images** | `zNe4/SillyTavern-ChromaticImages` | Baseline `79e65195914f31ab0ccf717884f014dfe4909c2c` (Branch: `main`) |
| **SillyTavern Stock Release** | `SillyTavern/SillyTavern` | Pinned Release `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (Branch: `release`) |
| **Accepted Hardened Source** | Local SillyTavern checkout | Commit `e735bc386e4523fb0220404e84910e00cf10a468` (`e735bc386`) (Branch: `d01-p2a-nanogpt-proxy-hardening`) |

---

## 3. Packaged Artifact Inventory

All distribution artifacts reside under `patches/sillytavern/release-06bde939f/`:

### 3.1 Runtime-Only Patch (`runtime.patch`)
- **Relative Path:** `patches/sillytavern/release-06bde939f/runtime.patch`
- **Target File:** `src/endpoints/stable-diffusion.js`
- **File Size:** 37,169 bytes (901 lines)
- **SHA-256 Checksum:** `f4c2e96a6a51e88de8517f4f36e23e104b6e0d42934fb27ad6cddc2fcd03ea3b`
- **Purpose:** Production runtime proxy routes. Modifies exclusively `src/endpoints/stable-diffusion.js`. Normal end users need only this patch.
- **Capability Contracts Preserved:**
  - **Normalized Image Route:** `GET /api/sd/nanogpt/images`, `POST /api/sd/nanogpt/images` with marker header `x-st-nanogpt-proxy: v1`.
  - **Compatibility Image Generations Route:** `GET /api/sd/nanogpt/images/generations`, `POST /api/sd/nanogpt/images/generations` with marker header `x-st-nanogpt-proxy: v1-compat`.

### 3.2 Developer Test Patch (`tests.patch`)
- **Relative Path:** `patches/sillytavern/release-06bde939f/tests.patch`
- **Target File:** `tests/stable-diffusion.test.js`
- **File Size:** 96,122 bytes (2,233 lines)
- **SHA-256 Checksum:** `8f948b50cf249cb9e5f2f3cfdbc37c5e07a1a2dc31ebeaee65952d507fc6f6cf`
- **Purpose:** Upstream server test suite additions covering normalized and compatibility routes, security boundaries, timeout propagation, and stream failure lifecycle hardening. Optional artifact intended for developer and CI environments; not applied to user installations.

### 3.3 Cumulative Equivalence
- **Cumulative Patch Checksum (concatenation):**
  `1996fc6d41861635670ea2d762639b6602f9d0ee105bcfa4f01a80153306a479`
- Concatenating `runtime.patch` and `tests.patch` exactly reproduces the accepted cumulative source difference between stock release `06bde939f` and hardened commit `e735bc386`.

---

## 4. Deterministic Export Procedure

Patches are exported directly from Git using deterministic options:
```bash
# 1. Export runtime-only patch
git -C /path/to/SillyTavern diff \
  --binary --no-ext-diff --no-color \
  06bde939fb1e9c4c8d8641d810f0a916b5bce127 e735bc386 \
  -- src/endpoints/stable-diffusion.js \
  > patches/sillytavern/release-06bde939f/runtime.patch

# 2. Export developer test patch
git -C /path/to/SillyTavern diff \
  --binary --no-ext-diff --no-color \
  06bde939fb1e9c4c8d8641d810f0a916b5bce127 e735bc386 \
  -- tests/stable-diffusion.test.js \
  > patches/sillytavern/release-06bde939f/tests.patch
```

---

## 5. Compatibility Manifest (`manifest.json`)

The manifest provides a machine-readable, declarative contract for future installer verification:

```json
{
  "schemaVersion": "1.0.0",
  "targetRepository": "SillyTavern/SillyTavern",
  "supportedBranch": "release",
  "releaseCommit": "06bde939fb1e9c4c8d8641d810f0a916b5bce127",
  "sourceCommit": "e735bc386e4523fb0220404e84910e00cf10a468",
  "sourceCommitShort": "e735bc386",
  "compatibilityScope": {
    "guarantee": "pinned-release-only",
    "disclaimer": "This manifest certifies compatibility only with the exact tested releaseCommit (06bde939fb1e9c4c8d8641d810f0a916b5bce127). Compatibility with future or arbitrary release branch commits is not guaranteed and requires independent verification.",
    "endUserRequirement": "Normal end users require only the runtime patch. The developer test patch is optional for test and CI environments."
  },
  "capabilities": {
    "normalized": {
      "routes": [
        { "method": "GET", "path": "/api/sd/nanogpt/images" },
        { "method": "POST", "path": "/api/sd/nanogpt/images" }
      ],
      "markerHeader": "x-st-nanogpt-proxy",
      "markerValue": "v1"
    },
    "compatibility": {
      "routes": [
        { "method": "GET", "path": "/api/sd/nanogpt/images/generations" },
        { "method": "POST", "path": "/api/sd/nanogpt/images/generations" }
      ],
      "markerHeader": "x-st-nanogpt-proxy",
      "markerValue": "v1-compat"
    }
  },
  "patches": {
    "runtime": {
      "patchFile": "runtime.patch",
      "relativePath": "patches/sillytavern/release-06bde939f/runtime.patch",
      "sha256": "f4c2e96a6a51e88de8517f4f36e23e104b6e0d42934fb27ad6cddc2fcd03ea3b",
      "sizeBytes": 37169,
      "targetFile": "src/endpoints/stable-diffusion.js",
      "original": {
        "gitBlobSha": "077c2f961b528afa10376a7cc20a62132cf9fcd8",
        "sha256": "15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43"
      },
      "expected": {
        "gitBlobSha": "e8bcfb652520450951268bd7521fdc6eae1aa2b6",
        "sha256": "16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6"
      }
    },
    "tests": {
      "patchFile": "tests.patch",
      "relativePath": "patches/sillytavern/release-06bde939f/tests.patch",
      "sha256": "8f948b50cf249cb9e5f2f3cfdbc37c5e07a1a2dc31ebeaee65952d507fc6f6cf",
      "sizeBytes": 96122,
      "targetFile": "tests/stable-diffusion.test.js",
      "original": {
        "gitBlobSha": "6a33571d8fbb1a71e56aec51f6c3db30d18eb2d8",
        "sha256": "c185b4559be6e5aa9487cbd42f351ba2bd2ee8158b11c8f67ad4b4dabc4cba93"
      },
      "expected": {
        "gitBlobSha": "3bd7bab7006fd1e138f74dcdd132e16a17f79933",
        "sha256": "cc2f40c4a83e66c947591bcfeba36150f4d4205d990522cc6d3e84aa724f3dfe"
      }
    }
  },
  "cumulative": {
    "sha256": "1996fc6d41861635670ea2d762639b6602f9d0ee105bcfa4f01a80153306a479"
  }
}
```

### 5.1 Blob and Content Fingerprints
- **Stock `src/endpoints/stable-diffusion.js`:**
  - Git blob SHA: `077c2f961b528afa10376a7cc20a62132cf9fcd8`
  - Content SHA-256: `15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43`
- **Hardened `src/endpoints/stable-diffusion.js`:**
  - Git blob SHA: `e8bcfb652520450951268bd7521fdc6eae1aa2b6`
  - Content SHA-256: `16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6`
- **Stock `tests/stable-diffusion.test.js`:**
  - Git blob SHA: `6a33571d8fbb1a71e56aec51f6c3db30d18eb2d8`
  - Content SHA-256: `c185b4559be6e5aa9487cbd42f351ba2bd2ee8158b11c8f67ad4b4dabc4cba93`
- **Hardened `tests/stable-diffusion.test.js`:**
  - Git blob SHA: `3bd7bab7006fd1e138f74dcdd132e16a17f79933`
  - Content SHA-256: `cc2f40c4a83e66c947591bcfeba36150f4d4205d990522cc6d3e84aa724f3dfe`

---

## 6. Offline Verification Tooling

The verification tool `scripts/verify-sillytavern-patches.mjs` provides standalone integrity checking without external network requests or modifying SillyTavern repositories.

### 6.1 Validation Checks Enforced
1. **Manifest Integrity:** Strict schema validation ensuring required fields, exact supported schema version (`1.0.0`), expected target repository (`SillyTavern/SillyTavern`), 40-character hex commit hashes, positive safe integer byte sizes, and 64-character hex checksums are present and well-formed. Rejects unknown properties or malformed descriptors.
2. **File Checksums & Byte Sizes:** Validates runtime patch, test patch, and cumulative patch SHA-256 digests, and confirms exact file sizes against declared `sizeBytes`.
3. **Path Safety & Traversal Prevention:** Rejects any target or patch paths containing directory traversal (`..`), absolute paths (`/` or `\`), backslashes, empty segments, or Windows drive-letter paths (`C:`, `c:/`, `C:\`).
4. **Patch Scope Restriction:** Confirms that each patch contains **exactly one** `diff --git` block modifying exclusively its declared `targetFile` (`src/endpoints/stable-diffusion.js` for runtime, `tests/stable-diffusion.test.js` for developer tests). Rejects extra patched files or unexpected targets.
5. **Operation Allowlisting:** Rejects forbidden file operations such as `new file mode`, `deleted file mode`, `Binary files differ`, `rename`, or `copy`.
6. **Git Blob Prefix Verification:** Parses the unified diff `index <orig>..<dest>` line and ensures the short hashes are genuine prefixes of the declared `gitBlobSha` values in the manifest.
7. **Path Containment:** Enforces strict filesystem containment ensuring patch file paths never escape the manifest directory.

### 6.2 Scope: Metadata Verification vs. Full Source Reconstruction
The verification tool `scripts/verify-sillytavern-patches.mjs` performs **offline metadata and package consistency verification**. Its scope is intentionally bounded:
- It verifies that the manifest is structurally valid, that referenced patch files exist, that checksums and byte counts match, that diff scopes are strictly confined to allowed target files, and that Git blob headers match expected identities.
- It does **not** perform full source reconstruction, does not apply patches to an existing codebase, and is not an installer (patch application is deferred to the future D01-P3 installer).
- Full source reconstruction and compatibility verification were performed and proven separately in an isolated stock release environment (detailed in Section 7).

### 6.3 Security: Integrity Consistency vs. Independent Cryptographic Authenticity
The SHA-256 digests and blob fingerprints embedded inside `manifest.json` provide **self-consistent package integrity**:
- They guarantee that `runtime.patch` and `tests.patch` have not suffered file corruption, truncation, or accidental editing relative to the declared manifest.
- However, checksums recorded within the manifest itself do **not** provide independent cryptographic authenticity or third-party non-repudiation. If an untrusted actor were to tamper with both the manifest and the patch files simultaneously, internal checksum checks would still pass.
- Cryptographic provenance and authenticity rely on the integrity of the containing Git repository, commit history, and release distribution channels. Downstream consumers should only obtain the manifest from verified, canonical repository sources.

### 6.4 Tooling Execution
Run via npm or Node.js:
```bash
npm run verify:patches
# or
node scripts/verify-sillytavern-patches.mjs [path/to/manifest.json]
```

Automated unit tests covering positive validation, tampered checksum rejection, unauthorized path rejection, and forbidden patch operation rejection run via:
```bash
npm test
```

---

## 7. Isolated Release Validation Results

To prove applicability without disturbing user installations, validation was executed in an isolated detached worktree cloned from stock release `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

### 7.1 Execution Steps and Gates
1. **Pre-patch Fingerprints:** Confirmed stock blobs `077c2f961...` and `6a33571d8...` and SHA-256 digests matched stock release.
2. **Dry Run Check:** `git apply --check runtime.patch` passed with exit code 0.
3. **Runtime Patch Application:** Applied `runtime.patch` via `git apply`.
4. **Runtime Post-Patch Verification:** Resulting `src/endpoints/stable-diffusion.js` matched blob `e8bcfb652...` and SHA-256 `16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6`.
5. **Capability Markers:** Confirmed presence of `x-st-nanogpt-proxy: v1` (`GET`/`POST /api/sd/nanogpt/images`) and `x-st-nanogpt-proxy: v1-compat` (`GET`/`POST /api/sd/nanogpt/images/generations`).
6. **Test Patch Application:** Applied `tests.patch` via `git apply`.
7. **Test Post-Patch Verification:** Resulting `tests/stable-diffusion.test.js` matched blob `3bd7bab70...` and SHA-256 `cc2f40c4a83e66c947591bcfeba36150f4d4205d990522cc6d3e84aa724f3dfe`.
8. **Linters:**
   - Root ESLint: `npm run lint` passed with 0 errors.
   - Test ESLint on `stable-diffusion.test.js`: `npx --prefix tests eslint tests/stable-diffusion.test.js` passed with 0 errors.
9. **Focused Jest Tests:**
   - `npm --prefix tests run test:unit -- stable-diffusion.test.js`
   - **Result: 77/77 tests passed** (4.50s).
10. **Full Unit Test Suite:**
    - `npm --prefix tests run test:unit`
    - **Result: 485/485 tests passed across 19 suites** (10.43s).
11. **Patch Reversal:**
    - `git apply -R tests.patch` succeeded.
    - `git apply -R runtime.patch` succeeded.
12. **Working Tree Cleanliness:** `git status --short` returned clean with zero uncommitted or untracked changes, restoring stock release baseline exactly.

---

## 8. Disclaimers and Limitations

- **Stock SillyTavern Route Absence:** Stock upstream SillyTavern does not include these proxy routes. Downstream users require this patch for diagnostic image generation.
- **Pinned Release Guarantee Only:** This manifest certifies compatibility exclusively with SillyTavern release `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. Applying to arbitrary future commits is unsupported without independent revalidation.
- **Unverified Normalized Response Envelope:** While normalized request construction and dispatch are implemented and tested, the normalized success contract remains unverified in vendor documentation. Normalizer fails closed with `unverified-normalized-response-contract`.
- **Global JSON Body Parser Limit:** SillyTavern's default 500 MB body parser ceiling remains an acknowledged upstream architecture characteristic; proxy route limits enforce a defensive 50 MB application ceiling.
- **Installer Scope:** D01-P2B provides distribution artifacts and verification tooling only. An automated end-user installer is deferred to D01-P3.

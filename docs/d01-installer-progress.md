# D01 installer status and implementation handoff

> Stage acceptance records updated **2026-10-20** for `zNe4/SillyTavern-ChromaticImages`. Acceptance of the disposable Android capability probe does **not** authorize live installer mutation.

## Stage ledger and current stop boundary

| Stage | Review status | Owned boundary |
| --- | --- | --- |
| D01-P1 / D01-P2A / D01-P2B | Accepted | Pinned release, hardened NanoGPT proxy, distribution patches and manifest verification. |
| D01-P3A | Accepted | Read-only installer `--status` and `--check`; no live patching. |
| D01-P3B-1 | Accepted | Lease-backed lock, journal, transaction inspection and preflight. |
| D01-P3B-2A | Accepted | Authenticated isolated result preparation. |
| D01-P3B-2B | Accepted | Verified backup of the live initial bytes and original mode; no live target mutation. |
| **D01-P3B-2C** | **Accepted / closed** | Durable, independently authenticated destination candidate; `BACKUP_CREATED → READY_TO_SWAP`. |
| **D01-P3B-2D-1** | **Accepted / closed 2026-10-20** | Read-only post-swap inspection of live target, missing/leftover candidate, and possible unrecorded swap. |
| **D01-P3B-2D-2-A** | **Source reviewed; Android device gate accepted 2026-10-20** | Non-destructive Termux filesystem capability probe; disposable `$HOME` files only. |
| **D01-P3B-2D-2-B** | **Accepted / closed 2026-10-20** | Lease-authorized read-only pre-swap authentication, certified bytes, directory/descriptor continuity, fail-closed refusals; no live rename. |
| D01-P3B-2D-2-C | **Planning only; not authorized for coding** | First live-target atomic replacement, durability and journal advancement; requires reviewed design and explicit authorization. |
| D01-P3B-3 and subsequent | Deferred | Completion, recovery/rollback and public mutation CLI gates. |

The accepted code baseline is [`38043acd5a35e4087c2c7d214ee95f3a5f280323`](https://github.com/zNe4/SillyTavern-ChromaticImages/commit/38043acd5a35e4087c2c7d214ee95f3a5f280323) (P3B-2C-F2). The initial P3B-2C implementation and corrective commits F1/F2 were independently source-reviewed before executable acceptance.

## Certified package and resource identity

- Certified SillyTavern release commit: `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.
- Target relative path: `src/endpoints/stable-diffusion.js`.
- Certified stock SHA-256: `15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43`.
- Certified patched SHA-256: `16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6`.
- Certified stock Git blob: `077c2f961b528afa10376a7cc20a62132cf9fcd8`.
- Certified patched Git blob: `e8bcfb652520450951268bd7521fdc6eae1aa2b6`.
- Apply direction: initial live/backup = stock; isolated output/candidate = patched. Remove direction reverses those fingerprints.
- Package integrity source: `patches/sillytavern/release-06bde939f/manifest.json`, verified with `npm run verify:patches`. The scope is this pinned release, not generic SillyTavern HEAD.

## Accepted journal lifecycle and module responsibilities

Current journal schema recognizes `LOCKED → ISOLATED_PREPARED → BACKUP_CREATED → READY_TO_SWAP → SWAPPED → COMPLETED`. **Only the stages through `READY_TO_SWAP` have production execution in the accepted installer track; recognizing later phase names is not implementation of the live swap or finalization.**

- `src/patch-installer/lock.js`: transaction lock and unforgeable in-process lease.
- `src/patch-installer/journal.js`: durable phase updates, required phase-bound metadata, canonical paths, lock/lease authorization.
- `src/patch-installer/transaction-state.js`: read-only transaction and artifact classification.
- `src/patch-installer/staging.js`: isolated authenticated result preparation.
- `src/patch-installer/backup.js`: verified original-target backup; persists `backupPath` and `targetMode`.
- `src/patch-installer/destination-staging.js`: internal `stageDestinationCandidate()`, creating the canonical candidate and registering `destinationStagedPath`.
- `src/patch-installer/inspect.js` and `scripts/sillytavern-patch.mjs`: read-only inspection/preflight and disabled public mutation CLI.

At `BACKUP_CREATED`, the journal already contains `isolatedStagedPath`, `backupPath`, and `targetMode`, but **not** `destinationStagedPath`. On accepted P3B-2C success it contains `destinationStagedPath = src/endpoints/.stable-diffusion.js.ci-staged-<txId>.tmp` and phase `READY_TO_SWAP`. The candidate remains on disk, independently verified. The original target and backup remain intact.

## Security and durability invariants accepted in P3B-2C

1. Verify the lease, lock, journal phase/identity, certified manifest, and source/staging/backup SHA-256 and Git blob digests. Cross-mission inode history is **not** persisted; capture and recheck device/inode continuity during this invocation.
2. Require the real platform `fs.constants` and fixed `/proc/self/fd/<parentFd>/<candidateBase>` descriptor anchoring. Candidate creation uses `O_CREAT | O_EXCL | O_NOFOLLOW` (and write access). A missing/unusable procfs anchor fails closed, **never** falling back to an absolute-path create.
3. Create an independent candidate with `0600`, verify a single link and proper inode/device identity, write only authenticated isolated resulting bytes, fsync data, apply the recorded target mode via descriptor, fsync metadata, bounded-read and authenticate the candidate, and fsync the authenticated destination directory.
4. Reauthenticate lock/journal, existing source/staging/backup, destination-parent identity, candidate fingerprints/mode and creation-time inode before advancing the journal to `READY_TO_SWAP`. The live source is not modified or replaced.
5. Preserve existing/uncertain candidates on collision, fault, or failed validation. No automatic adoption, overwrite, unlink, cleanup, retry, or recovery. Intentional crash-simulation faults propagate; ordinary errors carry a diagnostic stage and, where appropriate, uncertainty.
6. Read-only inspection must find the reserved candidate filename family even when `.ci-patch` is absent. Valid `READY_TO_SWAP` requires a verified candidate; `BACKUP_CREATED` with a candidate indicates interrupted staging. A missing temporary candidate in future `SWAPPED`/`COMPLETED` is not automatically erroneous (a successful rename consumes it).
7. State precedence remains unchanged. **Correct report interpretation:** `isPending` is currently `state !== 'none'`; consequently, `orphaned-artifact` **always** has `isPending: true`, including missing `.ci-patch` and foreign candidate cases. Two `false` entries in the submitted acceptance report were table mistakes, not source defects.
8. These guards do not constitute complete protection from a privileged, actively racing filesystem writer. Linux procfs access and POSIX inode/mode semantics are assumed; unsupported platforms fail closed.

## Acceptance evidence (2026-10-19)

The user supplied Gemini's **D01-P3B-2C-V — Final Executable Acceptance Report**. It reports:

| Verification | Reported result |
| --- | --- |
| Targeted destination-staging suite | **63 passed / 63**, 0 failed, 0 skipped/cancelled. |
| Full Node test suite | **1,043 passed / 1,043** across 60 suites, 0 failed, 0 skipped/cancelled. |
| Package integrity | `npm run verify:patches` passed. |
| Repository-wide JavaScript syntax | 64 tracked `.js`/`.mjs` files passed `node --check`. |
| Authentic apply/remove | Certified candidate fingerprints verified in disposable repositories for both directions; live target unchanged. |
| F1/F2 regressions | Caller-safety override isolation, descriptor closure, substitution/fault tests and journal uncertainty reported passing. |
| CLI mutation gates | `--apply`/`--remove` still exit 2; `--recover` unsupported. |
| SillyTavern checkout preservation | Linked installation HEAD, Git status/index, target content/mode/inode/mtime and transaction artifacts unchanged before/after. |

Evidence provenance: test runs and installation observations were **reported by Gemini** in the read-only verification run; ChatGPT independently checked the pushed source and corrected the two `isPending` report entries but did **not** re-execute the tests on that machine.

An optional local, ignored `./SillyTavern` symlink may point to a separate installation and supply **read-only pinned Git objects** for tests (e.g., `SILLYTAVERN_TEST_REPO="$(realpath ./SillyTavern)" npm test`). Never apply patches, create transaction artifacts, reset/checkout, or mutate the target through the symlink. All mutation tests must use disposable independent fixtures.

## D01-P3B-2D-1 acceptance record (2026-10-20)

The accepted implementation and F1 corrections occupy `src/patch-installer/transaction-state.js` and `tests/patch-installer-transaction.test.mjs`. The accepted head is [`fccce70936bec0b507964e6e6b3427ff75d93973`](https://github.com/zNe4/SillyTavern-ChromaticImages/commit/fccce70936bec0b507964e6e6b3427ff75d93973).

- Scope: inspect the live target **only** when lock and journal are valid, agree on transaction identity, and the phase is `READY_TO_SWAP`, `SWAPPED`, or `COMPLETED`; preserve `none` for unrelated clean repositories.
- Safety: bounded read (50 MiB), actual `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` flags without fallback, pre-open pathname type check, post-open regular-file check, device/inode/size/mode continuity, pathname-to-descriptor identity, SHA-256 comparison, descriptor cleanup, and distinct missing-versus-error handling. Unsupported special objects fail closed without becoming false orphan entries.
- Semantics: `READY_TO_SWAP` with absent candidate and result live bytes means **possible**, not proven, unrecorded swap; classify `incomplete-transaction`. `SWAPPED` and `COMPLETED` with valid result bytes/mode and absent candidate are recognized as consistent. Other mismatches are reported safely; no auto journal change or recovery.
- Regression corrections: mandatory nonblocking access, authentic oversized live-file diagnostic using a sparse fixture, explicit `EACCES`/`EIO` handling, and a deterministic precheck-to-open FIFO substitution test.

Codex's **D01-P3B-2D-1-V — Executable Acceptance Report** dated 2026-10-20 records:

| Verification | Reported result |
| --- | --- |
| Pinned upstream fixture | Disposable Git checkout under `/tmp`, certified release `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, original and patched SHA-256 / Git blobs match manifest. |
| Targeted transaction suite | **146/146 passed**, zero failures or skips. |
| Authentic full Node suite | **1,064/1,064 passed** across 61 suites, zero failures or skips; both candidate staging directions exercised. |
| FIFO safety tests | Both regular-FIFO and precheck-to-open substitution paths executed; `mkfifo` available. |
| Package verification | `npm run verify:patches` PASS. |
| Repository-wide syntax | 64 tracked `.js`/`.mjs` files passed `node --check`. |
| Installation preservation | Linked SillyTavern installation reported unchanged; disposable fixture removed after the run. |
| CLI mutation boundary | `--apply`/`--remove` still reject; `--recover` unavailable. |

Evidence provenance: Codex performed and reported executable validation; ChatGPT independently reviewed the pushed source and the acceptance report, but **did not re-run** the suite on that host. GitHub had no associated workflow checks at the reviewed commit. A subsequent device-run capability probe has since verified the tested Termux-private-storage filesystem operations (see Stage A below); acceptance of P3B-2D-1 is not authorization for live target replacement.

## D01-P3B-2D-2-A — Termux capability probe (2026-10-20)

The standalone `scripts/check-termux-swap-capabilities.mjs` and `tests/termux-swap-capabilities.test.mjs` were implemented and independently source-reviewed in commits `116647c0` (A), `fab479d` (F1), `8e43e5e` (F2) and [`2735039aa4916cd1d89a5dec4006f9ab7d2123ff`](https://github.com/zNe4/SillyTavern-ChromaticImages/commit/2735039aa4916cd1d89a5dec4006f9ab7d2123ff) (F3). The successive corrections address descriptor-close errors, foreign/ambiguous cleanup ownership, short I/O, strict constant checks, cleanup-hook exceptions, and phase-aware target ownership. Only probe/tests changed; no live installer swap was enabled.

The user ran `node ci-termux-swap-probe.mjs --json` **on a physical Termux Android/ARM64 environment**, Node.js **v26.4.0**, under `/data/data/com.termux/files/home`. The reported result was `ok: true`, `failedStage: null`, `error: null`, `cleanupSucceeded: true`. **All 13 capability flags returned `true`:** `oNoFollow`, `oNonBlock`, `oDirectory`, `directoryDescriptorOpen`, `procfsDescriptorAnchoring`, `descriptorFileCreation`, `fileDataFsync`, `fileMetadataFsync`, `descriptorAnchoredRename`, `directoryFsync`, `inodeContinuityPreserved`, `modePreserved`, and `candidateConsumed`. The unique disposable probe directory was `.ci-termux-probe-oY2dSo` in Termux-private `$HOME`. This is **user-supplied on-device execution evidence**; ChatGPT reviewed the JSON and source but did not run the probe on that device. These findings certify the probed filesystem capabilities **on that environment**, not arbitrary Android filesystems or all future devices. No real SillyTavern target was accessed.

**Stage A accepted for source and device capability verification.** Authentic full-suite CI/verification results for the F3 head have not been independently confirmed by ChatGPT; there were no GitHub check runs. Do not infer that the complete installer is implemented. The next authorized coding boundary is Stage B pre-rename authentication/refusal, with no live mutation. Stage C remains separately gated.

## D01-P3B-2D-2-B — Pre-swap authentication accepted (2026-10-20)

**Accepted source baseline:** [`00bcee97a1e0dca71efbc9cab2dbc00a96881d8c`](https://github.com/zNe4/SillyTavern-ChromaticImages/commit/00bcee97a1e0dca71efbc9cab2dbc00a96881d8c) (Stage B-F2), after source review of initial B, F1 and F2. Only `src/patch-installer/target-swap.js` and `tests/patch-installer-target-swap.test.mjs` changed. The new read-only `authenticateSwapPrerequisites()` validates the active transaction lease/lock, exact `READY_TO_SWAP` journal, canonical artifact paths, certified bundled manifest and SHA-256/Git blob digests, no-follow/nonblocking bounded reads, single-link identity, file modes and special-bit refusals, staging/backup directory contents, destination-parent descriptor/procfs anchoring and final pathname continuity. `swapVerifiedTarget()` remains deliberately unimplemented.

Codex's **D01-P3B-2D-2-B-V executable acceptance report**, dated **2026-10-20**, records verification against real pinned upstream Git objects at `06bde939fb1e9c4c8d8641d810f0a916b5bce127` with certified original SHA-256 `15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43` and blob `077c2f961b528afa10376a7cc20a62132cf9fcd8`; certified patched SHA-256 `16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6` and blob `e8bcfb652520450951268bd7521fdc6eae1aa2b6`. It used the existing `/home/zzzne4/SillyTavern` **as a read-only Git object source**; patch application and installer transaction tests occurred in disposable sandboxes.

| Verification gate | Reported result |
| --- | --- |
| Focused `tests/patch-installer-target-swap.test.mjs` | **75/75 passed, 8 suites, 0 failures/skips**. |
| `npm test`, authenticated `SILLYTAVERN_TEST_REPO` | **1,171/1,171 passed, 70 suites, 0 failures/skips**. |
| Authentic apply/remove pre-swap authentication | Both executed and passed. |
| FIFO race and concurrent hard-link test | Both executed and passed; required mutation/race evidence reported. |
| Descriptor closure + secondary error diagnostics | Regression tests executed and passed, including child-process isolation. |
| Strict Stage B read-only snapshots and Stage C placeholder | Tests passed; no live rename or `SWAPPED` transition. |
| `npm run verify:patches` | PASS; certified patch artifacts unchanged. |
| Tracked `.js`/`.mjs` syntax, `git diff --check`, `git status --short` | All PASS; clean local worktree. |
| Existing installation and `./SillyTavern` symlink | Reported unchanged; active SillyTavern checkout retained its existing HEAD and modifications. |
| Public `--apply` / `--remove` / `--recover` | Continue to refuse. |

**Evidence provenance:** Codex performed and submitted these runs; ChatGPT independently reviewed the pushed source, GitHub commit scope, and the supplied report, but **did not rerun** the suite on the user's host. GitHub returned **no CI statuses or workflow runs**. These are passing test totals, not an instrumented 100% code/branch-coverage measurement. This acceptance does not extend Stage A's Termux capability result to the full production installer.

**Stage B is formally accepted and closed.** No Stage C implementation is authorized yet. The next checkpoint is a read-only Stage C design/contract review, followed by separately bounded coding and authentic disposable-fixture acceptance.

## Next planning checkpoint: D01-P3B-2D-2-C

**Planning only: do not rename live files or advance the journal.** Stage C will require a new reviewed contract for candidate-to-live rename and crash/identity handling. The plan must settle:

- Lease and journal authorization immediately before swapping; full authentication of live initial bytes/mode/inode, backup, isolated result, and same-directory candidate (including identity/permissions/durability).
- Atomic rename semantics and directory fsync ordering; what happens if rename succeeds but subsequent directory synchronization or journal advance fails.
- Crash-window classification when the journal still says `READY_TO_SWAP` but candidate is absent and the live target may already contain the expected resulting bytes.
- How to prevent clobbering an unrelated replacement, and what can be guaranteed under the documented noncooperating-writer threat model.
- Read-only status/inspection for the post-rename state without pretending P3B-3 recovery is implemented.
- Deterministic forward and reverse fixture tests for every failure boundary, with **no changes** to the actual linked SillyTavern installation.

The on-device Termux capability gate has now passed for the tested environment. This does **not** certify the future production rename implementation. Before Stage C is authorized, review Stage B's accepted authentication contract, descriptor lifetime, rename/error provenance, fsync ordering and journal crash-boundary semantics against the actual accepted code. If any required operation is unsupported in the deployment environment, fail closed without fallback. Keep public `--apply`, `--remove`, and `--recover` unavailable until their own later authorization.

## Workflow

ChatGPT maintains accepted-milestone documentation and performs independent source/evidence review. **Codex should receive explicitly scoped coding and testing tasks only** after a reviewed plan; it should not independently advance milestones or edit acceptance/roadmap docs unless separately instructed. No force pushes to canonical `main`.


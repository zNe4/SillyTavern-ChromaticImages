# D01 installer status and implementation handoff

> Acceptance record dated **2026-10-19** for `zNe4/SillyTavern-ChromaticImages`. This records accepted stages; it does **not** authorize new installer mutation code.

## Stage ledger and current stop boundary

| Stage | Review status | Owned boundary |
| --- | --- | --- |
| D01-P1 / D01-P2A / D01-P2B | Accepted | Pinned release, hardened NanoGPT proxy, distribution patches and manifest verification. |
| D01-P3A | Accepted | Read-only installer `--status` and `--check`; no live patching. |
| D01-P3B-1 | Accepted | Lease-backed lock, journal, transaction inspection and preflight. |
| D01-P3B-2A | Accepted | Authenticated isolated result preparation. |
| D01-P3B-2B | Accepted | Verified backup of the live initial bytes and original mode; no live target mutation. |
| **D01-P3B-2C** | **Accepted / closed** | Durable, independently authenticated destination candidate; `BACKUP_CREATED → READY_TO_SWAP`. |
| D01-P3B-2D | **Not implemented; planning required** | Atomic candidate replacement of live target, with its own reviewed crash/identity contract. |
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

## Next planning checkpoint: D01-P3B-2D

**Not authorized for implementation.** P3B-2D is the first stage permitted to change the live target, so require a separate read-only design and independent review before issuing a bounded Codex coding mission. The review should settle:

- Lease and journal authorization immediately before swapping; full authentication of live initial bytes/mode/inode, backup, isolated result, and same-directory candidate (including identity/permissions/durability).
- Atomic rename semantics and directory fsync ordering; what happens if rename succeeds but subsequent directory synchronization or journal advance fails.
- Crash-window classification when the journal still says `READY_TO_SWAP` but candidate is absent and the live target may already contain the expected resulting bytes.
- How to prevent clobbering an unrelated replacement, and what can be guaranteed under the documented noncooperating-writer threat model.
- Read-only status/inspection for the post-rename state without pretending P3B-3 recovery is implemented.
- Deterministic forward and reverse fixture tests for every failure boundary, with **no changes** to the actual linked SillyTavern installation.

These are open design questions, not an approved swap algorithm. Keep public `--apply`, `--remove`, and `--recover` unavailable until their own later authorization.

## Workflow

ChatGPT maintains accepted-milestone documentation and performs independent source/evidence review. **Codex should receive explicitly scoped coding and testing tasks only** after a reviewed plan; it should not independently advance milestones or edit acceptance/roadmap docs unless separately instructed. No force pushes to canonical `main`.


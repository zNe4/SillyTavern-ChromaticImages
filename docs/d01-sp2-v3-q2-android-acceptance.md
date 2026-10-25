# D01-SP-2-V3-Q2 — Physical Android/Termux public CLI acceptance

**Date:** 2026-10-25

**Repository:** `zNe4/SillyTavern-ChromaticImages`

**Public CLI commit:** [`10ca7d502d9b26803c16d3493f442b706276cd78`](https://github.com/zNe4/SillyTavern-ChromaticImages/commit/10ca7d502d9b26803c16d3493f442b706276cd78) (parent `289837bdd31a58f1f665850611ca0586e29cde83`)

**Certified SillyTavern:** `06bde939fb1e9c4c8d8641d810f0a916b5bce127`

**Scope:** Owner-executed Android/Termux public CLI, exclusively against independent **disposable** SillyTavern Git clones.

## Acceptance and provenance

**V3-Q2: PASS on the tested physical Android/Termux environment.** The owner executed all device commands and supplied terminal reports. ChatGPT independently reviewed the published source and Linux evidence, then checked the actual uploaded 46-member Q2-E archive byte-for-byte against its reported SHA-256. An independent read-only consistency pass found **74 PASS / 0 FAIL**. This is owner-run device acceptance with independent archive verification, **not** a claim that ChatGPT executed the device commands, or verified the state of the phone after the audit.

The acceptance **does not** authorize patching any real SillyTavern installation, certify other SillyTavern commits/Android environments, or approve a general product release. The older P3B journaled swap and automatic recovery mechanisms remain unimplemented/deferred; SP-2 uses a distinct verified worktree-only Git patch mechanism.

## Gate ledger

| Gate | Disposition | Verified/report basis |
| --- | --- | --- |
| Q2-A | PASS | Independent certified SillyTavern and published ChromaticImages checkouts; public `status` and `check`, no mutation. |
| Q2-B | PASS | Public `apply`: exit 0 and exact patched SHA; pre-apply stock backup and metadata, index unchanged, lock released. |
| Q2-C | PASS | `apply` idempotence exit 3; `remove` exit 0; remove idempotence exit 3; two preserved backup/metadata pairs and final clean stock. |
| Q2-D original | HOLD (preserved) | Harness snapshot-key mismatch; stopped before executing refusal cases. |
| Q2-D-R1 | HOLD (preserved) | Harness expected-message mismatch; stopped after first two passing argument refusals. |
| Q2-D-R2 | PASS | 11/11 refusal cases, exact status/exit, no target mutation or unintended backups. |
| Q2-E | PASS | Read-only inventory and checksum audit of retained gate evidence, original backup bytes and refusal stdout. |

## Public lifecycle and state invariants

| Public operation | Status | Exit | Target SHA-256 |
| --- | --- | ---: | --- |
| Apply stock | `applied` | 0 | `16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6` |
| Apply patched | `already-applied` | 3 | Patched unchanged |
| Remove patched | `removed` | 0 | `15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43` |
| Remove stock | `already-removed` | 3 | Stock unchanged |

The target file was `src/endpoints/stable-diffusion.js`, and its Git index stayed at stock stage-0 entry `100644 077c2f961b528afa10376a7cc20a62132cf9fcd8 0`. Successful mutation backups contain respectively exact stock and patched bytes; both descriptor schemas are `1.1.0`. Backup files and descriptors had mode `0600`, storage directories `0700`. Idempotent requests created **no** additional backups. Normal operation locks were released. The final disposable target matched its original certified clean stock snapshot.

## Refusal matrix (Q2-D-R2)

| Classification | Test | Exit |
| --- | --- | ---: |
| `refused` | Conflicting commands; unknown option; upstream test flags before/after mutation commands; defined-empty `CI_LOCK_DIR`; invalid explicit target | 2 each (6 cases) |
| `refused` | Uncertified Git HEAD; staged endpoint index; unknown endpoint fingerprint; symlinked endpoint | 1 each (4 cases) |
| `lock-refused` | Existing foreign repository lock, preserved unchanged | 1 (1 case) |

All eleven recorded JSON responses match their archived raw CLI stdout. The designated refusal fixtures and foreign lock were preserved. Q2-D and R1 harness HOLD evidence was also preserved, with no retroactive assertion that those runs passed.

## Independent archive audit

- **Archive:** `v3-q2e-evidence.tar.gz`, retained outside the source repository in the owner's private device workspace; the owner also supplied a copy for independent verification.
- **SHA-256:** `036e2a7de8b4ce00d79585f782a1a923ee222c0d6ca0710bb11c39ef9ebc1046` (**exact match** to owner Q2-E report).
- **Members:** 46 unique relative paths, all regular files with stored mode `0600`, no repeated names, absolute paths, symlinks or traversal.
- **Independent result:** 74 consistency checks passed; all four public lifecycle JSON results and all eleven refusals match archived stdout; two recovery backups hash to expected stock/patched fingerprints; metadata and recorded Git snapshots are internally consistent; foreign-lock payload agrees with its recorded identity; five gate-evidence checksums agree.

**Limits:** The archive does not contain the six original Q2-A through Q2-D-R2 terminal reports; Q2-E records their SHA-256 hashes but they cannot be recomputed from the uploaded archive. Those reports were reviewed separately in the conversation. The archive contains snapshots, not the live Git repositories; preservation and final on-device filesystem states are owner-run observations rather than remotely repeated checks.

## Closure and next boundary

The V3-I1 publication and V3-Q2 physical-device acceptance are **closed for this specific certified release and tested environment**. No further mutation gate is required for this milestone. General-release packaging/documentation, certification of additional SillyTavern revisions, and any real-installation deployment require distinct future review. Do not delete/reset evidence fixtures or commit raw device-private evidence and backup files to the repository. Public `recover` and the P3B `swapVerifiedTarget()`/atomic-rename path are **not** enabled.

# Chromatic Images roadmap

> Living implementation plan for `zNe4/SillyTavern-ChromaticImages`.

## Current state

**Phase:** M03 — NanoGPT/Qwen transport and local image primitives.

**Current mission:** M03-G1 (Compatibility Transport & Server Proxy) implemented and verified, ready for independent review.

**Completed:** M01 scaffold, M02 message protocol / inline UI / managed prompt hygiene, M03-A contract evidence, M03-B request builder, M03-C response normalizer (accepted for provable behavior; unverified normalized envelope deferred to M03-G), M03-D1 single-request transport core (accepted), M03-D2A server path architecture decision (accepted; narrow core proxy update selected), M03-D2B1 SillyTavern normalized proxy (implemented and verified locally; committed in local SillyTavern checkout, pending upstream PR), M03-D2B2 Chromatic Images production dispatch adapter (accepted), M03-E SillyTavern-local image I/O (accepted), and M03-F Provider settings and diagnostic UI (accepted).

**Runtime code:** proposal parsing and validation, durable result parsing, message inspection/runtime reconstruction, inline proposal/review shells, managed prompt-hygiene Regex UI, request building (normalized and compatibility), response normalization, pure mocked transport core, production dispatch adapters with capability guards (normalized and compatibility), local image I/O primitives, provider settings schema, credential readiness reader, and connection diagnostics UI are implemented. Paid image generation is not enabled.

**Canonical repository:** `zNe4/SillyTavern-ChromaticImages`

**Workflow:** work directly in the canonical local checkout; no separate `-aistudio` sandbox is required.

**Initial compatibility target:** SillyTavern 1.18.0+

**Primary real-device target:** mobile SillyTavern usage, with desktop remaining fully supported.

The current design is:

- proposal-first rather than automatic generation;
- Chromatic Dialogue as the modular/runtime donor;
- selected image-storage/message-rewrite utilities from SLAY Images;
- NanoGPT `qwen-image` as the first and only MVP provider;
- explicit user action before every paid generation;
- chat-message state instead of a separate generation database;
- trusted reference libraries bound to stable character-card identities;
- references organized by outfit/reference set;
- generated RP images never automatically become trusted references;
- deterministic reference allocation with a global maximum of three Qwen inputs.

## Fixed product decisions

| Area | Decision |
| --- | --- |
| Product name | Chromatic Images |
| Repository name | `SillyTavern-ChromaticImages` |
| Extension type | Browser-side SillyTavern extension |
| Runtime | Native JavaScript ES modules |
| Framework | None |
| Build step | None for MVP |
| Minimum ST target | 1.18.0 |
| Primary provider | NanoGPT |
| Initial model | `qwen-image` |
| Paid generation on proposal receipt | Never |
| Paid generation on reload | Never |
| Initial outputs/request | 1 |
| Qwen reference limit | 3 total images |
| External image host | Not required |
| Proposal source | `CI_IMAGE` in assistant message |
| Reviewable result source | Markdown image + `CI_RESULT` |
| Finalized result | Markdown image only |
| Separate generation-state DB | None |
| Character reference scope | Per stable character identity/card, not per chat |
| Reference grouping | Outfit/reference sets |
| Generated images as references | Never automatically |
| Recommended refs/outfit | 3+ trusted images, recommendation not hard minimum |
| Ambiguous character name | Ask user; never guess |
| Chromatic Dialogue coupling | Optional resolver aid only |
| Model responsibility | Decide/identify/describe scene only |
| Provider mechanics in model prompt | Forbidden |
| MVP multi-provider abstraction | Non-goal |
| Continuous DOM polling | Non-goal |
| License target | GNU AGPL v3 |

## Message-state protocol

### Proposal

~~~text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"Current visual scene..."} -->
~~~

### Generated/reviewable

~~~text
![ChromaticImages](/user/images/.../ci_example.png)

<!-- CI_RESULT {"v":1,"characters":["Hina","Ako"],"prompt":"...","path":"/user/images/.../ci_example.png"} -->
~~~

### Kept/finalized

~~~text
![ChromaticImages](/user/images/.../ci_example.png)
~~~

Rules:

- one CI_IMAGE maximum per assistant message in MVP;
- CI_IMAGE is model-authored;
- CI_RESULT is extension-authored only;
- malformed records never trigger API calls;
- Keep removes CI_RESULT but leaves Markdown image untouched;
- failed provider/upload operations leave CI_IMAGE unchanged;
- prompt hygiene removes CI_IMAGE, CI_RESULT, and ChromaticImages Markdown records from outgoing model context without mutating stored chat.

---

# Mission sequence

Every mission has one purpose, explicit acceptance gates, and a stop point. AI Studio must not implement future missions opportunistically.

## M00 — Bootstrap documentation

**Status: complete.**

### Deliverables

- `README.md`
- `roadmap.md`
- `docs/architecture.md`

### Acceptance

- message-state lifecycle is explicit;
- no obsolete generation-state database remains in the design;
- per-character-card trusted reference identity is explicit;
- generated images are prohibited from automatic reference reuse;
- donor code boundaries are explicit;
- NanoGPT/Qwen and three-reference constraint are explicit;
- no runtime implementation code is introduced.

---

## M01 — Clean extension scaffold

**Status: complete.**

### Goal

Create the smallest installable Chromatic Images extension using a deliberately trimmed Chromatic Dialogue scaffold, with no proposal parser and no image generation.

### Donor baseline

Pin Chromatic Dialogue donor code to:

`00b1e9d56593d97f259f162fb3bb8a0848417f40`

### Required work

- copy/adapt root manifest/package/global typings/LICENSE scaffold;
- reuse initialize-once/lifecycle discipline from Chromatic Dialogue;
- extract only minimal panel mounting and drawer accessibility code;
- create Chromatic Images settings shell and mobile-safe CSS;
- create minimal constants/module layout and Node test harness.

### Explicitly do not copy

- color/tone systems;
- Dialogue registry/registration;
- automatic review;
- mode system unless later required;
- legacy migration stack;
- migration UI;
- Dialogue-specific Regex definitions.

### Acceptance gates

- installs from Git URL;
- loads without console errors;
- initializes once;
- chat switching does not duplicate handlers/UI;
- panel works at narrow mobile widths;
- no polling/permanent MutationObserver loop;
- `npm test` passes;
- every JS/MJS file passes `node --check`;
- no provider request occurs merely by loading the extension.

### Stop point

No CI_IMAGE parsing yet.

---

## M02 — Message protocol, inline UI, and managed prompt hygiene

**Status: complete.**

### Goal

Prove model output -> validated CI_IMAGE -> inline proposal card, plus durable reconstruction from raw chat text, with no provider.

### Donor reuse

From Chromatic Dialogue:

- copy `message-reader.js` and its tests essentially unchanged;
- adapt message runtime/inspection patterns;
- adapt strict standalone HTML-comment parser structure;
- reuse managed Regex integration core/tests with Chromatic Images definitions.

### Required work

- implement CI_IMAGE parser/validator;
- implement CI_RESULT parser for extension-authored result records;
- listen to appropriate SillyTavern lifecycle/render events;
- render one idempotent inline proposal card for CI_IMAGE;
- recognize Markdown + CI_RESULT as reviewable generated state;
- recognize Markdown-only ChromaticImages image as finalized state;
- reconstruct UI after reload/chat switch by rereading source message;
- install/repair one managed prompt-hygiene Regex that strips CI_IMAGE, CI_RESULT, and ChromaticImages-owned Markdown records from outgoing prompts;
- never rewrite normal roleplay prose.

### Acceptance gates

- valid CI_IMAGE appears once;
- malformed JSON produces no card/crash;
- user/system messages ignored;
- chat switching cannot attach UI to wrong message/chat;
- reload reconstructs proposal/result/finalized states from message text;
- works beside CD_NEW records;
- managed Regex install/repair is explicit and tested;
- no external API call exists;
- mobile smoke test passes.

### Stop point

No NanoGPT and no reference library yet.

---


## M03 — NanoGPT/Qwen transport and local image primitives

**Status:** M03-A complete; M03-B accepted; M03-C accepted for currently provable behavior (normalized success-envelope adapter remains deferred); M03-D1 accepted; M03-D2A accepted; M03-D2B1 implemented locally in SillyTavern checkout; M03-D2B2 accepted; M03-E accepted; M03-F implemented and under independent review.

### Goal

Build and prove the image engine independently of proposal-card generation. M03 must not wire the inline Generate button, rewrite assistant messages, or create `CI_RESULT`.

### Evidence contract

M03 implementation follows `docs/m03-contract.md`.

Key decisions from M03-A:

- keep `qwen-image` as the MVP default;
- prefer NanoGPT's normalized `POST /api/v1/images` contract;
- normalized reference images use `input_references`;
- enforce the project maximum of three references;
- reuse SillyTavern's existing server-side NanoGPT secret;
- never persist a NanoGPT key in extension settings or browser storage;
- do not use SillyTavern's current `/api/sd/nanogpt/generate` unchanged because it logs the entire request body at DEBUG and targets the older native NanoGPT image route;
- no automatic retry of a potentially billable request.

### M03-A — Contract and security evidence

**Status: complete.**

Document NanoGPT image APIs, Qwen capabilities, SillyTavern secret/proxy behavior, local image upload, privacy risks, size limits, and transport alternatives.

Gate result:

- M03-B, M03-C and M03-E may proceed;
- production M03-D transport and paid M03-G diagnostic remain gated on a privacy-safe server-side transport decision.

### M03-B — Request validation and building

Build a pure deterministic validator/request builder for the normalized Image API.

Requirements:

- validate prompt/model/settings;
- `n = 1`;
- preserve reference ordering;
- 0–3 references accepted, 4+ rejected before networking;
- full data-URL references through `input_references`;
- use exact current `qwen-image` metadata for optional guidance/steps/negative-prompt controls instead of guessing field names;
- no fetch, DOM, credentials, or chat mutation.

### M03-C — Provider response normalization

**Status: Accepted (for provable behavior).**

Pure response normalizer and validator implemented in `src/providers/nanogpt-image-response.js` with comprehensive test coverage in `tests/nanogpt-image-response.test.mjs`.

Implemented scope:
- Normalizes documented OpenAI-compatible base64 and remote URL outputs.
- Enforces strict envelope, single-image `n = 1`, and field mutual exclusivity validation.
- Detects provider error envelopes and rejects invalid or unsafe inputs.
- Conservative URL validation: HTTPS only, no credentials, rejects obvious localhost/private/loopback destinations.
- Syntactic check only; full SSRF/DNS-rebinding protection belongs to network layer.
- Strictly fails closed with `unverified-normalized-response-contract` when `source: 'normalized'` is passed, as vendor reference documentation does not specify a normative success envelope for `POST /api/v1/images`. Resolving the normalized success contract is deferred to a future explicitly authorized diagnostic (M03-G).

### M03-D1 — Mocked single-request NanoGPT image transport core

**Status: Accepted.**

Pure single-request transport core implemented in `src/providers/nanogpt-image-transport.js` with comprehensive test coverage in `tests/nanogpt-image-transport.test.mjs`.

Implemented scope:
- Pure `sendNanoGptImageTransportRequest(options)` with injected `dispatch`.
- At most one invocation of `dispatch` per explicit caller invocation (zero automatic retries under any circumstance).
- Conservative billing uncertainty: all post-dispatch failures return `dispatchAttempted: true` and `uncertainBilling: true` (including HTTP 401/403, 429, 4xx, 5xx, network drops, timeouts, caller cancellations, and malformed responses). Only pre-dispatch failures return `dispatchAttempted: false` and `uncertainBilling: false`.
- HTTP status preservation: HTTP status codes (100–599) are preserved on all responses that obtained an HTTP response, including body-parse timeouts, body-parse cancellations, and malformed responses. `status: null` indicates no usable HTTP status was obtained.
- Whole-lifecycle timeout and cancellation covering both `dispatch()` and `response.json()` body parsing via `Promise.race`.
- Resource cleanup: timeout timer handles cleared and caller `AbortSignal` listeners detached in `finally` on every exit path.
- Privacy guarantee: error objects, diagnostics, and module code never leak RP scene prompts, credentials, or image payloads.
- Verified contract compatibility with M03-C response normalizer.

### M03-D2 — Production NanoGPT transport

**Status: Subdivided into D2A, D2B1, and D2B2.**

- **M03-D2A (Server path architecture decision): Accepted.** Narrow SillyTavern core proxy route update selected (`GET`/`POST /api/sd/nanogpt/images`) over server plugin.
- **M03-D2B1 (SillyTavern normalized proxy): Complete locally.** Implemented and committed in local SillyTavern checkout (`origin/staging` baseline `ad29cbda62e92f145e44d7a10398a38af22ca986`). Adds `GET` capability and `POST` proxy with server-side validation (16-reference generic ceiling and 50 MiB outbound JSON ceiling), `SECRET_KEYS.NANOGPT` authentication, `x-st-nanogpt-proxy: v1` response marker, zero body logging, and 25 unit tests. Not yet submitted upstream; open PR #6107 affects only legacy `/nanogpt/generate` behavior and does not provide the normalized D2B1 contract. D2B2 does not depend on PR #6107; if #6107 or other NanoGPT changes land before a future SillyTavern upstream contribution, D2B1 must be rebased and reconciled against current staging.
- **M03-D2B2 (Chromatic Images production dispatch adapter): Accepted.**
  - Target module: `src/providers/nanogpt-image-dispatch.js`.
  - Comprehensive unit test coverage: `tests/nanogpt-image-dispatch.test.mjs`.
  - Implements `checkNanoGptImagesCapability()` with session-memory caching, `x-st-nanogpt-proxy: v1` marker validation, bounded capability timeout, and caller cancellation cleanup.
  - Implements `createNanoGptImageDispatch()` for standard same-origin POST requests.
  - Implements `sendProductionNanoGptImageRequest()` with universal proxy marker interception across all dispatches (default or custom), pre-flight dependency/capability isolation (`dispatchAttempted: false`), whole-operation timeout budgeting, and conservative post-dispatch failure classification (`uncertainBilling: true`).
  - Privacy guarantee: zero logging or exposure of RP prompts, base64 images, or secrets.

### M03-E — SillyTavern-local image I/O

**Status: Accepted.**

Pure and browser-side primitives implemented in `src/images/local-image-io.js` with comprehensive unit test coverage in `tests/local-image-io.test.mjs`.

Implemented scope:
- Strict durable user image path validator (`validateDurableUserImagePath`) enforcing `/user/images/...` confinement, no traversal (literal, percent-encoded, or double-encoded), no query/fragment, no control characters, and strict PNG/JPEG/WEBP extensions.
- Authentic byte signature detection (`detectSupportedImageFormat`) for PNG, JPEG, and WEBP magic bytes.
- Browser-native Blob/File to canonical data URL conversion (`imageBlobToDataUrl`) using `FileReader` with zero Node Buffer dependencies, full cancellation support, single-settle safety, and reader output validation.
- Same-origin local path reading (`loadUserImageAsDataUrl`) using `fetch` with `redirect: 'error'`, `credentials: 'same-origin'`, and decoupled from SillyTavern CSRF headers.
- Sequential reference batch preparation (`prepareImageReferences`) with hard 3-reference ceiling and pre-conversion budget enforcement against an aggregate 30 MiB ceiling.
- Generated raw base64 upload (`uploadGeneratedImageBase64`) with format derived from magic bytes, separate defensive upload ceiling, safe filename validation ($\le 128$ code units), SillyTavern `getRequestHeaders()` authentication, and independent re-validation of server-returned paths.
- No M04 character-library storage layout or M05 message rewriting is frozen here.

### M03-F — Provider settings and diagnostic UI

**Status: Accepted.**

Implements nonsensitive provider settings and non-billable local diagnostic controls without introducing an API key input, secret storage, or billable request paths.

Implemented scope:
- Persisted settings schema: `extensionSettings.chromatic_images = { resolution: 'auto' }`. Managed via `src/provider-settings.js` (`readProviderSettings` pure reader and `updateProviderResolution` schema-safe mutator dropping unexpected keys).
- Read-only provider & model metadata rendered in settings panel: NanoGPT, `qwen-image`, 1 output, max 3 references.
- Credential readiness probe: `checkNanoGptCredentialReadiness()` in `src/providers/nanogpt-readiness.js` inspects SillyTavern's `POST /api/secrets/read` using `getRequestHeaders({ omitContentType: true })`. Enforces a strict 5,000 ms hard deadline (`Promise.race`), fail-closed status matrix (`configured`, `not-configured`, `unavailable`), and zero credential/response logging or exposure.
- Proxy capability probe: reuses M03-D2B2 `checkNanoGptImagesCapability({ forceCheck: true })`, mapping missing proxy (404) to clear "Update required" status.
- UI DOM controller: `refreshProviderPanel(panel)` in `src/provider-panel.js` manages `#chromatic-images-resolution-select` and `#chromatic-images-diagnostics-run`. Employs WeakMap state tracking, single-flight click locking, generation token invalidation, scoped MutationObserver for DOM detachment, neutral cancellation recovery (`Not checked`), and resilient probe error handling.
- Layout and styling: `settings.html` and `style.css` updated with responsive, SmartTheme-compatible provider and diagnostic sections.
- Verification: comprehensive unit tests in `tests/provider-settings.test.mjs`, `tests/nanogpt-readiness.test.mjs`, `tests/provider-panel.test.mjs`, and `tests/panel.test.mjs`.
- Acceptance: passed independent review and all 7 real-browser smoke checks.

### M03-G — Explicit diagnostic generation

Subdivided into M03-G1 (Compatibility transport & server proxy) and M03-G2 (Diagnostic generation UI & paid execution).

#### M03-G1 — Compatibility Transport & Server Proxy

**Status: Complete (ready for independent review).**

Implements a second, strictly allowlisted image generation transport for the subscription-compatible NanoGPT endpoint (`POST /api/v1/images/generations`) via SillyTavern's local image proxy without breaking or altering normalized transport.

Implemented scope:
- Vendor evidence: NanoGPT Studio export `schema_version: media-integration-spec/v2` (2026-10-08) captured and verified.
- SillyTavern server proxy (`src/endpoints/stable-diffusion.js` on local branch `m03-d2b1-nanogpt-proxy`):
  - Routes: `GET` and `POST` at `/api/sd/nanogpt/images/generations`.
  - Proxy marker: `x-st-nanogpt-proxy: v1-compat`.
  - Upstream target: `POST https://api.nano-gpt.com/api/v1/images/generations` with `redirect: 'error'`.
  - Strict payload validation: `model === 'qwen-image'`, trimmed prompt 1..3000 UTF-16 code units, `nImages === 1` (rejects `n` and other aliases), 7 allowed resolutions, `response_format === 'b64_json'`, mutually exclusive `imageDataUrl` (1 reference) vs `imageDataUrls` (2-3 references) with authentic PNG/JPEG/WebP magic bytes and $\le 30$ MiB aggregate decoded bytes.
  - Safeguards: 50 MB local application payload limit (HTTP 413), 50 MB upstream response ceiling with stream counting via `Transform` (HTTP 502), client disconnect abort propagation, and zero sensitive body logging.
  - SillyTavern unit test suite: 25 comprehensive tests in `tests/stable-diffusion.test.js` (total 50 suite tests passing).
- Chromatic Images compatibility request builder (`src/providers/nanogpt-qwen-compat-request.js`):
  - Pure function `buildQwenImageCompatibilityRequest(options)`.
  - Maps references to `imageDataUrl` (1 ref) or `imageDataUrls` (2-3 refs), enforces bounds, and validates data URLs.
  - Unit tests: 10 tests in `tests/nanogpt-qwen-compat-request.test.mjs`.
- Chromatic Images compatibility dispatch adapter (`src/providers/nanogpt-image-dispatch.js`):
  - `checkNanoGptGenerationsCapability(options)` with isolated session-memory cache `cachedGenerationsCapabilitySupported`.
  - `clearNanoGptGenerationsCapabilityCache()` clearing only the compatibility cache.
  - `createNanoGptGenerationsDispatch(dependencies)` targeting `POST /api/sd/nanogpt/images/generations`.
  - `sendProductionNanoGptGenerationsRequest(options)` with pre-flight checks, timeout budgeting, and universal `v1-compat` marker verification wrapping default or custom dispatches.
  - Unit tests: 15 compatibility dispatch tests in `tests/nanogpt-image-dispatch.test.mjs` (total 64 suite tests passing).
- Isolation: normalized route (`v1`) and compatibility route (`v1-compat`) never share cache state or accept each other's markers.
- Boundaries: zero paid calls, no diagnostic generation UI, no image generation.

#### M03-G2 — Diagnostic Image Generation & Settings UI Wiring

**Status: Planned (pending independent review).**

First deliberately billable path, available only after M03-G1 independent review approval.

Flow:

~~~text
explicit diagnostic click
 -> validate
 -> load 0–3 refs
 -> build compatibility request
 -> one NanoGPT call via compatibility dispatch
 -> normalize
 -> local upload
 -> show durable local path/preview
~~~

Failures never mutate chat and never auto-retry.

### M03-H — Integration and closeout

Validate:

1. 0 refs;
2. 1 ref;
3. 2 refs;
4. 3 refs;
5. 4th rejected preflight;
6. bad local path -> no paid call;
7. provider failure -> no upload;
8. upload failure -> no false durable result;
9. successful local output survives reload;
10. Android/mobile diagnostics;
11. no surprise generation on reload/chat switch;
12. M02 proposal and Regex behavior remain intact.

Update documentation with the exact shipped transport/model/settings behavior.

### Stop point

No proposal Generate wiring. M05 remains the first end-to-end `CI_IMAGE` generation milestone.

## M04 — Stable character identity and trusted reference library

### Goal

Create the only substantial extension-owned persistent domain: trusted character references bound to stable character identities/cards.

### Identity rules

Permanent storage identity must not be:

- display name;
- short/full name alone;
- Chromatic Dialogue cN ID;
- chat ID.

Preferred model:

- stable ChromaticImages identity associated with an actual SillyTavern character card where possible;
- card/avatar identifier as local binding/fallback;
- names, aliases, and optional Chromatic Dialogue names as resolver signals only.

If duplicated/imported cards share an embedded ChromaticImages identity, detect the collision and let the user choose whether they intentionally share one visual identity or need a new identity.

### Reference-set model

~~~text
Character identity
  stableId
  cardBinding
  displayName
  aliases[]
  referenceSets[]
    outfit/reference-set name
    description
    references[]
      stableRefId
      label
      type/view
      description
      localPath
~~~

### Required work

- inspect/prove supported SillyTavern character-card extension metadata and/or stable binding mechanism;
- inspect/prove supported per-character nested asset storage API;
- explicit Import Images workflow;
- reference-set/outfit CRUD;
- recommend 3+ distinct trusted refs per outfit;
- no generated RP image import shortcut;
- local reference binaries remain character-scoped where supported;
- metadata may fall back to extension settings if arbitrary adjacent metadata files are unsupported;
- deterministic name/alias resolver;
- ambiguity UI instead of guessing;
- optional Chromatic Dialogue registry/name information may aid current-chat resolution but cannot be required.

### Acceptance gates

- three distinct cards named Hina remain distinguishable;
- renaming/display-name changes do not silently merge libraries;
- Sorasaki Hina and short Hina aliases resolve only when unambiguous/bound;
- ambiguous Hina proposal requests user choice;
- trusted image library survives reload;
- no base64 blobs persisted;
- generated outputs never enter trusted refs automatically;
- at least one real character/outfit with multiple imported refs works on-device.

### Stop point

Reference diagnostics only; proposal Generate remains unwired.

---

## M05 — Message rewrite primitives and first end-to-end generation MVP

### Goal

Connect proposal, trusted refs, provider, local upload, and chat-message persistence.

### SLAY donor responsibilities

Port/adapt proven logic for:

- safe message-source replacement;
- `message.mes`;
- `message.extra.display_text`;
- assistant `swipes`;
- `swipe_info` fields where relevant;
- `context.saveChat()`;
- preserving already-valid image paths on transient failures.

Do not copy SLAY's immediate-generation trigger model.

### Required flow

~~~text
CI_IMAGE
  -> inline card
  -> user Generate
  -> stale-source/chat guard
  -> resolve character identities
  -> choose <=3 trusted refs
  -> build Qwen prompt
  -> NanoGPT
  -> upload result locally
  -> replace exact CI_IMAGE with Markdown + CI_RESULT
  -> saveChat
  -> rerender
~~~

### Safety

Before paid request:

- origin chat/message still valid;
- current source still contains the exact approved CI_IMAGE;
- no concurrent request for same proposal;
- ambiguous identity unresolved => block/ask user;
- reference selection visible/inspectable enough for MVP.

After request:

- if provider fails: leave CI_IMAGE unchanged;
- if local upload fails: leave CI_IMAGE unchanged;
- only transition message after local path exists;
- never attach result to whichever chat happens to be active later.

### Acceptance gates

- real proposal generates only after Generate tap;
- successful result becomes Markdown + CI_RESULT;
- reload reconstructs reviewable generated state with no separate DB;
- no reload regeneration;
- double-tap cannot duplicate request;
- stale source/chat blocked;
- message/swipe tests confirm old proposal/result does not resurrect unexpectedly;
- local output path used, not temporary remote URL.

### MVP checkpoint

M05 is the first end-to-end usable MVP.

---

## M06 — Result actions: Edit & Regenerate, Regenerate, Keep

### Goal

Use CI_RESULT as temporary durable regeneration metadata and finalize images cleanly.

### Required work

- Regenerate from CI_RESULT;
- Edit Prompt & Regenerate;
- reference inspection/override for that attempt;
- optional seed behavior where supported;
- replacement of old result only after new generation + local upload succeeds;
- Keep removes exact CI_RESULT and leaves Markdown;
- finalized Markdown no longer exposes regeneration controls;
- preserve old working image if regeneration fails.

### Acceptance gates

- failed regeneration never destroys current working image;
- Keep survives reload as ordinary Markdown;
- result controls are reconstructed solely from message text;
- no result database introduced;
- every regeneration remains explicit paid action.

---

## M07 — Multi-reference/outfit selection policy

### Goal

Use richer trusted reference sets while respecting the global three-image provider cap.

### Default policy

1. give each visible resolvable character at least one reference until slots are exhausted;
2. use remaining slot(s) for additional references from the selected/relevant outfit set;
3. stay <=3 total;
4. allow manual override;
5. never use generated RP outputs as candidate refs.

Examples:

~~~text
1 character -> up to 3 refs from selected outfit
2 characters -> 1 + 1 first, then deterministic third slot
3 characters -> 1 each
4+ characters -> at most 3 backed identities
~~~

Metadata-assisted selection may later use label/type/description. AI-assisted selection is deferred until there is evidence it improves results safely.

### Acceptance gates

- allocator pure/tested/deterministic;
- exact sent refs visible to user;
- Image N mapping always matches binary order;
- no cross-character trait assignment;
- outfit/ref-set selection does not silently drift identity.

---

## M08 — Image viewer, mobile/interruption hardening, compatibility

### Goal

Make daily-driver behavior robust.

### Areas

- custom viewer for ChromaticImages Markdown images;
- click/tap expand;
- zoom/pan/reset/close;
- result controls integrated without storing viewer state;
- responsive proposal/result cards;
- Android/tab interruption handling;
- chat switches during generation;
- message edit/swipe/regeneration interactions;
- Chromatic Dialogue coexistence;
- duplicate-handler/UI prevention;
- accessibility/focus;
- diagnostic logs without secrets/base64.

### Paid-request rule

No automatic retry unless it is provably non-billable. Normal retry requires user action.

---

## M09 — Release hardening

### Goal

Prepare public stable development release.

### Required work

- README/setup aligned with shipped behavior;
- roleplay/Nemo directive;
- trusted-reference setup guide;
- explanation of character identity ambiguity;
- NanoGPT/privacy documentation;
- troubleshooting;
- AGPL attribution;
- version consistency;
- clean install/update tests;
- desktop + Android smoke tests;
- no secrets/personal generated images/temp files committed.

---

# Deferred work

- multiple providers;
- automatic no-click generation;
- generated-image-to-reference promotion;
- AI-selected reference files by default;
- cloud reference library;
- external image hosting;
- wardrobe system;
- video generation;
- gallery/database system;
- migration of SLAY settings;
- hard dependency on Chromatic Dialogue;
- global cN identity semantics;
- fuzzy automatic identity matching.

# Mission acceptance discipline

1. The canonical repository/local checkout is the baseline.
2. Only one bounded mission is active at a time.
3. Gemini implements coding work only when explicitly assigned; ChatGPT may directly own research/documentation missions.
4. Review the actual pushed diff/content rather than implementation claims.
5. Run the full relevant validation in the canonical checkout.
6. Perform real SillyTavern smoke tests whenever runtime behavior changes.
7. Do not commit credentials, personal generated images, or transient artifacts.
8. Accept the current mission before advancing the roadmap.
9. Roadmap status changes after acceptance, not merely after implementation.

See `docs/architecture.md` for full invariants and workflow.

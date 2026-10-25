# Chromatic Images

**Chromatic Images** is a browser-side SillyTavern extension for proposal-first, context-aware image generation during roleplay.

It belongs to the planned **Chromatic** family of SillyTavern extensions alongside Chromatic Dialogue.

> **Project status (2026-10-25):** M01–M03 are accepted, including explicit settings-only diagnostic generation. D01-SP-2 public `apply`/`remove` was published at `10ca7d502d9b26803c16d3493f442b706276cd78` and accepted on an owner-operated Android/Termux device using only independent disposable fixtures for the exact certified SillyTavern commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`. General release and mutation of any real installation are **not** authorized by this acceptance. The older P3B atomic-swap/recovery path remains deferred; automatic roleplay generation and M04/M05 character-reference/proposal Generate work remain future milestones.

## Product goal

Chromatic Images lets the roleplay model decide when a scene is worth illustrating while keeping image-provider mechanics, credentials, local files, reference selection, and generation settings under extension/user control.

Receiving a proposal must **never** make a paid image request by itself.

The intended message lifecycle is:

~~~text
Roleplay prose
    |
    | model proposes an illustration
    v
<!-- CI_IMAGE {"characters":["Hina"],"prompt":"..."} -->
    |
    | extension renders an inline proposal UI
    | user presses Generate
    v
reference resolver + Qwen prompt builder
    |
    v
NanoGPT qwen-image
    |
    v
SillyTavern local image upload
    |
    v
![ChromaticImages](/local/path/to/image.png)
<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"...","path":"/local/path/to/image.png"} -->
    |
    | user may Regenerate / Edit & Regenerate / Keep
    v
Keep removes CI_RESULT and leaves ordinary durable Markdown
~~~

The chat message is the durable state. Chromatic Images does not need a separate database for pending proposals or generated-image state.

## Core separation of responsibilities

### The roleplay model owns

- deciding whether an illustration would add value;
- naming the characters visibly present;
- describing the visually relevant current scene:
  - pose and action;
  - expression;
  - interaction;
  - environment;
  - framing/composition when useful.

### Chromatic Images owns

- parsing and validating control records;
- resolving model-used names to trusted character identities;
- rendering proposal/result controls;
- trusted reference-image storage and metadata;
- reference allocation;
- NanoGPT authentication;
- Qwen-specific request parameters;
- the three-reference input limit;
- binary image/data-URL handling;
- identity/reference instructions;
- paid-request approval;
- message rewriting and saveChat persistence;
- regeneration/finalization controls;
- image viewer/lightbox behavior;
- mobile-safe UI and lifecycle handling.

The roleplay model must never need to know reference slot numbers, local paths, base64, API payloads, seeds, guidance, steps, or provider details.

## Control protocol

### Proposal

The model may emit at most one standalone proposal record per assistant response:

~~~text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"Hina and Ako sit opposite each other at dinner. Hina pauses mid-bite and gives Ako an irritated sideways look."} -->
~~~

For protocol v1:

- characters is an ordered array of character names and may be empty for environment/object scenes;
- prompt is the current visual scene description;
- unknown fields are rejected;
- the record is a standalone one-line HTML comment;
- unrelated roleplay prose is not rewritten;
- Chromatic Images must coexist with other auxiliary records such as Chromatic Dialogue CD_NEW records.

The model emits only CI_IMAGE. CI_RESULT is extension-owned.

### Generated/reviewable result

After a successful provider response and successful local SillyTavern upload, the extension replaces the exact CI_IMAGE record with:

~~~text
![ChromaticImages](/user/images/.../ci_example.png)

<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"...","path":"/user/images/.../ci_example.png"} -->
~~~

CI_RESULT is durable regeneration metadata while the image remains reviewable.

The initial result payload should stay intentionally small. Later versions may add reference IDs, seed, or generation parameters only when they are needed for reproducible regeneration.

### Keep

Keep means:

~~~text
Markdown image + CI_RESULT
    ->
Markdown image only
~~~

The image remains in the chat permanently as standard Markdown. Chromatic Images no longer treats it as a regeneratable result.

If the extension is disabled or removed, kept images should remain ordinary renderable Markdown images.

## Prompt hygiene

Stored chat may contain:

- CI_IMAGE proposal records;
- CI_RESULT result records;
- ChromaticImages-owned Markdown image records.

These are persistence/display artifacts, not future roleplay instructions.

Chromatic Images should use a managed SillyTavern Regex integration, derived from the proven Chromatic Dialogue manager, to remove its own control records and generated-image Markdown from outgoing model context without mutating the stored chat.

## Trusted character reference library

Reference images are **trusted user inputs**, never generated outputs.

Chromatic Images must never automatically promote an AI-generated RP image into the trusted reference library. Generated images may contain subtle hallucinated traits and feeding them back as identity evidence can cause cumulative design drift.

Reference import is an explicit user action.

### Identity is not the display name

Multiple SillyTavern cards may share the same visible name. Therefore names such as Hina, Sorasaki Hina, or Chromatic Dialogue IDs such as c1 are not permanent storage keys.

Where supported, Chromatic Images should assign/bind a stable extension-owned identity to the actual SillyTavern character card. A card/avatar identifier may be used as a local binding/fallback, but the visual library should not rely on a globally unique display name.

Conceptually:

~~~text
stable ChromaticImages identity
    |
    +-- linked SillyTavern character card
    +-- display name
    +-- aliases
    +-- optional current-chat Chromatic Dialogue names
    |
    +-- reference sets / outfits
~~~

Chromatic Dialogue may improve name resolution, but Chromatic Images must remain usable without it.

### Ambiguity must never be guessed

If three distinct installed characters are all called Hina, the resolver must not silently choose one.

Resolution may use, in order:

1. explicit/current card binding where applicable;
2. exact known alias/full-name binding;
3. optional current-chat Chromatic Dialogue naming context;
4. unique short-name match;
5. user choice when ambiguity remains.

The user's choice may later become an explicit alias/binding, but automatic fuzzy guessing is not allowed.

### Reference sets / outfits

References are organized per trusted character identity and per outfit/reference set:

~~~text
Hina
├── Standard uniform
│   ├── front
│   ├── three-quarter
│   └── full-body
├── Casual
│   └── ...
└── Swimsuit
    └── ...
~~~

The UI should **recommend at least three different trusted images per outfit/reference set** for stronger identity and outfit consistency, but this is a quality recommendation rather than a hard requirement.

A reference may store lightweight metadata such as:

- label;
- type/view;
- description;
- local path;
- stable reference ID.

AI-assisted reference description may be added later, but suggestions must remain user-reviewable.

### Per-character physical storage

The preferred storage model is character-scoped rather than chat-scoped or one undifferentiated global image pool.

Target concept:

~~~text
<character-scoped asset root>/
└── chromatic-images/
    ├── standard/
    ├── casual/
    └── swimsuit/
~~~

The exact supported SillyTavern API/path for creating, listing, and deleting these nested assets must be proven before it is frozen as public behavior.

If arbitrary metadata files beside images are not supported, lightweight reference metadata may live in extension settings while the image binaries remain character-scoped.

## Reference allocation

NanoGPT qwen-image currently accepts at most **3 reference images total per request**.

The library may contain many trusted images. The allocator chooses at most three.

Examples:

~~~text
1 visible character
-> up to 3 useful refs for that character/outfit

2 visible characters
-> one each first, then one remaining slot according to deterministic policy

3 visible characters
-> one reference each

4+ visible characters
-> no more than 3 total refs; UI must make uncovered identities visible
~~~

The first allocator should be deterministic and testable. A future smarter selector may use metadata, but binary slot assignment must not be silently delegated to the roleplay model.

## Identity vs current scene

References establish **who** the character is and, when a specific outfit/reference set is selected, what trusted design evidence exists for that outfit.

The proposal establishes **what is happening now**.

The prompt builder should therefore distinguish identity evidence from current-scene instructions:

~~~text
REFERENCE IDENTITIES

Image 1 depicts Hina.
Use it to preserve Hina's identity, facial features, hair, body characteristics
and distinctive design traits.
Do not copy the reference pose or background unless the current scene calls for it.

CURRENT SCENE

...
~~~

Reference ordering and character-identity mappings are strictly preserved:
- Exactly one reference maps to `imageDataUrl` (representing Image 1).
- Two or three references map to `imageDataUrls[N-1]`, preserving their order.


## Initial image backend

The first provider remains deliberately narrow:

- Provider: **NanoGPT**
- MVP model: **`qwen-image`**
- Project reference limit: **3**
- Initial output count: **1**
- Credentials: reuse SillyTavern's existing server-side NanoGPT secret (`SECRET_KEYS.NANOGPT`); never persist a raw key in Chromatic Images settings or browser storage
- Privacy guarantee: server-side proxies never log RP prompts, base64 images, or credentials; browser code never leaks sensitive payloads

M03 implemented two distinct same-origin SillyTavern server proxy routes:

### 1. Subscription-compatible generations API (Active diagnostic backend)

- **Route:** `POST /api/sd/nanogpt/images/generations` (capability: `GET /api/sd/nanogpt/images/generations`)
- **Proxy marker header:** `x-st-nanogpt-proxy: v1-compat`
- **Upstream destination:** `POST https://api.nano-gpt.com/api/v1/images/generations` with `response_format: 'b64_json'`
- **Reference input:** mutually exclusive `imageDataUrl` (exactly 1 reference) vs `imageDataUrls` (2 to 3 references)
- **Status:** Powers the active diagnostic image generator in the extension settings drawer. Real end-to-end generation is verified across 0, 1, 2, and 3 reference images, with local upload to `/user/images/...`.
- **Prerequisite:** SillyTavern must contain the compatibility proxy patch. The SP-2 CLI can install that patch only on its certified release commit; the historical `m03-d2b1-nanogpt-proxy` development branch is a separate development setup. The route is not merged into stock SillyTavern.

### 2. Normalized Image API (Standardized target)

- **Route:** `POST /api/sd/nanogpt/images` (capability: `GET /api/sd/nanogpt/images`)
- **Proxy marker header:** `x-st-nanogpt-proxy: v1`
- **Upstream destination:** `POST https://api.nano-gpt.com/api/v1/images`
- **Reference input:** `input_references` (array of data URLs)
- **Status:** Pure request building (`buildQwenImageRequest`) and transport dispatch adapters are implemented and verified locally. Because vendor OpenAPI documentation does not specify a normative success envelope, response normalization for this route remains deferred and strictly fail-closed (`unverified-normalized-response-contract`).

M03-A found that stock SillyTavern's existing `/api/sd/nanogpt/generate` route logged its complete request body at DEBUG and targeted an older native route. Both Chromatic Images routes bypass that legacy route and communicate through privacy-safe, zero-body-logging proxies.

## Persistence principles

Only two durable domains are required:

1. **Chat-message state**
   - CI_IMAGE before generation;
   - Markdown image + CI_RESULT while reviewable/regeneratable;
   - Markdown image alone after Keep.

2. **Trusted reference library**
   - stable character-card identity/bindings;
   - outfit/reference-set metadata;
   - local trusted reference paths.

There is no separate pending-proposal database, generation-state database, or per-chat image registry.

Important invariants:

- failed generation leaves CI_IMAGE unchanged;
- failed local upload leaves CI_IMAGE unchanged;
- message transition occurs only after the generated image exists locally;
- reload never automatically issues a paid request;
- large base64/data URLs are not persisted when local paths exist;
- stale UI is revalidated against the current chat/message before any paid action;
- generated RP images are outputs and never automatically become trusted references.

## Generated image viewer

Generated Markdown should stay portable and standard.

Chromatic Images may enhance rendered images identified by its deterministic alt marker, for example alt="ChromaticImages", with a custom viewer that supports:

- tap/click to expand;
- zoom;
- pan;
- close/reset;
- reviewable-result controls when a paired CI_RESULT exists.

Viewer state is transient and does not require persistence.

## Technical direction and code reuse

Chromatic Images follows Chromatic Dialogue's engineering style:

- browser-side SillyTavern extension;
- native JavaScript ES modules;
- no runtime framework;
- no build step for MVP;
- modular src files;
- event-driven runtime;
- pure parser/validator/domain code covered by Node tests;
- safe chat-switch and stale-state handling;
- responsive/mobile-first UI.

The extension's target minimum SillyTavern version is **1.18.0**, but the distributed proxy patch is **not** certified for all 1.18.0+ revisions. Live diagnostic generation requires the compatibility proxy route, provided either by a separately maintained development setup or by the SP-2 patch manager on its exact certified commit; `v1-compat` is not merged into stock SillyTavern.

### Pinned Chromatic Dialogue donor

Initial code reuse should be based on Chromatic Dialogue commit:

**00b1e9d56593d97f259f162fb3bb8a0848417f40**

Strong reuse candidates include:

- lifecycle/initialize-once structure;
- global.d.ts;
- manifest/package scaffold;
- message-reader and its tests;
- event-registration safety patterns;
- strict HTML-comment parser structure;
- stale-source approval/generation guard pattern;
- managed Regex integration and tests;
- panel mounting, accessibility, and responsive UI patterns.

Do not copy Dialogue-specific color, tone, registry, automatic-review, or legacy-migration systems.

### SLAY Images donor

SLAY is the image-mechanics donor for:

- /api/images/upload;
- image data-URL parsing/conversion;
- local image path -> data URL;
- safe message-source rewriting;
- message.mes / display_text / swipes / swipe_info handling;
- saveChat persistence;
- mobile image/network hardening;
- lightbox/presentation lessons.

Port these as small modules; do not inherit SLAY's monolithic provider/wardrobe/legacy architecture.

## Planned repository shape

~~~text
SillyTavern-ChromaticImages/
├── manifest.json
├── index.js
├── settings.html
├── style.css
├── package.json
├── README.md
├── roadmap.md
├── LICENSE
├── docs/
│   └── architecture.md
├── src/
│   ├── constants.js
│   ├── message-reader.js
│   ├── message-runtime.js
│   ├── proposal-parser.js
│   ├── proposal-validator.js
│   ├── message-rewriter.js
│   ├── result-parser.js
│   ├── prompt-hygiene.js
│   ├── reference-library.js
│   ├── reference-resolver.js
│   ├── reference-allocator.js
│   ├── image-storage.js
│   ├── prompt-builder.js
│   ├── generation-guard.js
│   ├── generation-service.js
│   ├── image-viewer.js
│   ├── panel.js
│   └── providers/
│       └── nanogpt-qwen.js
└── tests/
    └── *.test.mjs
~~~

This is a responsibility map, not an instruction to create every module immediately.


## Distribution installer status (D01)

**Implemented and device-accepted for one certified target; not a general-release approval.** D01-SP-2 publishes a worktree-only Git patch manager (`./ci-patch.sh`) with read-only `status`, `check`, and `check-release`, plus public `apply` and `remove`. The implementation commit is [`10ca7d502d9b26803c16d3493f442b706276cd78`](https://github.com/zNe4/SillyTavern-ChromaticImages/commit/10ca7d502d9b26803c16d3493f442b706276cd78). Real-device Android/Termux acceptance on **independent disposable checkouts** passed on 2026-10-25. **No real SillyTavern installation was patched as part of that acceptance.**

The patch is certified **only** for SillyTavern commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, endpoint `src/endpoints/stable-diffusion.js` (stock SHA-256 `15439fdffd839815ef7adcaa39806738c4e4503db8bbb697b337e905dfb4ed43`; patched SHA-256 `16c01a8833a4dbaa547981acdf969e4dc8cb53d018135cb5976a0759d4d87da6`). An unsupported commit, unknown endpoint bytes, modified target index, ambiguous transaction or unsafe symlink must fail closed. The extension's minimum-version goal **does not** imply that the patch works on every SillyTavern 1.18.0+ revision.

For an independently verified compatible installation, the explicit-target CLI shape is:

```sh
./ci-patch.sh status --target /absolute/path/to/SillyTavern --json
./ci-patch.sh check --target /absolute/path/to/SillyTavern --json
# Mutating operations: use only when the installation is deliberately approved for patching.
./ci-patch.sh apply --target /absolute/path/to/SillyTavern --json
./ci-patch.sh remove --target /absolute/path/to/SillyTavern --json
```

`apply` and `remove` modify only the target file in the **working tree**, not the Git index or HEAD. Before each successful mutation they verify a separate recovery backup (mode `0600`) in user-local `${XDG_DATA_HOME:-$HOME/.local/share}/chromatic-images/backups/`; operation locks use `chromatic-images/locks/`. Normal success exits `0`; already-satisfied operations exit `3`; operational refusals exit `1`; usage/invalid-target refusals exit `2`. Public mutation commands reject `CI_LOCK_DIR` overrides, including empty-but-defined values. Backups are retained and there is **no automatic rollback** if a mutation becomes ambiguous; inspect before any manual recovery. Public `recover` is **not supported**.

The older D01-P3B journaled atomic-swap design and its accepted read-only/staging stages remain **historical/deferred**; `swapVerifiedTarget()` and P3B completion/recovery have **not** been enabled by SP-2. General release, future-version certification, and real-installation deployment need separate review and approval.

See [D01 status and history](docs/d01-installer-progress.md), [SP-2 historical design](docs/d01-sp2-plan.md), and [V3-Q2 Android acceptance](docs/d01-sp2-v3-q2-android-acceptance.md).

## Development model

Development now uses the canonical repository directly:

- Source of truth: `zNe4/SillyTavern-ChromaticImages`
- Work is performed in the canonical local checkout.
- One bounded mission is implemented at a time.
- ChatGPT owns architecture/research/review and inspects the actual pushed diff.
- Codex (or another explicitly assigned implementer) handles bounded coding and automated testing; ChatGPT handles architecture, independent review, and acceptance documentation so the coding mission stays focused.
- Full automated validation and relevant real-SillyTavern smoke tests are required before a mission is accepted.
- No credentials, generated user images, or temporary personal artifacts may be committed.
- Future missions do not begin automatically after implementation.

See `docs/architecture.md` for the full architecture and `roadmap.md` for mission gates.

## License

Chromatic Images is intended to use **GNU Affero General Public License v3.0**.

Copied/adapted code must preserve required attribution and license notices.

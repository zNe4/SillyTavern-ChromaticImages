# Chromatic Images

**Chromatic Images** is a browser-side SillyTavern extension for proposal-first, context-aware image generation during roleplay.

It belongs to the planned **Chromatic** family of SillyTavern extensions alongside Chromatic Dialogue.

> **Project status:** M02 is complete and M03 image-engine work is in progress. Proposal parsing, inline proposal UI, durable result recognition, message lifecycle reconstruction, and managed prompt hygiene are implemented. Paid image generation is not enabled yet.

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

The extension must keep Image N aligned with imageDataUrls[N-1].


## Initial image backend

The first provider remains deliberately narrow:

- Provider: **NanoGPT**
- MVP model: **`qwen-image`**
- New-integration target: NanoGPT's normalized Image API, `POST https://api.nano-gpt.com/api/v1/images`
- Reference input: `input_references`
- Project reference limit: **3**
- Initial output count: **1**
- Credentials: reuse SillyTavern's existing server-side NanoGPT secret; never persist a raw key in Chromatic Images settings

M03-A found that current SillyTavern already has a NanoGPT image proxy and server-side secret, but the stock image proxy logs its complete request body at DEBUG and targets NanoGPT's older native image route. Chromatic Images therefore must not use that endpoint unchanged for reference-image generation.

The preferred transport is a privacy-safe same-origin SillyTavern server proxy that retains the existing NanoGPT secret and forwards the normalized Image API without logging prompts or base64 references. See `docs/m03-contract.md` for the evidence and transport gate.

Model-specific controls such as guidance, inference steps, negative prompt, seed, and exact resolution choices must be taken from NanoGPT's current model metadata rather than assumed globally.

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

The target minimum SillyTavern version is **1.18.0**.

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


## Development model

Development now uses the canonical repository directly:

- Source of truth: `zNe4/SillyTavern-ChromaticImages`
- Work is performed in the canonical local checkout.
- One bounded mission is implemented at a time.
- ChatGPT owns architecture/research/review and inspects the actual pushed diff.
- Gemini may implement explicitly assigned coding missions.
- Full automated validation and relevant real-SillyTavern smoke tests are required before a mission is accepted.
- No credentials, generated user images, or temporary personal artifacts may be committed.
- Future missions do not begin automatically after implementation.

See `docs/architecture.md` for the full architecture and `roadmap.md` for mission gates.

## License

Chromatic Images is intended to use **GNU Affero General Public License v3.0**.

Copied/adapted code must preserve required attribution and license notices.

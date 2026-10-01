# Chromatic Images

**Chromatic Images** is a browser-side SillyTavern extension for proposal-first, context-aware image generation during roleplay.

It belongs to the planned **Chromatic** family of SillyTavern extensions alongside
[Chromatic Dialogue](https://github.com/zNe4/SillyTavern-ChromaticDialogue).

> **Project status:** architecture/bootstrap stage. No runtime release exists yet.

## Product goal

Chromatic Images should let the roleplay model decide when a scene is visually worth illustrating without giving the model control over image-provider mechanics, API credentials, local files, reference-image allocation, or generation settings.

The intended flow is:

```text
Roleplay model
    |
    | proposes an illustration
    v
hidden CI_IMAGE control record
    |
    v
Chromatic Images validates the proposal
    |
    v
persistent inline proposal card
    |
    | user presses Generate
    v
character/reference resolver
    |
    v
Qwen identity + scene prompt builder
    |
    v
NanoGPT qwen-image
    |
    v
SillyTavern local image storage
    |
    v
persistent inline generated image
```

Receiving a proposal must **never** make a paid image request by itself.

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

- parsing and validating proposal records;
- rendering the proposal UI;
- local reference-image storage;
- character-to-reference mapping;
- NanoGPT authentication;
- Qwen-specific request parameters;
- the three-reference input limit;
- binary image/data-URL handling;
- identity/reference instructions;
- user edits and reference overrides;
- paid-request approval;
- generated-image persistence;
- retry/regeneration controls;
- mobile-safe UI and lifecycle handling.

The roleplay model should never need to know reference slot numbers, local paths, base64, API payloads, seeds, guidance, steps, or provider details.

## Initial proposal protocol

The first protocol target is one standalone control record per assistant response:

```text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"Hina and Ako sit opposite each other at dinner. Hina pauses mid-bite and gives Ako an irritated sideways look."} -->
```

For the first release series:

- `characters` is an ordered array of character names and may be empty for environment/object scenes.
- `prompt` is the current visual scene description.
- one `CI_IMAGE` proposal is allowed per assistant message;
- the record is hidden from normal chat display;
- the raw record remains the durable proposal source;
- unrelated visible roleplay prose is not rewritten;
- Chromatic Images must coexist with other auxiliary control records, including Chromatic Dialogue's `CD_NEW` records.

The protocol is intentionally semantic. Provider/model settings do not belong in it.

## User experience target

A valid proposal should become an inline card attached to the originating assistant message, conceptually:

```text
┌─────────────────────────────────────────┐
│ Suggested illustration                  │
│                                         │
│ Hina · Ako                              │
│ Hina and Ako sit opposite each other... │
│                                         │
│ References: Hina ×1 · Ako ×1            │
│                                         │
│ [ Generate ] [ Edit Prompt ] [ Refs ]   │
└─────────────────────────────────────────┘
```

The first functional version may expose fewer controls while the generation path is being proven, but the final v0.x target includes:

- **Generate**
- **Edit Prompt**
- **References**
- **Regenerate**
- clear generating/error/retry states
- reload-safe reconstruction
- touch-friendly mobile behavior

## Initial image backend

The initial provider is deliberately narrow:

- Provider: **NanoGPT**
- Model: **`qwen-image`**
- Endpoint target: `POST https://nano-gpt.com/api/v1/images/generations`
- Authentication: `x-api-key`
- Reference input: `imageDataUrls`
- Maximum reference images: **3**
- Initial output count: **1**
- Initial resolution: **`auto`**

Known target generation controls include:

- `num_inference_steps`
- `guidance_scale`
- `negative_prompt`
- `seed`

The first implementation should prove the known-good NanoGPT/Qwen request path before introducing provider abstraction. Chromatic Images is not intended to become a generic multi-provider router during the MVP.

## Character references

Chromatic Images should eliminate the need for temporary external hosts such as Catbox.

Reference images should be stored through SillyTavern's local image storage and converted to data URLs only when constructing the outbound NanoGPT request.

The initial character library is intentionally simple:

```text
Character
  name
  aliases[]
  primary reference
```

Later versions may extend a character to multiple labeled references, for example:

```text
Hina
  primary
  face
  full body
  alternate outfit
```

Qwen's global three-image limit remains authoritative regardless of library size.

### Identity vs current scene

References answer **who the character is**. The proposal answers **what is happening now**.

The prompt builder should therefore distinguish identity from scene state. A reference image should preserve identity/design traits without automatically forcing the reference pose, background, or clothing when the current scene says otherwise.

A future Qwen prompt can follow this pattern:

```text
REFERENCE IDENTITIES

Image 1 depicts Hina.
Preserve Hina's identity, facial features, hair, body characteristics,
and distinctive design traits.
The reference pose, background, and clothing are not necessarily the
current scene unless requested below.

Image 2 depicts Ako.
Preserve Ako's identity and do not merge or transfer traits between
characters.

CURRENT SCENE

...
```

## Persistence principles

Chromatic Images should separate three kinds of state:

1. **Proposal source** — the raw `CI_IMAGE` control record in the assistant message.
2. **Character/reference library** — extension-level persistent settings backed by SillyTavern-local image paths.
3. **Generation result state** — message-associated durable state sufficient to reconstruct a generated card after reload.

Important invariants:

- pending proposals can be reconstructed from raw messages;
- a reload must not automatically trigger a paid generation;
- generated outputs must be copied into SillyTavern local image storage rather than depending on temporary remote URLs;
- large base64/data URLs must not be persisted in chat metadata or prompts;
- stale UI must be revalidated against the current chat/message before a paid request starts.

The exact SillyTavern storage location for durable per-message generation state must be proven against message edits and swipes before it is treated as stable API.

## Security and privacy

- Never commit NanoGPT API keys.
- Never write API keys into chat messages, prompts, generated-state metadata, or diagnostic logs.
- Prefer SillyTavern's supported secret-storage mechanism if available for extensions.
- Reference images sent to NanoGPT are external API inputs; the UI/documentation should make this clear.
- Reference image data should exist in memory only as needed for a request.
- No third-party image host is required for normal operation.

## Technical direction

The extension should follow Chromatic Dialogue's engineering style:

- browser-side SillyTavern extension;
- native JavaScript ES modules;
- no runtime framework;
- no build step for the MVP;
- modular `src/` files;
- event-driven runtime;
- no polling or permanent `MutationObserver` loop unless a later proven SillyTavern limitation makes it necessary;
- pure parser/validator/domain code covered by Node tests;
- safe chat-switch and stale-state handling;
- responsive settings and inline UI.

The target minimum SillyTavern version for the initial development series is **1.18.0**.

## Planned repository shape

```text
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
│   ├── architecture.md
│   └── ...
├── src/
│   ├── constants.js
│   ├── message-reader.js
│   ├── message-runtime.js
│   ├── proposal-parser.js
│   ├── proposal-validator.js
│   ├── proposal-renderer.js
│   ├── settings-store.js
│   ├── reference-library.js
│   ├── reference-resolver.js
│   ├── image-storage.js
│   ├── prompt-builder.js
│   ├── generation-service.js
│   └── providers/
│       └── nanogpt-qwen.js
└── tests/
    └── *.test.mjs
```

This is a responsibility map, not a requirement to create every module in the first mission.

## Development model

Two repositories are used deliberately:

- Canonical/source-of-truth:
  `zNe4/SillyTavern-ChromaticImages`
- AI Studio sandbox:
  `zNe4/SillyTavern-ChromaticImages-aistudio`

AI Studio implements one bounded mission at a time in the sandbox. The canonical repository is updated only after review and validation. See [docs/architecture.md](docs/architecture.md) for the exact workflow and [roadmap.md](roadmap.md) for mission gates.

## Inspirations and reuse

Chromatic Images is a hybrid architecture:

- **Chromatic Dialogue** supplies the structural inspiration for event handling, message retrieval, proposal parsing/validation, safe approval flows, modular UI, persistence discipline, and testing.
- **SLAY Images** supplies image-specific implementation references such as SillyTavern-local image upload, data-URL/reference handling, generated-image persistence patterns, mobile/network hardening, and image presentation.

The project should port only narrowly useful image utilities from SLAY rather than inherit its full provider/wardrobe/legacy feature surface.

Both source projects are AGPL-family projects. Chromatic Images is intended to use **GNU AGPL v3** as well. Any copied/adapted third-party code must keep required notices and attribution.

## Roadmap

The implementation is divided into small, reviewable missions. The first usable end-to-end MVP arrives only after the proposal UI, NanoGPT transport, local character references, and reload-safe generation path have each been proven independently.

See [roadmap.md](roadmap.md).

## License

Planned license: **GNU Affero General Public License v3.0**.

A root `LICENSE` file should be added before implementation code is published as a usable build.

# Chromatic Images roadmap

> Living implementation plan for `zNe4/SillyTavern-ChromaticImages`.
>
> AI Studio performs implementation work only in
> `zNe4/SillyTavern-ChromaticImages-aistudio`. The canonical repository is the
> reviewed source of truth.

## Current state

**Phase:** Bootstrap architecture and planning.

**Runtime code:** none.

**Canonical repository:** `zNe4/SillyTavern-ChromaticImages`

**AI Studio sandbox:** `zNe4/SillyTavern-ChromaticImages-aistudio`

**Initial compatibility target:** SillyTavern 1.18.0+

**Primary real-device target:** mobile SillyTavern usage, with desktop remaining fully supported.

The initial design has been chosen:

- proposal-first rather than automatic generation;
- Chromatic Dialogue architecture as the scaffold;
- selected image utilities/patterns from SLAY Images;
- NanoGPT `qwen-image` as the first and only MVP provider;
- local SillyTavern reference/output storage;
- one semantic `CI_IMAGE` proposal per assistant message;
- explicit user action before every paid generation;
- deterministic reference handling with a global maximum of three Qwen inputs.

## Fixed product decisions

These are project constraints unless a later reviewed decision explicitly changes them.

| Area | Decision |
| --- | --- |
| Product name | Chromatic Images |
| Repository name | `SillyTavern-ChromaticImages` |
| Extension type | Browser-side SillyTavern extension |
| Runtime | Native JavaScript ES modules |
| Framework | None |
| Build step | None for the MVP |
| Minimum ST target | 1.18.0 |
| Primary provider | NanoGPT |
| Initial model | `qwen-image` |
| Paid generation on proposal receipt | Never |
| Paid generation on reload | Never |
| Initial outputs/request | 1 |
| Qwen reference limit | 3 total images |
| External image host | Not required |
| Character references | Stored locally through SillyTavern |
| Proposal source | Raw assistant-message control record |
| Proposal UI | Inline card associated with source message |
| Initial proposal count | Maximum 1 per assistant message |
| Model responsibility | Decide/identify/describe scene only |
| Provider mechanics in model prompt | Forbidden |
| MVP multi-provider abstraction | Explicit non-goal |
| Continuous DOM polling | Explicit non-goal |
| License target | GNU AGPL v3 |

## Protocol target

The MVP proposal record is:

```text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"Current visual scene..."} -->
```

Parser requirements:

- exact standalone one-line control record;
- one record maximum per assistant message in the MVP;
- `characters` must be an array of non-empty strings after normalization;
- duplicate character names are normalized/rejected deterministically;
- `prompt` must be a non-empty string within a documented length ceiling;
- unknown fields are rejected for the v1 protocol rather than silently gaining semantics;
- malformed records never make API requests;
- the parser must coexist with unrelated auxiliary records such as `CD_NEW`;
- visible roleplay prose is not rewritten.

The protocol schema is versionless while only one schema exists. Add explicit versioning before making an incompatible change.

---

# Mission sequence

Every mission has one purpose, explicit acceptance gates, and a stop point. AI Studio must not implement future missions opportunistically.

## M00 — Bootstrap documentation

**Status:** current.

### Deliverables

- `README.md`
- `roadmap.md`
- `docs/architecture.md`

### Acceptance

- product boundaries are explicit;
- canonical/sandbox workflow is explicit;
- proposal-first behavior is explicit;
- NanoGPT/Qwen and three-reference constraint are explicit;
- no implementation code is introduced.

### Exit

User reviews and approves the bootstrap docs. Only then does M01 begin.

---

## M01 — Clean extension scaffold

### Goal

Create the smallest installable Chromatic Images extension with Chromatic
Dialogue-style project structure and lifecycle discipline, but **no proposal
parser and no image generation**.

### Required work

- root `manifest.json`;
- `index.js`;
- `settings.html`;
- `style.css`;
- `package.json`;
- root `LICENSE` using AGPL v3;
- minimal `src/constants.js`;
- minimal panel/bootstrap modules;
- a minimal Node test harness;
- initialization and chat-change handling;
- visible settings panel identifying the project as Chromatic Images.

Use Chromatic Dialogue as a structural reference. Do not copy color, Regex,
registration, tone, contrast, legacy migration, or automatic-review features.

### Acceptance gates

- installs through SillyTavern Extension Manager from a Git URL;
- loads without console errors;
- initializes once;
- chat switching does not duplicate handlers or UI;
- panel remains usable at narrow mobile widths;
- no polling/interval/MutationObserver runtime loop;
- `npm test` passes;
- every JS/MJS file passes `node --check`;
- no API/network request occurs merely by loading the extension.

### Stop point

No `CI_IMAGE` parsing yet.

---

## M02 — Proposal protocol, message inspection, and inline card

### Goal

Prove the complete **model output -> validated proposal -> inline card** path
without introducing any image provider.

### Required work

- adapt the safe message-reader/message-inspector pattern from Chromatic Dialogue;
- implement pure `CI_IMAGE` parser and validator;
- listen to appropriate SillyTavern message/render/chat lifecycle events;
- render one inline proposal card beside/in the originating assistant message;
- reconstruct cards after chat reload/switch by re-reading raw message source;
- never rewrite ordinary roleplay prose;
- invalid/malformed records fail closed;
- card displays character names and scene prompt;
- temporary Generate control may be present but must remain disabled or perform no paid action;
- define a prompt-hygiene strategy so historical `CI_IMAGE` records do not become unwanted model instructions. A manual Regex artifact is acceptable at this stage if managed installation is deferred.

### Acceptance gates

- valid proposal appears once, not duplicated;
- malformed JSON produces no card and no crash;
- proposal in a user/system message is ignored;
- switching chats cannot attach a card to the wrong chat;
- reload reconstructs the pending card from message source;
- no external API call exists;
- works with a message that also contains `CD_NEW`;
- parser/validator/message-inspection tests pass;
- physical/mobile smoke test confirms the card is readable and tappable.

### Stop point

Do not add NanoGPT or character-reference storage.

---

## M03 — NanoGPT/Qwen transport and local image infrastructure

### Goal

Prove the image pipeline independently of roleplay proposals.

### Required work

- implement a dedicated NanoGPT/Qwen provider module;
- use `POST https://nano-gpt.com/api/v1/images/generations`;
- authenticate using `x-api-key`;
- support target parameters:
  - `model: "qwen-image"`
  - `prompt`
  - `imageDataUrls`
  - `resolution`
  - `nImages: 1`
  - `num_inference_steps`
  - `guidance_scale`
  - `negative_prompt`
  - `seed`;
- enforce a provider capability of maximum three reference images;
- investigate and use SillyTavern-supported secret storage for the API key if available;
- never log or persist the key in chat data;
- implement local image -> data URL conversion;
- implement generated response -> SillyTavern local image upload/storage;
- add a developer/manual diagnostic path in the extension panel so transport can be tested without `CI_IMAGE`.

### Validation matrix

Prove manually:

1. prompt with zero references;
2. one local reference;
3. two local references;
4. three local references;
5. fourth reference rejected before request;
6. generated output is saved locally and remains viewable after reload;
7. no Catbox/external temporary upload is needed.

### Acceptance gates

- known-good request body matches the target NanoGPT contract;
- local `/user/images/...` references successfully become request data URLs;
- output becomes a SillyTavern-local path;
- provider errors surface readable diagnostics without exposing secrets;
- a failed request does not automatically retry into a second paid request;
- transport/domain tests pass where practical.

### Stop point

Manual/diagnostic generation only. Do not wire the proposal card's Generate button yet.

---

## M04 — Character identity/reference library

### Goal

Create the extension-owned identity layer that keeps reference mechanics out of
the roleplay model.

### Initial data model

```text
Character identity
  name
  aliases[]
  primaryReference
```

### Required work

- extension-level persistent character library;
- add/edit/delete character identities;
- normalized exact-name/alias lookup;
- one primary local reference per identity;
- reference upload into SillyTavern local image storage;
- thumbnail/status UI;
- safe deletion behavior;
- resolver accepts the proposal's ordered `characters[]` and returns matching identities/references.

### Acceptance gates

- Hina -> Hina reference resolves deterministically;
- Ako -> Ako reference resolves deterministically;
- aliases resolve without fuzzy accidental matches;
- unresolved characters are clearly reported and never silently mapped to another identity;
- library survives reload and chat switching;
- no base64 image blobs are stored in extension settings;
- character library is not copied separately into every chat.

### Stop point

The resolver may be demonstrated in diagnostics; proposal Generate remains unwired until M05.

---

## M05 — First end-to-end proposal generation MVP

### Goal

Connect the proven pieces into the first usable roleplay flow.

### Required flow

```text
CI_IMAGE proposal
    ->
inline pending card
    ->
user presses Generate
    ->
revalidate active chat + source message
    ->
resolve characters/references
    ->
allocate max 3 refs
    ->
build Qwen identity + current-scene prompt
    ->
NanoGPT request
    ->
save generated output locally
    ->
render generated image/card
    ->
persist enough message-associated state to reconstruct after reload
```

### Initial reference allocation

With only one primary reference per identity:

- one character -> one reference;
- two characters -> one reference each;
- three characters -> one reference each;
- four or more characters -> first three resolvable characters receive references; remaining characters are prompt-only and the card must make this visible;
- no hidden fourth Qwen image may be sent.

### Paid-action safety

Before the request starts:

- active chat must still match the proposal's origin;
- source assistant message must still contain the same valid proposal;
- a per-proposal generation lock must prevent double-taps;
- no request starts merely because a card was reconstructed.

After request completion:

- result must not be attached to an unrelated currently active chat;
- local persistence must be completed before presenting a durable success state.

### Persistence gate

This mission must experimentally settle the stable storage mechanism for
message-associated generated state, including behavior around:

- reload;
- chat switching;
- edited source message;
- assistant swipes;
- deleted messages.

Prefer message-associated state rather than a global index, but do not treat
`message.extra` or any other SillyTavern field as guaranteed until tested.

### Acceptance gates

- real Nemo/roleplay proposal can produce an image only after Generate is tapped;
- generated card survives reload;
- reload does not regenerate;
- double-tap does not issue duplicate requests;
- stale source/chat is blocked before paid generation;
- one- and two-character Hina/Ako tests preserve correct identity mapping;
- local output is used after generation, not a remote temporary URL.

### MVP checkpoint

Completion of M05 is the first end-to-end **Chromatic Images MVP**.

---

## M06 — Edit Prompt, reference inspection/override, and regeneration

### Goal

Make the proposal card controllable without exposing provider internals to the
roleplay model.

### Required work

- **Edit Prompt** interaction;
- edited prompt persistence for the proposal state;
- **References** interaction showing automatic resolution;
- per-generation manual reference override;
- **Regenerate** action;
- clear distinction between:
  - reuse same seed;
  - random/new seed, if the provider contract supports the desired behavior;
- user-visible current generation settings where useful;
- safe cancel/close behavior on mobile.

### Acceptance gates

- editing never changes the original visible roleplay prose;
- reference override never mutates unrelated character identities;
- regeneration is always an explicit paid action;
- user can tell which refs will be sent before generation;
- state remains coherent after reload.

---

## M07 — Multiple references per character

### Goal

Extend identity fidelity without making Qwen's global three-input limit
ambiguous.

### Library extension

A character may own multiple labeled references, for example:

```text
Hina
  primary
  face
  full-body
  alternate
```

References may later carry semantic tags such as `primary`, `identity`,
`face`, `full-body`, or `outfit`, but only after the use of those tags is
defined in tests/UI.

### Default deterministic allocator

The automatic allocator should remain simple and explainable:

1. Give each resolvable proposed character one primary reference in proposal order until three slots are filled.
2. If slots remain, add additional references in deterministic character order.
3. Never exceed three total provider inputs.
4. Manual References override can replace the automatic selection.

Examples:

```text
1 character: primary + extra + extra
2 characters: primary A + primary B + one extra
3 characters: primary A + primary B + primary C
4+ characters: refs for at most first 3 resolvable characters
```

### Acceptance gates

- slot allocation is pure/tested and deterministic;
- card shows exactly what will be sent;
- identity prompt maps Image N to the correct character mechanically;
- traits are never assigned to the wrong character by the extension's mapping text;
- no AI model is used to decide binary slot assignment.

---

## M08 — Mobile UX, interruption recovery, and compatibility hardening

### Goal

Reach the robustness expected from a daily-driver SillyTavern extension.

### Areas

- responsive inline cards at phone widths;
- touch-friendly reference chooser;
- image lightbox/zoom only if it materially improves mobile use;
- clear generating, failed, interrupted, and retry states;
- Android browser/network failure handling;
- safe behavior if the tab is killed mid-generation;
- chat switches while generating;
- message edit/swipe/regeneration interactions;
- managed prompt-hygiene setup/repair if not already implemented;
- compatibility testing with Chromatic Dialogue active simultaneously;
- duplicate-handler/duplicate-card prevention;
- accessibility labels/focus behavior;
- diagnostic logging that excludes secrets and base64 payloads.

### Important paid-request rule

Automatic retry must remain conservative. A network failure must not silently
produce multiple billable requests. Retry UI should normally require user
action unless the provider semantics make a transport retry provably safe.

---

## M09 — Release hardening

### Goal

Prepare the first public stable development release.

### Required work

- update README to match shipped behavior exactly;
- add full setup guide and roleplay-model/Nemo directive;
- document NanoGPT configuration and privacy implications;
- add troubleshooting;
- confirm AGPL notices/attribution for adapted code;
- version manifest/package consistently;
- clean install test from canonical GitHub URL;
- update test;
- fresh-chat and existing-chat tests;
- desktop + physical Android smoke tests;
- confirm no secrets, temporary files, base64 dumps, or generated personal images are committed;
- release checklist.

No release is considered stable because AI Studio says it is finished. It is
stable only after canonical-repo validation and real SillyTavern testing.

---

# Deferred work

The following are deliberately outside the initial MVP unless a concrete need
appears during testing:

- generic OpenAI/Gemini/Naistera provider support;
- automatic background image generation without approval;
- model-selected API parameters;
- model-selected reference files or slot numbers;
- server plugin requirement;
- cloud reference library;
- external temporary image hosting;
- wardrobe system;
- video generation;
- multi-image output galleries;
- AI-based reference allocation;
- AI-based prompt rewriting by a second LLM;
- deep integration with SLAY's legacy formats;
- migration of old SLAY settings;
- automatic import from Chromatic Dialogue;
- group-chat-specific semantics beyond ordinary proposal character lists.

# Mission acceptance discipline

For every mission:

1. Canonical `main` is the baseline.
2. Sandbox is reset/synchronized from canonical before AI Studio begins.
3. AI Studio receives one mission only.
4. ChatGPT reviews actual sandbox contents/diff against canonical.
5. Only approved paths move into a mission branch in the canonical repo.
6. Validation is run again in the canonical repo.
7. User tests in SillyTavern when the mission has runtime behavior.
8. Only then is the mission merged to canonical `main`.
9. The roadmap status is updated after acceptance, not merely after implementation.

See [docs/architecture.md](docs/architecture.md) for the complete repository
workflow and architectural invariants.

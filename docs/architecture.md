# Chromatic Images architecture

> Technical source of truth for the initial Chromatic Images development series.

## 1. Purpose

Chromatic Images is a proposal-first SillyTavern image-generation extension.

It is intentionally **not** a fork of SLAY Images and **not** a modified build
of Chromatic Dialogue.

It is a new extension that combines:

- the modular runtime, message inspection, validation, safe user-approval, UI,
  persistence discipline, and test style proven in Chromatic Dialogue;
- selected image-specific implementation patterns from SLAY Images;
- a purpose-built NanoGPT/Qwen path designed around the actual roleplay
  workflow.

The architecture should remain understandable without knowing SLAY's legacy
feature set.

---

## 2. Product boundary

### Roleplay model

The model may answer only these image questions:

1. Is an illustration useful now?
2. Which characters are visibly present?
3. What does the current scene look like?

It expresses that decision through one semantic record:

```text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"..."} -->
```

The model must not select:

- provider;
- image model;
- API endpoint;
- API key;
- local/remote file;
- reference slot;
- base64 input;
- resolution;
- number of outputs;
- inference steps;
- guidance;
- negative prompt;
- seed.

### Extension

Chromatic Images owns all provider and binary-image mechanics and requires an
explicit user action before a paid request.

This boundary is more important than any individual module layout.

---

## 3. Why this architecture

### Why not fork SLAY Images

SLAY already solves many difficult image problems, but its current architecture
is centered on an immediate-generation tag:

```text
image-generation tag exists
    ->
generate
```

Chromatic Images needs:

```text
semantic proposal exists
    ->
validate
    ->
show user
    ->
explicit approval
    ->
generate
```

Retrofitting proposal lifecycle state into SLAY would preserve a large amount
of unrelated provider, wardrobe, compatibility, and legacy behavior.

### Why Chromatic Dialogue is the scaffold

Chromatic Dialogue already models:

```text
MESSAGE_RECEIVED
    ->
read raw assistant message
    ->
parse/validate proposal
    ->
create user-facing review state
    ->
user acts
    ->
re-read source/current state
    ->
reject stale/conflicting state
    ->
perform side effect
```

Chromatic Images replaces the final side effect with a paid image-generation
pipeline. That is an architectural fit rather than a workaround.

### Why not literally gut Chromatic Dialogue

Chromatic Dialogue remains its own product. Chromatic Images should reuse
concepts and carefully adapted modules, not turn one extension into another or
couple their release cycles.

---

## 4. Repository model

### Canonical repository

`zNe4/SillyTavern-ChromaticImages`

Purpose:

- reviewed source of truth;
- installable public repository;
- mission branches;
- pull requests/releases.

### AI Studio sandbox

`zNe4/SillyTavern-ChromaticImages-aistudio`

Purpose:

- disposable implementation workspace;
- one AI Studio mission at a time;
- may be force-reset from canonical;
- its Git history is not trusted as project history.

### Rules

- Never force-push the canonical repository.
- Force-reset/force-push is permitted only for the AI Studio sandbox when
  synchronizing it to the approved canonical baseline.
- AI Studio works only in the sandbox unless the user explicitly changes the
  workflow.
- ChatGPT reviews contents/diffs; it does not approve code merely because AI
  Studio reports success.
- Only reviewed paths are transferred into a canonical mission branch.
- Final tests for a mission run against the canonical repo/branch, not only the
  sandbox.
- Do not advance to the next mission without explicit user direction.
- Do not store credentials in either repository.

### Normal mission flow

```text
canonical main
    |
    | synchronize/reset
    v
AI Studio sandbox main
    |
    | AI Studio implements MNN only
    v
sandbox candidate
    |
    | ChatGPT reviews actual diff
    v
approved paths only
    |
    v
canonical branch mNN-...
    |
    | tests + SillyTavern validation
    v
PR / merge
    |
    v
canonical main
```

---

## 5. Runtime architecture

The runtime should be event-driven.

### Preferred high-level pipeline

```text
SillyTavern lifecycle/message event
    |
    v
message-reader
    |
    v
proposal parser + validator
    |
    v
proposal view model
    |
    v
inline card renderer
    |
    | Generate click
    v
generation guard / stale-source validation
    |
    v
character resolver
    |
    v
reference allocator
    |
    v
Qwen prompt builder
    |
    v
NanoGPT provider
    |
    v
generated-image localizer
    |
    v
generation-state persistence
    |
    v
inline generated card
```

### Event rules

Use SillyTavern events rather than continuous DOM scanning whenever possible.

Expected relevant lifecycle categories include:

- extension/application initialization;
- chat change;
- assistant message received;
- assistant message rendered/re-rendered;
- message update/edit if exposed and required.

Exact event identifiers must be verified against the target SillyTavern
version during implementation.

Avoid:

- permanent polling loops;
- broad MutationObservers watching the whole chat indefinitely;
- cached long-lived chat references that survive chat switching.

A bounded DOM query during an event/render operation is acceptable.

---

## 6. Proposal protocol

### v1 wire record

```text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"Hina and Ako sit opposite each other at dinner."} -->
```

### Parsing rules

The parser should be pure and independently testable.

For v1:

- input must be a string;
- control record must be a standalone one-line HTML comment;
- marker is case-sensitive: `CI_IMAGE`;
- maximum one valid record per assistant message;
- JSON must parse;
- JSON value must be a plain object;
- allowed keys are exactly `characters` and `prompt`;
- `characters` must be an array;
- each character must normalize to a non-empty string;
- normalized duplicate character names are rejected or deduplicated according
  to one documented deterministic rule; prefer rejection initially because it
  surfaces malformed model output;
- `prompt` must normalize to a non-empty string;
- enforce a reasonable maximum length to prevent pathological payloads;
- malformed/unclosed/multiline lookalike records fail closed;
- normal prose containing the words `CI_IMAGE` but not the exact record syntax
  is not a proposal.

### Multiple-extension compatibility

Chromatic Images must not assume its record is the only auxiliary data in a
message.

A typical response may eventually end as:

```text
Visible roleplay prose...

<!-- CD_NEW {"id":"c6","name":"Mara","color":"#B86FD4"} -->
<!-- CI_IMAGE {"characters":["Mara"],"prompt":"Mara enters the candlelit room..."} -->
```

The Chromatic Images parser should concern itself only with its own exact
standalone record.

### Prompt hygiene

The raw record is valuable for durable reconstruction but should not become
uncontrolled historical instruction text in later model prompts.

Before stable release, Chromatic Images must provide a supported prompt-hygiene
mechanism that removes only its control records from outgoing model context
while leaving stored chat messages untouched.

Chromatic Dialogue's managed SillyTavern Regex pattern is the preferred design
reference.

---

## 7. Proposal/card state model

The source control record is authoritative for an ungenerated proposal.

Conceptual states:

```text
invalid
pending
generating
generated
failed/interrupted
stale
```

Rules:

- `pending` can be reconstructed from raw source after reload.
- `generating` is not permission to auto-restart after reload.
- a reload during generation should return to a safe interrupted/retry state,
  never silently issue another billable request.
- `generated` requires a durable local output path.
- `failed` must not loop automatically into a second paid request.
- `stale` means the source/chat changed enough that the stored action no longer
  matches; user must re-evaluate rather than the extension guessing.

The UI may derive some state rather than persisting every transient flag.

---

## 8. Paid-action guard

A generation click must pass a preflight guard.

At minimum:

1. capture origin `chatId`;
2. capture/identify origin message and proposal;
3. prevent concurrent generation for the same proposal;
4. re-read current SillyTavern context;
5. confirm the origin chat is still the active/valid target for the action;
6. re-read the raw assistant source;
7. reparse/revalidate the proposal;
8. verify it matches the proposal the user approved;
9. resolve current reference selections;
10. only then construct/send the NanoGPT request.

If the user changes chat before the request begins, fail safely.

If the request has already been sent and the active chat changes, do not attach
the result to whatever chat happens to be visible. Persist only against the
validated origin if that can be done safely; otherwise surface a recoverable
state.

Use `AbortController` when it actually prevents unnecessary work, but do not
assume aborting a browser fetch guarantees the remote provider did not already
accept/bill the request.

---

## 9. Character identity/reference architecture

### Storage scope

The character identity library is extension-level, not copied into each chat.

Reason: a Hina reference should be reusable across unrelated roleplay chats.

### MVP entity

Conceptually:

```json
{
  "name": "Hina",
  "aliases": ["Sorasaki Hina"],
  "primaryReference": {
    "path": "/user/images/...",
    "label": "Primary"
  }
}
```

Actual schema should include a version and stable internal identity/reference
IDs once CRUD exists.

### Matching

Initial matching should be deterministic:

- canonical normalized name;
- canonical normalized alias;
- exact match after normalization;
- no fuzzy similarity;
- no substring guessing.

The proposal's explicit `characters[]` is the primary resolver input. Do not
fall back to generic scene-prompt name scanning for the main proposal path.

### Local image paths

Persist local SillyTavern paths/metadata, not base64 blobs.

At request time:

```text
local path
    ->
load bytes
    ->
data URL
    ->
NanoGPT imageDataUrls[]
```

After the request, release large transient data where practical.

---

## 10. Reference allocation

Provider capability, not a global arbitrary constant, determines reference
limits.

Initial capability:

```text
NanoGPT / qwen-image
maxReferenceImages = 3
```

### MVP with one primary reference

- 0 characters -> 0 refs.
- 1 resolvable character -> 1 ref.
- 2 resolvable characters -> 2 refs.
- 3 resolvable characters -> 3 refs.
- 4+ characters -> at most first 3 resolvable character primaries.

No hidden truncation should surprise the user; the card/reference UI should
show which identities are backed by images.

### Later multi-reference allocator

When characters own multiple refs:

1. assign one primary to each resolvable character in proposal order until
   slots are exhausted;
2. fill remaining slots with additional refs deterministically;
3. manual override may replace automatic picks;
4. total remains <= provider capability.

The allocator should be a pure function with extensive tests.

---

## 11. Qwen prompt construction

The prompt builder, not the roleplay model, maps binary inputs to identities.

Input:

```text
proposal characters + scene prompt
resolved references
```

Output conceptually:

```text
REFERENCE IDENTITIES

Image 1 depicts Hina.
Preserve Hina's identity, facial features, hair, body characteristics and
distinctive design traits. The reference pose, background and clothing are not
necessarily the current scene unless explicitly requested below.

Image 2 depicts Ako.
Preserve Ako's identity and do not merge or transfer visual traits between
characters.

CURRENT SCENE

<proposal.prompt>
```

Principles:

- mapping text is mechanical;
- Image N must correspond exactly to `imageDataUrls[N-1]`;
- identities must not be swapped;
- reference clothing is not automatically current-scene clothing;
- current scene wins for pose/action/environment/outfit when explicitly
  described;
- avoid inventing traits not present in proposal/reference configuration.

A future reference semantic such as `outfit` may intentionally alter these
instructions, but the MVP should treat primary refs principally as identity
references.

---

## 12. NanoGPT/Qwen provider boundary

Use a dedicated provider module rather than a generic OpenAI-compatible layer.

Target request:

```json
{
  "model": "qwen-image",
  "prompt": "...",
  "imageDataUrls": ["data:image/png;base64,..."],
  "resolution": "auto",
  "nImages": 1,
  "num_inference_steps": 30,
  "guidance_scale": 2.5,
  "negative_prompt": "",
  "seed": 12345
}
```

Endpoint target:

```text
POST https://nano-gpt.com/api/v1/images/generations
```

Header:

```text
x-api-key: <secret>
```

Implementation details must be based on the actually tested NanoGPT response
shape rather than assumptions from unrelated OpenAI image APIs.

### Provider settings

Keep the initial UI small:

- API key / secret connection;
- model fixed to `qwen-image` initially;
- resolution;
- steps;
- guidance;
- negative prompt;
- seed behavior.

Do not add generic endpoint/model/provider selectors during the MVP unless a
real requirement appears.

---

## 13. Image persistence

### References

References are uploaded/stored locally through SillyTavern.

### Generated outputs

Every successful provider output should be localized:

```text
provider result
    ->
obtain image bytes/base64
    ->
SillyTavern /api/images/upload or supported equivalent
    ->
/user/images/... local path
```

The generated card should ultimately render the local path.

Do not rely on a temporary NanoGPT or other remote URL for durable chat state.

### Reuse from SLAY

SLAY is a useful implementation reference for:

- `/api/images/upload`;
- path conventions;
- local image -> data URL conversion;
- handling base64 vs returned URL;
- downscaling/compression when required;
- network/browser error normalization;
- lightbox/mobile image presentation;
- interrupted-generation recovery patterns.

Port only what is needed, in modular form.

---

## 14. Generation-state persistence

This is deliberately a **tested architecture gate**, because SillyTavern
message/swipe semantics matter more than theoretical cleanliness.

Desired property:

> Generated state belongs to the originating message/proposal and can be
> reconstructed after reload without rewriting normal roleplay prose.

Candidate locations may include message-associated `extra` data or a
chat-metadata index keyed by a stable proposal fingerprint. The implementation
must not settle this by guesswork.

M05 must test:

- reload;
- switching away/back;
- message edit;
- deleting the message;
- creating/selecting assistant swipes;
- regenerating an assistant response.

Whichever mechanism is chosen must include source validation so stale state
cannot silently attach to changed content.

Do not persist:

- API key;
- raw reference base64;
- raw generated base64 if a local path exists;
- entire provider response objects unless needed.

---

## 15. Settings vs chat vs message scope

Use the narrowest correct scope.

### Extension/global settings

Appropriate for:

- provider configuration;
- character identity/reference library;
- default generation settings;
- UI preferences.

### Chat scope

Appropriate only for truly chat-level behavior if later needed.

Do not copy the global character library into each chat.

### Message/proposal scope

Appropriate for:

- source proposal identity/fingerprint;
- user prompt override;
- manual ref override for that generation;
- generated local output path;
- seed/parameters needed for regeneration;
- completed generation status.

---

## 16. UI architecture

### Settings panel

Eventually contains:

- provider/API configuration;
- generation defaults;
- character/reference library;
- diagnostics;
- prompt-hygiene status/setup.

### Inline proposal card

Attached to the source assistant message, not a separate global review list.

Important mobile behavior:

- touch targets large enough for phone use;
- no hover-only controls;
- prompt text can wrap/collapse;
- reference thumbnails must not overflow;
- dialogs/sheets must fit narrow viewport;
- progress/error state remains understandable after scroll/re-render.

### DOM ownership

Use extension-specific IDs/classes/data attributes with a `ci-` or
`chromatic-images-` namespace.

Rendering must be idempotent: handling the same message render event twice must
not create duplicate cards.

---

## 17. Failure handling

### Parser/validation failure

- fail closed;
- no generation;
- no crash;
- optional debug log without dumping private story content unnecessarily.

### Missing character reference

Not equivalent to malformed proposal.

The UI should show that the character is unresolved/no reference assigned.
Generation may later be allowed with prompt-only identity if the user chooses;
the extension must never silently substitute another character's ref.

### Provider error

- show readable error;
- preserve proposal;
- permit explicit retry;
- no automatic paid retry loop.

### Interrupted request

On reload/tab kill:

- never assume success;
- never auto-repeat;
- present safe retry/recovery semantics.

---

## 18. Testing strategy

Follow Chromatic Dialogue's preference for pure modules and Node tests.

### Pure tests

High-value targets:

- proposal parser;
- proposal validator;
- normalization;
- character/alias resolver;
- reference allocator;
- prompt builder;
- provider request builder;
- generation-state normalization/fingerprinting.

### Runtime tests with fakes

Where feasible:

- message reading;
- chat-change stale protection;
- duplicate render protection;
- Generate lock;
- persistence adapter behavior.

### Real SillyTavern tests

Required for mission acceptance when relevant:

- fresh install;
- existing chat;
- reload;
- chat switching;
- mobile width;
- physical Android;
- Chromatic Dialogue simultaneously active;
- Nemo-generated real proposal;
- local reference upload;
- actual NanoGPT request;
- assistant edit/swipe behavior.

Automated tests do not replace the real SillyTavern gates.

---

## 19. Security rules

Hard rules:

- API keys never enter Git.
- API keys never enter assistant prompts/messages.
- API keys never enter chat metadata.
- API keys never appear in console logs/errors.
- base64 reference/generated images are not logged.
- large data URLs are not persisted when a local path can be stored.
- the extension sends only user-selected/resolved refs needed for the current
  generation.
- no hidden external image-upload service.
- never instruct users to paste secrets into issue reports or AI Studio prompts.

If SillyTavern exposes a supported secret vault/API for third-party extensions,
prefer it. If not, the fallback storage decision must be reviewed explicitly.

---

## 20. Licensing and attribution

Chromatic Dialogue and the inspected SLAY Images fork both use GNU AGPL v3
licensing.

Chromatic Images should also use GNU AGPL v3.

When implementation code is adapted:

- distinguish conceptual inspiration from copied/adapted code;
- preserve required copyright/license notices;
- document substantial third-party source reuse;
- prefer reimplementation of small generic concepts when that yields clearer
  ownership and architecture;
- do not copy SLAY's monolithic structure merely because a needed function
  exists inside it.

---

## 21. Planned module responsibilities

The exact file list may evolve, but responsibilities should remain separated.

| Area | Responsibility |
| --- | --- |
| `index.js` | bootstrap and lifecycle registration |
| `constants.js` | identifiers, limits, metadata keys |
| `message-reader.js` | safe raw assistant-message retrieval |
| `message-runtime.js` | event registration/orchestration |
| `proposal-parser.js` | exact CI_IMAGE syntax parsing |
| `proposal-validator.js` | semantic schema validation |
| `proposal-renderer.js` | idempotent inline card UI |
| `settings-store.js` | extension-level settings normalization/persistence |
| `reference-library.js` | character/ref CRUD domain |
| `reference-resolver.js` | proposal names -> identities/refs |
| `reference-allocator.js` | provider-capability slot selection |
| `image-storage.js` | local upload/load/data-URL conversion |
| `prompt-builder.js` | identity mapping + current scene |
| `generation-guard.js` | stale/double-click/paid-action checks |
| `generation-state-store.js` | durable message-associated result state |
| `generation-service.js` | end-to-end approved generation orchestration |
| `providers/nanogpt-qwen.js` | NanoGPT request/response boundary |
| `panel.js` | settings panel composition |
| `style.css` | settings + inline/mobile presentation |

Avoid a large central file that owns provider logic, DOM, storage, parsing, and
references at once.

---

## 22. Explicit MVP non-goals

Do not add these opportunistically:

- automatic no-click generation;
- multiple providers;
- wardrobe management;
- video generation;
- gallery system;
- cloud sync;
- remote reference hosting;
- AI-selected reference slots;
- LLM-generated provider prompt translation layer;
- automatic import of SLAY settings;
- automatic import of Chromatic Dialogue state;
- image generation triggered by generic name scanning alone;
- background polling;
- rewriting all assistant messages to embed permanent HTML.

---

## 23. Decision gates

Some decisions should be made only after the prerequisite is testable.

### Gate A — API-key persistence

Resolve in M03 after inspecting the current SillyTavern extension secret API.

### Gate B — durable generated-state location

Resolve in M05 after real tests with message reload/edit/swipe behavior.

### Gate C — multi-reference semantics

Resolve in M07 after observing actual Qwen behavior with one/two/three
references. Do not invent complex scoring before evidence exists.

### Gate D — managed prompt hygiene

A supported solution is mandatory before stable release. Full managed Regex UI
may be implemented earlier or during M08 depending on scope.

These are deliberate evidence-based gates, not permission for AI Studio to make
unreviewed architectural choices.

---

## 24. Definition of first useful success

Chromatic Images has reached its first meaningful MVP when all of the following
work together in real SillyTavern:

1. Nemo emits a valid `CI_IMAGE` record after an RP response.
2. Chromatic Images renders one inline proposal card.
3. No API request occurs until the user presses Generate.
4. Hina/Ako names resolve to configured local references.
5. No more than three refs are sent.
6. The Qwen prompt mechanically identifies which image belongs to which
   character.
7. NanoGPT returns a generated image.
8. The image is saved into SillyTavern local storage.
9. The generated card survives reload.
10. Reload, chat switching, and double taps do not produce surprise paid
    requests.

Everything beyond that is refinement.

# Chromatic Images roadmap

> Living implementation plan for `zNe4/SillyTavern-ChromaticImages`.
>
> AI Studio performs implementation work only in
> `zNe4/SillyTavern-ChromaticImages-aistudio`. The canonical repository is the
> reviewed source of truth.

## Current state

**Phase:** Bootstrap architecture refresh.

**Runtime code:** none.

**Canonical repository:** `zNe4/SillyTavern-ChromaticImages`

**AI Studio sandbox:** `zNe4/SillyTavern-ChromaticImages-aistudio`

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

**Status:** current refresh.

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

### Goal

Prove provider transport and SillyTavern-local image I/O independently of proposal generation.

### Required work

- dedicated NanoGPT/Qwen module;
- POST `https://nano-gpt.com/api/v1/images/generations`;
- `x-api-key` authentication;
- support model, prompt, imageDataUrls, resolution, nImages=1, steps, guidance, negative prompt, seed;
- enforce max 3 refs before request;
- investigate current SillyTavern-supported secret storage;
- local image path -> data URL conversion;
- provider result -> SillyTavern local image upload;
- port/adapt SLAY data-URL parsing/upload helpers as modular code;
- add a manual diagnostic path in settings.

### Validation matrix

1. zero references;
2. one local reference;
3. two local references;
4. three local references;
5. fourth rejected preflight;
6. output saved locally and survives reload;
7. no external temporary host.

### Acceptance gates

- known-good NanoGPT request succeeds;
- secrets never logged/chat-persisted;
- local paths convert successfully to data URLs;
- local upload returns durable path;
- failed request does not auto-retry into another paid request.

### Stop point

No proposal Generate wiring.

---

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

1. Canonical main is baseline.
2. Sandbox is synchronized/reset from canonical.
3. AI Studio receives one mission only.
4. ChatGPT reviews actual sandbox diff.
5. Only approved paths move into canonical mission branch.
6. Validation runs again in canonical repo.
7. User tests in SillyTavern when runtime behavior exists.
8. Mission merges only after acceptance.
9. Roadmap status changes after acceptance, not implementation claim.

See `docs/architecture.md` for full invariants and workflow.

# Chromatic Images architecture

> Technical source of truth for the initial Chromatic Images development series.

## 1. Purpose

Chromatic Images is a proposal-first SillyTavern image-generation extension.

It is a new extension that combines:

- modular runtime/message-safety patterns proven in Chromatic Dialogue;
- selected image upload/rewrite/mobile lessons from SLAY Images;
- a purpose-built NanoGPT/Qwen path;
- a trusted, character-bound reference library.

The roleplay model proposes **what to illustrate**. The extension decides **how to generate it**.

---

## 2. Product boundary

### Roleplay model

The model answers only:

1. Is an illustration useful now?
2. Which characters are visibly present?
3. What does the current scene look like?

It may emit:

~~~text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"..."} -->
~~~

It must not select provider, model, endpoint, key, local file, reference slot, base64, resolution, steps, guidance, negative prompt, or seed.

### Extension

Chromatic Images owns:

- protocol parsing/validation;
- identity resolution;
- trusted reference selection;
- provider/auth/settings;
- explicit paid-action approval;
- local image I/O;
- chat-message rewrite/persistence;
- result/regeneration/finalization UI;
- prompt hygiene;
- image viewing.

---

## 3. Core persistence model

Chromatic Images does **not** use a separate durable proposal/result database.

The chat message itself is authoritative.

### State A — proposed

~~~text
Visible roleplay prose...

<!-- CI_IMAGE {"characters":["Hina"],"prompt":"Hina looks over her shoulder..."} -->
~~~

Runtime UI: proposal card with Generate and related controls.

### State B — generated/reviewable

~~~text
Visible roleplay prose...

![ChromaticImages](/user/images/.../ci_123.png)

<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"Hina looks over her shoulder...","path":"/user/images/.../ci_123.png"} -->
~~~

Runtime UI: generated image plus Regenerate / Edit & Regenerate / Keep.

### State C — finalized

~~~text
Visible roleplay prose...

![ChromaticImages](/user/images/.../ci_123.png)
~~~

Runtime UI: ordinary image, optionally enhanced by the ChromaticImages viewer.

### Transition rules

~~~text
CI_IMAGE
  |
  | explicit Generate
  | provider succeeds
  | local upload succeeds
  v
Markdown image + CI_RESULT
  |
  | explicit Keep
  v
Markdown image
~~~

Failure before the rewrite leaves the original state untouched.

No reload may automatically continue or repeat a paid request.

---

## 4. Why this architecture

### Why not fork SLAY Images

SLAY's trigger model is effectively:

~~~text
generation tag exists -> generate
~~~

Chromatic Images requires:

~~~text
semantic proposal -> validate -> show user -> explicit approval -> generate
~~~

SLAY remains valuable as a donor for image mechanics, not as the product skeleton.

### Why Chromatic Dialogue is the structural donor

Chromatic Dialogue already demonstrates:

- initialize-once lifecycle control;
- safe raw message retrieval;
- strict control-comment parsing;
- re-reading source at approval time;
- rejecting stale chat/message state;
- managed Regex installation/repair;
- modular UI and extensive tests.

Those concerns map directly to Chromatic Images.

### Why not copy Dialogue wholesale

Dialogue-specific color, tone, registration, automatic-review, migration, and registry systems are unrelated.

Reuse should be allowlisted and pinned.

Pinned donor commit:

`00b1e9d56593d97f259f162fb3bb8a0848417f40`

---

## 5. Repository workflow

### Canonical

`zNe4/SillyTavern-ChromaticImages`

Reviewed source of truth.

### AI Studio sandbox

`zNe4/SillyTavern-ChromaticImages-aistudio`

Disposable one-mission implementation workspace.

### Rules

- never force-push canonical;
- force-reset sandbox only;
- AI Studio works only in sandbox unless explicitly changed;
- inspect actual content/diff, not AI claims;
- transfer only reviewed paths;
- final mission tests run against canonical branch;
- do not advance missions without explicit user direction;
- never commit credentials.

---

## 6. Runtime architecture

~~~text
SillyTavern event/render
    |
    v
message-reader
    |
    v
CI parser/validator
    |
    +--> CI_IMAGE -> proposal UI
    |
    +--> Markdown + CI_RESULT -> reviewable result UI
    |
    +--> Markdown only -> finalized image/viewer
~~~

Generate path:

~~~text
Generate click
    |
    v
generation guard
    |
    v
identity resolver
    |
    v
reference allocator <= 3
    |
    v
Qwen prompt builder
    |
    v
NanoGPT
    |
    v
local image upload
    |
    v
message rewriter
    |
    v
saveChat()
~~~

Use SillyTavern events rather than permanent polling or broad whole-chat MutationObserver loops.

Bounded DOM queries during render/event handling are acceptable.

---

## 7. Control protocol

### CI_IMAGE

Model-authored, one standalone one-line HTML comment:

~~~text
<!-- CI_IMAGE {"characters":["Hina","Ako"],"prompt":"..."} -->
~~~

v1 rules:

- marker case-sensitive;
- max one per assistant message;
- JSON must be a plain object;
- exact keys: characters, prompt;
- characters is an array of normalized non-empty strings;
- prompt is a normalized non-empty string with a documented ceiling;
- unknown fields rejected;
- malformed/unclosed/multiline lookalikes fail closed;
- unrelated prose containing CI_IMAGE is not a proposal;
- user/system messages do not qualify.

### CI_RESULT

Extension-authored only:

~~~text
<!-- CI_RESULT {"v":1,"characters":["Hina"],"prompt":"...","path":"/user/images/..."} -->
~~~

Initial exact keys:

- v
- characters
- prompt
- path

The result schema may later gain stable reference IDs, seed, or generation parameters only when needed for reproducible regeneration.

### ChromaticImages Markdown marker

Use a deterministic alt marker:

~~~text
![ChromaticImages](/user/images/.../ci_123.png)
~~~

Do not put scene prose into the alt text.

---

## 8. Prompt hygiene

Stored control/image records must not pollute future roleplay prompts.

A managed SillyTavern Regex integration should remove from outgoing prompt context only:

- CI_IMAGE records;
- CI_RESULT records;
- ChromaticImages-owned Markdown image records.

The stored chat remains unchanged.

The implementation should adapt Chromatic Dialogue's managed Regex manager and tests rather than recreate installation/repair semantics.

Prompt hygiene belongs early in development, not as a late cleanup feature.

---

## 9. Paid-action guard

Before sending NanoGPT:

1. capture origin chat/message/proposal snapshot;
2. prevent concurrent generation for the same proposal;
3. re-read current SillyTavern context;
4. verify origin chat still matches;
5. re-read raw source message;
6. reparse/revalidate current CI_IMAGE;
7. compare current proposal with the user-approved snapshot;
8. resolve current character identities;
9. require user disambiguation if identity is ambiguous;
10. resolve selected trusted references;
11. only then construct/send provider request.

After request submission:

- a chat switch must not redirect the result;
- upload must complete before durable success rewrite;
- aborting fetch does not prove the provider did not accept/bill the request.

This is adapted from Chromatic Dialogue's stale-approval discipline.

---

## 10. Stable character identity

### Names are not storage identity

These are not globally safe keys:

- Hina;
- Sorasaki Hina;
- c1;
- any chat-local CD ID;
- display name alone.

Multiple distinct cards may share the same visible name.

### Preferred identity

Where supported, Chromatic Images assigns/binds a stable extension-owned identity to the actual SillyTavern character card.

Conceptually:

~~~text
ChromaticImages stable ID
    |
    +-- linked ST card/avatar identity
    +-- display name
    +-- aliases
    +-- reference sets
~~~

The exact supported character-card extension metadata mechanism must be verified against target SillyTavern before implementation is frozen.

A local card/avatar identifier may serve as binding/fallback but should not replace the stable CI identity where a better supported identity can be persisted.

### Duplicated card collision

If two installed cards carry the same ChromaticImages identity, do not silently merge.

Offer an explicit choice:

- keep shared visual identity;
- assign this card a new identity.

This lets duplicated cards intentionally share references when appropriate without forcing unrelated same-name cards together.

---

## 11. Identity resolution

The proposal provides names, not internal IDs.

Resolution precedence:

1. explicit/current card binding when applicable;
2. exact known alias/full-name binding;
3. optional current-chat Chromatic Dialogue name/registry context;
4. unique short-name match;
5. explicit user selection when ambiguity remains.

No fuzzy similarity or substring guessing for automatic final resolution.

Example:

~~~text
Installed visual identities:
- Hina / ci_A
- Hina / ci_B
- Sorasaki Hina / ci_C

Proposal:
characters: ["Hina"]

Result:
ambiguous -> ask user
~~~

If the active card is Hina/ci_B and the proposal clearly refers to that card, current-card context may resolve it directly.

Chromatic Dialogue is an optional signal source, not a dependency and not the permanent storage identity.

---

## 12. Trusted reference library

Reference images are authoritative **user-imported inputs**.

Generated RP images are outputs and must never automatically enter this library.

### Reference-set model

~~~text
Character
├── Standard uniform
│   ├── front
│   ├── three-quarter
│   └── full-body
├── Casual
└── Swimsuit
~~~

Suggested entity:

~~~json
{
  "stableId": "ci-character-...",
  "displayName": "Hina",
  "aliases": ["Sorasaki Hina"],
  "cardBinding": "...",
  "referenceSets": [
    {
      "id": "set-...",
      "name": "Standard uniform",
      "description": "...",
      "references": [
        {
          "id": "ref-...",
          "label": "Front",
          "type": "identity",
          "description": "...",
          "path": "..."
        }
      ]
    }
  ]
}
~~~

Recommend at least **three distinct trusted images per outfit/reference set** for fidelity, but do not make three a hard minimum.

AI-assisted description may later suggest metadata, but the user must be able to review/edit it.

---

## 13. Per-character physical storage

The preferred binary storage scope is per character identity/card, not per chat and not one global flat pool.

Conceptual target:

~~~text
<character-scoped asset root>/
└── chromatic-images/
    ├── standard/
    ├── casual/
    └── swimsuit/
~~~

The exact supported SillyTavern mechanism for:

- creating nested character-scoped folders;
- listing;
- uploading;
- deleting;
- surviving rename/export/import behavior

must be proven in M04.

If arbitrary metadata files beside these assets are unsupported, lightweight metadata may live in extension settings while binaries remain character-scoped.

Do not invent unsupported filesystem APIs.

---

## 14. Reference allocation

Provider capability:

~~~text
NanoGPT / qwen-image
maxReferenceImages = 3
~~~

The library may hold many refs. The request may contain at most three.

Baseline policy:

- 0 visible characters -> 0 refs;
- 1 character -> up to 3 refs from selected/relevant set;
- 2 characters -> at least one each, then deterministic third slot;
- 3 characters -> one each;
- 4+ characters -> at most 3 backed identities, clearly disclosed.

Manual override may replace automatic picks.

A future metadata-aware selector may use labels/descriptions, but the roleplay model never selects binary slots.

Generated chat images are never candidate references.

---

## 15. Prompt construction

Input:

- resolved character identities;
- selected trusted refs;
- scene prompt.

Output pattern:

~~~text
REFERENCE IDENTITIES

Image 1 depicts Hina.
Preserve Hina's identity and distinctive design traits.
Do not copy the reference pose/background unless requested by the current scene.

Image 2 depicts Ako.
Preserve Ako's identity and do not merge traits between characters.

CURRENT SCENE

<proposal.prompt>
~~~

If an outfit/reference set is intentionally selected, its trusted design evidence may be described accordingly.

Image N must always map mechanically to imageDataUrls[N-1].

---

## 16. NanoGPT/Qwen boundary

Dedicated provider module; no generic provider abstraction in MVP.

Target:

~~~text
POST https://nano-gpt.com/api/v1/images/generations
x-api-key: <secret>
~~~

Body shape:

~~~json
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
~~~

Implementation must follow the actually tested response contract.

API-key persistence is an explicit M03 investigation against current SillyTavern-supported secret mechanisms.

---

## 17. Image I/O and message rewrite

### Generated image localization

~~~text
provider result
  -> bytes/base64
  -> /api/images/upload or supported equivalent
  -> local SillyTavern path
~~~

No durable dependency on temporary remote URLs.

### Message rewrite

After local upload succeeds, replace the **exact originating CI_IMAGE record** with Markdown + CI_RESULT.

The rewriter must account for SillyTavern representations proven relevant by testing, including lessons from SLAY:

- message.mes;
- message.extra.display_text when applicable;
- assistant swipes;
- swipe_info display/extra fields when applicable.

Then call `context.saveChat()`.

Do not blindly mutate every field; port only behavior proven necessary for target ST semantics.

### Regeneration safety

A failed regeneration must never trade a working local image for an error marker.

Only replace old Markdown/result after the new provider result is locally stored successfully.

---

## 18. Result lifecycle

### Reviewable result

Markdown + CI_RESULT enables:

- Regenerate;
- Edit & Regenerate;
- inspect/change refs for the attempt;
- Keep.

### Keep

Remove the exact CI_RESULT control record and saveChat.

The Markdown remains.

After reload, no regeneration UI should be reconstructed for a kept image.

### Viewer

Rendered images with alt="ChromaticImages" may be enhanced in the DOM with:

- expand/lightbox;
- zoom;
- pan;
- reset;
- close.

Viewer state is transient.

If Chromatic Images is removed, standard Markdown image rendering remains the fallback.

---

## 19. Failure handling

### Parse/validation

- fail closed;
- no API request;
- no crash.

### Missing reference

- distinguish unresolved identity from no available reference;
- never substitute another character;
- allow prompt-only generation only if product/UI explicitly permits it.

### Ambiguous identity

- block automatic generation;
- ask user to select the intended character identity.

### Provider failure

- keep CI_IMAGE unchanged for first generation;
- keep existing working Markdown + CI_RESULT unchanged for regeneration;
- show readable error;
- retry only by explicit user action.

### Upload failure

Same durability rule as provider failure: do not rewrite source state.

### Interrupted browser/tab

- never assume success;
- never auto-repeat paid request;
- reconstruct from persisted message state on next render.

---

## 20. Settings and storage scope

### Extension/global

Appropriate for:

- provider defaults/configuration;
- lightweight reference metadata if it cannot live with character assets;
- stable identity bindings/aliases;
- UI preferences.

### Character scope

Preferred for trusted reference binaries and, where supported, visual-identity metadata.

### Chat/message scope

No separate ChromaticImages database.

Message text itself stores proposal/result/final state.

Do not copy the trusted library into each chat.

---

## 21. Testing strategy

### Reuse from Chromatic Dialogue

Strong candidates:

- message-reader implementation/tests;
- lifecycle initialize-once tests;
- message-runtime event registration/race cases;
- parser edge-case structure;
- stale-approval tests adapted to generation guard;
- Regex integration tests;
- panel accessibility/idempotence patterns.

### Pure tests

- CI_IMAGE parser;
- CI_RESULT parser;
- validator;
- identity normalization/resolution;
- ambiguity behavior;
- reference allocator;
- prompt builder;
- provider request builder;
- message rewrite transforms.

### Runtime tests with fakes

- chat switching;
- duplicate render prevention;
- generation lock;
- Regex installation/repair;
- source revalidation;
- Keep transition.

### Real SillyTavern tests

- fresh install;
- reload;
- active-card rename;
- three different Hina cards;
- group/narrator scenario;
- Chromatic Dialogue simultaneously active;
- imported refs;
- per-character asset storage;
- real NanoGPT request;
- assistant swipe/edit behavior;
- Android/mobile.

---

## 22. Security

- API keys never enter Git;
- never enter chat/control records;
- never enter logs;
- base64 images not logged;
- persist local paths rather than base64;
- send only selected trusted refs for current request;
- no hidden third-party upload host;
- never ask users to paste secrets into AI Studio prompts/issues.

---

## 23. Licensing and donor policy

Chromatic Dialogue and inspected SLAY Images code are AGPLv3.

Chromatic Images uses GNU AGPL v3.

### Chromatic Dialogue donor

Pinned initial donor commit:

`00b1e9d56593d97f259f162fb3bb8a0848417f40`

Copy/adapt only allowlisted generic infrastructure.

### SLAY donor

Use only narrow image primitives/patterns:

- upload;
- data URL conversion;
- message rewrite;
- saveChat/swipe durability;
- mobile/lightbox/network lessons.

Do not copy its monolithic architecture, provider zoo, wardrobe, video, or legacy compatibility surface.

Preserve attribution/license requirements for copied/adapted code.

---

## 24. Planned module responsibilities

| Area | Responsibility |
| --- | --- |
| `index.js` | bootstrap/lifecycle |
| `constants.js` | identifiers/protocol/provider limits |
| `message-reader.js` | safe raw assistant-message access |
| `message-runtime.js` | event orchestration |
| `proposal-parser.js` | CI_IMAGE parsing |
| `result-parser.js` | Markdown + CI_RESULT parsing |
| `proposal-validator.js` | semantic validation |
| `prompt-hygiene.js` / Regex modules | managed outgoing-context stripping |
| `reference-library.js` | stable identity/reference-set CRUD |
| `reference-resolver.js` | proposal name -> trusted identity |
| `reference-allocator.js` | <=3 provider refs |
| `image-storage.js` | local image load/upload/data URL |
| `prompt-builder.js` | identity mapping + scene |
| `generation-guard.js` | stale/double-click/paid-action safety |
| `message-rewriter.js` | CI_IMAGE/result/Keep source transitions |
| `generation-service.js` | approved E2E generation |
| `image-viewer.js` | DOM enhancement/lightbox |
| `panel.js` | settings/reference UI |
| `providers/nanogpt-qwen.js` | NanoGPT boundary |

There is intentionally no `generation-state-store.js`.

---

## 25. Explicit MVP non-goals

- automatic no-click generation;
- multiple providers;
- global cN identity semantics;
- hard dependency on Chromatic Dialogue;
- fuzzy automatic identity matching;
- generated image auto-promotion into references;
- wardrobe management;
- video;
- gallery/database;
- cloud sync;
- external reference hosting;
- automatic SLAY migration;
- background polling.

---

## 26. Evidence gates

### Gate A — API key storage

Resolve in M03 against current SillyTavern capabilities.

### Gate B — per-character asset storage / stable card binding

Resolve in M04 by testing actual supported APIs and rename/duplicate behavior.

### Gate C — message/swipe rewrite semantics

Resolve in M05 by testing reload/edit/swipe behavior before freezing the rewriter.

### Gate D — advanced reference selection

Resolve after real Qwen tests with richer outfit/reference sets.

Prompt hygiene is no longer a deferred gate: it is part of M02.

---

## 27. Definition of first useful success

MVP is achieved when:

1. model emits valid CI_IMAGE;
2. one inline proposal UI appears;
3. no request occurs before Generate;
4. same-name character ambiguity is resolved safely;
5. trusted local refs resolve from the intended character identity;
6. <=3 refs are sent;
7. Qwen prompt maps each ref to the correct character;
8. NanoGPT returns an image;
9. image is uploaded locally;
10. CI_IMAGE becomes Markdown + CI_RESULT and survives reload;
11. Keep removes CI_RESULT and leaves durable Markdown;
12. reload/chat switch/double tap never triggers surprise paid requests.

Everything beyond that is refinement.

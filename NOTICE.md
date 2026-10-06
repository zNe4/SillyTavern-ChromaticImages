# Chromatic Images — Attribution and provenance

Chromatic Images is licensed under the **GNU Affero General Public License v3.0**.
See the repository root `LICENSE` file for the full license text.

This notice records source-code provenance and major implementation references
used during development. It should be updated when future missions copy or adapt
additional third-party code.

## Chromatic Dialogue

Repository:

`https://github.com/zNe4/SillyTavern-ChromaticDialogue`

Pinned donor commit used for the initial Chromatic Images scaffold:

`00b1e9d56593d97f259f162fb3bb8a0848417f40`

Chromatic Dialogue is licensed under GNU AGPL v3.

Chromatic Images M01 and M02 contain code copied or adapted from this pinned
Chromatic Dialogue revision, together with Chromatic Images-specific
modifications.

### M01 — Generic scaffold reuse

The initial M01 reuse is intentionally limited to generic extension infrastructure,
including:

- SillyTavern extension manifest/package structure;
- global SillyTavern typings;
- initialize-once lifecycle and concurrent-initialization guard patterns;
- settings-panel mounting through `renderExtensionTemplateAsync`;
- native inline-drawer accessibility synchronization;
- small theme-aware/responsive settings-panel CSS patterns;
- Node test techniques for lifecycle idempotence, panel mounting, failure
  recovery, and lightweight SillyTavern/DOM fakes.

### M02 — Managed Regex integration reuse

Chromatic Images M02 adapts the generic managed SillyTavern Regex
definition/integration infrastructure from this pinned donor revision,
including:

- canonical managed-field schema and script definitions;
- pure inspection of SillyTavern extension settings by exact script name;
- current, missing, outdated, and duplicate-name conflict states;
- deterministic differing-fields detection;
- disabled-extension detection;
- safe explicit repair preserving unrelated global scripts, unmanaged fields,
  and installed UUIDs;
- atomic save with rollback on persistence failure;
- generic Regex status/repair settings-controller pattern (WeakMap panel state,
  listener idempotency, textContent-only rendering, and accessible feedback).

Chromatic Dialogue-specific product systems were not imported. In particular,
Chromatic Images does not inherit Dialogue color assignments, operation modes,
character registration, automatic review, prompt macros, dialogue-display
regex patterns, two-script display controls, tone styling runtime, or legacy
migration behavior. Chromatic Images uses solely prompt-hygiene regex to hide
its own image records from outgoing prompt context without altering stored
messages or requiring chat reloads.

## SLAY Images

Repository:

`https://github.com/zNe4/SLAYimages`

SLAY Images is licensed under GNU AGPL v3.

SLAY Images is an image-specific implementation reference for planned future
Chromatic Images work. Areas of interest include:

- SillyTavern-local image upload;
- local image path to data-URL conversion;
- image data normalization;
- safe assistant-message source replacement;
- SillyTavern swipe/display-text persistence behavior;
- `saveChat()` usage after image/message updates;
- mobile/network failure handling;
- image viewing/lightbox interaction.

**No SLAY Images source code is included in the M01 scaffold.**

If a later Chromatic Images mission copies or adapts SLAY Images code, this
notice must be updated to identify the donor revision and the adapted
components. Any applicable upstream attribution carried by the adapted SLAY
code must also be preserved.

## Reuse policy

Chromatic Images distinguishes between:

- **copied/adapted code**, which must retain appropriate license/provenance
  information; and
- **conceptual or architectural inspiration**, which should be documented
  without implying source-code copying.

Future donor reuse should remain narrow and mission-specific rather than
copying unrelated product surfaces wholesale.

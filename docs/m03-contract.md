# M03 contract and security evidence

> M03-A / M03-B evidence snapshot for Chromatic Images.
>
> Verified: 2026-10-06 (M03-A), updated 2026-10-07 (M03-B metadata capture).
>
> Documentation and pure request builder: no paid image generation was performed.

## 1. Scope

This document freezes the evidence needed before implementing NanoGPT/Qwen transport and SillyTavern-local image I/O. Claims are marked conceptually as **proven**, **unresolved**, **unsupported for this project**, or **product decision** so later code does not turn assumptions into contracts.

Primary sources inspected:

- NanoGPT Image API: https://docs.nano-gpt.com/api-reference/image-generation
- NanoGPT normalized generation endpoint: https://docs.nano-gpt.com/api-reference/endpoint/image-api-generate
- NanoGPT image model discovery/endpoint metadata:
  - https://docs.nano-gpt.com/api-reference/endpoint/image-api-models
  - https://docs.nano-gpt.com/api-reference/endpoint/image-api-model-endpoints
- NanoGPT OpenAI-compatible image route: https://docs.nano-gpt.com/api-reference/endpoint/image-generation-openai
- NanoGPT authentication: https://docs.nano-gpt.com/authentication
- NanoGPT request billing: https://docs.nano-gpt.com/api-reference/endpoint/request-billing
- NanoGPT Qwen catalog pages, including `qwen-image`, `qwen-image-2.0`, `qwen-image-3`, and `qwen-image-3-pro`
- SillyTavern upstream commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`
- pinned SLAY donor `d9fde435079f73ecaebb0a6961f4ebcaa2bbea3d`

Relevant SillyTavern paths inspected include `src/endpoints/secrets.js`, `public/scripts/secrets.js`, `src/endpoints/nanogpt.js`, `src/endpoints/stable-diffusion.js`, `public/scripts/extensions/stable-diffusion/index.js`, `src/endpoints/images.js`, `src/server-main.js`, `src/users.js`, and `src/constants.js`.

## 2. NanoGPT image API

### 2.1 New-integration route

**Proven:** NanoGPT now provides a dedicated normalized Image API and states that new integrations should prefer it:

`POST https://api.nano-gpt.com/api/v1/images`

Generation is JSON-only and requires API-key authentication. Model discovery is public:

- `GET /api/v1/images/models`
- then use the returned per-model `endpoints` URL / model endpoint metadata.

Model metadata exposes machine-readable `supported_parameters`, pricing and `input_reference_constraints`. These are model-specific and may change, so later code must not treat every optional control as globally valid.

Compatibility image-generation/edit routes remain available, including `/api/v1/images/generations`, but field names are not interchangeable with the normalized API.

### 2.2 Normalized generic request fields

Current generic fields include:

- `model`
- `prompt`
- `n`
- `resolution`
- optional `aspect_ratio`, `quality`, `output_format`, `background`, and `seed` where a selected model supports them
- `input_references`

Chromatic Images fixes `n = 1` for the MVP.

### 2.3 Reference images

**Proven:** normalized requests use `input_references`.

Entries may be public image URL strings, full data URLs, or OpenAI-style `image_url` objects. NanoGPT rejects mixing `input_references` with legacy aliases such as `imageDataUrl`, `imageDataUrls`, `image_url`, or `images`.

**Project decision:** trusted local references will be converted to full data URLs and inserted into `input_references` in deterministic order.

## 3. Qwen model decision

### 3.1 MVP default

Keep exact model ID:

`qwen-image`

Current NanoGPT catalog evidence describes it as:

- approximately USD 0.020/image;
- up to 3 input/reference images;
- route total around 30 MB;
- up to 4 outputs provider-side, although Chromatic Images requests one;
- output up to 1024;
- guidance scale (default 2.5, range 1-20);
- inference steps (default 30);
- negative prompt;
- resolution (`auto` plus explicit choices);
- seed.

**Decision:** do not silently move the MVP to a newer Qwen model.

### 3.2 Newer alternatives

Current catalog also includes:

- `qwen-image-2.0`: text-to-image + edits, up to 3 refs, about USD 0.027/image, up to 1536;
- `qwen-image-3`: text-to-image + edits, up to 3 refs, 1K/2K, about USD 0.030/image, prompt expansion and seed;
- `qwen-image-3-pro`: text-to-image + edits, up to 3 refs, 1K/2K, about USD 0.040/image;
- Qwen Image 2.1 text-to-image variants that do not accept reference inputs, plus separate edit routes.

Qwen Image 3 is a plausible later quality upgrade while preserving the three-reference concept, but changing the default is a product/cost/quality decision, not an M03-A documentation migration.

## 4. Model-specific parameter names
 
**Proven capability & metadata (captured 2026-10-07 via `GET /api/v1/images/models` and `GET /api/v1/images/models/qwen-image/endpoints`):**

The public normalized metadata for `qwen-image` was captured in `docs/m03-qwen-image-metadata.json`.

Exact verified fields:
- `model`: `'qwen-image'`
- `supported_parameters`:
  - `max_prompt_characters`: 3000 (`prompt_length: { "status": "known", "unit": "utf16_code_units", "trim_whitespace": true }`). The provider route limit of 3,000 UTF-16 code units is stricter than the 8,000-character proposal protocol ceiling (`CI_IMAGE`), representing distinct validation layers: proposal validation permits up to 8,000 code units in chat records, while `buildQwenImageRequest()` strictly enforces the provider's 3,000-code-unit ceiling after outer trimming.
  - `resolutions`: `["auto", "1024x1024", "512x512", "768x1024", "576x1024", "1024x768", "1024x576"]`. The metadata does not specify an explicit default; `'auto'` is the Chromatic Images project-selected default.
  - `max_images`: 4
  - `max_output_images`: 4
  - `max_input_images`: 3
  - `input_image_constraints`:
    - `max_items`: 3 (project cap is fixed to 3)
    - `route`: `min_width: 8`, `min_height: 8`, `max_width: 16384`, `max_height: 16384`, `max_bytes: 31457280` (approx 30 MB)
    - `formats`: `["png", "jpeg", "webp"]`
- `allowed_passthrough_parameters`: `[]`

**Resolved normalized JSON names:**
The normalized route for `qwen-image` does **not** expose parameters for guidance scale (`guidance_scale` / `scale`), inference steps (`num_inference_steps` / `num_steps`), negative prompt (`negative_prompt`), or seed (`seed`). `allowed_passthrough_parameters` is explicitly empty (`[]`).

Therefore, M03-B builder strictly rejects caller attempts to inject those fields (or their internal names `guidanceScale`, `inferenceSteps`, `negativePrompt`, `seed`), preserving the purity and security of the normalized request.

## 5. Provider response contract

Inspected official vendor sources (verified 2026-10-07):
- OpenAI-compatible endpoint reference: `https://docs.nano-gpt.com/api-reference/endpoint/image-generation-openai`
- Image generation overview: `https://docs.nano-gpt.com/api-reference/image-generation`
- Normalized generation route reference: `https://docs.nano-gpt.com/api-reference/endpoint/image-api-generate`

### 5.1 Confirmed OpenAI-compatible response format
The OpenAI-compatible image route (`POST /v1/images/generations` and related) is proven by official OpenAPI schemas to return a plain-object envelope with a `data` array:
- Each `data[i]` contains either `b64_json` (raw base64 string, default) or `url` (short-lived signed HTTPS URL), never both and never neither.
- Signed URLs expire after a short period (~1 hour) and are untrusted, temporary representations, never durable Chromatic Images result paths.
- Top-level non-payload metadata fields (`created`, `cost`, `paymentSource`, `remainingBalance`) may be present on the envelope and are not classified as errors.
- Chromatic Images MVP strictly requires `n = 1`, requiring `data` to have length exactly 1.

Current SillyTavern's legacy NanoGPT proxy expects NanoGPT's native response at `data[0].b64_json` and converts it to `{ image: base64 }`.

### 5.2 Unverified normalized response format
**Unresolved:** The official vendor reference documentation for the normalized route (`POST /api/v1/images`) documents request fields and error responses (`missing_model`, `invalid_input_references`, `conflicting_image_inputs`, `unsupported_stream`, `unsupported_provider_options`), but does not provide any normative success response envelope or schema.

Therefore, the normalized success response contract remains unverified. As mandated by project discipline, we do not assume the normalized endpoint returns an OpenAI-compatible envelope merely because both routes exist on the same platform.

### 5.3 Implemented response normalizer boundaries (M03-C)
Pure, deterministic validator implemented in `src/providers/nanogpt-image-response.js`:
- Supported sources: `openai-compatible` (fully validated) and `normalized` (strict fail-closed).
- Source `normalized` strictly returns `{ ok: false, image: null, errors: ['unverified-normalized-response-contract'] }`.
- Error envelope detection: known provider error envelopes (`error` object/string, `object: 'error'`, `status: 'error'`, `type: 'error'`) return `provider-error-response`.
- Base64 validation: pure syntactic character set and padding verification (`invalid-image-base64`). No image decoding performed at this layer.
- URL validation: purely syntactic and conservative. Requires HTTPS (`unsafe-image-url-protocol`), rejects embedded credentials (`unsafe-image-url-credentials`), and rejects obvious localhost, loopback, private RFC1918, link-local, and local-network IPv4/IPv6 destinations (`unsafe-image-url-target`).
- Retrieval security boundary: Syntactic URL validation does not eliminate DNS-rebinding, redirect, or complete SSRF risks; network-level retrieval security and sandboxing belong to later network layers (M03-E). Normalizer never performs network fetches.
- What M03-D may safely reuse: `normalizeNanoGptImageResponse(response, { source: 'openai-compatible' })` can be used to parse mocked/live compatibility responses into `{ ok: true, image: { kind: 'base64', data } | { kind: 'remote-url', url }, errors: [] }`.
- Future resolution: A future explicitly authorized diagnostic (M03-G) must safely inspect the response structure before implementing the normalized adapter. Diagnostics and normalizers must never record or log base64 data, signed URL query tokens, or raw credentials.

## 6. Authentication and browser security

NanoGPT accepts bearer/API-key authentication and recommends backend calls or OAuth PKCE rather than shipping unrestricted secrets in browser JavaScript. It also supports browser-origin restrictions for API keys.

**Project decision:** direct browser -> NanoGPT using a raw spending-capable key is unsupported for the MVP, regardless of whether CORS technically permits it.

The exact live NanoGPT CORS preflight headers were not independently captured in M03-A. This is not blocking because the direct raw-key architecture is already rejected.

## 7. SillyTavern NanoGPT secret

**Proven:** current SillyTavern defines:

`SECRET_KEYS.NANOGPT = "api_key_nanogpt"`

Server-side secrets live in the user's SillyTavern data root (`secrets.json`). Server provider endpoints call `readSecret(..., SECRET_KEYS.NANOGPT)`. Browser-facing secret state is normally masked/existence metadata; raw-key viewing requires explicit server configuration.

**Decision:** Chromatic Images reuses SillyTavern's existing NanoGPT secret and creates no duplicate credential store.

Never persist the raw key in:

- `extensionSettings`;
- localStorage/sessionStorage;
- chat;
- `CI_IMAGE` / `CI_RESULT`;
- logs;
- URLs.

Chromatic Images may later inspect safe credential-readiness state, not the raw value.

## 8. Stock SillyTavern NanoGPT image proxy

Current SillyTavern exposes:

- `POST /api/sd/nanogpt/models`
- `POST /api/sd/nanogpt/generate`

The generate route currently:

1. reads `SECRET_KEYS.NANOGPT` server-side;
2. executes `console.debug('NanoGPT request:', request.body)`;
3. forwards the JSON body;
4. calls the old native `https://nano-gpt.com/api/generate-image`;
5. adds `x-api-key`;
6. expects `data[0].b64_json`;
7. returns `{ image: base64 }`.

Its built-in frontend sends old/native fields such as `negative_prompt`, `num_steps`, `scale`, width/height/resolution and `nImages`.

## 9. Privacy/logging verdict

**NOT ACCEPTABLE FOR CHROMATIC IMAGES AS-IS.**

The stock NanoGPT image proxy logs the complete incoming request body. Current SillyTavern `setupLogLevel()` enables `console.debug` at DEBUG level, and the default `config.yaml` sets `logging.minLogLevel: 0` (DEBUG).

A Chromatic Images request containing references could therefore put into the server terminal/log stream:

- RP scene prompt;
- full base64 character-reference data.

That violates the project invariant that prompts and base64 image payloads are never dumped to diagnostics. Asking users to raise their global log level is not a security boundary.

The proxy also targets NanoGPT's older native route instead of the normalized route recommended for new integrations.

## 10. Transport options

### A. Stock ST proxy unchanged

Advantages: same-origin browser call, existing server secret, no CORS/raw-key exposure.

Blockers: complete body logging and old API contract.

**Verdict: reject as-is.**

### B. Direct browser -> NanoGPT

Avoids an ST server change, but exposes/duplicates a spending-capable credential in page JavaScript.

**Verdict: reject for MVP.**

### C. Chromatic Images server plugin

A plugin can add a privacy-safe server endpoint, but requires `enableServerPlugins`, is not sandboxed, adds installation/distribution burden, and needs a maintainable supported route to reuse the existing NanoGPT secret.

**Verdict: viable fallback only after explicit product decision.**

### D. Narrow SillyTavern core update

Update the already-existing NanoGPT image proxy to:

- retain `SECRET_KEYS.NANOGPT`;
- never log sensitive request bodies;
- forward the normalized `https://api.nano-gpt.com/api/v1/images` contract;
- keep a same-origin browser endpoint.

SillyTavern's provider-integration guidance directs fixes/updates for supported providers through upstream discussion/PR.

**Recommended long-term architecture:** this narrow upstream SillyTavern proxy update.

**Development fallback:** a small server plugin only if waiting for upstream is unacceptable and its distribution tradeoff is explicitly accepted.

### Transport gate

M03-B, M03-C and M03-E can proceed independently.

Production M03-D transport and M03-G paid diagnostic remain gated on the core-update vs plugin decision. Do not silently use direct browser credentials.

## 11. SillyTavern local image upload

### Endpoint

**Proven:**

`POST /api/images/upload`

JSON body:

- `image`: required **raw base64**, not a full data URL;
- `format`: required and validated against SillyTavern media extensions;
- `filename`: optional basename;
- `ch_name`: optional subfolder.

The server sanitizes names, decodes with `Buffer.from(image, 'base64')`, writes under the current user's `user/images`, and returns `{ path: <client-relative-path> }`.

Current SillyTavern serves `/user/images/*` back from that user-scoped directory, so a returned path is fetchable after reload.

For generated still images, Chromatic Images should intentionally support only image formats it has validated (initial target PNG/JPEG/WEBP), not every media extension accepted by the generic endpoint.

### Size ceiling

SillyTavern currently configures JSON/urlencoded body parsing at 500 MB. This is a server parser ceiling, not an application target.

NanoGPT per-model input constraints and mobile memory are the meaningful limits.

## 12. Local path -> provider reference

M03-E should use:

~~~text
validated /user/images/... path
 -> same-origin fetch
 -> Blob/bytes
 -> validate MIME/format
 -> data:<mime>;base64,...
 -> input_references[index]
~~~

Rules:

- reject arbitrary external URLs in the local-path primitive;
- require successful fetch;
- validate supported image MIME;
- preserve deterministic order;
- never log/persist the data URL when a durable local path exists.

The pinned SLAY donor uses the same core pattern: same-origin `fetch(path)` -> `Blob` -> `FileReader.readAsDataURL`, and uploads raw base64 through `/api/images/upload`.

## 13. Size/reference constraints

For the current `qwen-image` catalog snapshot:

- maximum references: 3;
- route total shown: 30 MB.

Base64 expands binary data by roughly one third before JSON overhead. M03-E should use a conservative preflight based on current model endpoint metadata and encoded size rather than relying on SillyTavern's 500 MB parser ceiling.

NanoGPT endpoint metadata is authoritative for accepted formats and max bytes.

## 14. Paid-operation semantics

The normalized Image API is non-streaming.

Abort, timeout or client disconnect does **not** prove that a provider request was not accepted/billed.

NanoGPT's request-billing API can query a request's primary charge for a limited period, but billing may complete asynchronously and a 404 does not prove the request was free. Request IDs are not inference idempotency keys.

**Invariant:** never automatically retry a potentially billable image request.

After submission, timeout/abort/disconnect must be treated as an uncertain outcome and another provider call requires explicit user action.

## 15. Alternative ST services

Current `ConnectionManagerRequestService` supports chat-completion and text-completion profiles; it is not a generic image HTTP proxy.

It does not remove the M03 transport gate.

## 16. Proven facts

- NanoGPT recommends normalized `POST /api/v1/images` for new image integrations.
- Normalized references use `input_references`.
- `qwen-image` currently fits the project's 0–3 reference requirement.
- SillyTavern already stores NanoGPT credentials server-side.
- Stock SillyTavern already has a NanoGPT image proxy, but it logs the complete body at default DEBUG.
- SillyTavern's image upload endpoint accepts raw base64 and returns a durable user-image path.
- UI extension settings are not an acceptable API-key store.
- Connection Manager is not a generic image transport.
- Server plugins provide server-side capability at an installation/security cost.
- No real paid generation was needed to establish these facts.

## 17. Unresolved items

1. **Resolved in M03-B:** Captured current normalized `qwen-image` metadata from `https://api.nano-gpt.com/api/v1/images/models/qwen-image/endpoints` (`docs/m03-qwen-image-metadata.json`). Proven that normalized route supports only `model`, `prompt`, `n`, `resolution`, and `input_references` (max 3, formats png/jpeg/webp). Optional guidance, steps, negative prompt, and seed are not exposed on this route and are rejected as unknown options by the request builder.
2. Normative normalized success response for `qwen-image`; remains unverified in vendor documentation. Implemented response normalizer (`src/providers/nanogpt-image-response.js`) strictly fails closed on `source: 'normalized'`. Resolve from authoritative metadata/schema or future M03-G live validation.
3. Core proxy update vs server-plugin fallback for production transport.
4. If plugin fallback is selected, prove a supported maintainable way to reuse the existing NanoGPT secret without credential duplication.
5. Real Android memory behavior with three large base64 references, to be tested M03-E/H.
6. Exact direct-browser CORS headers, non-blocking because raw-key direct transport is rejected.

## 18. Consequences for M03-B through M03-G

### M03-B

Completed: pure request validator/builder implemented in `src/providers/nanogpt-qwen-request.js` with metadata snapshot in `docs/m03-qwen-image-metadata.json` and exhaustive test coverage in `tests/nanogpt-qwen-request.test.mjs`, pending review acceptance of the final correction.

### M03-C

Accepted for all provable behavior: pure response normalizer and validator implemented in `src/providers/nanogpt-image-response.js` with exhaustive test coverage in `tests/nanogpt-image-response.test.mjs`. Normalizes documented OpenAI-compatible base64 and remote URL outputs. Strictly fails closed on `source: 'normalized'` due to unverified vendor response documentation. Resolving the normalized success contract is deferred to a future explicitly authorized diagnostic (M03-G).

### M03-D1

Implemented pure mocked transport core in `src/providers/nanogpt-image-transport.js` with comprehensive test coverage in `tests/nanogpt-image-transport.test.mjs`.
- Export: `sendNanoGptImageTransportRequest(options)`
- Contract:
  - `options.request`: plain object
  - `options.dispatch`: injected function `(request, { signal }) => Promise<Response>`
  - `options.timeoutMs`: optional positive integer (no internal timer armed if omitted)
  - `options.signal`: optional `AbortSignal` instance
- Invariants:
  - **Single dispatch:** At most one invocation of `dispatch` per explicit caller call. Zero automatic retries under any circumstance.
  - **Conservative billing uncertainty:** Any failure after `dispatch` has been called yields `dispatchAttempted: true` and `uncertainBilling: true` (including HTTP 401/403, 429, 4xx, 5xx, network drops, timeouts, caller cancellations, and malformed responses). Only pre-dispatch failures yield `dispatchAttempted: false` and `uncertainBilling: false`. Successful 2xx responses yield `uncertainBilling: false` (transport outcome unambiguous; not a claim that the call was free).
  - **HTTP status preservation:** `status: number | null` preserves received HTTP status codes whenever an HTTP response was obtained, including body-parse timeouts, body-parse cancellations, and malformed responses. `status: null` indicates no usable HTTP status was obtained.
  - **Lifecycle deadline & cancellation:** Timeout and cancellation cover both `dispatch()` and `response.json()` body parsing via `Promise.race`.
  - **Resource cleanup:** `clearTimeout` and caller signal `removeEventListener` are guaranteed to run in `finally` on every exit path.
  - **Privacy:** Error objects, diagnostics, and module code never leak RP scene prompts, credentials, or image payloads.
  - **M03-C handoff:** Transport `body` is verified compatible with `normalizeNanoGptImageResponse(body, { source: 'openai-compatible' })`.

### M03-D2

Subdivided and resolved through M03-D2A, M03-D2B1, and M03-D2B2:

1. **M03-D2A (Server path architecture decision):** Option A (Narrow SillyTavern core update) was approved over Option C (server plugin). It establishes a dedicated same-origin proxy route (`/api/sd/nanogpt/images`) preserving `SECRET_KEYS.NANOGPT` without logging request bodies or base64 references.
2. **M03-D2B1 (SillyTavern normalized proxy):** Implemented in the local SillyTavern checkout (`origin/staging` baseline `ad29cbda62e92f145e44d7a10398a38af22ca986`):
   - Capability route: `GET /api/sd/nanogpt/images` returns `{ ok: true, route: 'nanogpt-images' }` with header `x-st-nanogpt-proxy: v1`. Makes zero external network calls.
   - Generation route: `POST /api/sd/nanogpt/images` forwards to `https://api.nano-gpt.com/api/v1/images` with server-side `x-api-key`, transparent status and stream piping, independent validation (16-reference generic ceiling and 50 MiB serialized outbound JSON safety ceiling; distinct from separate Qwen provider route constraints), zero request body logging, and response header `x-st-nanogpt-proxy: v1`.
   - Upstream reconciliation note: SillyTavern open PR #6107 affects only legacy `/nanogpt/generate` behavior and does not provide the normalized D2B1 contract. M03-D2B2 does not depend on PR #6107; if #6107 or other NanoGPT changes land before a future SillyTavern upstream contribution, D2B1 must be rebased and reconciled against current staging.
3. **M03-D2B2 (Chromatic Images production dispatch adapter):** Implemented in `src/providers/nanogpt-image-dispatch.js` with comprehensive test coverage in `tests/nanogpt-image-dispatch.test.mjs`:
   - Exports: `checkNanoGptImagesCapability()`, `clearNanoGptImagesCapabilityCache()`, `createNanoGptImageDispatch()`, `sendProductionNanoGptImageRequest()`.
   - Pre-flight capability guard: queries `GET /api/sd/nanogpt/images`, caches positive capability in session memory, and fails closed with `sillytavern-update-required` if proxy is absent.
   - Universal marker verification: wraps every dispatch execution (default or injected) to observe `x-st-nanogpt-proxy: v1` on the raw `Response` before D1 normalization. Unmarked responses never become clean success and clear the capability cache.
   - Whole-operation timeout budgeting: accounts for capability elapsed time and passes remaining budget to D1.
   - Preserves M03-D1 conservative billing uncertainty: post-dispatch failures retain `dispatchAttempted: true` and `uncertainBilling: true`. Pre-dispatch failures guarantee `dispatchAttempted: false` and `uncertainBilling: false`.
   - Privacy guarantee: zero logging or leakage of RP scene prompts, reference images, or credentials.

### M03-E

Cleared for local-path/data-URL and `/api/images/upload` primitives.

### M03-F

Nonsensitive settings/diagnostics may later proceed. Do not add a Chromatic Images API-key field.

### M03-G

Diagnostic generation will use the verified production dispatch adapter once authorized. Direct browser keys remain prohibited.

## 19. M03-A gate result

**PASS, with one explicit transport product decision deferred.**

M03-B request builder is implemented (with final review correction applied).

The project must not reuse `/api/sd/nanogpt/generate` unchanged and must not introduce direct browser API-key storage merely to avoid the server transport decision.

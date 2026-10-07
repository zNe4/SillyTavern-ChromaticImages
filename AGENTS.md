# Chromatic Images — agent instructions

These rules apply to all work in this repository, including Antigravity IDE sessions. Keep them concise; detailed requirements live in the documents linked below.

## Project boundaries

- Canonical repository: `zNe4/SillyTavern-ChromaticImages`. Work in the canonical local checkout; no separate `-aistudio` sandbox is required.
- Product: browser-side SillyTavern extension, native JavaScript ES modules, no build step for the MVP, SillyTavern 1.18.0+ target, mobile-first and desktop-compatible.
- Human-approved, proposal-first image generation. A `CI_IMAGE` proposal or chat reload **never** makes a paid call. Only an explicit user-approved action may initiate one.
- Durable generation state lives in chat messages: `CI_IMAGE`, then Markdown image plus `CI_RESULT`, then Markdown only after Keep. Do not introduce a parallel generation-state database.
- Trusted character references require stable card identity; never identify characters solely by display name or automatically promote generated outputs into trusted reference libraries.
- Max **3** provider reference images; fixed **1** output per MVP request.
- Never expose, persist, or log provider credentials, RP prompts, or reference-image base64. NanoGPT's existing SillyTavern image proxy logs request bodies at DEBUG and **must not be reused unchanged** for Chromatic Images.
- No automatic retries of paid or potentially paid requests. Timeout/abort is not proof of non-billing.
- Fail closed on invalid inputs, stale chat/message identity, ambiguous characters, and unsupported provider fields.

## Source of truth and required reading

At the start of an **implementation mission**, explicitly read the following repository-relative documents before editing:

1. `README.md` — product behavior and constraints.
2. `roadmap.md` — currently authorized milestone and stop boundary.
3. `docs/architecture.md` — architecture and persistence decisions.
4. The mission-specific contract(s), e.g. `docs/m03-contract.md` for M03 provider work.

If the user/task references additional documents, read those too. Do not resolve contradictory requirements by guessing: document the conflict and request a decision.

## Mission discipline

- Implement **only** the explicitly authorized mission. Never opportunistically advance to the next one.
- Before changing files, inspect `git status --short`, current branch, relevant code, and existing tests. Preserve pre-existing user changes.
- For complex or security-sensitive work, create a concise implementation plan for review **before making edits**. Include target files, tests, risks, and open decisions.
- Prefer small, dependency-free, pure modules with `node:test` tests. Match existing patterns; minimize broad refactors, new dependencies, and unnecessary copying from donor projects.
- Do not modify SillyTavern core, add a server plugin, change provider/model, or perform a paid external request without explicit approval.
- Never claim a command or manual/browser test passed if it was not actually run.
- The agent may commit and push **only after** an explicitly authorized implementation task is completed, required local automated checks pass, and only approved files are staged. Never force-push or overwrite unrelated changes.
- A successful push means **ready for independent review**, not that the mission has been accepted. The human/ChatGPT reviewer controls milestone acceptance.
- Read-only research/review/planning tasks must not commit or push unless explicitly asked.

## Verification and handoff

For implementation missions, apply the `chromatic-mission` and `chromatic-verification` skills when available.

- Run `npm test`.
- Run `node --check` on every tracked `.js` and `.mjs` source file, including tests.
- Review `git diff` and `git diff --cached` before committing; ensure no secrets, generated personal images, unrelated files, or oversized payloads enter history.
- For UI/runtime behavior, also identify required real SillyTavern desktop/Android smoke checks. Automated Node tests do not replace those.
- On success, report branch, commit SHA, pushed remote, changed files, exact tests and results, unresolved issues, and manual tests still pending. Stop for review.
- On failure, report the blocker and **do not** commit/push.

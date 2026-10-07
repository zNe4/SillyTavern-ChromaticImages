---
name: chromatic-mission
description: Executes a user-approved Chromatic Images implementation mission in Antigravity IDE, from repository and document review through scoped edits, tests, a clean commit, and push for independent review. Use when asked to implement or fix a milestone.
---

# Chromatic Images — bounded implementation mission

This skill applies **only** when the user has authorized implementation or a correction. For research-only and review-only tasks, do not modify Git history.

## 1. Orient before modifying

1. Inspect `git status --short`, `git branch --show-current`, `git log -1 --oneline`, and existing diff. Do not reset, clean, discard, or silently incorporate user-owned edits.
2. **Read the following repository-relative documents before editing:** `AGENTS.md`, `README.md`, `roadmap.md`, `docs/architecture.md`; also read the exact mission contract (for example `docs/m03-contract.md`) and any paths named in the task.
3. Restate the mission ID, allowed and forbidden files, acceptance criteria, manual checks, and explicit stop point. If authorization/scope is ambiguous, stop and request clarification.

## 2. Plan at the appropriate scale

- Tiny, deterministic correction: state a short plan and proceed.
- Multi-file, security-sensitive, provider/API, or architectural change: prepare an Antigravity **Implementation Plan artifact** and seek approval before editing. Include affected files, dependencies, test matrix, privacy/risk assessment, and decisions that remain blocked.
- Do not commit IDE-only planning artifacts unless the task explicitly lists them as deliverables.
- External docs/metadata lookup may be performed when explicitly allowed. Never make a billable generation request or change external state as an incidental test.

## 3. Implement the approved slice

- Prefer tests for expected behavior and failure boundaries before writing the implementation.
- Keep each layer's ownership clear (pure validation, transport, storage, UI, message-state persistence).
- Preserve chat, credential, privacy, reference-limit, and explicit paid-action invariants in `AGENTS.md`.
- Do not implement downstream missions or modify additional files merely because doing so seems convenient.
- Stop and report unexpected contract changes, provider schema discrepancies, unauthorized work, or security hazards.

## 4. Verify before making a commit

Apply `chromatic-verification` and run its automated checks. Verify the full intended diff against the baseline. For UI/runtime work, capture browser evidence if an accessible test instance is available; explicitly identify any Android/manual checks that were not performed.

If tests fail or files outside the approved set changed, fix within scope or stop. Never conceal a failed or skipped test.

## 5. Commit and push only when safe

When this is an authorized **implementation** task and all required local automated checks pass:

1. Check the current branch and confirm no concurrent changes landed unexpectedly.
2. Stage **only** explicitly authorized files with `git add -- <paths...>`. Avoid `git add -A`.
3. Inspect `git diff --cached --check`, `git diff --cached --name-only`, and `git diff --cached`; confirm no secrets, private images, unapproved files, or large base64.
4. Commit with a concise mission-specific subject, such as `feat: implement M03-C response normalization`.
5. Push the current branch to its configured canonical remote with normal `git push`. **Never force-push, amend shared commits, change remotes, or push another branch without authorization.**
6. If the push is rejected, stop and report; do not force a retry or reset history.

Commit/push happens **before** human acceptance, but does **not** authorize proceeding to the next mission.

## 6. Handoff

Report exact branch/commit SHA, paths, tests with pass/fail counts, changes against scope, privacy implications, limitations, manual smoke tests pending, and what is ready for ChatGPT/human review. Then stop.

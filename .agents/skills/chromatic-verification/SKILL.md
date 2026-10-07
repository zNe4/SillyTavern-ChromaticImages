---
name: chromatic-verification
description: Verifies Chromatic Images code changes for regression, security, mission scope, test execution, and review readiness. Use before committing/pushing an implementation or when auditing a proposed milestone change.
---

# Chromatic Images — verification gate

Use the repository's existing automated test harness. This skill performs checks; it does **not** imply authorization to edit, commit, push, or accept the mission.

## 1. Establish evidence

- Read `AGENTS.md`, the task's mission-specific document(s), and relevant architecture context.
- Identify the agreed baseline commit, current branch, authorized paths, and requested behavior.
- Capture `git status --short` and both staged/unstaged diffs. Determine whether unrelated user changes existed beforehand.
- For a read-only review, do not alter the checkout or Git history.

## 2. Run automated checks

From repository root:

```bash
npm test
```

Then syntax-check **every tracked JavaScript module and test**, not just the files edited:

```bash
git ls-files -z -- '*.js' '*.mjs' |
  while IFS= read -r -d '' file; do
    node --check "$file" || exit 1
  done
```

The command assumes Bash and a compatible Node.js installation. Report any environment or tooling limitation as **not run**, not as a pass. If the mission introduces an additional approved test command, run that too.

## 3. Audit the diff

Inspect `git diff --check`, `git diff --name-status`, `git diff`; repeat with `--cached` when staging is involved. Compare against the accepted baseline, not just the previous terminal output.

Review at least:

- Paths changed are precisely in the user-approved scope; no dependency churn.
- Expected behavior and failure cases have meaningful assertions rather than tests that merely restate implementation.
- No unauthorized auto-generation, paid requests, retry loops, or false claims that an aborted request was not billed.
- No secrets, API keys, full RP prompts, reference base64, local personal images, or debug logging of sensitive payloads.
- No chat/message rewrite until durable local output exists; reload/chat switch must never charge.
- Character identity, source staleness, three-reference limit, and one-output limit remain intact wherever relevant.
- No silent model or provider-schema switch.
- Documentation/comments match the actual code and captured metadata.

Do not paste secrets or base64 payloads into review artifacts.

## 4. Manual/browser verification decision

- Pure function/documentation work: Node tests and source review normally suffice.
- Browser/UI/runtime work: use an accessible local SillyTavern instance and Antigravity browser when possible; record evidence and exact steps.
- Android/mobile-specific acceptance: require an actual device test by the user when appropriate. Desktop emulation alone is insufficient.
- If manual verification remains pending, label it explicitly. A successful commit is still only a **review candidate**.

## 5. Gate outcome

Report one of:

- **Ready to commit/push**: required local automated checks passed and scope/security review is clean.
- **Needs corrections**: concrete failures or defects, with affected files and reproducible evidence.
- **Blocked/unverified**: required commands or environmental/manual checks could not run; distinguish blockers from follow-up smoke tests.

Only the `chromatic-mission` implementation workflow may proceed to commit/push, and only if authorized. Never advance milestone acceptance yourself.

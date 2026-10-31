# Bounded Workflow Store Keys Implementation Plan

> Execute inline with superpowers:executing-plans; use TDD and a final independent review.

**Goal:** Fix the reported 256-character store-key failure in all ten workflow mods without losing readable legacy session state.

**Architecture:** Change `scripts/workflow/adapter.template.ts`, then regenerate the ten adapters with `scripts/sync-workflow.mjs`. Hash the JSON tuple `[cwd, sessionId]` using the existing runtime hash. Read the hashed key first, falling back to the old key only when missing and the old key is at most 256 characters. Persist mutations and explicit resets to the hashed key; keep read-only reports write-free.

**Tech Stack:** TypeScript adapters, Node test runner, existing workflow host harness.

**Spec:** User-supplied long-directory issue in this conversation.

## Global Constraints

- No new dependencies or host capabilities.
- Preserve folder/session/mod isolation, serialization, sanitization, and session-change cancellation.
- Never submit an over-limit legacy key, including during fallback reads.
- Store failures must remain visible and must not overwrite existing state.

## Review Focus

- Windows JSON escaping and long POSIX paths must not stop commands or observations.
- Legacy keys of exactly 256 characters remain readable; 257-character keys are never queried.
- Legacy fallback must not override newer hashed state or resurrect reset records.
- Read-only legacy reports must still work when writes fail.
- A session change during fallback, or a fallback read error, must not save state.

### Task 1: Regression tests and bounded-key implementation

**Files:** Modify `scripts/workflow/lifecycle.test.mjs`, `scripts/workflow/adapter.template.ts`, and the ten generated `*/hooks/register.ts` files.

**Interfaces:** Existing `register` hooks, `hash(text: string): string`, and `$.store.get/set` remain unchanged.

- [x] Enforce the 256-character host limit in the workflow harness and record reads.
- [x] Add tests for all ten adapters on long POSIX/Windows paths and boundary-length legacy keys; test handoff preview and continued Bash observations.
- [x] Add legacy fallback, read-only availability, hashed precedence/reset, migration-write recovery, fallback-error, identity-change, and hashed folder/session isolation tests.
- [x] Run lifecycle tests and observe expected failures against current production code.
- [x] Implement hashed keys plus bounded legacy fallback in the template; regenerate adapters and adapt existing harness key lookups.
- [x] Re-run lifecycle tests to green.

### Task 2: Review, verification, commit, push

**Files:** All Task 1 changes and this plan.

**Interfaces:** No additional runtime interfaces.

- [x] Run `npm test`, `npm run typecheck`, `npm run check:workflow`, `npm run test:privacy`, and available adapter tests.
- [x] Review the complete diff independently, resolve findings, and re-run checks affected by any fixes.
- [x] Prepare the verified changes for commit on `fix/workflow-store-key-limit`; push that branch to origin as the final operation.

## Execution Record

- Baseline: `npm test` passed, 461 tests, zero failures.
- Clean starting checkout on `main`; created dedicated fix branch. Work proceeds in the existing checkout to avoid an unnecessary worktree approval step.
- User explicitly requested planning, TDD implementation, commit, and push; execute continuously.

- RED: strict-host lifecycle run reproduced the issue (45 failures, including the parent test); Windows fixture corrected before implementation to ensure JSON-escaped keys actually exceed 256 characters.
- GREEN: lifecycle 60/60; full core suite 508/508; typecheck, generated consistency, privacy checks, and all 17 real Claude plugin test suites passed.
- Independent read-only review found no critical, important, or minor issues. Windows behavior exercised through a strict host boundary, not a native Windows session.
- Ruling: bump all ten plugin patch versions from 0.1.1 to 0.1.2, following the existing workflow-fix release convention in 00e167e. No runtime change beyond the reviewed fix.

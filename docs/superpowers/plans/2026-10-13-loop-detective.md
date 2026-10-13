# Loop Detective Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task.

**Goal:** Deliver an evidence-based repeated Bash failure detector with reports, pane and bounded state.

**Architecture:** A pure core classifies results and tracks per-command streaks in invocation order. A transparent hook adapter forwards execution unchanged and renders case evidence. Each plugin is independently installable.

**Tech Stack:** TypeScript, existing Claude Code engine test kit, Node core test runner, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-loop-detective-design.md`

## Global Constraints

- Default threshold 3 consecutive identical failures; configurable integer 3–10, invalid input uses 3.
- No new dependencies, subprocesses, network, persistence, model requests, prompt injection, blocking, or automatic edits.
- Caps: output 65,536 characters; 512 groups; 128 agent contexts; 16 in-flight calls/group; 100 historical cases; 20 displayed edited files; expiry after 200 later tool starts.
- Require Claude Code 2.1.287+ by default; older engines use `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Review Focus

- A successful command printing error text must not open a case.
- Changed assertion numbers and decreasing failure counts must restart the streak.
- Out-of-order results and edits finishing after a test starts must not invent edit/retry cycles.
- Denial, truncation, interruption, background execution and late results after reset must not open stale cases.
- Secrets and terminal controls must be masked before display truncation.

## Task 1: Failure fingerprinting

Create `loop-detective/hooks/core/fingerprint.ts` and `tests/fingerprint.test.ts`.

Interface: `classifyResult(answer: unknown): { kind: 'failure'|'success'|'unknown'; signature?: string; excerpt?: string }`, `hash(text: string): string`, `display(text: string, max?: number): string`.

- [ ] Write tests using `expect(classifyResult({ result: { stdout: 'Error: expected 2', stderr: '', exitCode: 0 } }).kind).toBe('success')`; repeated errors with different assertion values must have different signatures. Cover all Review Focus inputs owned by the classifier and runtime-noise equivalence.
- [ ] Run `node --experimental-transform-types --import ./scripts/core-loader.mjs --test loop-detective/tests/fingerprint.test.ts`; confirm missing implementation, then implement bounded classification and rerun green.

## Task 2: State machine and reporting

Create `hooks/core/detector.ts`, `hooks/core/report.ts`, `tests/detector.test.ts`, `tests/report.test.ts`.

Interfaces: `Detector.begin(tool: string, input: Record<string, unknown>, agent?: string, cwd?: string): Ticket`; `Detector.finish(ticket: Ticket, answer: unknown): Case[]`; `Detector.snapshot(): Snapshot`; `renderReport(snapshot: Snapshot, args: string): string`; `paneLines(snapshot: Snapshot): string[]`; `statusLine(snapshot: Snapshot): string`.

- [ ] Write a helper that runs `const ticket = detector.begin('Bash', {command:'npm test'}, undefined, '/repo'); detector.finish(ticket, {isError:true, text:'Error: expected 2'});`; after two repetitions expect no active cases, after three expect count 3.
- [ ] Add actual success/changed/unknown outcomes, edit epochs, scope identity, timing, ordered draining, duplicate completion, queue overflow, retention, expiry and copied-snapshot assertions. Reports assert evidence and usage, default main-only scope, history, suggestions and status/pane output.
- [ ] Run the two test files, observe failure, implement the documented core interfaces and rerun green.

## Task 3: Plugin adapter and repository integration

Create `hooks/register.tsx`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, `tsconfig.json`, `tests/adapter.test.ts`, `README.md`, `README_KR.md`. Modify marketplace, root README, test scripts, package typecheck command, and gitignore.

- [ ] Engine tests execute three stubbed Bash failures through `$.tool.call` and assert `/loop-report` includes `3 identical failures`; assert answers are unchanged, edit/retry evidence, denial, reset/clear, late old results, one toast per case, pane registration and args.
- [ ] Run `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test loop-detective` before adapter implementation and confirm missing hooks/commands. Implement hooks with one `next(e)` call, bounded observation and independently guarded UI.
- [ ] Add the fourth plugin to core/adapters scripts and marketplace; document exact detection boundaries and commands in both languages.
- [ ] Run `npm test`, engine suites, `claude plugin validate loop-detective`, and `npm run typecheck` with local generated declarations. Review implementation against every spec requirement; record observed results and limitations below.

## Execution record

- Baseline: `npm test` passed 199 tests. Local engine is Claude Code 2.1.280; existing local declarations describe 2.1.292. User requested both specification and implementation; proceed inline in the current clean checkout, preserving reviewable files without requiring another approval or creating commits.

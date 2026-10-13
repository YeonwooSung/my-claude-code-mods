# Loop Detective design

## Purpose

An observer-only Claude Code mod that highlights repeated failures of the same Bash invocation. It distinguishes repeated retries from edit/retry cycles and offers evidence-backed investigation prompts. It never claims to know the model's reasoning, the root cause, or whether an experiment was intentional.

## Scope and behavior

- Standalone `loop-detective` plugin, TypeScript core and engine hook adapter; no new dependencies, subprocesses, network, persistence, model requests, prompt injection, blocking, or automatic edits.
- Requires Claude Code 2.1.287+ for mods enabled by default; older engines need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Engine test compatibility is reported separately from interactive UI compatibility.
- Observe `tool.call` before/after execution. Detect Bash only. Successful Edit/MultiEdit/Write/NotebookEdit calls record an edit epoch per agent. Bash edits and external edits are not inferred.
- Group by agent, session cwd, and exact command hash. Preserve quoted arguments, semantic numbers, multiline commands, and whitespace; different commands are different investigations. Unavailable cwd disables detection for that call.
- Failure requires `isError: true`, a finite nonzero structured exitCode/exit_code, or a recognized positive failed-test summary (Node TAP, Jest/Vitest, pytest, Cargo, Go). Output containing the word error alone is not failure evidence.
- Denied, interrupted, timed-out, background/task-id results, empty failure output, unsupported results, and output over 65,536 characters are unknown; they break the corresponding streak. A completed result with a zero exit code or explicit isError false, or ordinary foreground Bash stdout/stderr, counts as success if no positive test-failure summary overrides it.
- Fingerprint the entire bounded output after removing ANSI SGR, normalizing CRLF, and replacing narrowly identified runtime noise: test-summary elapsed time (pytest/Cargo/Go), Jest/Vitest timing lines, `duration_ms` TAP fields including the final summary, and parenthesized `N ms` test timings. Do not remove assertion values, failure counts, paths, test names, or source locations. This is lexical matching, not semantic matching. Hashes are noncryptographic and not anonymization.
- Default threshold 3 consecutive identical failures for a group; configurable integer 3–10, invalid input uses 3. Same command succeeding closes a case as recovered; changed failures close as changed; unknown results close as unknown. Other commands do not imply recovery. Cases expire after 200 later tool starts with no result in their group. State is capped at 512 groups, 128 agent contexts, 16 in-flight calls per group, 100 historical cases, and 20 displayed edited files. Eviction closes detected cases as expired.
- Process overlapping calls in invocation order within each group. Capture completed edit epochs at invocation time, so edits finishing after a test starts are not credited to that test. Bounded queue overflow expires the old group; late completions cannot revive evicted groups. Reset/reload/clear/resume drops state, and late results from the old detector cannot populate the new one.
- Classify `edit-retry` after at least two repeated failure transitions each containing observed successful edits since the previous invocation; otherwise `retry`. Evidence shows first/last tool sequence, count, edit/retry transitions, edited paths, redacted command and redacted failure excerpt. Edited paths identify observed activity, not causal blame.

## User interface

- `/loop-report`: main-agent active cases; `/loop-report --agents`: all agents; `/loop-report --history`: includes closed cases; flags combine. Unknown args return usage.
- `/loop-pane`: live pane for main-agent active cases; terminal and desktop; command output remains usable without UI.
- Status: active case count and maximum repeated-failure count, or `loop: no active cases`.
- One optional toast when each new case crosses the threshold (`toastAlerts`, default true); no repeat toasts for every further failure. UI failures never change tool results.
- `/loop-reset`: clear bookkeeping; does not touch files or the conversation.
- Suggestions: compare inputs/environment and investigate another hypothesis for retry cases; inspect test expectations/data/dependencies and a different code path for edit-retry cases. All phrased as possible next checks, never as untested diagnosis or assertions about unobserved actions.

## Privacy and fault isolation

Hash raw identity/failure text transiently; retain only hashes, counters, and bounded display excerpts. Mask common authorization/bearer/API-key/password/env-secret shapes before truncating display strings, strip terminal controls, and flatten excerpts. Best-effort masking is not a guarantee; no automatic export exists. Never retain edit contents, prompts, or full tool results. Adapter bookkeeping is guarded independently of `next(e)`; call `next` exactly once and return its answer unchanged, or rethrow its original exception. Hook exceptions produce no synthetic failures.

## Files and verification

Core: `fingerprint.ts` (bounded result classification, hashing and redaction), `detector.ts` (state machine, sequencing and retention), `report.ts` (commands/report/pane/status). Adapter: `hooks/register.tsx`. Plugin manifest, hooks manifest, English/Korean README, tsconfig, marketplace entry, root scripts/docs.

Test first: detection threshold; edit/retry transitions; changed semantic values and decreasing failure counts; recovery; agent/cwd/command isolation; unknown and huge output; test frameworks; duplicate/out-of-order completions; queue overflow/eviction/expiry; edit timing; bounded retention; redaction and terminal escapes; report flags/copies; actual engine adapter passthrough, clear/reset, reports and toast behavior. Run complete Node suite, engine plugin tests, plugin validation and TypeScript checking against local generated engine declarations. Interactive panes and simultaneous mods require a separate live run; do not claim these from unit tests.

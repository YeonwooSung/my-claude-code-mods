# Loop Detective

**English** | [한국어](README_KR.md)

A Claude Code mod that opens a case when the same Bash command produces the same failure repeatedly. It connects observed edits to subsequent retries and presents possible next checks. It observes only: tool execution, permissions, prompts and files are never changed.

## Install

```text
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install loop-detective@my-claude-code-mods
```

During development:

```sh
claude --plugin-dir ./loop-detective
```

Requires Claude Code 2.1.287+ (mods enabled by default). Older engines need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The engine suite runs locally on 2.1.280; TypeScript checking uses the repository's local 2.1.292 declarations. Interactive UI and simultaneous-mod compatibility need a separate live integration run.

## Commands

| Command | Behavior |
|---|---|
| `/loop-report` | Main-agent active cases, evidence and possible next checks |
| `/loop-report --agents` | Include subagents, tracked independently |
| `/loop-report --history` | Include up to 100 closed cases; combine with `--agents` |
| `/loop-pane` | Main-agent live case pane in terminal and desktop |
| `/loop-reset` | Clear observations; does not change files or conversation |

Status line: `loop: 1 active · max 4 failures`. Each case gets at most one optional toast when it opens. A case that has already closed while overlapping results are being drained is not toasted.

Example: three `npm test` failures, with successful file edits between the invocations:

```text
Case #1 [edit-retry; active] — main
  3 identical failures · calls #1–#5 · 2 edit/retry transitions
  Command: npm test
  Cwd: /repo
  Failure: Error: expected 2, got 1
  Observed edited files (not causal evidence): /repo/a.ts
  Possible next checks: inspect test expectations, input data, dependencies,
  or a different code path before another edit.
```

## Detection rules

- Group by agent, session cwd and exact command hash. Different arguments, quoting, whitespace and cwd start separate investigations. A missing cwd skips detection and breaks existing streaks for that agent/command as unknown. Shell `cd` is part of the exact command; cwd here is the session cwd, not inferred shell state.
- Open after 3 consecutive identical failures by default. With at least two transitions containing successful Edit/MultiEdit/Write/NotebookEdit calls, label the case `edit-retry`; otherwise `retry`. Count edits completed before each Bash invocation starts, never edits that finish during its execution. Changed file paths show activity, not blame.
- Failure evidence is an explicit engine error, a finite nonzero structured exit code, or positive Node TAP/Jest/Vitest/pytest/Cargo/Go test-failure summary. Printing `error` alone is insufficient. A zero shell exit code does not override a recognized failing-test summary.
- Match the complete bounded output after ANSI SGR and CRLF normalization, plus narrowly recognized test timings (TAP duration fields, Jest/Vitest runtime summaries, pytest/Cargo/Go elapsed times and parenthesized millisecond timings). Keep assertion values, failure counts, locations and test names. Decreasing failure counts or different assertion values restart the streak.
- Success for the same command closes a case as `recovered`; a different failure closes as `changed`; unsupported/denied/interrupted/timed-out/background/truncated results close as `unknown`. Unknown does not mean recovered. Oversized output (over 65,536 characters) and empty errors are also unknown. Other commands succeeding do not close this case.
- Reserve invocation order and edit epoch at hook entry, before looking up cwd. Results of overlapping invocations are processed in that order, using bounded per-agent/command metadata queues shared across cwd (only bookkeeping waits). Expire idle cases after 200 later tool starts with no activity in their group. Eviction and queue overflow also expire old evidence; late results cannot revive it.

These are observations and lexical estimates, not semantic judgments. Repeated failure does not prove a lack of progress, an infinite loop, a root cause, or that a particular hypothesis has not been tried. Fingerprints use noncryptographic hashes; collisions are possible.

## Settings

Set in the `/plugin` settings menu or settings `pluginConfigs`.

| Key | Default | Meaning |
|---|---|---|
| `threshold` | `3` | Integer 3–10; invalid values use 3. Applies when the mod loads or observations reset |
| `toastAlerts` | `true` | Notify once per new active case |

## Retention and privacy

State stays in memory; no export, automatic file writes, network calls, model calls or backfill. Reload, resume, `/clear` and `/loop-reset` start fresh. Caps: 512 groups, 128 agent contexts, 512 metadata queues with 16 in-flight calls each, 100 closed cases, 100 recent edit records per agent and 20 displayed edited paths per case. Commands, cwd, paths, agent labels and failure excerpts are displayed with common secrets masked and terminal controls removed before truncation (160 characters each).

Only hashes, counters and bounded display metadata are retained; no prompts, edit bodies or full tool output. Masking is best-effort, and hashes are not anonymization. ANSI/log changes outside the timing rules can create false negatives. Bash/external edits and edits by another agent are not credited to a case. Whole-command fingerprints cannot recognize equivalent commands or semantic paraphrases. VS Code chat and headless sessions use text reports; their UI may not display panes or status.


Secret masking is best-effort and covers credential flags, sensitive headers, URL passwords, curl/mysql credentials and common credential fields in JSON strings. It does not sanitize snapshot file contents or retroactively rewrite saved files. Review files before sharing.

## Development

```sh
npm test
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test loop-detective
claude plugin validate loop-detective
npm run typecheck
```

The root Node suite runs pure core tests without an account or engine. Adapter tests run through the real engine's testing kit and verify passthrough, reset, edit/retry, reports, notifications and UI fault isolation. Typechecking requires engine-generated declarations in `loop-detective/.claude-plugin/types/claude-code/index.d.ts`, as for the other mods; use declarations for the engine being targeted. Core classes contain no engine dependency.

# Assumption Tracker

Local Claude Code mod. Install: `claude plugin install assumption-tracker@my-claude-code-mods --scope user`, then reload plugins.

Evidence-backed assumption states with retained transition history.

## Commands

```text
/assume help
/assume [add <claim> | <reference>] [confirm <id> | <evidence>] [refute <id> | <evidence>]
/assume reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-assumption-tracker-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test assumption-tracker`, `npx tsc -p assumption-tracker`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/assume add API timestamps are UTC | src/api.ts
/assume confirm 1 | API contract section 4
/assume refute 1 | Integration test found an offset
/assume reopen 1
/assume show 1
```

Latest 200 claims and 20 transitions per claim. Confirm/refute requires nonempty evidence text, whose truth is not automatically evaluated. Reopening clears current evidence but preserves history.

Local preview before marketplace publication: `claude --plugin-dir ./assumption-tracker` from this checkout. Engine tests were run with Claude Code 2.1.302.

## Hooks, programs and data flow

Stores user-entered claims, references, status and evidence. Its tool hook only forwards; no filesystem, environment, process or replay bridge is generated.

The `command.run` hook answers only `/assume` with local report/control text. It does not intercept unrelated slash commands. The `tool.call` hook forwards each original event once and returns its outcome unchanged; observer failures do not retry a tool. No `tool.check`, permission-mode or Remote Control override is installed.

This mod contains no `process.run` calls. The generated adapter omits the unused shared program-launch and environment-inspection code instead of merely leaving it dormant.

This mod makes no `tool.call` of its own. The common Bash-replay implementation is not included in its generated adapter; observing/forwarding an existing tool call does not create another call.

There are no HTTP requests, telemetry destinations or automatic uploads in this feature. Local read results support analysis/fingerprints and local report text; masked feature records go only to the plugin store under the current cwd/session identity. No project build, startup, settings or instruction files are edited. User/agent tool calls that are forwarded retain their independent behavior and destinations.

For review: `String.raw`/regular-expression literals in the redactor are string-pattern data, never a shell program. Template literals beginning `#` format record numbers. `constructor` names ordinary TypeScript class initialization. These are not credential reads or command execution. Runtime command access is limited to the concrete cases documented above.

# Decision Ledger

Local Claude Code mod. Install: `claude plugin install decision-ledger@my-claude-code-mods --scope user`, then reload plugins.

Explicit decisions with rationale, rejected alternatives and file references.

## Commands

```text
/decision help
/decision [add <file#symbol> | <choice> | <rationale> | <alternative>] [list | remove <id>]
/decision reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-decision-ledger-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test decision-ledger`, `npx tsc -p decision-ledger`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/decision add src/cache.ts#lookup | LRU cache | Bound memory | Unbounded Map
/decision list src/cache.ts
/decision remove 1
```

Latest 200 decisions. IDs are monotonic until reset. Text is explicit user input, never inferred from model reasoning. State is capped at 256 KiB; failed writes return an error without replacing saved state.

Local preview before marketplace publication: `claude --plugin-dir ./decision-ledger` from this checkout. Engine tests were run with Claude Code 2.1.302.

## Hooks, programs and data flow

Stores user-entered decisions, references, rationale and alternatives. Its tool hook only forwards; no filesystem, environment, process or replay bridge is generated.

The `command.run` hook answers only `/decision` with local report/control text. It does not intercept unrelated slash commands. The `tool.call` hook forwards each original event once and returns its outcome unchanged; observer failures do not retry a tool. No `tool.check`, permission-mode or Remote Control override is installed.

This mod contains no `process.run` calls. The generated adapter omits the unused shared program-launch and environment-inspection code instead of merely leaving it dormant.

This mod makes no `tool.call` of its own. The common Bash-replay implementation is not included in its generated adapter; observing/forwarding an existing tool call does not create another call.

There are no HTTP requests, telemetry destinations or automatic uploads in this feature. Local read results support analysis/fingerprints and local report text; masked feature records go only to the plugin store under the current cwd/session identity. No project build, startup, settings or instruction files are edited. User/agent tool calls that are forwarded retain their independent behavior and destinations.

For review: `String.raw`/regular-expression literals in the redactor are string-pattern data, never a shell program. Template literals beginning `#` format record numbers. `constructor` names ordinary TypeScript class initialization. These are not credential reads or command execution. Runtime command access is limited to the concrete cases documented above.

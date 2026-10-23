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

## Hook behavior, local processes and data flow

The shared adapter registers `tool.call` and can see tool inputs/results, including network-capable tools. It forwards each original call once and returns its result unchanged; an observer failure does not retry the tool or change a permission decision. It does not register a `tool.check` hook. Its tool hook forwards immediately because this feature has no observer. Explicit commands retain user-entered references, decisions, rationale and alternatives in the plugin store and return local reports. This feature does not invoke the shared file/process/replay helpers.

The adapter's `$.process.run(argv, { cwd, timeoutMs: 10_000 })` bridge executes local argument arrays supplied by the feature/runtime, not commands downloaded from a server. Shared Git evidence helpers use `rev-parse`, `status`, `diff` (with external diff/text conversion disabled) and `ls-files`; results and any read file bytes are processed locally. The shared adapter also defines a Node environment-presence helper (used by Env Doctor) and a Bash replay helper (used only by Command Shelf's explicit run command). Defining these helpers does not call them in other features.

This mod has no direct HTTP requests, telemetry endpoint or fixed remote hosts. Its own retained data is masked feature state in the local plugin store, isolated by cwd/session, and reports returned to the user's command UI. Conversation/tool data is not automatically uploaded. Forwarded user/agent tool calls keep their original behavior, including any network destinations and data they independently specify; this feature does not invoke the Bash replay helper. Local file reads and the process bridge do not by themselves upload files or conversation text. No project build, startup, settings or instruction files are edited by this feature.

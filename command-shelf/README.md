# Command Shelf

Local Claude Code mod. Install: `claude plugin install command-shelf@my-claude-code-mods --scope user`, then reload plugins.

Successful-command history with explicit permission-aware replay.

## Commands

```text
/shelf help
/shelf [list | show <id> | pin <id> <label> | run <id> | remove <id>]
/shelf reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No automatic network calls. Explicit replay performs the selected command's normal side effects. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-command-shelf-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test command-shelf`, `npx tsc -p command-shelf`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/shelf list
/shelf pin 1 Auth regression tests
/shelf show 1
/shelf run 1
```

Up to 200 successful foreground commands. Commands containing recognized secrets or terminal escapes are excluded. Replay binds the original cwd and uses the Bash permission path; it never executes during listing. Other mods can observe an explicit replay. Environment values are not snapshotted. Shell cwd binding targets macOS/Linux.

Local preview before marketplace publication: `claude --plugin-dir ./command-shelf` from this checkout. Engine tests were run with Claude Code 2.1.302.

## Hook behavior, local processes and data flow

The shared adapter registers `tool.call` and can see tool inputs/results, including network-capable tools. It forwards each original call once and returns its result unchanged; an observer failure does not retry the tool or change a permission decision. It does not register a `tool.check` hook. Its observer records successful foreground Bash command text and cwd, after masking checks, in the plugin store. Only an explicit `/shelf run <id>` sends the selected stored command and its quoted cwd to `$.tool.call({ tool: 'Bash', ... })`, through normal host permissions. That command can execute programs, read files or contact network hosts according to its own contents; the destination and transmitted data are determined by the selected command, not by a mod endpoint. Viewing or pinning an entry does not execute it.

The adapter's `$.process.run(argv, { cwd, timeoutMs: 10_000 })` bridge executes local argument arrays supplied by the feature/runtime, not commands downloaded from a server. Shared Git evidence helpers use `rev-parse`, `status`, `diff` (with external diff/text conversion disabled) and `ls-files`; results and any read file bytes are processed locally. The shared adapter also defines a Node environment-presence helper (used by Env Doctor) and a Bash replay helper (used only by Command Shelf's explicit run command). Defining these helpers does not call them in other features.

This mod has no direct HTTP requests, telemetry endpoint or fixed remote hosts. Its own retained data is masked feature state in the local plugin store, isolated by cwd/session, and reports returned to the user's command UI. Conversation/tool data is not automatically uploaded. Forwarded user/agent tool calls keep their original behavior, including any network destinations and data they independently specify; the explicit shelf replay has the same boundary. Local file reads and the process bridge do not by themselves upload files or conversation text. No project build, startup, settings or instruction files are edited by this feature.

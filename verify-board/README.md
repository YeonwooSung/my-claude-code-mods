# Verify Board

Local Claude Code mod. Install: `claude plugin install verify-board@my-claude-code-mods --scope user`, then reload plugins.

Revision-aware verification results: PASS, FAIL, STALE and UNKNOWN.

## Commands

```text
/verify help
/verify [list | reset]
/verify reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-verify-board-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test verify-board`, `npx tsc -p verify-board`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/verify
npm test
/verify list
```

Snapshots include HEAD, tracked binary diffs and up to 200 untracked files (2 MiB total). Missing evidence stays UNKNOWN. Only an explicit conservative list of check commands is recognized; this is not a coverage guarantee.

Local preview before marketplace publication: `claude --plugin-dir ./verify-board` from this checkout. Engine tests were run with Claude Code 2.1.302.

Evidence boundary: dirty submodules and symlink snapshot/review targets remain unknown/incomplete; symlink targets are not read. Verification signatures include the staged index separately from working changes. Ignored files remain outside Git-based evidence.

## Hook behavior, local processes and data flow

The shared adapter registers `tool.call` and can see tool inputs/results, including network-capable tools. It forwards each original call once and returns its result unchanged; an observer failure does not retry the tool or change a permission decision. It does not register a `tool.check` hook. Its observer records recognized verification command outcomes and before/after revision evidence. Revision checks run local Git commands and hash local untracked-file bytes; reports mark stale or incomplete evidence. It does not run the observed test command again.

The adapter's `$.process.run(argv, { cwd, timeoutMs: 10_000 })` bridge executes local argument arrays supplied by the feature/runtime, not commands downloaded from a server. Shared Git evidence helpers use `rev-parse`, `status`, `diff` (with external diff/text conversion disabled) and `ls-files`; results and any read file bytes are processed locally. The shared adapter also defines a Node environment-presence helper (used by Env Doctor) and a Bash replay helper (used only by Command Shelf's explicit run command). Defining these helpers does not call them in other features.

This mod has no direct HTTP requests, telemetry endpoint or fixed remote hosts. Its own retained data is masked feature state in the local plugin store, isolated by cwd/session, and reports returned to the user's command UI. Conversation/tool data is not automatically uploaded. Forwarded user/agent tool calls keep their original behavior, including any network destinations and data they independently specify; this feature does not invoke the Bash replay helper. Local file reads and the process bridge do not by themselves upload files or conversation text. No project build, startup, settings or instruction files are edited by this feature.

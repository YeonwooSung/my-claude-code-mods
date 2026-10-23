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

## Hooks, programs and data flow

Observes successful foreground Bash calls and retains replayable command text/cwd. No direct filesystem, process or environment bridge is generated.

The `command.run` hook answers only `/shelf` with local report/control text. It does not intercept unrelated slash commands. The `tool.call` hook forwards each original event once and returns its outcome unchanged; observer failures do not retry a tool. No `tool.check`, permission-mode or Remote Control override is installed.

This mod contains no `process.run` calls. The generated adapter omits the unused shared program-launch and environment-inspection code instead of merely leaving it dormant.

Only explicit `/shelf run <id>` invokes a tool itself: `Bash`, with the selected stored command preceded by a quoted `cd -- <recorded-cwd>`. This goes through normal host permissions. Viewing/pinning an entry does not run it. The selected command can run programs, read files or contact hosts according to its contents; its destinations/data are chosen by that command, not by a mod server. The adapter's other tool observations never initiate a replay.

There are no direct HTTP client calls, telemetry destinations or automatic uploads in this feature. Local read results support analysis/fingerprints and local report text; masked feature records go only to the plugin store under the current cwd/session identity. No project build, startup, settings or instruction files are edited. User/agent tool calls that are forwarded retain their independent behavior and destinations.

For review: `String.raw`/regular-expression literals in the redactor are string-pattern data, never a shell program. Template literals beginning `#` format record numbers. `constructor` names ordinary TypeScript class initialization. These are not credential reads or command execution. Runtime command access is limited to the concrete cases documented above.

## Directory review: session data and replay destination

The `session.cwd` read selects the local cwd/session store identity and provides the working-directory prefix for a recorded command. On explicit `/shelf run <id>`, the adapter sends only `Bash` and the selected stored command text with a quoted `cd -- <recorded-cwd>` prefix to the host's `tool.call` API. It does not include the rest of the shelf, session transcript, arbitrary store entries or environment-variable values in that call. The Bash result returns to the local caller; observers may see that tool call under normal host behavior.

This is a shell execution boundary: the selected command can read local files, launch other programs and send their data to hosts specified or resolved by that command and its configuration. There is no fixed host allowlist for explicit replay. Inspect the selected entry before running it; normal host tool permissions apply. The mod fetches no command from an HTTP service and has no direct HTTP client, telemetry endpoint or mod-chosen remote recipient. Listing, showing, pinning and observing commands never initiate a replay or upload. The `tool.call` observer forwards the original event once and records only eligible successful foreground Bash entries; it does not consume server responses as execution instructions.

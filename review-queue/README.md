# Review Queue

Local Claude Code mod. Install: `claude plugin install review-queue@my-claude-code-mods --scope user`, then reload plugins.

Purpose-grouped file review with staged/unstaged freshness checks.

## Commands

```text
/review-queue help
/review-queue [group <purpose> | <path>] [mark <path> | unmark <path> | list]
/review-queue reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-review-queue-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test review-queue`, `npx tsc -p review-queue`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/review-queue group Authentication | src/auth.ts
/review-queue mark src/auth.ts
/review-queue list
/review-queue unmark src/auth.ts
```

File-level groups, not hunk groups. Up to 200 changed files. Both staged and unstaged diffs and binary working content contribute to review signatures. Missing evidence cannot become REVIEWED. Run from repository root.

Local preview before marketplace publication: `claude --plugin-dir ./review-queue` from this checkout. Engine tests were run with Claude Code 2.1.302.

Evidence boundary: dirty submodules and symlink snapshot/review targets remain unknown/incomplete; symlink targets are not read. Verification signatures include the staged index separately from working changes. Ignored files remain outside Git-based evidence.

## Hooks, programs and data flow

Fingerprints local file bytes and staged/unstaged Git diffs for explicit review reports; its tool hook only forwards.

The `command.run` hook answers only `/review-queue` with local report/control text. It does not intercept unrelated slash commands. The `tool.call` hook forwards each original event once and returns its outcome unchanged; observer failures do not retry a tool. No `tool.check`, permission-mode or Remote Control override is installed.

The following complete argv templates describe every program launched with `process.run`. Each item is an argument array passed directly to the host, with no shell command parsing. `<cwd>`/`<repo>` are the current project or Git root, `<base>` is the validated selected ref, `<manifest>` is `package.json` or `package-lock.json`, and `<path>` is a selected project file. `[--cached]` denotes two fixed variants, with and without that argument. Every call has a 10-second timeout.

```text
git -C <cwd> status --porcelain=v1 -z --untracked-files=all
git -C <cwd> diff --no-ext-diff --no-textconv --binary [--cached] HEAD -- <path>
```

Only `git` is accepted by this adapter's process bridge. Dynamic path/ref arguments are project evidence, not scripts fetched from a server. These Git commands query local history, status and diffs; none is fetch, push, install or a shell interpreter. Other features' version/environment/replay bridges are absent from this mod.

This mod makes no `tool.call` of its own. The common Bash-replay implementation is not included in its generated adapter; observing/forwarding an existing tool call does not create another call.

There are no HTTP requests, telemetry destinations or automatic uploads in this feature. Local read results support analysis/fingerprints and local report text; masked feature records go only to the plugin store under the current cwd/session identity. No project build, startup, settings or instruction files are edited. User/agent tool calls that are forwarded retain their independent behavior and destinations.

For review: `String.raw`/regular-expression literals in the redactor are string-pattern data, never a shell program. Template literals beginning `#` format record numbers. `constructor` names ordinary TypeScript class initialization. These are not credential reads or command execution. Runtime command access is limited to the concrete cases documented above.

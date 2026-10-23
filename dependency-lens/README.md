# Dependency Lens

Local Claude Code mod. Install: `claude plugin install dependency-lens@my-claude-code-mods --scope user`, then reload plugins.

Direct and transitive npm dependency changes and install-script markers.

## Commands

```text
/deps help
/deps [base <git-ref> | list]
/deps reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-dependency-lens-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test dependency-lens`, `npx tsc -p dependency-lens`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/deps
/deps base HEAD~1
/deps list
```

npm package-lock v2/v3 only, 2 MiB per evidence stream and 200 report entries. Manifest-only comparisons are marked incomplete. Installation scripts are metadata markers, not a safety verdict. No installs or registry requests. Run from repository root.

Local preview before marketplace publication: `claude --plugin-dir ./dependency-lens` from this checkout. Engine tests were run with Claude Code 2.1.302.

## Hooks, programs and data flow

Compares local npm manifests/lockfiles to an explicitly selected local Git revision; its tool hook only forwards.

The `command.run` hook answers only `/deps` with local report/control text. It does not intercept unrelated slash commands. The `tool.call` hook forwards each original event once and returns its outcome unchanged; observer failures do not retry a tool. No `tool.check`, permission-mode or Remote Control override is installed.

The following complete argv templates describe every program launched with `process.run`. Each item is an argument array passed directly to the host, with no shell command parsing. `<cwd>`/`<repo>` are the current project or Git root, `<base>` is the validated selected ref, `<manifest>` is `package.json` or `package-lock.json`, and `<path>` is a selected project file. `[--cached]` denotes two fixed variants, with and without that argument. Every call has a 10-second timeout.

```text
git -C <cwd> rev-parse --verify <base>^{commit}
git -C <cwd> ls-tree -z --name-only <base> -- <manifest>
git -C <cwd> show <base>:<manifest>
```

Only `git` is accepted by this adapter's process bridge. Dynamic path/ref arguments are project evidence, not scripts fetched from a server. These Git commands query local history, status and diffs; none is fetch, push, install or a shell interpreter. Other features' version/environment/replay bridges are absent from this mod.

This mod makes no `tool.call` of its own. The common Bash-replay implementation is not included in its generated adapter; observing/forwarding an existing tool call does not create another call.

There are no HTTP requests, telemetry destinations or automatic uploads in this feature. Local read results support analysis/fingerprints and local report text; masked feature records go only to the plugin store under the current cwd/session identity. No project build, startup, settings or instruction files are edited. User/agent tool calls that are forwarded retain their independent behavior and destinations.

For review: `String.raw`/regular-expression literals in the redactor are string-pattern data, never a shell program. Template literals beginning `#` format record numbers. `constructor` names ordinary TypeScript class initialization. These are not credential reads or command execution. Runtime command access is limited to the concrete cases documented above.

## Directory review: read-to-process boundary

Selected local manifests/source files, directory listings and Git evidence are used for the local dependency report.

The destination of `process.run` is the local Git executable. Its argv contains the documented Git subcommand/options and local project paths or selected refs, with the session cwd as the working directory. File contents are not inserted into shell code, sent as stdin, or posted to a server by this adapter. Git reads the repository locally and returns stdout/stderr for this analysis. Reports return to the local slash-command caller; persisted feature records go to this plugin’s local cwd/session-scoped store. This mod has no HTTP upload, remote recipient, server-provided command source or own tool replay. It forwards independently requested tool calls once; any network activity of those calls belongs to their original inputs and permissions. The program list above describes what the mod requests; installed executables and user/system configuration retain their own capabilities.

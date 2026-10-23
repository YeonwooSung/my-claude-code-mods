# Env Doctor

Local Claude Code mod. Install: `claude plugin install env-doctor@my-claude-code-mods --scope user`, then reload plugins.

Project runtime requirements and environment-variable presence checks.

## Commands

```text
/env-doctor help
/env-doctor [check | require <ENV_NAME>]
/env-doctor reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-env-doctor-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test env-doctor`, `npx tsc -p env-doctor`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/env-doctor require DATABASE_URL
/env-doctor require API_TOKEN
/env-doctor check
```

Node/package-manager requirements come from package.json. Conservative ranges: exact, major/x, comparisons, full ^/~, and ||. Partial > and <= expressions, prereleases and other unsupported syntax return UNKNOWN. Dynamic env names are checked by a Node subprocess returning presence only; no variable values are returned or stored.

Local preview before marketplace publication: `claude --plugin-dir ./env-doctor` from this checkout. Engine tests were run with Claude Code 2.1.302.

## Hooks, programs and data flow

Reads local package.json to compare Node/package-manager versions and checks user-selected variable names. Its tool hook only forwards.

The `command.run` hook answers only `/env-doctor` with local report/control text. It does not intercept unrelated slash commands. The `tool.call` hook forwards each original event once and returns its outcome unchanged; observer failures do not retry a tool. No `tool.check`, permission-mode or Remote Control override is installed.

The following complete argv templates describe every program launched with `process.run`. Each item is an argument array passed directly to the host, with no shell command parsing. `<cwd>`/`<repo>` are the current project or Git root, `<base>` is the validated selected ref, `<manifest>` is `package.json` or `package-lock.json`, and `<path>` is a selected project file. `[--cached]` denotes two fixed variants, with and without that argument. Every call has a 10-second timeout.

```text
node --version
npm --version
pnpm --version
yarn --version
node -- <plugin-root>/hooks/env-presence.mjs <variable-name>
```

Version probes are dispatched to four separate calls with whole literal argv arrays; unsupported programs/options are refused. The presence check runs the bundled `.mjs` file, not `node -e` or downloaded code. It validates the variable name and uses `Object.hasOwn(process.env, variableName)` to test existence without retrieving a value. It prints only `set` or nothing. SET includes a variable declared with an empty value; MISSING means the name is absent. Required names and presence results remain local; no credential value is read, stored or shared. There is no sensitive `userConfig` value because no credential is required.

This mod makes no `tool.call` of its own. The common Bash-replay implementation is not included in its generated adapter; observing/forwarding an existing tool call does not create another call.

There are no HTTP requests, telemetry destinations or automatic uploads in this feature. Local read results support analysis/fingerprints and local report text; masked feature records go only to the plugin store under the current cwd/session identity. No project build, startup, settings or instruction files are edited. User/agent tool calls that are forwarded retain their independent behavior and destinations.

For review: `String.raw`/regular-expression literals in the redactor are string-pattern data, never a shell program. Template literals beginning `#` format record numbers. `constructor` names ordinary TypeScript class initialization. These are not credential reads or command execution. Runtime command access is limited to the concrete cases documented above.

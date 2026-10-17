# Scope Guard

Local Claude Code mod. Install: `claude plugin install scope-guard@my-claude-code-mods --scope user`, then reload plugins.

Allowed-path warnings with rename and pre-existing-change awareness.

## Commands

```text
/scope help
/scope [allow <path> | list | reset]
/scope reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-scope-guard-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test scope-guard`, `npx tsc -p scope-guard`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/scope allow src/auth
/scope allow tests/auth
/scope list
```

Warnings only; no tool is blocked. Scope entries use literal file/directory boundaries, not globs. Baselines and displayed paths cap at 200; a capped baseline is reported as incomplete. Run Git analysis from the repository root.

Local preview before marketplace publication: `claude --plugin-dir ./scope-guard` from this checkout. Engine tests were run with Claude Code 2.1.302.

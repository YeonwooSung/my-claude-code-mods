# Blast Radius

Local Claude Code mod. Install: `claude plugin install blast-radius@my-claude-code-mods --scope user`, then reload plugins.

Local reverse-import impact and related test candidates.

## Commands

```text
/blast help
/blast [watch <path> | <path> | reset]
/blast reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-blast-radius-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test blast-radius`, `npx tsc -p blast-radius`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/blast watch src/shared.ts
/blast
/blast src/cache.ts
```

Static relative JS/TS import strings only. Regex analysis can miss or overreport edges; comments/strings, aliases, runtime imports and framework resolution require manual follow-up. Up to 2,000 files / 2 MiB; 200 report entries. Run from the repository root.

Local preview before marketplace publication: `claude --plugin-dir ./blast-radius` from this checkout. Engine tests were run with Claude Code 2.1.302.

# Handoff Pack

Local Claude Code mod. Install: `claude plugin install handoff-pack@my-claude-code-mods --scope user`, then reload plugins.

Resumable Markdown previews of goals, tasks, changes and evidence.

## Commands

```text
/handoff help
/handoff [goal <text> | todo <text> | done <id> | note <text> | preview]
/handoff reset
```

Reports are returned as command text, usable in terminal/Desktop/headless sessions. State is isolated by cwd and session ID in the plugin store; resuming the same identity restores it. Reset clears this mod's records only. Observations never block tools or execute commands twice. No network calls. Obvious secrets and terminal escapes are masked before storage/display; masking is best effort.

## Limits and verification

First release: see [design](../docs/superpowers/specs/2026-10-17-handoff-pack-design.md) for exact analysis limits. Git commands have a 10-second timeout. Lists cap at 200 entries and repository scans at 2,000 paths / 2 MiB; incomplete evidence is reported. Commands use explicit data entry; no model inference or automatic source editing. Actual engine tests cover command behavior and forwarding; live terminal/Desktop pixels have not been checked.

Development: `npm test`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test handoff-pack`, `npx tsc -p handoff-pack`. Engine typechecking needs local ignored declarations. Canonical runtime sources are in `scripts/workflow/`; run `node scripts/sync-workflow.mjs` after editing.

## Example

```text
/handoff goal Fix login retry
/handoff todo Add regression test
/handoff done 1
/handoff note Timeout handling still needs review
/handoff preview
```

Markdown preview returned in the command result, with no automatic file write or external transfer. Up to 200 tasks, notes, failures and latest checks. Current changes are queried from Git; missing evidence is labelled incomplete. Run from repository root for changed-file paths.

Local preview before marketplace publication: `claude --plugin-dir ./handoff-pack` from this checkout. Engine tests were run with Claude Code 2.1.302.

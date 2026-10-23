# Context Inspector — context waste analyzer

**English** | [한국어](README_KR.md)

A mod that shows what fills the context window in a Claude Code session, why the same information comes back in again, and what compaction kept and lost.
It only observes: it never changes rows, tool calls or compaction.

## Install

```
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install context-inspector@my-claude-code-mods
```

Requires Claude Code 2.1.287 or later (mods enabled by default). Older builds need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## Commands

| Command | What it does |
|---|---|
| `/context-inspect [overview\|occupants\|rereads\|similar\|compactions\|efficiency\|advice] [--agents]` | Text report. Defaults to the overview of the main context; `--agents` includes subagents |
| `/context-pane` | Live pane (terminal, desktop app) |
| `/context-export` | Saves metadata only, no raw content, as JSONL: `<outputDir>/<sessionId>/context-<load>-<n>.jsonl` |

Status line: `ctx 62% · waste≈8.1k` (window occupancy is measured, waste is estimated). Waste is the waste **still in the window now** — it shrinks when compaction drops duplicate copies. The whole-session re-read cost stays in `session ≈…` of `/context-inspect rereads`.

## What it measures — observability grades

| Grade | Examples |
|---|---|
| measured | Input tokens the API reported for each request (uncached + cache read + cache write), tokens before/after compaction |
| observed | Character counts and hashes of rows that entered the conversation, message sets before/after compaction |
| estimated (`≈`) | Per-item tokens = chars/4 (images 1,500) × calibration factor k (calibrated against measured input growth, between 0.5 and 2.0; the report shows `(clamped)` when it hits a bound) |

Per-token attention inside the model and exact occupancy are not visible from outside, so the mod does not claim them.

## Analyses

- **Occupants**: items still in the current window, by category (tool name, `attachment:<name>`, prompt/response) and by target (file, command).
- **Re-reads**: classifies every read of a file after the first — `engine-deduped` (the engine replaced it with an "unchanged" notice), `restored` (the engine re-attached it after compaction), `different-range`, `after-edit`, `after-compaction`, `changed-externally`, `unchanged-live` (the earlier copy is still in the window = pure waste).
- **Similar outputs**: same full-content hash (exact) or 64-bit SimHash Hamming distance ≤ 3 (near). This is **lexical** similarity over word 3-shingles, not semantic (embedding) similarity. Numbers are folded to `#`, so test outputs that differ only in run time are grouped. Comparisons and window waste are computed separately per context. Outputs longer than 262,144 characters or 20,000 normalized words participate in exact matching only; a partial sample cannot justify whole-output near-duplicate waste.
- **Compactions**: extracts edited files, read files, errors and user identifiers from the pre-compaction conversation and checks string presence in the summary and the kept messages. Presence does not establish that the associated decisions or constraints survived. Reports lost edited files and how much was re-read because of the compaction (reflow).
- **Efficiency**: lines changed (Edit/MultiEdit/Write/NotebookEdit) against measured input growth for each main turn. Turns that grew without edits are only marked as "exploration turns" (exploration is not a defect).
- **Advice**: unchanged re-reads, whole reads of large files, long command output, repeated output, edited files lost by compaction, re-inflow after compaction, long subagent results, MCP servers never called, large memory files. Each piece of advice comes with its evidence and ≈savings.

## Settings (userConfig)

| Key | Default | Meaning |
|---|---|---|
| `outputDir` | `~/.claude/context-inspector` | Where `/context-export` writes |
| `toastAdvice` | `true` | One toast per session the first time a high-priority piece of advice appears |

## Export format

One JSON object per line: `meta`, `item` (seq, ctx, turn, door, category, target, chars, est, hash, simhash, born, epoch, live …), `edit`, `sample`, `compaction`, `summary`.
No raw content. Non-file targets (commands, patterns, URLs and agent descriptions) are cut to 200 characters after best-effort secret masking. Masking covers secret environment assignments, Authorization/Bearer credentials, `--password`/`--token`/`--api-key`/`--secret` options, headers ending in `-key`/`-token`/`-secret`, URL passwords, curl `-u`/`--user` credentials, mysql `-p` passwords and common JSON credential fields. Shell-quoted headers treat escaped quotes as part of the value. File paths are retained unchanged. This is not a complete secret detector: review exports before sharing. Existing export files are not retroactively sanitized by an update; review or remove older files, and rotate any real credentials that were exposed.
Errors and user identifiers among compaction entities, and item contents, are kept only as hashes (unsalted; short values can be confirmed by guessing) — this is not anonymization.
`summary` carries `wasteEst` (window now) together with `currentWasteEst` and `sessionRereadEst` (re-read waste: window now / session total).

## Environments

| Environment | Behavior |
|---|---|
| Terminal | Status line, pane, toasts and commands |
| VS Code chat panel | Hooks and command text only (the mod's UI is not shown) — `/context-inspect` is the main output |
| `claude -p` | Recording only; commands can run with `-p "/context-inspect"` |

## Limitations

- On reload, resume or `/clear`, the ledger is cleared and only the main conversation is recovered from `$.session.messages()` (no attachments, subagents or timing). `/clear` is detected from `session.end` (reason `clear`) without a `session.start`.
- Recovery runs once afterwards, deferred, and only while no prompt/response has been recorded yet. Tool results that arrived before it are recognized by tool_use_id and not added twice.
- Recovered prompt/response items have no engine handle (`$.session.messages()` does not provide one). So the first compaction after a reload counts all of them as "dropped". Tool results keep matching by tool_use_id.
- The ledger is capped at 20,000 items (on overflow, items outside the window are dropped first).
- Compaction survival is judged by substring match (files also match by basename) — anything the summary paraphrases counts as lost.
- Each similarity bucket keeps and compares at most 256 distinct representatives per band value (thousands of nearly identical outputs still group through their representatives).
- Export file names always end in `-<n>` (a single file is `context-<load>-1.jsonl`). Running `/context-export` again within the same load overwrites that load's files with a full new snapshot.
- Advice such as large-read, large-bash, agent-verbose and reread-unchanged covers everything that happened in the session (habit advice), including output a later compaction removed. It differs from the status line's waste.
- When the ledger hits its cap and drops items, calibration intervals spanning dropped items are left out of the k calculation.


Reports, panels and display labels mask supported credential formats before truncation; this does not change the underlying analysis. Existing saved files are not rewritten.

## Development

```bash
CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude
"$CLAUDE292" plugin test context-inspector
cp -R agent-profiler/.claude-plugin/types context-inspector/.claude-plugin/types   # once, for tsc
npx -y -p typescript@5 tsc -p context-inspector --noEmit
"$CLAUDE292" plugin validate context-inspector
```

## File-write scope and data flow

`/context-export` writes context-ledger JSONL data with `$.fs.write` to `<outputDir>/<sessionId>/context-<loadId>-<n>.jsonl`. The default `outputDir` is `~/.claude/context-inspector`; it can be changed in plugin settings, and `HOME` is read only to expand a leading `~`. The session ID, load timestamp and chunk number determine the remaining path. The files contain the ledger's context accounting, summaries and export metadata, not executable instructions. This mod does not intentionally edit project build scripts, startup files, settings or instruction files; its variable write paths are for these generated data exports only. It does not upload these files or contact a network host.

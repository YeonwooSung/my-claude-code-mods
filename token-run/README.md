# Token Run

A small, fully local ASCII runner for Claude Code. Jump over BUG, 429 and TIMEOUT obstacles while a request is unavailable, or take a short break with `/token-run`. [한국어](README_KR.md).

## Install and start

Install while connected; after loading, the game needs no network or model calls. The mod uses the function-hooks/Client API verified with Claude Code **2.1.292**. Older builds without Mods support cannot load it.

```sh
claude plugin marketplace add YeonwooSung/my-claude-code-mods
claude plugin install token-run@my-claude-code-mods
# Or use this checkout with a compatible binary:
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ./token-run
```

```text
/token-run
/token-run help
/token-run close
```

A main turn ending in an error adds a “request failed” game invitation above the composer. Click it or run `/token-run`. It opens a Pane beside the transcript in wide fullscreen terminals, or above the prompt otherwise. It requests focus only after your command/click; if the composer or another dialog retains focus, click the game or use `ctrl+x tab`. It never replaces conversation text or sends a game prompt to the model.

## Controls

| Key / button | Action |
|---|---|
| Space / Up / Jump | Start and jump; no double jump |
| R | Restart the same course |
| P | Pause/resume |
| Q / Esc | Close the game and return to work |

Only the focused game receives keys. Ctrl/Meta/Shift combinations are ignored; no global game shortcuts. Escape is handled by the engine. Leaving focus pauses movement; returning resumes it unless P was used. Closing/reopening starts a fresh run. The game needs at least 24 columns and 8 rows; a smaller region shows a resize hint and suspends movement.

Narrow panes shorten status notices to `LOCAL`, `SAVE!` (record save warning) and `BACK:Esc` (response returned). Game-over/retry and pause controls remain visible. Q closes immediately while its accepted score save finishes.

Score counts survived seconds; collisions freeze it. The plugin-owned store saves the best score, shared across this plugin's sessions in the same local engine store. Scores are checkpointed each survived second, on collision and Q exit. Read/write failures show a warning and leave the game playable, with the best retained in memory. Engine close/Escape uses the latest checkpoint. There is no cross-process locking; simultaneous engine processes may race on records.

Terminal and Desktop use the same Client. VS Code chat, mobile and headless sessions do not run the game. Surveys retain priority over the failure invitation and may take focus away from the game.

## What “request failed” means

The verified engine API exposes main-turn failure, not an OS network-status event or readable retry markers. The invitation can also follow server, authentication or context errors, and appears after the turn fails rather than during opaque retries. It does not prove the computer is offline. No health probes or retries are introduced. A later main response shows a return-to-work notice without interrupting play. Subagent outcomes do not affect the invitation.

## Development

```sh
npm test
npm run typecheck
CLAUDE_BIN=/path/to/claude-2.1.292 npm run test:adapters
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 /path/to/claude-2.1.292 plugin test token-run
/path/to/claude-2.1.292 plugin validate token-run
```

Typecheck needs matching local `.claude-plugin/types` declarations; these generated files are ignored like those of other mods. No new dependencies. Pure tests cover deterministic physics, storage races/failure, request generations and responsive ASCII output. Real engine tests mount the Client on terminal/Desktop and advance its frame clock to test keys, buttons, focus/resize suspension, scores and lifecycle. These are render-tree tests, not terminal/Desktop pixel captures.

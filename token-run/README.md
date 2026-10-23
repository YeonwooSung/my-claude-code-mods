# Token Run

A small, fully local ASCII runner for Claude Code. Jump over BUG, 429 and TIMEOUT obstacles while a request is unavailable, or take a short break with `/token-run`. [한국어](README_KR.md).

## Install and start

Install while connected; after loading, the game needs no network or model calls. The mod uses the function-hooks/Client API verified in engine tests with Claude Code **2.1.296, 2.1.299, 2.1.300 and 2.1.301**, and in real terminal sessions with **2.1.296 and 2.1.301**. Older builds without Mods support cannot load it.

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
| Track click / Space / Up / Jump | Start and jump; no double jump |
| R | Restart the same course |
| P | Pause/resume |
| Q | Close the game |
| Esc | Return focus to the composer; another Esc at an empty idle prompt closes the pane |

Only the focused game receives keys. Ctrl/Meta/Shift combinations are ignored; no global game shortcuts. Click the track or Jump to give the Client keyboard focus. Escape is handled by the engine. Use P to pause before returning to work: the API does not expose Client blur, so leaving focus does not automatically pause. Closing/reopening starts a fresh run. The game needs at least 24 columns and 8 rows; a smaller region shows a resize hint and suspends movement.

Switching between docked and inline layouts may remount the Client. An in-memory checkpoint restores the run; paused/restarted states are saved immediately, while a running game may roll back by about one simulated second. Click the track or a button to regain focus after this transition. Closing clears this checkpoint.

Narrow panes shorten status notices to `LOCAL`, `SAVE!` (record save warning) and `BACK:Esc` (response returned). Game-over/retry and pause controls remain visible. Q closes immediately while its accepted score save finishes.

Score counts survived seconds; collisions freeze it. The plugin-owned store saves the best score, shared across this plugin's sessions in the same local engine store. Scores are checkpointed each survived second, on collision and Q exit. Read/write failures show a warning and leave the game playable, with the best retained in memory. Engine close/Escape uses the latest checkpoint. There is no cross-process locking; simultaneous engine processes may race on records.

Terminal and Desktop use the same Client. VS Code chat, mobile and headless sessions do not run the game. Surveys retain priority over the failure invitation and may take focus away from the game.

## What “request failed” means

The verified engine API exposes main-turn failure, not an OS network-status event or readable retry markers. The invitation can also follow server, authentication or context errors, and appears after the turn fails rather than during opaque retries. It does not prove the computer is offline. No health probes or retries are introduced. A later main response shows a return-to-work notice without interrupting play. Subagent outcomes do not affect the invitation.

## Development

```sh
npm test
npm run typecheck
CLAUDE_BIN=/path/to/claude-2.1.301 npm run test:adapters
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 /path/to/claude-2.1.301 plugin test token-run
/path/to/claude-2.1.301 plugin validate token-run
```

Typecheck needs matching local `.claude-plugin/types` declarations; these generated files are ignored like those of other mods. No runtime dependencies are added. Pure tests cover deterministic physics, storage races/failure, request generations and responsive ASCII output. Real engine tests mount the Client on terminal/Desktop and advance its frame clock to test keys, buttons, explicit pause, input with an unfocused parent Pane, resize suspension and checkpoint restoration, scores and lifecycle. These are render-tree tests, not terminal/Desktop pixel captures.


## Real terminal smoke test (optional)

On macOS/Linux, run the native CLI in an isolated PTY with a temporary config, a dummy API key and a refused loopback API endpoint. This checks actual input/focus, animation, resize, failure entry and records across process restart. It does not change system network settings or use your account. The optional Python dependencies are only for QA.

```sh
python3 -m venv /tmp/token-run-qa
/tmp/token-run-qa/bin/pip install -r token-run/qa/requirements.txt
/tmp/token-run-qa/bin/python token-run/qa/pty_smoke.py --claude-bin /path/to/claude-2.1.301 --artifacts /tmp/token-run-smoke
# Add --combined to load all seven mods together.
```

Solo runs on 2.1.296/2.1.301 and a combined run on 2.1.301 passed 19 checkpoints each. Artifacts include ANSI output, decoded screen snapshots and result.json. Native Desktop GUI rendering has not been checked; Desktop coverage is engine render-tree coverage. See the [verification report](../docs/verification/2026-10-17-token-run.md) for evidence and limits.

## Data flow and Client loading

The render hook calls the resolved `Client` element with the fixed local module path `./game.tsx` in an inline options object. This is the same engine element API as JSX; it loads only the bundled `hooks/game.tsx`. The Client receives game state, score and request-status flags, and posts score/checkpoint/exit messages back to this plugin through the local UI message channel. It receives no prompt or response text. Best scores go only to the plugin's local store; this mod has no network destinations or process execution.

In `tests/adapter.test.ts`, the `command($, args)` helper calls `$.command.run` for the fixed `token-run` command inside the engine test harness. It exercises local game/help/close behavior, not a shell or external service. Test store reads use an in-memory Map or test callbacks; their values are used for assertions and the local game UI, not sent externally. The `turn.step` hook observes chunk kinds to update recovery status and forwards chunks and the final response unchanged.

## Hook and test-call review details

The `command.run` hook answers only `/token-run [help|close]` and controls the local game pane; the installed game does not invoke slash commands. Session/turn hooks update local game/request state and forward their events or stream chunks. `ui.close` detaches game state, `ui.message` accepts validated score/checkpoint/exit data only for the active run, and `ui.render` preserves existing UI while adding the failure invitation or this game pane. None changes a model prompt, permission rule, setting or tool input/result.

In `tests/adapter.test.ts`, `command($, args)` calls the engine's fixed `$.command.run({ command: 'token-run', ... })` only to exercise this mod in the test harness. The `complete($, ...)` helper calls the engine-owned `$.turn.complete(...)` with a synthetic turn result. The latter is the unknown call reported at the cited test line: it is not supplied by another plugin and makes no network/process call. Store reads are in-memory test fixtures or local best-score reads. Constructors initialize game/request state.

The optional `qa/pty_smoke.py` builds its child environment from fixed OS metadata (PATH, home directory, LANG, TERM), then adds an isolated test config, refused loopback API URL and placeholder key. It does not enumerate or copy installer environment variables, so unrelated API tokens are not forwarded. Its control sequences and Korean control labels are UI data, not shell programs. Runtime gameplay remains fully local.

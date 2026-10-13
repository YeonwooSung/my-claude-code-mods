# Token Run design

## Intent and authorization

Provide an immediately understandable local runner game during Claude Code request failures. The user selected Token Run and explicitly requested specification, planning, TDD implementation and unit commits on main on 2026-10-14. Continue through implementation without additional approval gates; do not create branches/worktrees or push.

## Experience

- A failed main turn offers an unobtrusive AbovePrompt button; never auto-open the game or take prompt keys.
- `/token-run` opens a dedicated `token-run` Pane, also usable when online. Request focus only in response to that command or the invitation button. The engine preserves the conversation/composer. The Pane uses `closeOnEscape: true` so Escape returns to work.
- The first Space/Up starts and jumps; running Space/Up jumps only from ground. R restarts, P pauses/resumes, Q closes. Modified keys are ignored. Buttons provide Start/Jump, Restart, Pause and Close without global hotkeys.
- The cursor runner `@` clears compact BUG/429/TIMEOUT obstacles. Collision freezes score and allows immediate restart. Score counts survived seconds; best survives session restarts in the plugin-owned local store.
- A game is local TypeScript only: no model, fetch, process or extra packages. Physics is pure, immutable, deterministic seeded random, fixed 50 ms steps (20 FPS), fixed 64-cell world and bounded speed/obstacle count.
- The game requires at least 24 columns and 8 rows. Smaller regions show a resize hint and suspend physics. Losing Pane focus suspends physics, preserving the local run. Closing, unmount and session start/end/clear dispose the drawing's timer and invalidate old message handles. Focus loss, including survey focus, suspends movement while retaining the instance. Closing/reopening starts a new run; best is retained.

## Request observation and honesty

The local 2.1.292 contract has no network-status event; opaque `engine` stream markers cannot identify retry/offline status. Observe `turn.complete.reason === 'error'` for the main turn and offer “요청 실패 · 잠깐 달려볼까요?”. This includes exhausted network failures, server/auth/context errors: never label all of them OFFLINE. An aborted or refused turn does not trigger an invitation. A valid main response chunk (`text`, `thinking`, `tool`, `input`, `stop`) or answered main completion changes the status to response observed; after a failure the game shows “응답이 돌아왔어요 · Esc로 작업 복귀”. This is evidence of response availability, not an OS connectivity check. Subagent events and stale main-turn events do not update the status. Streams, final results, errors and lifecycle events pass through exactly once. No health probes, request retries or prompt modifications.

## Boundaries and interfaces

1. `hooks/core/game.ts`: `newGame(seed?: number): Game`; `act(game, 'jump'|'restart'|'pause'): Game`; `step(game): Game`. Game carries phase, ticks, y/vy, distance, nextSpawn, seed and obstacles. World width 64, player x=6; swept horizontal overlap prevents obstacles tunneling past the runner; only grounded contact collides. Game-over/ready/paused steps are inert. Seed is normalized; speed caps at 1.2 cells/tick, spawned obstacles at least 36 world cells apart.
2. `hooks/core/state.ts`: `RequestState` tracks current turn and status, with generation guards; `Scores` serializes local reads/writes and merges maximum scores. Store key `token-run.best.v1`, schema `{version:1,best:number}`; valid integer range 0..999999. Missing/malformed data starts at zero. Read/write failure leaves the game playable with a visible local-save warning. Read before each write prevents overwriting an unseen higher stored score; cross-process simultaneous writers have no synchronization guarantee.
3. `hooks/core/view.ts`: `gameView(game, columns, rows)` builds eight ASCII lines (title, score, four rows of track, ground, controls) clipped to region bounds. Region pixels/cells do not affect physics. Obstacles are clipped at both edges, runner height maps to track rows. No ANSI/control characters or user text.
4. `hooks/game.tsx`: Client module owns game state, one `surface.every` timer, focused keyboard and buttons. Posts bounded score checkpoints once per survived second, on collision and on exit, through `ui.message`; no host call per animation frame. Posts include runId. Timer stops on unmount; current props, focus and region bounds are consulted inside callbacks, avoiding stale captures. UI redraws retain local game state.
5. `hooks/register.tsx`: command registration, invitation, Pane render, request observation, score storage and validated Client messages. Increment runId on opens/close/session boundaries. Only the current open run may submit score or close messages. Preserve downstream trees and yield band to surveys. Terminal/Desktop supported; other surfaces get an explanatory command response.

## Validation and completion

Node >=22.19.0; TypeScript/JSX and matching local Claude Code 2.1.292 declarations. No new dependencies. Engine integration tests use the installed VS Code extension binary, not PATH's older 2.1.280.

TDD units: game physics; request/score state; responsive ASCII view; real engine adapter and Client input/timer; marketplace and documentation integration. Each behavior unit observes RED before implementation and GREEN before commit. Run full core suite, all engine suites, typecheck and plugin validation, then a separate review. Verify modified keys, double jumps, tunneling, narrow/NaN sizes, focus loss, reset/unmount, stale messages, failed storage, concurrent saves and stream/result preservation. Actual terminal visual inspection is desirable; report if not performed.


## Completion — 2026-10-14

Implemented on main with unit commits; no branch, worktree, push or installation. All behaviors observed RED then GREEN. A read-only independent review found delayed-open resurrection and clipped Pane movement; both fixed with regression tests. Notice truncation and blocked-Q exit were also treated as user-visible behavior problems and fixed. A further regression prevents a late old-turn completion/response from reattaching after reset: only a main `turn.start` binds the current turn.

The Pane now passes actual available rows/columns to the Client, in addition to the measured region. Phase/retry text precedes notices; narrow notices use LOCAL, SAVE! and BACK:Esc. Q detaches and closes immediately while the already-accepted record save finishes. A load-delayed open checks its generation before touching the Pane.

Final verification: core 303/303; engine 399/399 across seven mods, including Token Run 38/38; global typecheck and plugin validate pass. Marketplace validation passes with its pre-existing missing-description warning. Independent reviewer did not assess live terminal/Desktop focus transfer or pixels; render trees, focused inputs and timers were tested in the real engine. External health probing and cross-process store locking remain explicitly out of scope. No deferred code findings.

# agent-profiler

A Claude Code mod that shows where an agent session's time goes: model wait, tool execution, subagents, test runs, repeated file reads, and engine overhead. It exports the session as an OTLP trace so you can open it in Jaeger or Grafana Tempo.

Requires Claude Code 2.1.287 or later (desktop 2.1.286). Event shapes follow the 2.1.292 type declarations; the end-to-end probe (`claude -p`), the Jaeger import and the tests ran on Claude Code 2.1.280 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## What it shows

Every span and metric carries `agent_profiler.observability`. The mod never claims to measure "inference time"; it reports what the client can observe.

| Grade | Meaning | Example |
|---|---|---|
| `measured` | Value measured and handed over by the engine | `classic.PostToolUse.duration_ms` (tool execution time) |
| `observed` | Interval the mod timed in-process from event boundaries | `turn.step` send, first chunk, end; `tool.call` entry to return |
| `reported` | Value reported by the API | `usage.output_tokens`, cache read/creation tokens |
| `inferred` | Remainder computed from the values above | tool wait = wall - exec; engine overhead = turn - (request + tool) |

Time categories (one context is the main loop or one subagent loop):

```
turn (turn.start -> turn.complete)                                   observed
+- model.request (turn.step: next call -> stream end)                observed
|   +- ttft            : send -> first chunk (network + queueing + prefill, not separable)
|   +- thinking.stream : first thinking chunk -> last thinking chunk
|   +- output.stream   : first text/tool chunk -> end
|   + usage (tokens)                                                 reported
+- tool (tool.call: entry -> next return)                            observed
|   +- exec = duration_ms                                            measured
|   +- wait = wall - exec                                            inferred
|        approval wait if tool.check said 'ask', otherwise tool.overhead
+- subagent (classic.SubagentStart -> classic.SubagentStop)          observed
|   +- (recursive) model.request / tool
+- engine.overhead = turn - (model.request U tool U blocking subagent)   inferred
idle: turn.complete -> next turn.start (excluded from agent time)
```

TTFT and stream times are response-wait times observed at the client, not time the model spent computing. Engine retries are absorbed into one `turn.step`, so they appear as a longer TTFT.

## Install

```
/plugin install agent-profiler --marketplace YeonwooSung/my-claude-code-mods
```

During development, load the folder directly:

```
claude --plugin-dir ./agent-profiler
```

Mods are on by default from Claude Code 2.1.287 (desktop 2.1.286). Earlier builds need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment of the `claude` process; 2.1.287+ ignores it.

## Commands

| Command | What it does |
|---|---|
| `/profile` | Markdown report of the whole session (time categories, tool/model stats, repeated reads, subagents, findings) |
| `/profile turn` | The same report for the last turn only |
| `/profile-pane` | Opens the live pane (in-flight requests and tools, category bars, recent findings) |
| `/profile-export` | Writes the OTLP JSON file and POSTs it if an endpoint is configured; returns the path and status |

A status line (`model 61% - tools 28% - running: Bash npm test 14s`) is updated at most twice a second.

## Settings

Set in the `/plugin` settings menu or in settings `pluginConfigs`.

| Key | Default | Meaning |
|---|---|---|
| `otlpEndpoint` | `""` | OTLP/HTTP base URL, e.g. `http://localhost:4318`. The mod POSTs to `{endpoint}/v1/traces`. Empty means file only. |
| `outputDir` | `~/.claude/agent-profiler` | Where `<sessionId>.otlp.json` is written. |

The file is overwritten on every `turn.complete` and on `session.end`.

## Jaeger / Tempo

`traceId` is the session UUID without dashes and `spanId` is a deterministic hash, so re-sending the same session yields the same spans.

Jaeger:

```bash
docker compose -f agent-profiler/examples/jaeger/docker-compose.yml up -d
curl -sS -X POST -H 'content-type: application/json' \
  --data @$HOME/.claude/agent-profiler/<sessionId>.otlp.json \
  http://localhost:4318/v1/traces
```

Open http://localhost:16686 in a browser and pick the service `claude-code`. Stop it with:

```bash
docker compose -f agent-profiler/examples/jaeger/docker-compose.yml down
```

Or set `otlpEndpoint` to `http://localhost:4318` and the mod sends the trace itself.

Grafana Tempo accepts the same OTLP/HTTP endpoint (port 4318 by default), so use the same curl or `otlpEndpoint` value pointing at your Tempo (or OpenTelemetry Collector) host.

Span names follow the GenAI semantic conventions: `chat <model>`, `execute_tool <tool>`, `invoke_agent <type>`, with `agent_profiler.*` attributes for the rest.

## Behavior by environment

| Environment | Hooks, recording, export | Pane / status line | `/profile` text |
|---|---|---|---|
| Terminal `claude` | yes | yes | yes |
| Desktop Code tab | yes | yes | yes |
| VS Code chat panel | yes | no (drawing is not shown) | yes |
| `claude -p` / SDK | yes | no | yes |

## Limitations

- Time inside the model server (queueing, prefill, decoding, GPU) cannot be broken down. TTFT lumps network, queueing and prefill together.
- Files modified through Bash are not visible to the repeated-read detection.
- Hot reload resets in-memory state; only the on-disk snapshot survives.
- `turn.start` fires only for main-loop turns. Subagents have no `turn` spans of their own: their `chat` and `execute_tool` spans hang directly under `invoke_agent`.
- Background (async) subagents keep running after the Agent tool returns. Their `invoke_agent` span is still a child of `execute_tool Agent` but outlives it, and the completion notification starts an extra main turn.
- Event shapes follow the 2.1.292 type declarations; the end-to-end probe, Jaeger import and tests ran on 2.1.280 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Other versions may differ.

## Tests

```
cd agent-profiler
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test
claude plugin validate .
```

(The variable is only needed before 2.1.287.)

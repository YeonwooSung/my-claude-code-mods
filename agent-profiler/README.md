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
/plugin marketplace add YeonwooSung/my-claude-code-mods
/plugin install agent-profiler@my-claude-code-mods
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
| `/profile-export` | Writes a full snapshot of the session as OTLP JSON chunk files and POSTs each if an endpoint is configured; returns one line per file written and the POST result |

A status line (`model 61% - tools 28% - running: Bash npm test 14s`) is updated at most twice a second.

## Settings

Set in the `/plugin` settings menu or in settings `pluginConfigs`.

| Key | Default | Meaning |
|---|---|---|
| `otlpEndpoint` | `""` | OTLP/HTTP base URL, e.g. `http://localhost:4318`. The mod POSTs to `{endpoint}/v1/traces`. Empty means file only. |
| `outputDir` | `~/.claude/agent-profiler` | Where trace files are written, one folder per session (see below). |
| `exportCommandText` | `false` | Include turn prompts and Bash command lines in exported traces (files and POSTs), with obvious secrets redacted. |

## Trace files

Files go to `<outputDir>/<sessionId>/`. `<loadId>` is a base-36 timestamp taken when the mod loads, so a hot reload or `--resume` starts new file names and never overwrites earlier ones.

| File | Written | Contents |
|---|---|---|
| `<loadId>-<seq>.otlp.json` (`seq` = 0001, 0002, ...) | after every `turn.complete`, and at `session.end` | Per-turn batches hold only the turns, requests, tools and subagents that finished since the previous batch. The `session.end` batch holds everything not written yet (open spans marked `agent_profiler.incomplete`) plus the session root span. |
| `<loadId>-full-<n>.otlp.json` | by `/profile-export` | A full snapshot of what is in memory, root and open spans included. A later `/profile-export` in the same load rewrites these. |

Each file is at most 3.5 MiB; a larger batch or snapshot is split into several files (and several POSTs). If `otlpEndpoint` is set, each batch is POSTed after it is written. The `session.end` POST gets what is left of Claude Code's short exit budget (1.5 s at most) and is dropped past it; the file is written first. Nothing is written until the session id is known. A failed automatic write or POST is shown once as a toast.

The numbered batches together are the whole session; the `full` files are a separate snapshot, so send one set or the other, not both.

## What is exported

Per span: name, start/end time, parent, status, and these attributes.

- Resource: `service.name=claude-code`, `session.id`, `agent_profiler.version`.
- Turn: `agent_profiler.turn.reason`; `agent_profiler.turn.prompt` (first 120 characters) only with `exportCommandText`.
- Model request (`chat <model>`): `gen_ai.request.model`, `gen_ai.response.model`, input/output token counts, cache read/creation tokens, finish reason, effort, `agent_profiler.ttft_ms`; child spans `model.ttft`, `model.thinking_stream`, `model.output_stream`.
- Tool (`execute_tool <tool>`): tool name and call id, `agent_profiler.exec_ms`, `wait_ms`, `permission` decision, `fs.path` and `fs.range` (file tools), `search.pattern` (Glob/Grep), `bash.category`, launched agent id; `agent_profiler.bash.command` only with `exportCommandText`; child spans `tool.exec` and `tool.approval_wait` / `tool.overhead`.
- Subagent (`invoke_agent <type>`): agent id and type, whether it ran async.
- Every span: `agent_profiler.category`, `agent_profiler.observability`, `agent_profiler.incomplete` when still open.

With `exportCommandText` on, prompts and commands are redacted first: `Authorization: ...` header values, `Bearer <token>`, `--password <x>` / `--password=<x>`, `mysql ... -p<password>`, and `NAME=value` where `NAME` contains KEY, TOKEN, SECRET or PASSWORD. This catches common shapes only, so leave the setting off when traces leave your machine and commands may carry secrets. File paths and search patterns are always exported.

## Jaeger / Tempo

`traceId` is the session UUID without dashes and `spanId` is a deterministic hash, so re-sending the same session yields the same spans.

Jaeger:

```bash
docker compose -f agent-profiler/examples/jaeger/docker-compose.yml up -d
# send a session's numbered batches (leave out the -full- snapshot files)
for f in $HOME/.claude/agent-profiler/<sessionId>/*.otlp.json; do
  case "$f" in *-full-*) continue ;; esac
  curl -sS -X POST -H 'content-type: application/json' --data @"$f" http://localhost:4318/v1/traces
done
```

To send the latest `/profile-export` snapshot instead, loop over `*-full-*.otlp.json` of one load id.

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
- Hot reload resets in-memory state: `/profile` and the pane start over from the reload. Batches already written stay on disk, and the new load writes under a new load id.
- Memory is capped at 20,000 requests and tool calls. Past it, whole finished turns are dropped, oldest first, with their requests, tools and subagents; they were already written as batches. The report then says "covers the last N turns; M older turns dropped".
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

Type check (from the repository root):

```
npx -y -p typescript@5 tsc -p agent-profiler --noEmit
```

`tsconfig.json` includes `.claude-plugin/types`, where Claude Code writes `claude-code/index.d.ts` each time it loads the mod (the folder is git-ignored). Before the first load, copy the declarations there yourself, e.g. from the `plugin-authoring` skill's `types/claude-code.d.ts` to `agent-profiler/.claude-plugin/types/claude-code/index.d.ts`.

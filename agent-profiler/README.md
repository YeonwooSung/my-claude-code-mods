# agent-profiler

A Claude Code mod that shows where an agent session's time goes: model wait, tool execution, subagents, test runs, repeated file reads, and engine overhead. It exports the session as an OTLP trace so you can open it in Jaeger or Grafana Tempo.

Version 0.1.6 is verified on Claude Code **2.1.302**, including a real SDK-host permission/OTLP probe with telemetry export disabled. The function-hooks API is early access; the older 2.1.280–2.1.292 verification described in historical reports does not establish compatibility for this revision.

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
|        tool.approval_wait (estimated user/classifier prefix when identifiable)
|        tool.overhead (remaining wait with an identifiable decision)
|        tool.wait_unclassified (when permission timing is unavailable)
+- subagent (classic.SubagentStart -> classic.SubagentStop)          observed
|   +- (recursive) model.request / tool
+- engine.overhead = turn - (model.request U tool U blocking subagent)   inferred
idle: turn.complete -> next turn.start (excluded from agent time)
```

TTFT and stream times are response-wait times observed at the client, not time the model spent computing. Engine retries are absorbed into one `turn.step`, so they appear as a longer TTFT.

Terminal API failures (including usage/rate limits) close the affected turn and its open requests and tools at `classic.StopFailure`. Waiting for the limit to reset is excluded. Independent background agents keep their own timers; a failed subagent closes only its own context. `turn.complete` also settles any requests or tools still open in that turn.

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
| `exportCommandText` | `false` | Include turn prompts, Bash command lines and search patterns in exported traces (files and POSTs), with obvious secrets redacted. |

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
- Tool (`execute_tool <tool>`): tool name and call id, `agent_profiler.exec_ms`, `wait_ms`, `fs.path` and `fs.range` (file tools), `search.pattern` (Glob/Grep, redacted and only with `exportCommandText`), `bash.category`, launched agent id; `agent_profiler.bash.command` only with `exportCommandText`; final permission metadata `agent_profiler.permission_decision`, `permission_source`, `permission_classifier` when observed; `permission_wait_ms` and `permission_wait_kind` only when estimable. Child spans: `tool.exec`, `tool.approval_wait`, `tool.overhead` or `tool.wait_unclassified` as applicable. Confirmed rejections have zero execution and no `tool.exec` child.
- Subagent (`invoke_agent <type>`): agent id and type, whether it ran async.
- Every span: `agent_profiler.category`, `agent_profiler.observability`, `agent_profiler.incomplete` when still open.

With `exportCommandText` on, prompts and commands are redacted first: `Authorization: ...` header values, `Bearer <token>`, `--password <x>` / `--password=<x>`, `mysql ... -p<password>`, and `NAME=value` where `NAME` contains KEY, TOKEN, SECRET or PASSWORD. This catches common shapes only, so leave the setting off when traces leave your machine and commands may carry secrets. File paths are always exported; search patterns require `exportCommandText`.

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


Reports, panels and display labels mask supported credential formats before truncation; this does not change the underlying analysis. Existing saved files are not rewritten.

## Limitations

- Time inside the model server (queueing, prefill, decoding, GPU) cannot be broken down. TTFT lumps network, queueing and prefill together.
- Files modified through Bash are not visible to the repeated-read detection.
- Hot reload resets in-memory state: `/profile` and the pane start over from the reload. Batches already written stay on disk, and the new load writes under a new load id.
- Memory is capped at 20,000 requests and tool calls. Past it, whole finished turns are dropped, oldest first, with their requests, tools and subagents; they were already written as batches. The report then says "covers the last N turns; M older turns dropped".
- `turn.start` fires only for main-loop turns. Subagents have no `turn` spans of their own: their `chat` and `execute_tool` spans hang directly under `invoke_agent`.
- Background (async) subagents keep running after the Agent tool returns. Their `invoke_agent` span is still a child of `execute_tool Agent` but outlives it, and the completion notification starts an extra main turn.
- This revision was verified with the real CLI/SDK host and engine render-tree runner on 2.1.302. Native Desktop pixels, actual terminal permission-dialog interaction, real auto-classifier requests and older engine versions were not exercised by the new permission probe.

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

Secret masking is best-effort and covers credential flags, sensitive headers, URL passwords, curl/mysql credentials and common credential fields in JSON strings. It does not sanitize snapshot file contents or retroactively rewrite saved files. Review files before sharing.

## Permissions

Agent Profiler does not register `tool.check`, `classic.PreToolUse` or `classic.PermissionRequest`, and never reads/modifies their return values. Tool calls proceed through normal host permission checks. A `telemetry.log` hook filtered to `{ to: 'collector' }` observes `tool_decision` records and returns `next(e)` unchanged. It retains only the matching tool-use ID, final `accept`/`reject`, a fixed source enum, an optional fixed classifier enum and the decision timestamp. Other attributes (including identity fields and free text) are discarded. The hook does not enable telemetry exporters or send a telemetry record. In the verified engine it receives decisions even with external export disabled.

Final `accept`/`reject` is not the old `allow`/`ask`/`deny` verdict. Decisions from `user_temporary`, `user_permanent`, `user_reject` or `user_abort` can identify a user-related prefix; `config` plus a recognized `classifier_verdict` identifies an auto-check prefix. A bare `config`, `hook`, unknown source or absent event does not identify approval timing. In hosted sessions, saved grants may also retain a user source, so that source alone does not prove a fresh prompt was shown.

For a completed call with execution-duration evidence (or a confirmed rejection), the estimated prefix is `decision timestamp - tool entry`, clamped to the total non-execution interval. It includes preceding checks and hooks, not just human response time. The remaining non-execution interval is reported separately. Missing execution duration, unfinished calls or ambiguous sources leave permission timing unavailable. `/profile` shows `unavailable` instead of a false zero, or an estimate with coverage such as `1/2 calls`; the unclassified remainder may still contain approval time. Reports and OTLP use the same calculation.

Version 0.1.6 replaces the old `agent_profiler.permission` attribute with the final-result fields above. The approval-wait span can return, but is explicitly an estimate with `permission_wait_kind=user|auto`; queries that assumed the old verdict attribute or treated every wait as tool overhead need updating. Existing saved files are not rewritten. A valid late record can update reports and a new `/profile-export` snapshot; an automatic batch already exported before the record arrived is not rewritten. Unknown IDs, invalid timestamps, out-of-call timestamps and duplicate verdicts are ignored.

In `tests/adapter.test.ts`, collector records are injected through the real engine test driver into the registered observer with a local sink; tests assert reports, OTLP fields and unchanged tool results. These fixtures do not upload test records. The core tests also cover absent/invalid data, mixed coverage, classifier observations, subagent IDs and rejection without execution evidence.

## Network, observed calls and file writes

The `tool.call` hook observes tool names, summarized inputs, outcomes and timing, including calls that may themselves access the network. It forwards each original call once. The `turn.step` hook observes model/effort, chunk kinds and usage while forwarding conversation chunks. The `command.run` hooks answer only `/profile`, `/profile-pane` and `/profile-export`; they report, open the local pane or export recorded data. They do not run shell commands or execute instructions from an HTTP response.

The only direct network call is `$.http.fetch`: an HTTP POST of OTLP trace JSON to `<otlpEndpoint>/v1/traces`. There are no default external hosts: an empty endpoint disables HTTP. The destination host is the host of the user-configured `otlpEndpoint` (for example `localhost` on port 4318 for Jaeger/Tempo, or the user's Collector host). This host cannot be a compile-time constant because the collector is configurable. Responses are checked for success/status only, never evaluated as commands. No custom redirect option is supplied; HTTP redirects follow the host engine's fetch policy, so configure a collector you trust.

POST bodies contain the same trace JSON written locally: session and span IDs, timing, model/token metadata, tool names, paths/ranges, summaries and subagent metadata listed above. Turn prompt prefixes, Bash command text and search patterns are included only when `exportCommandText` is enabled, after best-effort masking. Full model response text is not exported. `$.env.get('HOME')` is used only to expand a leading `~` in `outputDir`; the environment value is not added to the POST body as a separate field. Paths in tool metadata may themselves contain home-directory names.

`$.fs.write` writes only generated `.otlp.json` trace files under `<outputDir>/<sessionId>/` with the exact naming patterns in “Trace files”. The default base is `~/.claude/agent-profiler`; `outputDir` is user configurable. These are data exports, not build, startup, settings or instruction files. This mod does not intentionally edit those files.

## Real permission smoke test

```sh
python3 agent-profiler/qa/permission_smoke.py --claude-bin /path/to/claude --artifacts /tmp/profiler-permission-smoke
```

The standard-library-only script starts a temporary driver mod and an isolated copy of this profiler with its output fallback redirected into the fixture. It uses a fresh Claude config, a placeholder credential and a refused loopback API URL; it makes no model request. All telemetry exporters remain disabled. The SDK test host approves only an exact temporary Write fixture after a 300ms delay, or denies it, and also checks an automatically allowed Read. It verifies actual file outcomes, tool-use ID correlation, exported permission metadata/timing, manifest/runtime version agreement and no execution span for a rejection. Only a local `result.json` summary is retained in the requested artifacts directory; no user settings or repository source files are edited.

## Hook and source-review details

The three `command.run` matchers answer only `/profile` (report text), `/profile-pane` (open this mod's pane) and `/profile-export` (write the trace and optionally POST it to the configured collector). They do not invoke slash commands themselves or intercept unrelated commands. `classic.StopFailure` closes the affected recorded context and schedules a save; `classic.PostToolUse` and `classic.PostToolUseFailure` record the host's duration; `classic.SubagentStart` and `classic.SubagentStop` record subagent lifecycle. Each classic hook passes the original event on unchanged; none rewrites settings, instructions, tool descriptions or permission results.

For the credential-review hold: `hooks/core/ids.ts` hashes a record identifier with FNV to produce stable OTLP span IDs, or derives a trace ID from a session ID. It reads no file, environment object or credential. Its `recordId` argument is not an API key. The runtime's only environment lookup is the literal `HOME` for output-path expansion, as described above. `Profiler.isLive` is a pure getter over the in-memory open-record collections, without I/O or state mutation; `constructor` initializes ordinary class state. The `tool.call` spelling in OTLP comments/attribute names describes observed calls, not a tool invocation made by that file.

`tests/redact.test.ts` passes command-shaped strings to the redactor as test data. Curl/header/password examples and sample URLs are never executed, downloaded or imported. The sample host is `example.invalid` and credentials use explicit placeholders. `qa/permission_smoke.py` constructs its child environment from fixed OS metadata names (PATH, home directory, LANG) and adds only isolated test settings and a placeholder key; it does not enumerate/copy the installer's environment. It exports no telemetry and its API URL is refused loopback. The only outbound POST in the actual mod remains the optional trace export described above; no installer credential is added to it.

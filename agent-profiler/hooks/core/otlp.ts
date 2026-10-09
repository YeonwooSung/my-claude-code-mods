import { classifyCommand } from './classify.ts'
import { spanId, traceIdFromSession } from './ids.ts'
import { MAIN, isAgentTool } from './profiler.ts'
import { redactSecrets } from './redact.ts'
import type { Snapshot } from './types.ts'

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
export type OtlpAttr = { key: string; value: AttrValue }
export type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttr[]
  status: { code: number; message?: string }
}
export type OtlpRequest = {
  resourceSpans: { resource: { attributes: OtlpAttr[] }; scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[] }[]
}
type Attrs = Record<string, string | number | boolean | undefined>

export type OtlpOptions = {
  // Which records to emit, by recordKey(); a record's phase spans (ttft, exec, wait, ...) go with it. Default: all.
  include?: (key: string) => boolean
  // Emit the session root span. Default true; batches leave it to the final export.
  root?: boolean
  // Export turn prompts and Bash command lines (redacted). Default false: both are left out.
  commandText?: boolean
}

export type RecordKind = 'turn' | 'step' | 'tool' | 'agent'

export function recordKey(kind: RecordKind, id: string): string {
  return `${kind}:${id}`
}

const INTERNAL = 1
const CLIENT = 3
const STATUS_OK = 1
const STATUS_ERROR = 2

export function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

function attrs(values: Attrs): OtlpAttr[] {
  const out: OtlpAttr[] = []
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined || v === '') continue
    if (typeof v === 'string') out.push({ key, value: { stringValue: v } })
    else if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } })
    else if (Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } })
    else out.push({ key, value: { doubleValue: v } })
  }
  return out
}

export function toOtlp(s: Snapshot, version: string, options: OtlpOptions = {}): OtlpRequest {
  const traceId = traceIdFromSession(s.sessionId)
  const include = options.include ?? (() => true)
  const want = (kind: RecordKind, id: string) => include(recordKey(kind, id))
  const text = (value: string | undefined) => (options.commandText === true && value ? redactSecrets(value) : undefined)
  const spans: OtlpSpan[] = []
  const end = (x: { end?: number }) => x.end ?? s.now
  const open = (x: { end?: number }) => (x.end === undefined ? true : undefined)
  const add = (kind: string, key: string, name: string, parent: string | undefined, start: number, stop: number, values: Attrs, extra: { spanKind?: number; error?: string } = {}): string => {
    const id = spanId(kind, key)
    spans.push({
      traceId,
      spanId: id,
      ...(parent ? { parentSpanId: parent } : {}),
      name,
      kind: extra.spanKind ?? INTERNAL,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(Math.max(start, stop)),
      attributes: attrs(values),
      status: extra.error ? { code: STATUS_ERROR, message: extra.error } : { code: STATUS_OK },
    })
    return id
  }

  // Span ids are deterministic, so a span can name a parent emitted in another batch.
  const root = spanId('session', s.sessionId)
  if (options.root !== false) {
    const sessionStart = [...s.turns, ...s.steps, ...s.tools, ...s.agents].reduce((min, x) => Math.min(min, x.start), s.started ?? s.now)
    add('session', s.sessionId, 'claude-code session', undefined, sessionStart, s.now, {
      'session.id': s.sessionId,
      'agent_profiler.observability': 'observed',
    })
  }

  const mainTurns = new Set<string>()
  for (const t of s.turns) {
    if (t.ctx !== MAIN) continue
    mainTurns.add(t.id)
    if (!want('turn', t.id)) continue
    add('turn', t.id, 'turn', root, t.start, end(t), {
      'agent_profiler.category': 'turn',
      'agent_profiler.observability': 'observed',
      'agent_profiler.turn.reason': t.reason,
      'agent_profiler.turn.prompt': text(t.prompt),
      'agent_profiler.incomplete': open(t),
    })
  }

  const agents = new Set(s.agents.map(a => a.id))
  const tools = new Map(s.tools.map(t => [t.id, t]))
  const parentOf = (ctx: string, turnId?: string): string =>
    ctx === MAIN
      ? turnId !== undefined && mainTurns.has(turnId)
        ? spanId('turn', turnId)
        : root
      : agents.has(ctx)
        ? spanId('agent', ctx)
        : root

  for (const a of s.agents) {
    if (!want('agent', a.id)) continue
    const parentTool = a.parentToolId ? tools.get(a.parentToolId) : undefined
    add('agent', a.id, `invoke_agent ${a.agentType}`, parentTool ? spanId('tool', parentTool.id) : root, a.start, end(a), {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': a.id,
      'gen_ai.agent.name': a.agentType,
      'agent_profiler.category': 'subagent',
      'agent_profiler.observability': 'observed',
      'agent_profiler.async': parentTool ? parentTool.launchedAsync === true : undefined,
      'agent_profiler.incomplete': open(a),
    })
  }

  for (const x of s.steps) {
    if (!want('step', x.id)) continue
    const ttft = x.firstContent !== undefined ? x.firstContent - x.start : undefined
    const id = add('step', x.id, `chat ${x.model}`, parentOf(x.ctx, x.turnId), x.start, end(x), {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': x.model,
      'gen_ai.response.model': x.usage?.model,
      'gen_ai.usage.input_tokens': x.usage?.input_tokens,
      'gen_ai.usage.output_tokens': x.usage?.output_tokens,
      'gen_ai.response.finish_reasons': x.stopReason,
      'gen_ai.agent.id': x.ctx === MAIN ? undefined : x.ctx,
      'agent_profiler.usage.cache_read_input_tokens': x.usage?.cache_read_input_tokens,
      'agent_profiler.usage.cache_creation_input_tokens': x.usage?.cache_creation_input_tokens,
      'agent_profiler.effort': x.effort,
      'agent_profiler.ttft_ms': ttft,
      'agent_profiler.category': 'model',
      'agent_profiler.observability': 'observed',
      'agent_profiler.incomplete': open(x),
    }, { spanKind: CLIENT })
    if (x.firstContent !== undefined) {
      add('step.ttft', x.id, 'model.ttft', id, x.start, x.firstContent, {
        'agent_profiler.observability': 'observed',
        'agent_profiler.note': 'network + queueing + prefill, not separable from the client',
      })
    }
    if (x.thinkFirst !== undefined && x.thinkLast !== undefined) {
      add('step.thinking', x.id, 'model.thinking_stream', id, x.thinkFirst, x.thinkLast, { 'agent_profiler.observability': 'observed' })
    }
    if (x.outFirst !== undefined) {
      add('step.output', x.id, 'model.output_stream', id, x.outFirst, end(x), { 'agent_profiler.observability': 'observed' })
    }
  }

  for (const x of s.tools) {
    if (!want('tool', x.id)) continue
    const wall = end(x) - x.start
    const exec = x.execMs !== undefined ? Math.min(x.execMs, wall) : undefined
    const wait = exec !== undefined ? wall - exec : undefined
    const id = add('tool', x.id, `execute_tool ${x.tool}`, parentOf(x.ctx, x.turnId), x.start, end(x), {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': x.tool,
      'gen_ai.tool.call.id': x.id,
      'gen_ai.agent.id': x.ctx === MAIN ? undefined : x.ctx,
      // An async Agent call returns at once and does not block the turn, as in summarize().
      'agent_profiler.category': isAgentTool(x.tool) && x.launchedAsync !== true ? 'subagent' : 'tool',
      'agent_profiler.observability': 'observed',
      'agent_profiler.exec_ms': exec,
      'agent_profiler.wait_ms': wait,
      'agent_profiler.permission': x.decision,
      'agent_profiler.fs.path': x.input.path,
      'agent_profiler.fs.range': x.input.range,
      'agent_profiler.search.pattern': x.input.pattern,
      'agent_profiler.bash.command': text(x.input.command),
      'agent_profiler.bash.category': x.tool === 'Bash' ? classifyCommand(x.input.command ?? '') : undefined,
      'agent_profiler.launched_agent': x.launchedAgentId,
      'agent_profiler.incomplete': open(x),
    }, { error: x.denied ? 'denied' : x.isError ? 'tool error' : undefined })
    if (exec !== undefined && wait !== undefined && x.end !== undefined) {
      if (wait > 0) {
        add('tool.wait', x.id, x.decision === 'ask' ? 'tool.approval_wait' : 'tool.overhead', id, x.start, x.start + wait, {
          'agent_profiler.observability': 'inferred',
        })
      }
      add('tool.exec', x.id, 'tool.exec', id, x.start + wait, x.end, { 'agent_profiler.observability': 'measured' })
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': 'claude-code', 'session.id': s.sessionId, 'agent_profiler.version': version }) },
        scopeSpans: [{ scope: { name: 'agent-profiler', version }, spans }],
      },
    ],
  }
}

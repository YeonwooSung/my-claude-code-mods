import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import { summarize, type Scope, type Summary } from './core/analyze.ts'
import { SummaryCache } from './core/cache.ts'
import { MAX_EXPORT_BYTES, pendingKeys, splitRequest } from './core/export.ts'
import { toOtlp, type OtlpRequest } from './core/otlp.ts'
import { Profiler, summarizeInput, toolOutcome } from './core/profiler.ts'
import { paneLines, renderReport, statusLine } from './core/report.ts'

const VERSION = '0.1.5'
const PANE = 'agent-profiler'
const COMMANDS = [
  { name: 'profile', description: "Show where this session's time went (model wait, tools, subagents, tests, re-reads); 'turn' for the last turn" },
  { name: 'profile-pane', description: 'Open the live Agent Profiler pane' },
  { name: 'profile-export', description: "Write this session's trace as OTLP JSON and send it to the configured endpoint" },
]
// Names this module load's files, so a hot reload or --resume never overwrites earlier batches.
const LOAD_ID = Date.now().toString(36)

let profiler = new Profiler()
let lastPaint = 0
let paintQueuedAt = 0
let anonymous = 0
let batchSeq = 0
let ticker: Timer | undefined
// Records already written as a per-turn batch, for the current profiler.
let exported = new Set<string>()
const toasted = new Set<string>()
const summaries = new SummaryCache()

// Recording must never break the session: every bookkeeping step goes through here.
function safe<T>(fn: () => T): void {
  try {
    fn()
  } catch {
    // dropped on purpose
  }
}

// Share a paint bucket while live; completed sessions keep their version-only cache.
function cachedSummary(scope: Scope = 'session'): Summary {
  return summaries.get(profiler, scope, Date.now())
}

function paintNow($: EngineInterface): void {
  const now = Date.now()
  lastPaint = now
  safe(() => {
    $.ui.status(statusLine(cachedSummary(), profiler.running(now)))
    $.ui.invalidate('ui.render')
  })
}

// Hooks never paint on their own path: a paint is queued behind the event (at most one pending).
function paint($: EngineInterface, force = false): void {
  const now = Date.now()
  if (paintQueuedAt && now - paintQueuedAt < 2_000) return // a refused timer must not block paints forever
  if (!force && now - lastPaint < 500) return
  paintQueuedAt = now
  try {
    $.clock.after(0, () => {
      paintQueuedAt = 0
      paintNow($)
    })
  } catch {
    paintQueuedAt = 0
  }
}

function useProfiler(next: Profiler): void {
  profiler = next
  exported = new Set()
}

// Failures of automatic saves surface once each, as a toast; the status line is the profiler's own.
function warn($: EngineInterface, message: string): void {
  if (toasted.has(message)) return
  toasted.add(message)
  safe(() => $.ui.toast(`agent-profiler: ${message}`))
}

async function sessionIdOf($: EngineInterface, p: Profiler): Promise<string | undefined> {
  if (p.sessionId !== 'unknown') return p.sessionId
  try {
    p.adoptSessionId(await $.session.id())
  } catch {
    // still unknown
  }
  return p.sessionId === 'unknown' ? undefined : p.sessionId
}

async function outputDir($: EngineInterface, options: PluginOptions): Promise<string> {
  const dir = (String(options.outputDir ?? '').trim() || '~/.claude/agent-profiler').replace(/\/+$/, '')
  if (!/^~(?=\/|$)/.test(dir)) return dir
  return dir.replace(/^~/, (await $.env.get('HOME')) ?? '.')
}

function endpointOf(options: PluginOptions): string {
  return String(options.otlpEndpoint ?? '').trim().replace(/\/+$/, '')
}

// One POST; with a deadline it gives up when the deadline passes or the signal aborts.
async function post($: EngineInterface, endpoint: string, body: string, deadline?: { at: number; signal?: AbortSignal }): Promise<string | undefined> {
  const request = $.http.fetch(`${endpoint}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  request.catch(() => undefined) // a late failure after a timeout is nobody's business
  try {
    let answer
    if (deadline) {
      const left = deadline.at - Date.now()
      if (left <= 0) return 'no time left before exit'
      const timeout = $.clock.sleep(left, deadline.signal ? { signal: deadline.signal } : undefined).then(() => undefined)
      answer = await Promise.race([request, timeout])
      if (!answer) return `no answer within ${left}ms`
    } else {
      answer = await request
    }
    return answer.ok ? undefined : `${endpoint} answered ${answer.status}`
  } catch (error) {
    return String(error)
  }
}

type ExportMode = 'batch' | 'final' | 'full'
type ExportResult = { notes: string[]; failures: string[] }

// batch: records finished since the last batch. final: everything not exported yet, open records
// marked incomplete, and the session root. full: a whole snapshot (/profile-export), in chunk files.
async function exportTrace($: EngineInterface, options: PluginOptions, mode: ExportMode, deadline?: { at: number; signal?: AbortSignal }): Promise<ExportResult> {
  const result: ExportResult = { notes: [], failures: [] }
  const p = profiler
  const done = exported
  const sessionId = await sessionIdOf($, p)
  if (sessionId === undefined) {
    result.failures.push('session id not known yet; nothing written')
    return result
  }
  const dir = `${await outputDir($, options)}/${sessionId}`

  // From snapshot to claim nothing awaits, so overlapping exports never pick the same records.
  const snap = p.snapshot(Date.now())
  const commandText = options.exportCommandText === true
  let claimed: string[] = []
  let request: OtlpRequest
  if (mode === 'full') {
    request = toOtlp(snap, VERSION, { commandText })
  } else {
    claimed = pendingKeys(snap, done, mode === 'final')
    const keys = new Set(claimed)
    for (const key of claimed) done.add(key)
    request = toOtlp(snap, VERSION, { include: key => keys.has(key), root: mode === 'final', commandText })
  }
  const parts = splitRequest(request, MAX_EXPORT_BYTES)
  if (parts.length === 0) {
    if (mode === 'full') result.notes.push('nothing recorded yet')
    return result
  }

  const bodies: string[] = []
  try {
    for (const [n, part] of parts.entries()) {
      const name = mode === 'full' ? `${LOAD_ID}-full-${n + 1}` : `${LOAD_ID}-${String((batchSeq += 1)).padStart(4, '0')}`
      const path = `${dir}/${name}.otlp.json`
      const body = JSON.stringify(part)
      await $.fs.write(path, body)
      bodies.push(body)
      result.notes.push(`wrote ${path}`)
    }
  } catch (error) {
    for (const key of claimed) done.delete(key) // retried with the next batch
    result.failures.push(`could not write to ${dir}: ${String(error)}`)
    return result
  }

  const endpoint = endpointOf(options)
  if (endpoint) {
    let failed = 0
    for (const body of bodies) {
      const reason = await post($, endpoint, body, deadline)
      if (reason !== undefined) {
        failed += 1
        result.failures.push(`POST failed: ${reason}`)
        break
      }
    }
    if (failed === 0) result.notes.push(`sent to ${endpoint}${bodies.length > 1 ? ` in ${bodies.length} requests` : ''}`)
  }
  return result
}

function autoExport($: EngineInterface, options: PluginOptions): void {
  exportTrace($, options, 'batch').then(
    r => r.failures.forEach(f => warn($, f)),
    error => warn($, `could not save the trace: ${String(error)}`),
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      useProfiler(new Profiler(await $.session.id()))
    } catch {
      useProfiler(new Profiler())
    }
    // Each step on its own: a refusal here must not keep the session from starting.
    for (const command of COMMANDS) {
      try {
        await $.command.register(command)
      } catch {
        // the command stays unavailable
      }
    }
    safe(() => ticker?.cancel())
    ticker = undefined
    try {
      ticker = $.clock.every(1_000, () => {
        if (profiler.running(Date.now()).length > 0) paintNow($)
      })
    } catch {
      // no live refresh
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const t = Date.now()
    try {
      const id = await $.session.id()
      if (profiler.sessionId === 'unknown') profiler.adoptSessionId(id) // loaded mid-session
      else if (id !== profiler.sessionId) useProfiler(new Profiler(id)) // a /clear starts a new session id
    } catch {
      // keep the current profiler
    }
    safe(() => profiler.turnStart(t, e.turnId, e.text))
    paint($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    safe(() => profiler.turnComplete(Date.now(), e.turnId, e.reason))
    paint($, true)
    safe(() => $.clock.after(0, () => autoExport($, options)))
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    safe(() => profiler.stopFailure(Date.now(), e.agent_id))
    paint($, true)
    safe(() => $.clock.after(0, () => autoExport($, options)))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let id = ''
    safe(() => {
      id = profiler.stepStart(Date.now(), { turnId: e.turnId, index: e.index, model: e.model, effort: e.effort, agentId: e.agentId })
    })
    paint($)
    try {
      for await (const chunk of next(e)) {
        safe(() => {
          profiler.stepChunk(Date.now(), id, chunk.kind)
          if (chunk.kind === 'stop') profiler.stepUsage(id, chunk.usage, chunk.stopReason)
        })
        yield chunk
      }
    } finally {
      safe(() => profiler.stepEnd(Date.now(), id))
      paint($)
    }
  })

  on('tool.call', async ($, e, next) => {
    anonymous += 1
    const id = e.tool_use_id ?? `anonymous-${anonymous}`
    const tool = String(e.tool)
    safe(() => profiler.toolStart(Date.now(), { id, tool, agentId: e.agentId, input: summarizeInput(tool, e as unknown as Record<string, unknown>) }))
    paint($)
    try {
      const answer = await next(e)
      safe(() => profiler.toolEnd(Date.now(), id, toolOutcome(answer)))
      return answer
    } catch (error) {
      safe(() => profiler.toolEnd(Date.now(), id, { denied: false, isError: true }))
      throw error
    } finally {
      paint($)
    }
  }).catch(($, e, next) => next(e))

  on('telemetry.log', { to: 'collector' }, ($, e, next) => {
    const version = profiler.version
    safe(() => profiler.toolDecision(e.event, e.attributes, e.loggedAt))
    if (profiler.version !== version) paint($)
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    safe(() => profiler.toolDuration(e.tool_use_id, e.duration_ms))
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    safe(() => profiler.toolDuration(e.tool_use_id, e.duration_ms))
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    safe(() => profiler.subagentStart(Date.now(), e.agent_id, e.agent_type))
    paint($, true)
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    safe(() => profiler.subagentStop(Date.now(), e.agent_id))
    paint($, true)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      // Files first; the POST gets what is left of the shared exit budget, 1.5s at most.
      const budget = next.budget.remainingMs
      const at = Date.now() + Math.max(0, Math.min(1_500, budget - 250))
      await exportTrace($, options, 'final', { at, signal: next.signal })
    } catch {
      // nothing left to tell
    }
    return next(e)
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const scope = e.args.trim() === 'turn' ? 'turn' : 'session'
    return { text: renderReport(summarize(profiler.snapshot(Date.now()), scope)) }
  })

  on('command.run', { command: 'profile-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agent Profiler' })
    return { text: 'Agent Profiler pane opened (shown in the terminal and the desktop app).' }
  })

  on('command.run', { command: 'profile-export' }, async $ => {
    try {
      const r = await exportTrace($, options, 'full')
      return { text: [...r.notes, ...r.failures].join('\n') }
    } catch (error) {
      return { text: `export failed: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(cachedSummary(), profiler.running(Date.now()), e.props.bodyColumns ?? 60)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text bold={line.bold} dimColor={line.dim}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
    )
  })
}

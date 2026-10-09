import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { summarize } from './core/analyze.ts'
import { toOtlp } from './core/otlp.ts'
import { Profiler, summarizeInput, toolOutcome } from './core/profiler.ts'
import { paneLines, renderReport, statusLine } from './core/report.ts'

const VERSION = '0.1.0'
const PANE = 'agent-profiler'

let profiler = new Profiler()
let lastPaint = 0
let anonymous = 0

// Recording must never break the session: every bookkeeping step goes through here.
function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // dropped on purpose
  }
}

function paint($: EngineInterface, force = false): void {
  const now = Date.now()
  if (!force && now - lastPaint < 500) return
  lastPaint = now
  safe(() => {
    $.ui.status(statusLine(summarize(profiler.snapshot(now)), profiler.running(now)))
    $.ui.invalidate('ui.render')
  })
}

async function persist($: EngineInterface, options: PluginOptions, send: boolean): Promise<string> {
  const body = JSON.stringify(toOtlp(profiler.snapshot(Date.now()), VERSION))
  const home = (await $.env.get('HOME')) ?? '.'
  const dir = (String(options.outputDir ?? '').trim() || '~/.claude/agent-profiler').replace(/^~(?=\/|$)/, home)
  const path = `${dir}/${profiler.sessionId}.otlp.json`
  await $.fs.write(path, body)
  const notes = [`wrote ${path}`]
  const endpoint = String(options.otlpEndpoint ?? '').trim().replace(/\/+$/, '')
  if (send && endpoint) {
    const answer = await $.http.fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    notes.push(answer.ok ? `sent to ${endpoint}` : `${endpoint} answered ${answer.status}`)
  }
  return notes.join(' · ')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      profiler = new Profiler(await $.session.id())
    } catch {
      profiler = new Profiler()
    }
    await $.command.register({ name: 'profile', description: "Show where this session's time went (model wait, tools, subagents, tests, re-reads); 'turn' for the last turn" })
    await $.command.register({ name: 'profile-pane', description: 'Open the live Agent Profiler pane' })
    await $.command.register({ name: 'profile-export', description: "Write this session's trace as OTLP JSON and send it to the configured endpoint" })
    $.clock.every(1_000, () => {
      if (profiler.running(Date.now()).length > 0) paint($, true)
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const t = Date.now()
    try {
      const id = await $.session.id()
      if (id !== profiler.sessionId) profiler = new Profiler(id) // a /clear starts a new session id
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
    $.clock.after(0, () => {
      persist($, options, true).catch(() => $.ui.status('agent-profiler: could not save the trace'))
    })
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

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (id !== undefined) safe(() => profiler.toolCheck(id, verdict.decision))
    return verdict
  }).catch(($, e, next) => next(e))

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
      await persist($, options, true)
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
      return { text: await persist($, options, true) }
    } catch (error) {
      return { text: `export failed: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const lines = paneLines(summarize(profiler.snapshot(now)), profiler.running(now), e.props.bodyColumns ?? 60)
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

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { BreakdownLite } from './core/advice.ts'
import { chunkLines, exportLines } from './core/export.ts'
import { fmtCount } from './core/format.ts'
import { backfill, ingestAppend, needsBackfill, ingestCompaction, ingestToolCall, ingestToolResult } from './core/ingest.ts'
import { Ledger } from './core/ledger.ts'
import { paneLines, parseArgs, renderReport, statusLine, type UsageLite } from './core/report.ts'
import { summarize, type Scope, type Summary } from './core/summary.ts'
import { inputOf } from './core/tokens.ts'
import { MAIN } from './core/types.ts'

const VERSION = '0.1.3'
const PANE = 'context-inspector'
const COMMANDS = [
  {
    name: 'context-inspect',
    description: 'Show what fills the context window and what is wasted: [overview|occupants|rereads|similar|compactions|efficiency|advice] [--agents]',
  },
  { name: 'context-pane', description: 'Open the live Context Inspector pane' },
  { name: 'context-export', description: "Write this session's context ledger as JSONL (metadata only, no content)" },
]
// Names this module load's export files, so a reload never overwrites an earlier load's.
const LOAD_ID = Date.now().toString(36)

let ledger = new Ledger()
let percent: number | undefined
let paintQueued = false
let toasted = false
const cache = new Map<Scope, { ledger: Ledger; version: number; sum: Summary }>()

// The inspector never breaks the session: every bookkeeping step goes through here.
function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // dropped on purpose
  }
}

function summary(scope: Scope = 'main'): Summary {
  const hit = cache.get(scope)
  if (hit && hit.ledger === ledger && hit.version === ledger.version) return hit.sum
  const sum = summarize(ledger.snapshot(), scope)
  cache.set(scope, { ledger, version: ledger.version, sum })
  return sum
}

// A new conversation in this process (start, reload, resume, /clear): forget the old one and read back,
// off the calling path, what the new one already holds. Rows that arrive before the read-back are kept.
function reset($: EngineInterface): void {
  const own = new Ledger()
  ledger = own
  cache.clear()
  toasted = false
  percent = undefined
  safe(() =>
    $.clock.after(0, async () => {
      try {
        const messages = await $.session.messages()
        if (own === ledger && needsBackfill(own) && messages.length > 0) backfill(own, messages)
      } catch {
        // nothing to read back
      }
    }),
  )
}

// Paints are queued behind the event that asked, at most one pending.
function paint($: EngineInterface, options: PluginOptions): void {
  if (paintQueued) return
  paintQueued = true
  try {
    $.clock.after(0, async () => {
      paintQueued = false
      try {
        percent = (await $.session.usage()).context.percent
      } catch {
        // keep the last figure
      }
      safe(() => {
        const sum = summary()
        $.ui.status(statusLine(sum, percent))
        $.ui.invalidate('ui.render')
        const high = sum.advice.find(a => a.severity === 'high')
        if (high && !toasted && options.toastAdvice !== false) {
          toasted = true
          $.ui.toast(`context-inspector: ${high.title} (saves ≈${fmtCount(high.savings)}) — /context-inspect advice`)
        }
      })
    })
  } catch {
    paintQueued = false
  }
}

const reportFailed = (error: unknown): string => `context-inspector: report failed: ${error instanceof Error ? error.message : String(error)}`

async function measured($: EngineInterface): Promise<{ usage?: UsageLite; breakdown?: BreakdownLite }> {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    return {
      usage: { percent: u.context.percent, tokens: u.context.tokens, window: u.context.window },
      breakdown: b
        ? {
            mcpTools: b.mcpTools.map(t => ({ name: t.name, serverName: t.serverName, tokens: t.tokens, isLoaded: t.isLoaded })),
            memoryFiles: b.memoryFiles.map(f => ({ path: f.path, tokens: f.tokens })),
          }
        : undefined,
    }
  } catch {
    return {}
  }
}

async function outputDir($: EngineInterface, options: PluginOptions): Promise<string> {
  const dir = (String(options.outputDir ?? '').trim() || '~/.claude/context-inspector').replace(/\/+$/, '')
  if (!/^~(?=\/|$)/.test(dir)) return dir
  return dir.replace(/^~/, (await $.env.get('HOME')) ?? '.')
}

async function exportLedger($: EngineInterface, options: PluginOptions): Promise<string> {
  let sessionId = 'unknown'
  try {
    sessionId = await $.session.id()
  } catch {
    // files go under 'unknown'
  }
  const dir = `${await outputDir($, options)}/${sessionId}`
  const snap = ledger.snapshot()
  const chunks = chunkLines(exportLines(snap, summarize(snap, 'all'), { sessionId, version: VERSION, at: new Date().toISOString() }))
  const written: string[] = []
  for (const [i, body] of chunks.entries()) {
    const path = `${dir}/context-${LOAD_ID}-${i + 1}.jsonl`
    await $.fs.write(path, body)
    written.push(path)
  }
  return `wrote ${written.join(', ')}`
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    safe(() => reset($))
    for (const command of COMMANDS) {
      try {
        await $.command.register(command)
      } catch {
        // the command stays unavailable
      }
    }
    return next(e)
  })

  // After /clear (or when another session takes this one's place) the process goes on under a new
  // session id and no session.start fires: this is where the old conversation's ledger is dropped.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') safe(() => reset($))
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    safe(() => ingestAppend(ledger, e))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (id !== undefined) safe(() => ingestToolCall(ledger, id, String(e.tool), e.agentId, e as unknown as Record<string, unknown>))
    const answer = await next(e)
    if (id !== undefined) safe(() => ingestToolResult(ledger, id, answer))
    return answer
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if (chunk.kind === 'stop') safe(() => ledger.sample(e.agentId ?? MAIN, inputOf(chunk.usage)))
      yield chunk
    }
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    safe(() => ingestCompaction(ledger, e, result))
    paint($, options)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    paint($, options)
    return next(e)
  })

  on('command.run', { command: 'context-inspect' }, async ($, e) => {
    const { section, scope, unknown } = parseArgs(e.args)
    const { usage, breakdown } = await measured($)
    try {
      const text = renderReport(summarize(ledger.snapshot(), scope, breakdown), section, usage)
      return { text: unknown ? `unknown section '${unknown}'; showing the overview\n\n${text}` : text }
    } catch (error) {
      return { text: reportFailed(error) }
    }
  })

  on('command.run', { command: 'context-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Context Inspector' })
    return { text: 'Context Inspector pane opened (shown in the terminal and the desktop app).' }
  })

  on('command.run', { command: 'context-export' }, async $ => {
    try {
      return { text: await exportLedger($, options) }
    } catch (error) {
      return { text: `export failed: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    let lines
    try {
      lines = paneLines(summary(), e.props.bodyColumns ?? 60)
    } catch (error) {
      return <Text>{reportFailed(error)}</Text>
    }
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text bold={line.bold}>{line.text || ' '}</Text>
        ))}
      </Box>
    )
  })
}

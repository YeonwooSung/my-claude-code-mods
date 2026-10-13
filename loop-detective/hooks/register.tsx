import type { EngineInterface, Register } from 'claude-code'
import { Detector, type Ticket } from './core/detector.ts'
import { display } from './core/fingerprint.ts'
import { paneLines, renderReport, statusLine } from './core/report.ts'

const PANE = 'loop-detective'
const COMMANDS = [
  { name: 'loop-report', description: 'Inspect repeated Bash failures: [--agents] [--history]' },
  { name: 'loop-pane', description: 'Open the live Loop Detective case pane' },
  { name: 'loop-reset', description: 'Clear Loop Detective observations without changing files or conversation' },
]
let threshold: unknown = 3
let detector = new Detector()
let scheduled: Detector | undefined
function safe(fn: () => void): void {
  try { fn() } catch { /* Observation and UI must not affect execution. */ }
}

function paint($: EngineInterface): void {
  const own = detector
  if (scheduled === own) return
  scheduled = own
  try {
    $.clock.after(0, () => {
      if (scheduled === own) scheduled = undefined
      if (own !== detector) return
      safe(() => $.ui.status(statusLine(own.snapshot())))
      safe(() => $.ui.invalidate('ui.render'))
    })
  } catch { if (scheduled === own) scheduled = undefined }
}

function reset($: EngineInterface): void {
  detector = new Detector(threshold)
  paint($)
}

export const register: Register = (on, options) => {
  threshold = options.threshold
  detector = new Detector(threshold)

  on('session.start', async ($, e, next) => {
    reset($)
    for (const command of COMMANDS) {
      try { await $.command.register(command) } catch { /* Still forward session startup. */ }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const answer = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') reset($)
    return answer
  })

  on('tool.call', async ($, e, next) => {
    const own = detector
    let ticket: Ticket | undefined
    try {
      ticket = own.reserve(String(e.tool), e as unknown as Record<string, unknown>, e.agentId)
      const cwd = e.tool === 'Bash' ? await $.session.cwd().catch(() => undefined) : undefined
      own.locate(ticket, cwd)
    } catch { /* Unsupported metadata cannot prevent the tool from running. */ }
    let answer
    try {
      // Never attach a fallback that could execute this tool a second time.
      answer = await next(e)
    } catch (error) {
      if (ticket) safe(() => own.finish(ticket!, {}))
      if (own === detector) paint($)
      throw error
    }
    if (ticket) safe(() => {
      const opened = own.finish(ticket!, answer)
      if (own !== detector || options.toastAlerts === false) return
      // A drained queue can open and close a case together: notify only still-active cases.
      const active = new Set(own.snapshot().active.map(c => c.id))
      for (const c of opened) if (active.has(c.id)) safe(() => {
        $.ui.toast(`Loop Detective: case #${c.id}, ${c.count} identical failures — /loop-report${c.isMain ? '' : ' --agents'}`)
      })
    })
    if (own === detector) paint($)
    return answer
  })

  on('turn.complete', async ($, e, next) => {
    paint($)
    return next(e)
  })

  on('command.run', { command: 'loop-report' }, async (_$, e) => ({ text: renderReport(detector.snapshot(), e.args ?? '') }))
  on('command.run', { command: 'loop-reset' }, async $ => {
    reset($)
    return { text: 'Loop Detective observations cleared. Files and conversation unchanged.' }
  })
  on('command.run', { command: 'loop-pane' }, async $ => {
    try {
      await $.ui.open({ id: PANE, title: 'Loop Detective' })
      return { text: 'Loop Detective pane opened (terminal and desktop app).' }
    } catch (error) {
      return { text: `Loop Detective pane unavailable: ${display(String(error))}. Use /loop-report.` }
    }
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column">{paneLines(detector.snapshot()).map(line => <Text>{line || ' '}</Text>)}</Box>
  })
}

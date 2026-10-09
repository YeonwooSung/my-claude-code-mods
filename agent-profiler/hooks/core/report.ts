import type { Category, Summary } from './analyze.ts'
import { bar, clip, fmtCount, fmtMs, pct } from './format.ts'
import type { RunningItem } from './profiler.ts'

const ORDER: Category[] = ['model', 'tool', 'subagent', 'engine']
const LABEL: Record<Category, string> = {
  model: 'Model response wait',
  tool: 'Tools',
  subagent: 'Subagents (blocking)',
  engine: 'Engine/other (inferred)',
}
const SHORT: Record<Category, string> = { model: 'model', tool: 'tools', subagent: 'subagents', engine: 'engine/other' }

export type PaneLine = { text: string; bold?: boolean; dim?: boolean }

export function renderReport(sum: Summary): string {
  const wall = sum.wallMs
  const lines = [`Agent Profiler · ${sum.scope === 'turn' ? 'last turn' : 'session'} · ${sum.turns} turn(s) · ${fmtMs(wall)} agent time`]
  if (sum.turns === 0) {
    lines.push('No turns recorded yet.')
    return lines.join('\n')
  }
  lines.push('', 'Where the time went (exclusive; adds up to agent time)')
  for (const cat of ORDER) {
    const ms = sum.exclusive[cat]
    lines.push(`  ${LABEL[cat].padEnd(24)} ${fmtMs(ms).padStart(7)} ${pct(ms, wall).padStart(4)}  ${bar(wall ? ms / wall : 0)}`)
  }

  const m = sum.model
  lines.push(
    '',
    `Model requests [observed] ${m.requests} · TTFT avg ${fmtMs(m.ttftAvg)} / p95 ${fmtMs(m.ttftP95)} · thinking stream ${fmtMs(m.thinkingMs)} · output stream ${fmtMs(m.outputMs)}`,
    `  tokens [reported] in ${fmtCount(m.inputTokens)} (cache read ${fmtCount(m.cacheReadTokens)}) · out ${fmtCount(m.outputTokens)}${m.tokensPerSec === null ? '' : ` · ${Math.round(m.tokensPerSec)} tok/s`}`,
  )

  const t = sum.tools
  const parallel = t.unionMs > 0 ? (t.sumMs / t.unionMs).toFixed(1) : '1.0'
  lines.push(
    '',
    `Tools ${t.calls} call(s) · exec ${fmtMs(t.execMs)} [measured] · approval wait ${fmtMs(t.permissionMs)} · overhead ${fmtMs(t.overheadMs)} [inferred] · parallelism ${parallel}×${t.errors ? ` · ${t.errors} error(s)` : ''}${t.denied ? ` · ${t.denied} denied` : ''}`,
  )
  for (const row of t.slowest) {
    const wait = row.waitMs >= 1_000 ? ` (wait ${fmtMs(row.waitMs)})` : ''
    const where = row.ctx === 'main' ? '' : ` [agent ${row.ctx.slice(0, 8)}]`
    lines.push(`  ${fmtMs(row.ms).padStart(7)}  ${clip(row.label, 70)}${wait}${where}`)
  }

  if (sum.bash.byCategory.length) {
    lines.push('', 'Bash by category [measured]')
    for (const row of sum.bash.byCategory) lines.push(`  ${row.category.padEnd(8)} ${fmtMs(row.ms).padStart(7)}  ${row.calls}×`)
  }
  if (sum.reads.length) {
    lines.push('', 'Files read more than once')
    for (const row of sum.reads) lines.push(`  ${String(row.reads).padStart(3)}×  ${clip(row.path, 70)}${row.redundant ? ` (${row.redundant}× unchanged)` : ''}`)
  }
  if (sum.agents.length) {
    lines.push('', 'Subagents')
    for (const a of sum.agents) {
      lines.push(`  ${fmtMs(a.wallMs).padStart(7)}  ${a.agentType} ${a.blocking ? 'blocking' : 'background'} · model ${fmtMs(a.modelMs)} · tools ${fmtMs(a.toolMs)} · ${a.requests} req / ${a.tools} tool(s)${a.done ? '' : ' · running'}`)
    }
  }
  if (sum.findings.length) {
    lines.push('', 'Findings')
    for (const finding of sum.findings) lines.push(`  • ${finding}`)
  }
  lines.push(
    '',
    'observed = timed by this mod at event boundaries · measured = timed by Claude Code · reported = API usage · inferred = remainder.',
    "Model time is how long the agent waited for the response, not the model's internal compute time.",
  )
  if (sum.incomplete || sum.dropped) lines.push(`${sum.incomplete} span(s) still open${sum.dropped ? ` · ${sum.dropped} old span(s) dropped` : ''}.`)
  return lines.join('\n')
}

export function statusLine(sum: Summary, running: RunningItem[]): string {
  const wall = sum.wallMs
  const parts = [`⏱ model ${pct(sum.exclusive.model, wall)}`, `tools ${pct(sum.exclusive.tool, wall)}`]
  if (sum.exclusive.subagent > 0) parts.push(`agents ${pct(sum.exclusive.subagent, wall)}`)
  const top = running.find(item => item.kind !== 'agent') ?? running[0]
  if (top && top.ms >= 1_000) parts.push(`▶ ${clip(top.label, 40)} ${fmtMs(top.ms)}`)
  return parts.join(' · ')
}

export function paneLines(sum: Summary, running: RunningItem[], width: number): PaneLine[] {
  const w = Math.max(30, width)
  const out: PaneLine[] = [{ text: `${fmtMs(sum.wallMs)} agent time · ${sum.turns} turn(s)`, bold: true }]
  for (const cat of ORDER) {
    const share = sum.wallMs ? sum.exclusive[cat] / sum.wallMs : 0
    out.push({ text: `${SHORT[cat].padEnd(12)} ${bar(share, Math.min(20, w - 20))} ${pct(sum.exclusive[cat], sum.wallMs).padStart(4)}` })
  }
  out.push({ text: '' }, { text: 'Running', bold: true })
  if (running.length === 0) out.push({ text: '  idle', dim: true })
  for (const item of running.slice(0, 5)) out.push({ text: clip(`  ${fmtMs(item.ms).padStart(6)} ${item.label}`, w) })
  out.push({ text: '' }, { text: 'Slowest tools', bold: true })
  for (const row of sum.tools.slowest) out.push({ text: clip(`  ${fmtMs(row.ms).padStart(6)} ${row.label}`, w) })
  if (sum.findings.length) {
    out.push({ text: '' }, { text: 'Findings', bold: true })
    for (const finding of sum.findings.slice(0, 4)) out.push({ text: clip(`• ${finding}`, w * 2) })
  }
  return out
}

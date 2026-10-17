import { bar, clip as clipText, fmtCount, pct } from './format.ts'
import { redactSecrets } from './redact.ts'
import type { Scope, Summary } from './summary.ts'
import { MAIN } from './types.ts'

export const SECTIONS = ['overview', 'occupants', 'rereads', 'similar', 'compactions', 'efficiency', 'advice'] as const
export type Section = (typeof SECTIONS)[number]
export type UsageLite = { percent?: number; tokens?: number; window?: number }
export type PaneLine = { text: string; bold?: boolean }

const tok = (n: number): string => `≈${fmtCount(n)}`
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${fmtCount(Math.abs(n))}`
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
const clip = (text: string, n: number): string => clipText(redactSecrets(text), n)

export function parseArgs(args: string): { section: Section; scope: Scope; unknown?: string } {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const scope: Scope = words.includes('--agents') ? 'all' : 'main'
  const first = words.find(w => w !== '--agents')
  if (first === undefined) return { section: 'overview', scope }
  if ((SECTIONS as readonly string[]).includes(first)) return { section: first as Section, scope }
  return { section: 'overview', scope, unknown: first }
}

// k at a bound of calibrate's clamp: the measured ratio lies beyond it.
const clamped = (sum: Summary): boolean => sum.segments > 0 && (sum.k === 0.5 || sum.k === 2)

function header(sum: Summary, usage?: UsageLite): string[] {
  const where = sum.scope === 'main' ? 'main context' : 'main + subagents'
  const window =
    usage?.tokens !== undefined && usage.window ? ` · window ${fmtCount(usage.tokens)}/${fmtCount(usage.window)} tokens (${usage.percent ?? 0}%, measured)` : ''
  const lines = [
    `Context Inspector — ${where}${window}`,
    `Live ${tok(sum.occupancy.liveEst)} tokens in ${sum.occupancy.liveItems} items · ${sum.turns} turn(s) · ${sum.compactions.length} compaction(s) · waste ${tok(sum.wasteEst)}`,
    `≈ = estimate (chars/4 × k=${sum.k.toFixed(2)}${clamped(sum) ? ' (clamped)' : ''}, ${sum.segments} calibration segment(s)); figures without ≈ are measured or engine-reported`,
  ]
  if (sum.dropped + sum.droppedLive > 0) lines.push(`(ledger cap reached: ${sum.dropped} old and ${sum.droppedLive} live items dropped)`)
  return lines
}

function occupants(sum: Summary, n: number): string[] {
  const o = sum.occupancy
  if (o.liveItems === 0) return ['Top occupants', '  nothing recorded yet']
  const out = ['Top occupants (live, by category)']
  for (const r of o.byCategory.slice(0, n))
    out.push(`  ${pad(clip(r.key, 28), 28)} ${pad(tok(r.est), 8)} ${pad(pct(r.est, o.liveEst), 4)} ${bar(r.est / o.liveEst)}  ${r.count} item(s)`)
  out.push('Largest live items')
  for (const t of o.top.slice(0, n)) out.push(`  ${pad(tok(t.est), 8)} ${pad(clip(t.category, 14), 14)} ${clip(t.label, 60)} · turn ${t.turn}`)
  return out
}

function rereadLines(sum: Summary, n: number): string[] {
  const r = sum.rereads
  const out = [`Re-reads — waste now ${tok(r.currentWasteEst)} · session ${tok(r.wasteEst)} · compaction-induced ${tok(r.compactionEst)} · engine-deduped ${r.deduped}`]
  if (r.files.length === 0) return [...out, '  no file was read twice']
  for (const f of r.files.slice(0, n)) {
    const classes = Object.entries(f.classes)
      .filter(([c]) => c !== 'first')
      .map(([c, x]) => `${c}×${x}`)
      .join(' ')
    out.push(`  ${clip(f.path, 50)}  ${f.reads} reads  ${classes}${f.wasteEst > 0 ? `  waste ${tok(f.wasteEst)}` : ''}`)
  }
  return out
}

function similarLines(sum: Summary, n: number): string[] {
  const out = [`Similar tool outputs (lexical SimHash ≤3 bits, not semantic) — waste ${tok(sum.similar.wasteEst)}`]
  if (sum.similar.clusters.length === 0) return [...out, '  none']
  for (const c of sum.similar.clusters.slice(0, n))
    out.push(`  ${c.category} ×${c.size} ${c.kind}  waste ${tok(c.wasteEst)} of ${tok(c.totalEst)}  ${clip(c.label, 50)}`)
  return out
}

function compactionLines(sum: Summary, n: number): string[] {
  if (sum.compactions.length === 0) return ['Compactions', '  none yet']
  const out = ['Compactions (string presence in summary/kept messages; not semantic retention)']
  const shown = sum.compactions.slice(-n)
  shown.forEach((c, i) => {
    const index = sum.compactions.length - shown.length + i + 1
    const sizes = c.tokensBefore !== undefined ? `  ${fmtCount(c.tokensBefore)}→${c.tokensAfter !== undefined ? fmtCount(c.tokensAfter) : '?'} tokens` : ''
    const who = c.ctx === MAIN ? '' : ` (${c.ctx})`
    out.push(`  #${index} ${c.trigger}${who} @turn ${c.turn}${sizes}  dropped ${c.droppedItems} item(s) ${tok(c.droppedEst)}`)
    const s = c.stats
    const lost = c.lostEdited.length > 0 ? ` · lost edits: ${c.lostEdited.map(base).join(', ')}` : ''
    const reflow = c.reflowEst > 0 ? ` · reflow ${tok(c.reflowEst)}` : ''
    out.push(
      `     kept: edited ${s['edited-file'].kept}/${s['edited-file'].total} · read ${s['read-file'].kept}/${s['read-file'].total} · errors ${s.error.kept}/${s.error.total} · requirements ${s.requirement.kept}/${s.requirement.total}${lost}${reflow}`,
    )
  })
  return out
}

function efficiencyLines(sum: Summary, n: number): string[] {
  const e = sum.efficiency
  const out = ['Efficiency (measured input growth vs changed lines; exploration is not a fault)']
  if (e.turns.length === 0) return [...out, '  no measured requests yet']
  const median = e.medianPerLine !== undefined ? `median ${fmtCount(e.medianPerLine)} tokens/line` : 'no edits yet'
  out.push(`  ${e.turns.length} turn(s) · +${fmtCount(e.growth)} tokens · ${e.lines} line(s) changed · ${median} · ${e.exploration} exploration turn(s)`)
  const top = e.turns
    .filter(t => t.growth !== undefined)
    .sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0))
    .slice(0, n)
  for (const t of top) {
    const tail = t.perLine !== undefined ? `  ${fmtCount(t.perLine)} tokens/line` : t.lines === 0 && (t.growth ?? 0) > 0 ? '  exploration' : ''
    out.push(`  turn ${t.turn}  ${signed(t.growth ?? 0)}  ${t.lines} line(s)${tail}`)
  }
  return out
}

function adviceLines(sum: Summary, n: number): string[] {
  const out = [`Advice${sum.hasBreakdown ? '' : ' (MCP and memory checks run from /context-inspect)'}`]
  if (sum.advice.length === 0) return [...out, '  nothing stands out']
  for (const a of sum.advice.slice(0, n)) {
    out.push(`  [${a.severity}] ${a.title} — saves ${tok(a.savings)}`)
    out.push(`     ${a.evidence}`)
    out.push(`     → ${a.action}`)
  }
  return out
}

const PARTS: [Section, (sum: Summary, n: number) => string[]][] = [
  ['occupants', occupants],
  ['rereads', rereadLines],
  ['similar', similarLines],
  ['compactions', compactionLines],
  ['efficiency', efficiencyLines],
  ['advice', adviceLines],
]

export function renderReport(sum: Summary, section: Section = 'overview', usage?: UsageLite): string {
  const n = section === 'overview' ? 3 : 15
  const blocks: string[][] = [header(sum, usage)]
  for (const [name, part] of PARTS) if (section === 'overview' || section === name) blocks.push(part(sum, n))
  return blocks.map(b => b.map(redactSecrets).join('\n')).join('\n\n')
}

export function statusLine(sum: Summary, percent?: number): string {
  const head = percent !== undefined ? `ctx ${percent}%` : `ctx ${tok(sum.occupancy.liveEst)}`
  return `${head} · waste${tok(sum.wasteEst)}`
}

export function paneLines(sum: Summary, width: number): PaneLine[] {
  return renderReport(sum, 'overview')
    .split('\n')
    .map(text => ({ text: clip(text, Math.max(20, width)), bold: text !== '' && /^[A-Z]/.test(text) }))
}

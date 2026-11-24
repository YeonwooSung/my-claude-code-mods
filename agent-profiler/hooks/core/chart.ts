import type { Category, Summary } from './analyze.ts'
import { fmtMs } from './format.ts'
import { redactSecrets } from './redact.ts'

const ORDER: Category[] = ['model', 'tool', 'subagent', 'engine']
const LABEL: Record<Category, string> = {
  model: 'model response wait', tool: 'tools', subagent: 'subagents (blocking)', engine: 'engine/other (inferred)',
}
export const CHART_COLORS: Record<Category, number> = { model: 0x60a5fa, tool: 0x34d399, subagent: 0xfbbf24, engine: 0xc4b5fd }
const GLYPHS = ['M', 'T', 'A', 'E']
const finite = (n: number): number => Number.isFinite(n) && n > 0 ? n : 0
const count = (n: number, max: number): number => Math.min(max, Math.floor(finite(n)))

export type ChartDatum = { label: string; ms: number; category?: Category }
export type ChartModel = {
  totalMs: number
  categories: ChartDatum[]
  turns: { label: string; totalMs: number; running: boolean; segments: ChartDatum[] }[]
  slowest: { label: string; ms: number; running: boolean }[]
  droppedTurns: number
  incomplete: number
}
export type ChartRow = {
  kind: 'session' | 'turn' | 'call'
  label: string
  ms: number
  running: boolean
  segments: number[]
  scaleMax: number
}

// Redact the whole label before shortening, and exclude characters XML 1.0 cannot carry.
function label(text: string): string {
  const clean = Array.from(redactSecrets(text)).filter(c => {
    const cp = c.codePointAt(0)!
    return cp >= 32 && !(cp >= 0xd800 && cp <= 0xdfff) && cp !== 0xfffe && cp !== 0xffff
  })
  return clean.length <= 64 ? clean.join('') : clean.slice(0, 63).join('') + '…'
}
const segments = (values: Record<Category, number>): ChartDatum[] => ORDER.map(category => ({ category, label: LABEL[category], ms: finite(values[category]) }))

export function chartModel(sum: Summary): ChartModel {
  return {
    totalMs: finite(sum.wallMs), categories: segments(sum.exclusive),
    turns: sum.recentTurns.slice(-12).map(t => ({ label: `Turn ${t.retainedIndex}`, totalMs: finite(t.wallMs), running: t.running, segments: segments(t.exclusive) })),
    slowest: sum.tools.slowest.slice(0, 5).map(t => ({ label: label(t.label), ms: finite(t.ms), running: t.running })),
    droppedTurns: count(sum.droppedTurns, Number.MAX_SAFE_INTEGER), incomplete: count(sum.incomplete, Number.MAX_SAFE_INTEGER),
  }
}

// Largest remainders preserve the rounded total and stable ties without overflowing the sum.
export function allocateCells(values: readonly number[], width: number, scaleMax: number): number[] {
  const w = count(width, 512), xs = values.map(finite)
  const largest = xs.reduce((m, n) => Math.max(m, n), 0)
  if (!w || !largest || !finite(scaleMax)) return xs.map(() => 0)
  const normalized = xs.map(n => n / largest)
  const total = normalized.reduce((a, b) => a + b, 0)
  const target = Math.round(w * Math.min(total / (scaleMax / largest), 1))
  const exact = normalized.map(n => (n / total) * target)
  const cells = exact.map(Math.floor)
  const order = exact.map((n, i) => ({ i, remainder: n - cells[i]! })).sort((a, b) => b.remainder - a.remainder || a.i - b.i)
  const remaining = target - cells.reduce((a, b) => a + b, 0)
  for (const { i } of order.slice(0, remaining)) cells[i] = cells[i]! + 1
  return cells
}

export function chartRows(model: ChartModel, maxTurns: number): ChartRow[] {
  const n = count(maxTurns, 12)
  const turns = n ? model.turns.slice(-n) : []
  const turnMax = turns.reduce((m, t) => Math.max(m, t.totalMs), 0)
  const callMax = model.slowest.reduce((m, t) => Math.max(m, t.ms), 0)
  return [
    { kind: 'session', label: 'Session', ms: model.totalMs, running: model.turns.some(t => t.running), segments: model.categories.map(d => d.ms), scaleMax: model.totalMs },
    ...turns.map(t => ({ kind: 'turn' as const, label: t.label, ms: t.totalMs, running: t.running, segments: t.segments.map(d => d.ms), scaleMax: turnMax })),
    ...model.slowest.map(t => ({ kind: 'call' as const, label: t.label, ms: t.ms, running: t.running, segments: [t.ms], scaleMax: callMax })),
  ]
}

export function rasterBars(model: ChartModel, columns: number, maxTurns: number): { columns: number; rows: number; cells: string } {
  const width = Math.max(1, count(columns, 512)), rows = chartRows(model, maxTurns)
  const bytes = new Uint8Array(width * rows.length * 12)
  const data = new DataView(bytes.buffer)
  for (const [y, row] of rows.entries()) {
    const widths = allocateCells(row.segments, width, row.scaleMax)
    let x = 0
    for (const [i, size] of widths.entries()) {
      for (let j = 0; j < size; j++, x++) {
        const offset = (y * width + x) * 12
        data.setUint32(offset, row.kind === 'call' ? 0x2588 : GLYPHS[i]!.charCodeAt(0), true)
        data.setUint32(offset + 4, row.kind === 'call' ? 0x94a3b8 : CHART_COLORS[ORDER[i]!], true)
        data.setUint32(offset + 8, 0x01000000, true)
      }
    }
    for (; x < width; x++) {
      const offset = (y * width + x) * 12
      data.setUint32(offset, 32, true)
      data.setUint32(offset + 4, 0x01000000, true)
      data.setUint32(offset + 8, 0x01000000, true)
    }
  }
  return { columns: width, rows: rows.length, cells: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) }
}

export function chartNotes(model: ChartModel): string[] {
  return [
    ...(!model.turns.length ? ['No turns recorded yet.'] : []),
    ...(model.droppedTurns ? [`${model.droppedTurns} older turns dropped; retained order shown.`] : []),
    ...(model.incomplete ? [`${model.incomplete} spans still open; running values are provisional.`] : []),
  ]
}
export const SECTION_LABEL = {
  session: 'Session · exclusive agent time', turn: 'Recent turns · common time scale · retained order', call: 'Slowest calls · wall time · separate scale',
}
const xml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

export function svgBars(model: ChartModel, maxTurns: number): { source: string; alt: string } {
  const rows = chartRows(model, maxTurns), parts: string[] = [], alt: string[] = []
  let y = 18, previous = ''
  const text = (value: string, x: number, at: number, color = '#e2e8f0', size = 12) => {
    parts.push(`<text x="${x}" y="${at}" fill="${color}" font-size="${size}">${xml(value)}</text>`)
  }
  for (const row of rows) {
    if (row.kind !== previous) {
      const title = SECTION_LABEL[row.kind]
      text(title, 12, y, '#94a3b8', 11); alt.push(title); y += 22; previous = row.kind
    }
    const caption = `${row.label} · ${fmtMs(row.ms)}${row.running ? ' · running' : ''}`
    parts.push(`<text x="12" y="${y}" fill="#e2e8f0" font-size="12" clip-path="url(#label-clip)">${xml(row.label)}</text>`)
    parts.push(`<text x="468" y="${y}" fill="#e2e8f0" font-size="12" text-anchor="end">${fmtMs(row.ms)}${row.running ? ' · running' : ''}</text>`)
    alt.push(caption); y += 7
    const widths = allocateCells(row.segments, 456, row.scaleMax)
    parts.push(`<rect x="12" y="${y}" width="456" height="8" rx="2" fill="#1e293b"/>`)
    let x = 12
    for (const [i, width] of widths.entries()) {
      const color = row.kind === 'call' ? 0x94a3b8 : CHART_COLORS[ORDER[i]!]
      if (width) parts.push(`<rect x="${x}" y="${y}" width="${width}" height="8" fill="#${color.toString(16).padStart(6, '0')}"/>`)
      x += width
    }
    y += 28
  }
  // Exact category values remain available in both pixels and alternative text.
  for (const d of model.categories) {
    const line = `${d.label}: ${fmtMs(d.ms)}`
    text(line, 12, y, `#${CHART_COLORS[d.category!].toString(16).padStart(6, '0')}`, 11); alt.push(line); y += 17
  }
  for (const note of chartNotes(model)) { text(note, 12, y, '#94a3b8', 11); alt.push(note); y += 17 }
  alt.push('Model is response wait, not internal compute. Engine is inferred. Call durations may overlap.')
  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${y + 8}" viewBox="0 0 480 ${y + 8}" font-family="system-ui,sans-serif"><defs><clipPath id="label-clip"><rect x="12" y="0" width="300" height="${y + 8}"/></clipPath></defs><rect width="480" height="${y + 8}" rx="8" fill="#0f172a"/>${parts.join('')}</svg>`,
    alt: alt.join('\n'),
  }
}

import { expect, test } from 'claude-code/testing'
import { allocateCells, chartModel, chartRows, rasterBars, svgBars } from '../hooks/core/chart.ts'
import { summarize } from '../hooks/core/analyze.ts'
import { Profiler } from '../hooks/core/profiler.ts'
import { session } from './fixtures.ts'

test('cell allocation preserves the common scale with deterministic rounding', () => {
  expect(allocateCells([1, 1, 1], 5, 3)).toEqual([2, 2, 1])
  expect(allocateCells([1, 1], 20, 10)).toEqual([2, 2])
  expect(allocateCells([1, 1], 1, 2)).toEqual([1, 0])
  expect(allocateCells([10, 10], 5, 10)).toEqual([3, 2])
  expect(allocateCells([1], 40, 1)).toEqual([40])
  expect(allocateCells([1], 39, 1)).toEqual([39])
  expect(allocateCells([1], 999, 1)).toEqual([512])
  expect(allocateCells([1], 0, 1)).toEqual([0])
})

test('allocation handles malformed numbers and overflow without invalid widths', () => {
  expect(allocateCells([], 20, 10)).toEqual([])
  expect(allocateCells([0, -2, NaN, Infinity], 20, 10)).toEqual([0, 0, 0, 0])
  expect(allocateCells([1], Infinity, 1)).toEqual([0])
  expect(allocateCells([1], 20, NaN)).toEqual([0])
  expect(allocateCells([1], 20, 0)).toEqual([0])
  expect(allocateCells([Number.MAX_VALUE, Number.MAX_VALUE], 10, Number.MAX_VALUE)).toEqual([5, 5])
})

test('chart rows preserve exclusive totals and compare turns on the same scale', () => {
  const p = session()
  p.turnStart(20_000, 'private-turn-id')
  p.turnComplete(25_000, 'private-turn-id')
  const model = chartModel(summarize(p.snapshot(30_000)))
  expect(model.totalMs).toBe(15000)
  expect(model.categories.map(d => d.ms)).toEqual([3000, 6050, 0, 5950])
  const turns = chartRows(model, 12).filter(r => r.kind === 'turn')
  expect(turns.map(t => t.scaleMax)).toEqual([10000, 10000])
  expect(turns.map(t => t.label)).toEqual(['Turn 1', 'Turn 2'])
  expect(chartRows(model, 1).filter(r => r.kind === 'turn').map(r => r.label)).toEqual(['Turn 2'])
  expect(model.slowest).toHaveLength(5)
  expect(model.slowest[0]?.ms).toBe(6000)
  expect(JSON.stringify(model)).not.toContain('private-turn-id')
})

test('empty, zero-duration and invalid summary values produce finite chart data', () => {
  const p = new Profiler('empty')
  const empty = chartModel(summarize(p.snapshot(0)))
  expect(empty.turns).toEqual([])
  expect(svgBars(empty, 12).alt).toContain('No turns recorded yet.')
  p.turnStart(0, 't'); p.turnComplete(0, 't')
  const sum = summarize(p.snapshot(0))
  sum.wallMs = Infinity; sum.exclusive.model = NaN; sum.exclusive.tool = -1
  const model = chartModel(sum)
  expect(model.totalMs).toBe(0)
  expect(model.categories.map(d => d.ms)).toEqual([0, 0, 0, 0])
  const svg = svgBars(model, 12)
  expect(svg.source).not.toMatch(/NaN|Infinity/)
  expect(svg.alt).toContain('0ms')
})

test('raster contains bounded little-endian cells with scale-correct filled lengths', () => {
  const model = chartModel(summarize(session().snapshot(20_000)))
  const raster = rasterBars(model, 40, 12)
  expect(raster.columns).toBe(40)
  expect(raster.rows).toBe(7) // session, one turn, five calls
  const bytes = Uint8Array.from(atob(raster.cells), c => c.charCodeAt(0))
  expect(bytes.length).toBe(40 * 7 * 12)
  const view = new DataView(bytes.buffer)
  expect(view.getUint32(0, true)).toBe('M'.charCodeAt(0))
  expect(view.getUint32(12 * 12, true)).toBe('T'.charCodeAt(0)) // 30% model
  expect(view.getUint32(4, true)).toBe(0x60a5fa)
  expect(view.getUint32(8, true)).toBe(0x01000000)
  for (let i = 0; i < bytes.length; i += 12) {
    expect([32, 77, 84, 65, 69, 9608]).toContain(view.getUint32(i, true))
    expect(view.getUint32(i + 4, true)).toBeLessThanOrEqual(0x01000000)
  }
  expect(rasterBars(model, 999, 999).columns).toBe(512)
  expect(rasterBars(model, 0, 0).columns).toBe(1)
})

test('SVG and alt mask before clipping, escape XML, and preserve running and dropped coverage', () => {
  const sum = summarize(session().snapshot(20_000))
  sum.tools.slowest[0]!.label = 'Read <tag>&"😀 --password "FAKE_CHART_SECRET' + 'x'.repeat(400) + '"'
  sum.tools.slowest[0]!.running = true
  sum.droppedTurns = 4; sum.incomplete = 2
  const model = chartModel(sum)
  const { source, alt } = svgBars(model, 12)
  for (const output of [source, alt, JSON.stringify(model)]) {
    expect(output).not.toContain('FAKE_CHART_SECRET')
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('\ufffd')
  }
  expect(source).toContain('&lt;tag&gt;&amp;&quot;😀')
  expect(source).not.toMatch(/<script|onload=|(?:href|src)=|isInteractive/)
  expect(source.length).toBeLessThan(131073)
  expect(alt).toContain('4 older turns dropped')
  expect(alt).toContain('2 spans still open')
  expect(alt).toContain('running')
  expect(alt).toContain('model response wait')
  expect(alt).toContain('engine/other (inferred)')
})

test('chart labels remove invalid XML controls and never split a surrogate pair', () => {
  const sum = summarize(session().snapshot(20_000))
  sum.tools.slowest[0]!.label = '😀'.repeat(100) + '\u0000\u0001\ud800'
  const label = chartModel(sum).slowest[0]!.label
  expect(Array.from(label).length).toBeLessThanOrEqual(64)
  expect(label).not.toMatch(/[\u0000-\u001f\ud800-\udfff]/u)
})

test('long SVG labels are clipped separately from right-aligned duration values', () => {
  const sum = summarize(session().snapshot(20_000))
  sum.tools.slowest[0]!.label = '긴이름'.repeat(30)
  const svg = svgBars(chartModel(sum), 12)
  expect(svg.source).toContain('clipPath')
  expect(svg.source).toContain('text-anchor="end"')
  expect(svg.source).toContain('>6.0s</text>')
})

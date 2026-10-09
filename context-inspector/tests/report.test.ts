import { expect, test } from 'claude-code/testing'

import { advise, severityOf } from '../hooks/core/advice.ts'
import { rereads } from '../hooks/core/analyze/rereads.ts'
import { ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { paneLines, parseArgs, renderReport, statusLine } from '../hooks/core/report.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, promptRow, readFile, runBash } from './fixtures.ts'

function busy(): Ledger {
  const l = new Ledger()
  ingestAppend(l, promptRow('fix the flaky test'))
  readFile(l, 'r1', '/src/big.ts', 'x'.repeat(40_000)) // ≈10k, whole file
  readFile(l, 'r2', '/src/big.ts', 'x'.repeat(40_000)) // unchanged-live ≈10k
  for (let i = 0; i < 3; i += 1) runBash(l, `b${i}`, 'npm test', `${okLines(400)}\nTime: ${i}.5s`) // ≈3.9k each, near-identical
  runBash(l, 'b9', 'cat huge.log', 'z'.repeat(24_000)) // ≈6k
  l.sample('main', 30_000)
  return l
}

test('severity thresholds', () => {
  expect(severityOf(10_000)).toBe('high')
  expect(severityOf(3_000)).toBe('medium')
  expect(severityOf(2_999)).toBe('low')
})

test('advice fires for unchanged re-reads, large whole reads, long output and repeated output, most severe first', () => {
  const s = summarize(busy().snapshot(), 'main')
  const ids = s.advice.map(a => a.id)
  expect(ids).toContain('reread-unchanged')
  expect(ids).toContain('large-read')
  expect(ids).toContain('large-bash')
  expect(ids).toContain('repeated-output')
  const reread = s.advice.find(a => a.id === 'reread-unchanged')!
  expect(reread.severity).toBe('high')
  expect(reread.evidence).toContain('big.ts ×2')
  const ranks = s.advice.map(a => ({ high: 0, medium: 1, low: 2 })[a.severity])
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
})

test('advice from a breakdown: idle MCP servers and large memory files', () => {
  const l = new Ledger()
  runBash(l, 'b', 'ls', 'a')
  const s = l.snapshot()
  const rr = rereads(s.items, s.edits, 1)
  const advice = advise({
    items: s.items,
    k: 1,
    rereads: rr,
    clusters: [],
    compactions: [],
    breakdown: {
      mcpTools: [
        { name: 'mcp__docs__a', serverName: 'docs', tokens: 2_500, isLoaded: true },
        { name: 'mcp__docs__b', serverName: 'docs', tokens: 1_000, isLoaded: true },
        { name: 'mcp__lazy__c', serverName: 'lazy', tokens: 9_000, isLoaded: false },
      ],
      memoryFiles: [{ path: '/r/CLAUDE.md', tokens: 6_000 }],
    },
  })
  // both medium: the larger saving first
  expect(advice.map(a => [a.id, a.severity, a.savings])).toEqual([
    ['memory-large', 'medium', 4_000],
    ['mcp-unused', 'medium', 3_500],
  ])
})

test('compaction that lost an edited file is at least medium', () => {
  const l = new Ledger()
  ingestCompaction(
    l,
    { trigger: 'auto', messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Write', input: { file_path: '/src/x.ts' } }] }] },
    { messages: [{ role: 'user', text: 'Summary: nothing about it', toolUses: [] }] },
  )
  const lost = summarize(l.snapshot(), 'main').advice.find(a => a.id === 'compaction-lost-edits')!
  expect(lost.severity).toBe('medium')
  expect(lost.evidence).toBe('x.ts')
})

test('summary: waste adds re-read and similar waste without double counting', () => {
  const s = summarize(busy().snapshot(), 'main')
  expect(s.wasteEst).toBe(s.rereads.wasteEst + s.similar.wasteEst)
  expect(s.rereads.wasteEst).toBe(10_000)
  // the two identical Reads also form an exact cluster, but its waste is already the re-read's
  expect(s.similar.clusters.find(c => c.category === 'Read')!.wasteEst).toBe(0)
  expect(s.similar.clusters.find(c => c.category === 'Bash')!.size).toBe(3)
})

test('summary scope: main leaves subagent items out, all keeps them', () => {
  const l = new Ledger()
  runBash(l, 'b1', 'ls', 'x'.repeat(400))
  runBash(l, 'b2', 'ls', 'y'.repeat(400), 'agent-1')
  expect(summarize(l.snapshot(), 'main').occupancy.liveItems).toBe(1)
  expect(summarize(l.snapshot(), 'all').occupancy.liveItems).toBe(2)
})

test('parseArgs', () => {
  expect(parseArgs('')).toEqual({ section: 'overview', scope: 'main' })
  expect(parseArgs('rereads --agents')).toEqual({ section: 'rereads', scope: 'all' })
  expect(parseArgs('nonsense')).toEqual({ section: 'overview', scope: 'main', unknown: 'nonsense' })
})

test('overview report names every section and marks estimates', () => {
  const text = renderReport(summarize(busy().snapshot(), 'main'), 'overview', { percent: 15, tokens: 30_000, window: 200_000 })
  for (const heading of ['Context Inspector — main context', 'Top occupants', 'Re-reads', 'Similar tool outputs', 'Compactions', 'Efficiency', 'Advice'])
    expect(text).toContain(heading)
  expect(text).toContain('window 30.0k/200.0k tokens (15%, measured)')
  expect(text).toContain('≈ = estimate')
  expect(text).toContain('/src/big.ts')
  expect(text).toContain('not semantic')
})

test('a single section renders only its block; an empty ledger renders without throwing', () => {
  const text = renderReport(summarize(busy().snapshot(), 'main'), 'advice')
  expect(text).toContain('Advice')
  expect(text).not.toContain('Top occupants')
  const empty = renderReport(summarize(new Ledger().snapshot(), 'main'))
  expect(empty).toContain('nothing recorded yet')
  expect(empty).toContain('nothing stands out')
})

test('status line and pane lines', () => {
  const s = summarize(busy().snapshot(), 'main')
  expect(statusLine(s, 62)).toMatch(/^ctx 62% · waste≈\d+(\.\d)?k$/)
  expect(statusLine(s)).toMatch(/^ctx ≈[\d.]+k · waste≈/)
  const lines = paneLines(s, 40)
  expect(lines.every(l => l.text.length <= 40)).toBe(true)
  expect(lines[0]!.bold).toBe(true)
})

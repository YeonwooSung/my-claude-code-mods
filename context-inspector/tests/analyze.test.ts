import { expect, test } from 'claude-code/testing'

import { compactionViews } from '../hooks/core/analyze/compaction.ts'
import { efficiency } from '../hooks/core/analyze/efficiency.ts'
import { occupancy } from '../hooks/core/analyze/occupancy.ts'
import { rereads } from '../hooks/core/analyze/rereads.ts'
import { similar } from '../hooks/core/analyze/similar.ts'
import { ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { attachmentRow, editFile, letters, okLines, promptRow, readFile, runBash } from './fixtures.ts'

const compactAll = (l: Ledger, ctx?: string): void =>
  ingestCompaction(l, { trigger: 'auto', agentId: ctx, messages: [] }, { messages: [] })

test('occupancy sums live items by category and target, scaled by k, largest first', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/big.ts', 'x'.repeat(4_000))
  readFile(l, 'r2', '/small.ts', 'x'.repeat(400))
  runBash(l, 'b1', 'ls', 'y'.repeat(800))
  const o = occupancy(l.snapshot().items, 2)
  expect(o.liveItems).toBe(3)
  expect(o.liveEst).toBe(2_000 + 200 + 400)
  expect(o.byCategory.map(r => [r.key, r.est, r.count])).toEqual([['Read', 2_200, 2], ['Bash', 400, 1]])
  expect(o.byTarget[0]).toEqual({ key: '/big.ts', est: 2_000, count: 1 })
  expect(o.top[0]!.label).toBe('/big.ts')
})

test('occupancy ignores items out of the window', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a', okLines(5))
  compactAll(l)
  expect(occupancy(l.snapshot().items, 1).liveItems).toBe(0)
})

test('rereads: first, unchanged-live (waste), after-edit, different-range, engine-deduped', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('go'))
  readFile(l, 'r1', '/a.ts', okLines(40))
  readFile(l, 'r2', '/a.ts', okLines(40)) // unchanged-live
  editFile(l, 'e1', '/a.ts', 'x', 'y')
  readFile(l, 'r3', '/a.ts', okLines(40, 'changed')) // after-edit
  readFile(l, 'r4', '/a.ts', okLines(5), { offset: 1, limit: 5, total: 40 }) // different-range
  readFile(l, 'r5', '/a.ts', '', { unchanged: true }) // engine-deduped
  const s = l.snapshot()
  const r = rereads(s.items, s.edits, 1)
  expect(r.rows.map(x => x.cls)).toEqual(['first', 'unchanged-live', 'after-edit', 'different-range', 'engine-deduped'])
  const wasted = s.items.find(i => i.toolUseId === 'r2')!
  expect(r.wasteEst).toBe(wasted.est)
  expect([...r.wasteSeqs]).toEqual([wasted.seq])
  expect(r.deduped).toBe(1)
  expect(r.files[0]!.reads).toBe(5)
  expect(r.files[0]!.classes['unchanged-live']).toBe(1)
})

test('rereads: a file that grew between whole reads is changed-externally, not different-range', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/log.txt', okLines(10))
  readFile(l, 'r2', '/log.txt', okLines(12))
  const s = l.snapshot()
  expect(rereads(s.items, s.edits, 1).rows.map(x => x.cls)).toEqual(['first', 'changed-externally'])
})

test('rereads: after-compaction when the earlier copy was dropped; restored for an engine file attachment', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(10))
  readFile(l, 'r2', '/b.ts', okLines(10))
  compactAll(l)
  readFile(l, 'r3', '/a.ts', okLines(10))
  ingestAppend(l, attachmentRow('file', 'Called the Read tool with the following input: {"file_path":"/b.ts"}\n' + okLines(10)))
  const s = l.snapshot()
  const r = rereads(s.items, s.edits, 1)
  expect(r.rows.map(x => [x.path, x.cls])).toEqual([
    ['/a.ts', 'first'],
    ['/b.ts', 'first'],
    ['/a.ts', 'after-compaction'],
    ['/b.ts', 'restored'],
  ])
  expect(r.compactionEst).toBe(r.rows[2]!.est + r.rows[3]!.est)
  expect(r.wasteEst).toBe(0)
})

test('rereads: a later read that survived a compaction while the earlier one did not is still unchanged-live', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(10), { uuid: 'row-1' })
  readFile(l, 'r2', '/a.ts', okLines(10), { uuid: 'row-2' })
  ingestCompaction(
    l,
    { trigger: 'auto', messages: [{ role: 'user', text: '', toolUses: [], handle: 'row-2' }] },
    { messages: [{ role: 'user', text: '', toolUses: [], handle: 'row-2' }] },
  )
  const s = l.snapshot()
  expect(rereads(s.items, s.edits, 1).rows.map(x => x.cls)).toEqual(['first', 'unchanged-live'])
})

test('similar: exact and near-duplicate tool outputs cluster; waste keeps the largest live copy', () => {
  const l = new Ledger()
  runBash(l, 'b1', 'npm test', `${okLines(40)}\nTime: 1.20s`)
  runBash(l, 'b2', 'npm test', `${okLines(40)}\nTime: 3.45s`)
  runBash(l, 'b3', 'npm test', `${okLines(40)}\nTime: 3.45s`)
  runBash(l, 'b4', 'ls', letters(300))
  const items = l.snapshot().items
  const sim = similar(items, 1)
  expect(sim.clusters.length).toBe(1)
  const c = sim.clusters[0]!
  expect(c.size).toBe(3)
  expect(c.kind).toBe('mixed')
  expect(c.category).toBe('Bash')
  expect(c.label).toBe('npm test')
  const ests = items.slice(0, 3).map(i => i.est)
  expect(c.wasteEst).toBe(ests.reduce((a, b) => a + b, 0) - Math.max(...ests))
  expect(sim.wasteEst).toBe(c.wasteEst)
})

test('similar: short outputs are ignored; excluded items do not count as waste twice', () => {
  const l = new Ledger()
  runBash(l, 'b1', 'echo', 'hi')
  runBash(l, 'b2', 'echo', 'hi')
  expect(similar(l.snapshot().items, 1).clusters.length).toBe(0)
  const m = new Ledger()
  readFile(m, 'r1', '/a', okLines(20))
  readFile(m, 'r2', '/a', okLines(20))
  const items = m.snapshot().items
  expect(similar(items, 1, new Set([items[1]!.seq])).wasteEst).toBe(0)
})

test('compaction views: entity stats, lost edits, reflow assigned to the compaction before it', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(10))
  ingestCompaction(
    l,
    { trigger: 'manual', messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Edit', input: { file_path: '/src/lost.ts' } }, { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }] }] },
    { messages: [{ role: 'user', text: 'Summary mentions a.ts only', toolUses: [] }], tokensBefore: 5_000, tokensAfter: 800 },
  )
  readFile(l, 'r2', '/a.ts', okLines(10))
  const s = l.snapshot()
  const rr = rereads(s.items, s.edits, 1)
  const [v] = compactionViews(s.compactions, rr.rows, 1)
  expect(v!.trigger).toBe('manual')
  expect(v!.tokensBefore).toBe(5_000)
  expect(v!.stats['edited-file']).toEqual({ total: 1, kept: 0 })
  expect(v!.stats['read-file']).toEqual({ total: 1, kept: 1 })
  expect(v!.lostEdited).toEqual(['/src/lost.ts'])
  expect(v!.reflowEst).toBe(rr.rows[1]!.est)
})

test('efficiency: growth per main turn within an epoch, lines per turn, exploration, median', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('one'))
  l.sample('main', 10_000)
  ingestAppend(l, promptRow('two'))
  l.sample('main', 14_000)
  editFile(l, 'e1', '/a', 'a', 'b') // 2 lines
  l.sample('a1', 99_999) // a subagent's requests do not count
  ingestAppend(l, promptRow('three'))
  l.sample('main', 20_000) // exploration: growth, no edits
  compactAll(l)
  ingestAppend(l, promptRow('four'))
  l.sample('main', 5_000) // new epoch: no growth figure
  const e = efficiency(l.snapshot().samples, l.snapshot().edits)
  expect(e.turns.map(t => [t.turn, t.growth, t.lines, t.perLine])).toEqual([
    [1, undefined, 0, undefined],
    [2, 4_000, 2, 2_000],
    [3, 6_000, 0, undefined],
    [4, undefined, 0, undefined],
  ])
  expect(e.growth).toBe(10_000)
  expect(e.lines).toBe(2)
  expect(e.exploration).toBe(1)
  expect(e.medianPerLine).toBe(2_000)
})

import { expect, test } from 'claude-code/testing'

import { chunkLines, exportLines } from '../hooks/core/export.ts'
import { ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, promptRow, readFile, runBash } from './fixtures.ts'

const meta = { sessionId: 's1', version: '0.1.0', at: '2026-10-10T00:00:00.000Z' }

test('export has meta first, one line per record, summary last, and no content', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('secret prompt text'))
  readFile(l, 'r1', '/a.ts', 'CONTENT_THAT_MUST_NOT_LEAK')
  runBash(l, 'b1', 'curl -H "Authorization: Bearer abc123" https://x', okLines(3))
  l.sample('main', 5_000)
  ingestCompaction(l, { trigger: 'manual', messages: [{ role: 'user', text: 'use `fooBar`', toolUses: [] }] }, { messages: [] })
  const lines = exportLines(l.snapshot(), summarize(l.snapshot(), 'all'), meta)
  const records = lines.map(line => JSON.parse(line) as Record<string, unknown>)
  expect(records[0]).toEqual({ type: 'meta', schema: 'context-inspector/1', ...meta })
  expect(records.at(-1)!.type).toBe('summary')
  expect(records.filter(r => r.type === 'item').length).toBe(3)
  expect(records.filter(r => r.type === 'sample').length).toBe(1)
  const all = lines.join('\n')
  expect(all).not.toContain('CONTENT_THAT_MUST_NOT_LEAK')
  expect(all).not.toContain('secret prompt text')
  expect(all).not.toContain('abc123')
  expect(all).not.toContain('fooBar')
  const compaction = records.find(r => r.type === 'compaction') as { entities: Record<string, unknown>[] }
  expect(compaction.entities[0]).toEqual({ type: 'requirement', kept: false, hash: expect.any(String) })
})

test('chunkLines splits under the byte limit and keeps every line whole', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(90)}"}`)
  const chunks = chunkLines(lines, 300)
  expect(chunks.length).toBe(5)
  expect(chunks.every(c => new TextEncoder().encode(c).length <= 300)).toBe(true)
  expect(chunks.join('').trim().split('\n')).toEqual(lines)
  expect(chunkLines([])).toEqual([])
})

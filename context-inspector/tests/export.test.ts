import { expect, test } from 'claude-code/testing'

import { chunkLines, exportLines } from '../hooks/core/export.ts'
import { ingestAppend, ingestCompaction, ingestToolCall, ingestToolResult } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, promptRow, readFile, runBash, toolResultRow } from './fixtures.ts'

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
  expect(records.at(-1)).toMatchObject({ currentWasteEst: 0, sessionRereadEst: 0, rereadWasteEst: 0 })
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

test('Agent call with secret in description exports redacted, truncated target', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('start'))
  const longDesc = 'This is a very long description that contains API_KEY=sekret123 and should be redacted to at most 200 characters because agent descriptions can contain sensitive information like credentials and tokens that must not leak'
  const toolId = 'agent-call-1'
  ingestToolCall(l, toolId, 'Agent', undefined, { description: longDesc })
  ingestToolResult(l, toolId, { result: {}, text: 'Agent completed' })
  ingestAppend(l, toolResultRow(toolId, 'Agent completed', { tool: 'Agent' }))
  const lines = exportLines(l.snapshot(), summarize(l.snapshot(), 'all'), meta)
  const records = lines.map(line => JSON.parse(line) as Record<string, unknown>)
  const all = lines.join('\n')
  expect(all).not.toContain('API_KEY=sekret123')
  expect(all).not.toContain('sekret123')
  const itemRecord = records.find(r => r.type === 'item' && r.category === 'Agent') as Record<string, unknown>
  expect(itemRecord).toBeDefined()
  const targetValue = (itemRecord?.target as Record<string, unknown>)?.value as string
  expect(targetValue.length).toBeLessThanOrEqual(200)
})

test('chunkLines exact boundary: line + newline = max fits alone, next starts new chunk', () => {
  const line1 = 'x'.repeat(98)
  const max = 99
  const chunks = chunkLines([line1, 'y'], max)
  expect(chunks.length).toBe(2)
  expect(new TextEncoder().encode(chunks[0]!).length).toBe(max)
  expect(new TextEncoder().encode(chunks[1]!).length).toBeLessThanOrEqual(max)
})

test('chunkLines single line longer than max goes alone, following line starts fresh chunk', () => {
  const longLine = 'x'.repeat(200)
  const max = 150
  const chunks = chunkLines([longLine, 'y'], max)
  expect(chunks.length).toBe(2)
  expect(new TextEncoder().encode(chunks[0]!).length).toBeGreaterThan(max)
  expect(chunks[0]!.trim()).toBe(longLine)
})

test('chunkLines multibyte UTF-8: chunks by bytes, not characters', () => {
  const char = '가'
  const byteLength = new TextEncoder().encode(char).length
  expect(byteLength).toBe(3)
  const line = char.repeat(50)
  const max = 200
  const chunks = chunkLines([line, 'a', line], max)
  expect(chunks.every(c => new TextEncoder().encode(c).length <= max)).toBe(true)
  const allLines = chunks.join('').trim().split('\n')
  expect(allLines).toEqual([line, 'a', line])
})

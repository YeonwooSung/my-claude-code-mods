import { expect, test } from 'claude-code/testing'

import { contentHash } from '../hooks/core/hash.ts'
import { ChunkWriter, chunkName, parseChunks, projectKey } from '../hooks/core/store.ts'

test('contentHash is 16 hex digits and content-dependent', () => {
  expect(contentHash('a')).toMatch(/^[0-9a-f]{16}$/)
  expect(contentHash('a')).toBe(contentHash('a'))
  expect(contentHash('a')).not.toBe(contentHash('b'))
})

test('projectKey is stable, sanitized and path-specific', () => {
  expect(projectKey('/Users/u/my app')).toMatch(/^my_app-[0-9a-f]{8}$/)
  expect(projectKey('/Users/u/my app/')).toBe(projectKey('/Users/u/my app'))
  expect(projectKey('/a/x')).not.toBe(projectKey('/b/x'))
  expect(projectKey('/')).toMatch(/^root-[0-9a-f]{8}$/)
})

test('chunk names sort in write order', () => {
  expect(chunkName('lz1', 2)).toBe('lz1-0002.jsonl')
})

test('ChunkWriter rewrites the current chunk whole and rolls past the limit', () => {
  const w = new ChunkWriter('abc', 120)
  const r1 = w.add({ type: 'branch', name: 'main', fromStep: 0, at: 1 })
  expect(r1.name).toBe('abc-0001.jsonl')
  const r2 = w.add({ type: 'branch', name: 'b1', fromStep: 2, at: 3 })
  expect(r2.name).toBe('abc-0001.jsonl')
  expect(r2.body.trim().split('\n').length).toBe(2)
  const r3 = w.add({ type: 'branch', name: 'b2', fromStep: 4, at: 5 })
  expect(r3.name).toBe('abc-0002.jsonl')
  expect(r3.body.trim().split('\n').length).toBe(1)
  expect(r3.body.endsWith('\n')).toBe(true)
})

test('parseChunks reads chunks in name order and skips garbage', () => {
  const recs = parseChunks([
    { name: 'b-0001.jsonl', text: '{"type":"branch","name":"x","fromStep":1,"at":2}\n' },
    { name: 'a-0002.jsonl', text: 'not json\n{"type":"turn","n":2,"at":5,"prompt":{"chars":1,"hash":"h"}}\n\n' },
    { name: 'a-0001.jsonl', text: '{"type":"turn","n":1,"at":1,"prompt":{"chars":1,"hash":"h"}}\n{"no":"type"}\n' },
    { name: 'meta.json', text: '{"type":"turn"}' },
  ])
  expect(recs.map(r => r.type)).toEqual(['turn', 'turn', 'branch'])
  expect(recs.map(r => ('n' in r ? r.n : 'name' in r ? r.name : ''))).toEqual([1, 2, 'x'])
})

import { expect, test } from 'claude-code/testing'

import { pendingKeys, splitRequest } from '../hooks/core/export.ts'
import { toOtlp, type OtlpRequest } from '../hooks/core/otlp.ts'
import { Profiler } from '../hooks/core/profiler.ts'
import { session, withSubagent } from './fixtures.ts'

const spansOf = (req: OtlpRequest) => req.resourceSpans[0]?.scopeSpans[0]?.spans ?? []
const ok = { denied: false, isError: false }

test('per-turn batches carry finished records once; the final batch adds open ones and the root', () => {
  const p = session()
  p.turnStart(20_000, 't2')
  p.toolStart(20_100, { id: 'open', tool: 'Bash', input: { command: 'sleep 100' } })
  const exported = new Set<string>()

  const s1 = p.snapshot(21_000)
  const first = pendingKeys(s1, exported, false)
  expect(first).toContain('turn:t1')
  expect(first).toContain('tool:b1')
  expect(first).not.toContain('turn:t2')
  expect(first).not.toContain('tool:open')
  const keys = new Set(first)
  const batch = spansOf(toOtlp(s1, '0.1.0', { include: k => keys.has(k), root: false }))
  expect(batch.some(x => x.name === 'claude-code session')).toBe(false)
  expect(batch.some(x => x.name === 'tool.approval_wait')).toBe(true)
  for (const k of first) exported.add(k)

  expect(pendingKeys(p.snapshot(22_000), exported, false)).toEqual([])

  const s2 = p.snapshot(23_000)
  const last = pendingKeys(s2, exported, true)
  expect(last).toEqual(['turn:t2', 'tool:open'])
  const lastKeys = new Set(last)
  const final = spansOf(toOtlp(s2, '0.1.0', { include: k => lastKeys.has(k) }))
  expect(final.map(x => x.name).sort()).toEqual(['claude-code session', 'execute_tool Bash', 'turn'])
  expect(final.find(x => x.name === 'execute_tool Bash')?.attributes).toContainEqual({ key: 'agent_profiler.incomplete', value: { boolValue: true } })

  // The batches together are exactly the full export.
  const full = spansOf(toOtlp(s2, '0.1.0')).map(x => x.spanId).sort()
  expect([...batch, ...final].map(x => x.spanId).sort()).toEqual(full)
})

test('a subagent is exported once it has stopped, under its Agent tool', () => {
  const s = withSubagent().snapshot(2_000)
  const keys = pendingKeys(s, new Set(), false)
  expect(keys).toContain('agent:a1')
  expect(keys).not.toContain('turn:st')
})

test('splitRequest keeps every span, in order, within the byte limit', () => {
  const p = new Profiler('8201ea2b-079a-467e-9ef6-a14e37417dde', 50_000)
  p.turnStart(0, 't')
  for (let i = 0; i < 400; i += 1) {
    p.toolStart(i, { id: `x${i}`, tool: 'Read', input: { path: `/some/long/path/number/${i}/file.ts` } })
    p.toolEnd(i + 1, `x${i}`, ok)
  }
  p.turnComplete(500, 't')
  const req = toOtlp(p.snapshot(600), '0.1.0')
  const max = 20_000
  const parts = splitRequest(req, max)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) {
    expect(new TextEncoder().encode(JSON.stringify(part)).length).toBeLessThanOrEqual(max)
    expect(part.resourceSpans[0]?.resource).toEqual(req.resourceSpans[0]?.resource)
  }
  expect(parts.flatMap(spansOf).map(x => x.spanId)).toEqual(spansOf(req).map(x => x.spanId))
  expect(splitRequest(req, 1_000_000_000)).toEqual([req])
  expect(splitRequest(toOtlp(new Profiler('s').snapshot(0), '0.1.0', { root: false }), 1_000)).toEqual([])
})

test('an async Agent call is tool time, a blocking one subagent time', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't')
  p.toolStart(1, { id: 'bg', tool: 'Agent', input: { subagentType: 'x' } })
  p.toolEnd(2, 'bg', { denied: false, isError: false, launchedAgentId: 'a', launchedAsync: true })
  p.toolStart(3, { id: 'fg', tool: 'Agent', input: { subagentType: 'y' } })
  p.toolEnd(4, 'fg', { denied: false, isError: false, launchedAgentId: 'b', launchedAsync: false })
  p.turnComplete(5, 't')
  const spans = spansOf(toOtlp(p.snapshot(6), '0.1.0'))
  const category = (id: string) =>
    spans.find(x => x.attributes.some(a => a.key === 'gen_ai.tool.call.id' && 'stringValue' in a.value && a.value.stringValue === id))
      ?.attributes.find(a => a.key === 'agent_profiler.category')?.value
  expect(category('bg')).toEqual({ stringValue: 'tool' })
  expect(category('fg')).toEqual({ stringValue: 'subagent' })
})

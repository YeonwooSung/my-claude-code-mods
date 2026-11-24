import { expect, test } from 'claude-code/testing'

import { SummaryCache } from '../hooks/core/cache.ts'
import { Profiler } from '../hooks/core/profiler.ts'

const ok = { denied: false, isError: false }

test('live summary changes with time alone, shares a paint bucket and freezes after completion', () => {
  const p = new Profiler('s')
  const cache = new SummaryCache()
  p.turnStart(0, 't')
  p.toolStart(0, { id: 'bash', tool: 'Bash', input: { command: 'sleep 10' } })
  const version = p.version
  const first = cache.get(p, 'session', 1_000)
  expect(first.exclusive.tool).toBe(1_000)
  expect(cache.get(p, 'session', 1_200)).toBe(first)
  expect(cache.get(p, 'session', 10_000).exclusive.tool).toBe(10_000)
  expect(p.version).toBe(version)
  p.toolEnd(10_000, 'bash', ok)
  p.turnComplete(10_000, 't', 'answer')
  const done = cache.get(p, 'session', 11_000)
  expect(cache.get(p, 'session', 20_000)).toBe(done)
  expect(cache.get(new Profiler('other'), 'session', 20_000).wallMs).toBe(0)
})

test('an open turn keeps engine time live between model and tool spans', () => {
  const p = new Profiler('s')
  const cache = new SummaryCache()
  p.turnStart(0, 't')
  expect(cache.get(p, 'turn', 1_000).exclusive.engine).toBe(1_000)
  expect(cache.get(p, 'turn', 10_000).exclusive.engine).toBe(10_000)
})

test('model waiting before first content refreshes its live exclusive time', () => {
  const p = new Profiler('s')
  const cache = new SummaryCache()
  p.turnStart(0, 't')
  p.stepStart(0, { turnId: 't', index: 0, model: 'm' })
  expect(cache.get(p, 'session', 1_000).exclusive.model).toBe(1_000)
  expect(cache.get(p, 'session', 10_000).exclusive.model).toBe(10_000)
})

test('an API failure freezes model and wall time throughout the usage-limit wait', () => {
  const p = new Profiler('s')
  const cache = new SummaryCache()
  p.stepStart(0, { turnId: 't', index: 0, model: 'm' })
  expect(cache.get(p, 'session', 1_000).wallMs).toBe(1_000)
  p.stopFailure(2_000)
  const failed = cache.get(p, 'session', 3_000)
  expect(failed.wallMs).toBe(2_000)
  expect(failed.exclusive.model).toBe(2_000)
  expect(cache.get(p, 'session', 3_600_000)).toBe(failed)
})

test('cached chart rows update only with the live bucket and reset with the profiler', () => {
  const p = new Profiler('s'), cache = new SummaryCache()
  p.turnStart(0, 't')
  const first = cache.get(p, 'session', 1000)
  expect(first.recentTurns[0]?.wallMs).toBe(1000)
  expect(cache.get(p, 'session', 1200)).toBe(first)
  expect(cache.get(p, 'session', 1500).recentTurns[0]?.wallMs).toBe(1500)
  p.turnComplete(1600, 't')
  const done = cache.get(p, 'session', 2000)
  expect(done.recentTurns[0]?.running).toBe(false)
  expect(cache.get(p, 'session', 9000)).toBe(done)
  expect(cache.get(new Profiler('next'), 'session', 9000).recentTurns).toEqual([])
})

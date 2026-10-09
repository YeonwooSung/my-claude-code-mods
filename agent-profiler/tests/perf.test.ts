import { expect, test } from 'claude-code/testing'

import { attribute, summarize } from '../hooks/core/analyze.ts'
import { Profiler } from '../hooks/core/profiler.ts'

const ok = { denied: false, isError: false }

// 2000 turns × (5 requests + 5 tools) = 20,000 spans.
function big(): Profiler {
  const p = new Profiler('s', 25_000)
  for (let n = 0; n < 2_000; n += 1) {
    const base = n * 10_000
    p.turnStart(base, `t${n}`)
    for (let i = 0; i < 5; i += 1) {
      const at = base + i * 1_000
      const step = p.stepStart(at, { turnId: `t${n}`, index: i, model: 'm' })
      p.stepChunk(at + 100, step, 'text')
      p.stepEnd(at + 500, step)
      p.toolStart(at + 500, { id: `x${n}.${i}`, tool: i % 2 ? 'Read' : 'Bash', input: i % 2 ? { path: `/f${i}` } : { command: 'npm test' } })
      p.toolDuration(`x${n}.${i}`, 300)
      p.toolEnd(at + 900, `x${n}.${i}`, ok)
    }
    p.turnComplete(base + 5_000, `t${n}`, 'answer')
  }
  return p
}

test('summarize over 20k spans in many turns stays fast', () => {
  const s = big().snapshot(30_000_000)
  expect(s.steps.length + s.tools.length).toBe(20_000)
  const t0 = Date.now()
  const sum = summarize(s)
  const ms = Date.now() - t0
  expect(sum.turns).toBe(2_000)
  expect(sum.exclusive.model + sum.exclusive.tool + sum.exclusive.subagent + sum.exclusive.engine).toBe(sum.wallMs)
  expect(ms).toBeLessThan(200)
})

test('attribute: nested, touching and out-of-window intervals', () => {
  expect(
    attribute([0, 100], [
      { cat: 'tool', iv: [-50, 30] },
      { cat: 'subagent', iv: [20, 60] },
      { cat: 'model', iv: [40, 50] },
      { cat: 'tool', iv: [60, 70] },
      { cat: 'tool', iv: [120, 130] },
    ]),
  ).toEqual({ model: 10, subagent: 30, tool: 30, engine: 30 })
  expect(attribute([10, 10], [{ cat: 'model', iv: [0, 20] }])).toEqual({ model: 0, subagent: 0, tool: 0, engine: 0 })
})

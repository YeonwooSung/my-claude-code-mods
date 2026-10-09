import { expect, test } from 'claude-code/testing'

import { attribute, summarize, unionLength } from '../hooks/core/analyze.ts'
import { Profiler } from '../hooks/core/profiler.ts'
import { ok, session, withSubagent } from './fixtures.ts'

test('unionLength merges overlapping and touching intervals', () => {
  expect(unionLength([[0, 10], [5, 15], [20, 30], [30, 31]])).toBe(26)
  expect(unionLength([])).toBe(0)
})

test('attribute: model wins overlaps, gaps are engine, shares sum to the window', () => {
  expect(attribute([0, 100], [{ cat: 'model', iv: [10, 50] }, { cat: 'tool', iv: [40, 80] }])).toEqual({ model: 40, subagent: 0, tool: 30, engine: 30 })
})

test('summarize a session', () => {
  const sum = summarize(session().snapshot(20_000))
  expect(sum.wallMs).toBe(10_000)
  expect(sum.exclusive).toEqual({ model: 3000, subagent: 0, tool: 6050, engine: 950 })
  expect(sum.model.requests).toBe(2)
  expect(sum.model.ttftAvg).toBe(750)
  expect(sum.model.ttftP95).toBe(1000)
  expect(sum.model.outputMs).toBe(1500)
  expect(sum.model.tokensPerSec).toBe(100)
  expect(sum.tools.calls).toBe(6)
  expect(sum.tools.execMs).toBe(5050)
  expect(sum.tools.permissionMs).toBe(1000)
  expect(sum.tools.overheadMs).toBe(0)
  expect(sum.bash.byCategory).toEqual([{ category: 'test', calls: 1, ms: 5000 }])
  expect(sum.bash.testShare).toBe(0.5)
  expect(sum.reads).toEqual([{ path: '/a.ts', reads: 4, redundant: 2 }])
  expect(sum.findings.length).toBe(3)
  expect(sum.incomplete).toBe(0)
})

test('turn scope counts only the last turn; open spans are cut at now', () => {
  const p = session()
  p.turnStart(20_000, 't2')
  p.toolStart(20_100, { id: 'b2', tool: 'Bash', input: { command: 'sleep 100' } })
  const sum = summarize(p.snapshot(21_000), 'turn')
  expect(sum.turns).toBe(1)
  expect(sum.wallMs).toBe(1000)
  expect(sum.exclusive).toEqual({ model: 0, subagent: 0, tool: 900, engine: 100 })
  expect(sum.incomplete).toBe(2)
})

test('paged reads are not redundant', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't')
  p.toolStart(1, { id: 'a', tool: 'Read', input: { path: '/big', range: '0:100' } })
  p.toolEnd(2, 'a', ok)
  p.toolStart(3, { id: 'b', tool: 'Read', input: { path: '/big', range: '100:100' } })
  p.toolEnd(4, 'b', ok)
  p.turnComplete(5, 't')
  expect(summarize(p.snapshot(10)).reads).toEqual([{ path: '/big', reads: 2, redundant: 0 }])
})

test('a blocking subagent counts as subagent time and is broken down', () => {
  const sum = summarize(withSubagent().snapshot(2000))
  expect(sum.exclusive).toEqual({ model: 0, subagent: 810, tool: 0, engine: 190 })
  expect(sum.agents).toEqual([{ id: 'a1', agentType: 'Explore', wallMs: 790, modelMs: 500, toolMs: 200, requests: 1, tools: 1, blocking: true, done: true }])
  expect(sum.tools.calls).toBe(1)
  expect(sum.model.requests).toBe(1)
})

test('turn scope follows subagents launched in that turn', () => {
  const sum = summarize(withSubagent().snapshot(2000), 'turn')
  expect(sum.agents.map(a => a.id)).toEqual(['a1'])
  expect(sum.tools.calls).toBe(1)
})

test('dropped turns take their spans along: a model-only session shows no engine time', () => {
  const p = new Profiler('s', 20)
  for (let n = 0; n < 30; n += 1) {
    p.turnStart(n * 1_000, `t${n}`)
    const step = p.stepStart(n * 1_000, { turnId: `t${n}`, index: 0, model: 'm' })
    p.stepEnd(n * 1_000 + 1_000, step)
    p.turnComplete(n * 1_000 + 1_000, `t${n}`)
  }
  const sum = summarize(p.snapshot(40_000))
  expect(sum.droppedTurns).toBeGreaterThan(0)
  expect(sum.turns + sum.droppedTurns).toBe(30)
  expect(sum.exclusive.engine).toBe(0)
  expect(sum.exclusive.model).toBe(sum.wallMs)
  expect(sum.findings.some(f => f.includes('outside model requests'))).toBe(false)
})

test('test and approval shares stay within agent time with parallel and subagent runs', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't1')
  p.toolStart(0, { id: 'ag', tool: 'Agent', input: { subagentType: 'runner' } })
  p.subagentStart(0, 'a1', 'runner')
  for (const [id, agentId] of [['b1', undefined], ['b2', undefined], ['b3', 'a1']] as const) {
    p.toolStart(0, { id, tool: 'Bash', agentId, input: { command: 'npm test' } })
    p.toolCheck(id, 'ask')
    p.toolDuration(id, 400)
    p.toolEnd(1_000, id, { denied: false, isError: false })
  }
  p.subagentStop(1_000, 'a1')
  p.toolEnd(1_000, 'ag', { denied: false, isError: false, launchedAgentId: 'a1', launchedAsync: false })
  p.turnComplete(1_000, 't1')
  const sum = summarize(p.snapshot(2_000))
  expect(sum.wallMs).toBe(1_000)
  expect(sum.bash.testMs).toBe(1_200)
  expect(sum.bash.testShare).toBe(0.4)
  expect(sum.tools.permissionMs).toBe(1_800)
  expect(sum.tools.permissionShare).toBe(0.6)
  expect(sum.findings).toContain('Tests took 40% of agent time (1.2s over 3 run(s)).')
  expect(sum.findings.some(f => f.startsWith('Waiting for approval took 60%'))).toBe(true)
})

test('tokens per second counts only requests whose stream was timed', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't')
  const timed = p.stepStart(0, { turnId: 't', index: 0, model: 'm' })
  p.stepChunk(500, timed, 'text')
  p.stepUsage(timed, { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  p.stepEnd(1_500, timed)
  const blind = p.stepStart(1_500, { turnId: 't', index: 1, model: 'm' })
  p.stepUsage(blind, { input_tokens: 1, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  p.stepEnd(2_000, blind)
  p.turnComplete(2_000, 't')
  const sum = summarize(p.snapshot(3_000))
  expect(sum.model.outputTokens).toBe(1_000)
  expect(sum.model.tokensPerSec).toBe(100)
})

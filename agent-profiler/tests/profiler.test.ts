import { expect, test } from 'claude-code/testing'

import { Profiler, summarizeInput, toolOutcome } from '../hooks/core/profiler.ts'

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, model: 'm' }
const ok = { denied: false, isError: false }

test('a turn with one request and one tool', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't1', 'fix it')
  const step = p.stepStart(10, { turnId: 't1', index: 0, model: 'm' })
  p.stepChunk(15, step, 'engine')
  p.stepChunk(300, step, 'thinking')
  p.stepChunk(900, step, 'thinking')
  p.stepChunk(1000, step, 'tool')
  p.stepChunk(1100, step, 'stop')
  p.stepUsage(step, usage, 'tool_use')
  p.stepEnd(1100, step)
  p.toolStart(1200, { id: 'toolu_1', tool: 'Bash', input: { command: 'npm test' } })
  p.toolDuration('toolu_1', 4000)
  p.toolEnd(5300, 'toolu_1', ok)
  p.turnComplete(6000, 't1', 'answer')
  const s = p.snapshot(7000)
  expect(s.turns).toEqual([{ id: 't1', ctx: 'main', start: 0, end: 6000, reason: 'answer', prompt: 'fix it' }])
  expect(s.steps[0]).toEqual({
    id: 't1#0', ctx: 'main', turnId: 't1', index: 0, model: 'm', start: 10,
    firstContent: 300, thinkFirst: 300, thinkLast: 900, outFirst: 1000, end: 1100, usage, stopReason: 'tool_use',
  })
  expect(s.tools[0].turnId).toBe('t1')
  expect(s.tools[0].execMs).toBe(4000)
  expect(s.tools[0].end).toBe(5300)
})

test('PostToolUse may arrive before tool.call returns, or before the tool is seen', () => {
  const p = new Profiler('s')
  p.toolDuration('a', 50)
  p.toolStart(0, { id: 'a', tool: 'Read', input: { path: '/x' } })
  p.toolEnd(60, 'a', ok)
  p.toolStart(100, { id: 'b', tool: 'Read', input: { path: '/y' } })
  p.toolDuration('b', 7)
  p.toolEnd(110, 'b', ok)
  const s = p.snapshot(200)
  expect(s.tools.map(t => t.execMs)).toEqual([50, 7])
})

test('subagent work attaches to the agent context and its Agent tool', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't1')
  p.toolStart(10, { id: 'toolu_agent', tool: 'Agent', input: { subagentType: 'Explore' } })
  p.subagentStart(12, 'ag1', 'Explore')
  p.toolEnd(14, 'toolu_agent', { denied: false, isError: false, launchedAgentId: 'ag1', launchedAsync: true })
  const step = p.stepStart(20, { turnId: 'sub-t', index: 0, model: 'h', agentId: 'ag1' })
  p.stepEnd(40, step)
  p.toolStart(50, { id: 'toolu_r', tool: 'Read', agentId: 'ag1', input: { path: '/a' } })
  p.toolEnd(60, 'toolu_r', ok)
  p.subagentStop(100, 'ag1')
  const s = p.snapshot(200)
  expect(s.agents[0]).toEqual({ id: 'ag1', agentType: 'Explore', start: 12, end: 100, parentToolId: 'toolu_agent' })
  expect(s.tools.find(t => t.id === 'toolu_r')?.ctx).toBe('ag1')
  expect(s.tools.find(t => t.id === 'toolu_r')?.turnId).toBe('sub-t')
  expect(s.turns.find(t => t.id === 'sub-t')).toEqual({ id: 'sub-t', ctx: 'ag1', start: 20, end: 100, reason: 'agent-stop', prompt: '' })
  expect(p.running(200)).toEqual([])
})

test('a subagent turn first announced by turn.start moves out of the main context', () => {
  const p = new Profiler('s')
  p.turnStart(0, 'main-t')
  p.turnStart(5, 'sub-t')
  p.stepStart(6, { turnId: 'sub-t', index: 0, model: 'h', agentId: 'ag1' })
  p.toolStart(7, { id: 'x', tool: 'Read', input: {} })
  const s = p.snapshot(8)
  expect(s.tools[0].turnId).toBe('main-t')
  expect(s.turns.find(t => t.id === 'sub-t')?.ctx).toBe('ag1')
})

test('retried steps get distinct ids; open spans show as running, longest first', () => {
  const p = new Profiler('s')
  const a = p.stepStart(0, { turnId: 't', index: 0, model: 'm' })
  const b = p.stepStart(5, { turnId: 't', index: 0, model: 'm' })
  expect([a, b]).toEqual(['t#0', 't#0.1'])
  p.toolStart(1, { id: 'b1', tool: 'Bash', input: { command: 'sleep 9' } })
  expect(p.running(1001).map(r => r.label)).toEqual(['model m', 'Bash sleep 9', 'model m'])
})

test('finished spans are dropped past the cap and counted', () => {
  const p = new Profiler('s', 10)
  for (let i = 0; i < 12; i += 1) {
    p.toolStart(i, { id: `t${i}`, tool: 'Read', input: {} })
    p.toolEnd(i + 1, `t${i}`, ok)
  }
  const s = p.snapshot(100)
  expect(s.tools.length).toBe(10)
  expect(s.dropped).toBe(2)
})

test('summarizeInput and toolOutcome read the engine shapes', () => {
  expect(summarizeInput('Bash', { command: 'ls', description: 'list' })).toEqual({ command: 'ls', description: 'list' })
  expect(summarizeInput('Read', { file_path: '/a', offset: 10, limit: 5 })).toEqual({ path: '/a', range: '10:5' })
  expect(summarizeInput('Read', { file_path: '/a' })).toEqual({ path: '/a' })
  expect(summarizeInput('Grep', { pattern: 'x', path: 'src' })).toEqual({ pattern: 'x', path: 'src' })
  expect(summarizeInput('Agent', { subagent_type: 'Explore', description: 'look' })).toEqual({ subagentType: 'Explore', description: 'look' })
  expect(toolOutcome({ result: { status: 'async_launched', agentId: 'ag' } })).toEqual({ denied: false, isError: false, launchedAgentId: 'ag', launchedAsync: true })
  expect(toolOutcome({ deny: 'no' })).toEqual({ denied: true, isError: false, launchedAgentId: undefined, launchedAsync: false })
  expect(toolOutcome(undefined)).toEqual({ denied: false, isError: false, launchedAgentId: undefined, launchedAsync: false })
})

test('version moves on every change and stays put on chunks that change nothing', () => {
  const p = new Profiler('s')
  const v0 = p.version
  p.turnStart(0, 't')
  const step = p.stepStart(1, { turnId: 't', index: 0, model: 'm' })
  p.stepChunk(2, step, 'text')
  const v1 = p.version
  expect(v1).toBeGreaterThan(v0)
  p.stepChunk(3, step, 'text')
  p.stepChunk(4, step, 'tool')
  expect(p.version).toBe(v1)
  p.stepEnd(5, step)
  expect(p.version).toBeGreaterThan(v1)
  expect(p.running(6)).toEqual([])
})

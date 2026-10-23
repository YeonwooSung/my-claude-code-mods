import { Profiler } from '../hooks/core/profiler.ts'

export const ok = { denied: false, isError: false }

// One 10s turn: 2 model requests (3s), Read, npm test behind an approval prompt (6s), re-reads of /a.ts.
export function session(): Profiler {
  const p = new Profiler('s')
  p.turnStart(0, 't1', 'fix the tests')
  let step = p.stepStart(0, { turnId: 't1', index: 0, model: 'm' })
  p.stepChunk(1000, step, 'text')
  p.stepUsage(step, { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'tool_use')
  p.stepEnd(2000, step)
  p.toolStart(2000, { id: 'r1', tool: 'Read', input: { path: '/a.ts' } })
  p.toolDuration('r1', 10)
  p.toolEnd(2010, 'r1', ok)
  p.toolStart(2010, { id: 'b1', tool: 'Bash', input: { command: 'npm test' } })
  p.toolDecision('tool_decision', { tool_use_id: 'b1', decision: 'accept', source: 'user_temporary' }, '1970-01-01T00:00:03.010Z')
  p.toolDuration('b1', 5000)
  p.toolEnd(8010, 'b1', ok)
  step = p.stepStart(8010, { turnId: 't1', index: 1, model: 'm' })
  p.stepChunk(8510, step, 'text')
  p.stepEnd(9010, step)
  p.toolStart(9010, { id: 'r2', tool: 'Read', input: { path: '/a.ts' } })
  p.toolEnd(9020, 'r2', ok)
  p.toolStart(9020, { id: 'r3', tool: 'Read', input: { path: '/a.ts' } })
  p.toolEnd(9030, 'r3', ok)
  p.toolStart(9030, { id: 'e1', tool: 'Edit', input: { path: '/a.ts' } })
  p.toolEnd(9040, 'e1', ok)
  p.toolStart(9040, { id: 'r4', tool: 'Read', input: { path: '/a.ts' } })
  p.toolEnd(9050, 'r4', ok)
  p.turnComplete(10_000, 't1', 'answer')
  return p
}

// One 1s turn whose main loop waits on a blocking Explore subagent (100–910ms).
export function withSubagent(): Profiler {
  const p = new Profiler('s')
  p.turnStart(0, 't1')
  p.toolStart(100, { id: 'ag', tool: 'Agent', input: { subagentType: 'Explore' } })
  p.subagentStart(110, 'a1', 'Explore')
  const step = p.stepStart(120, { turnId: 'st', index: 0, model: 'h', agentId: 'a1' })
  p.stepEnd(620, step)
  p.toolStart(620, { id: 'g', tool: 'Grep', agentId: 'a1', input: { pattern: 'x' } })
  p.toolEnd(820, 'g', ok)
  p.subagentStop(900, 'a1')
  p.toolEnd(910, 'ag', { denied: false, isError: false, launchedAgentId: 'a1', launchedAsync: false })
  p.turnComplete(1000, 't1', 'answer')
  return p
}

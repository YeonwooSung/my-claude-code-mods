import { expect, test } from 'claude-code/testing'

import { traceIdFromSession } from '../hooks/core/ids.ts'
import { toOtlp } from '../hooks/core/otlp.ts'
import { session, withSubagent } from './fixtures.ts'

function spansOf(p: ReturnType<typeof session>) {
  return toOtlp(p.snapshot(20_000), '0.1.0').resourceSpans[0].scopeSpans[0].spans
}

test('spans form a tree under the session root', () => {
  const spans = spansOf(session())
  const named = (name: string) => spans.filter(s => s.name === name)
  const root = named('claude-code session')[0]
  expect(root.parentSpanId).toBeUndefined()
  expect(root.traceId).toBe(traceIdFromSession('s'))
  const turn = named('turn')[0]
  expect(turn.parentSpanId).toBe(root.spanId)
  expect(named('chat m').length).toBe(2)
  expect(named('chat m').every(s => s.parentSpanId === turn.spanId)).toBe(true)
  expect(named('model.ttft').length).toBe(2)
  const bash = named('execute_tool Bash')[0]
  expect(bash.parentSpanId).toBe(turn.spanId)
  expect(bash.startTimeUnixNano).toBe('2010000000')
  expect(bash.attributes).toContainEqual({ key: 'agent_profiler.bash.category', value: { stringValue: 'test' } })
  expect(bash.attributes).toContainEqual({ key: 'agent_profiler.exec_ms', value: { intValue: '5000' } })
  expect(named('tool.approval_wait')[0].parentSpanId).toBe(bash.spanId)
  expect(named('tool.exec').length).toBe(2)
})

test('exports are deterministic', () => {
  expect(JSON.stringify(spansOf(session()))).toBe(JSON.stringify(spansOf(session())))
})

test('a subagent hangs under its Agent tool, its work under the subagent', () => {
  const spans = spansOf(withSubagent())
  const named = (name: string) => spans.find(s => s.name === name)
  const agentTool = named('execute_tool Agent')
  const agent = named('invoke_agent Explore')
  expect(agent?.parentSpanId).toBe(agentTool?.spanId)
  expect(named('chat h')?.parentSpanId).toBe(agent?.spanId)
  expect(named('execute_tool Grep')?.parentSpanId).toBe(agent?.spanId)
  expect(spans.some(s => s.name === 'turn' && s.parentSpanId === agent?.spanId)).toBe(false)
})

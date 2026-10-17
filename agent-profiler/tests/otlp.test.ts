import { expect, test } from 'claude-code/testing'

import { traceIdFromSession } from '../hooks/core/ids.ts'
import { toOtlp } from '../hooks/core/otlp.ts'
import { Profiler, summarizeInput } from '../hooks/core/profiler.ts'
import { session, withSubagent } from './fixtures.ts'

test('search text is opt-in and masked in exported traces', () => {
  const p = new Profiler('search')
  p.toolStart(0, { id: 'grep', tool: 'Grep', input: summarizeInput('Grep', { pattern: 'API_KEY=FAKE_SEARCH_SECRET', path: '/repo' }) })
  const snapshot = p.snapshot(1)
  const defaultExport = JSON.stringify(toOtlp(snapshot, 'test'))
  expect(defaultExport).not.toContain('FAKE_SEARCH_SECRET')
  expect(defaultExport).not.toContain('agent_profiler.search.pattern')
  const optedIn = JSON.stringify(toOtlp(snapshot, 'test', { commandText: true }))
  expect(optedIn).not.toContain('FAKE_SEARCH_SECRET')
  expect(optedIn).toContain('API_KEY=[REDACTED]')
})

function spansOf(p: ReturnType<typeof session>) {
  return toOtlp(p.snapshot(20_000), '0.1.0').resourceSpans[0]?.scopeSpans[0]?.spans ?? []
}

test('spans form a tree under the session root', () => {
  const spans = spansOf(session())
  const named = (name: string) => spans.filter(s => s.name === name)
  const first = (name: string) => {
    const span = named(name)[0]
    if (!span) throw new Error(`no ${name} span`)
    return span
  }
  const root = first('claude-code session')
  expect(root.parentSpanId).toBeUndefined()
  expect(root.traceId).toBe(traceIdFromSession('s'))
  const turn = first('turn')
  expect(turn.parentSpanId).toBe(root.spanId)
  expect(named('chat m').length).toBe(2)
  expect(named('chat m').every(s => s.parentSpanId === turn.spanId)).toBe(true)
  expect(named('model.ttft').length).toBe(2)
  const bash = first('execute_tool Bash')
  expect(bash.parentSpanId).toBe(turn.spanId)
  expect(bash.startTimeUnixNano).toBe('2010000000')
  expect(bash.attributes).toContainEqual({ key: 'agent_profiler.bash.category', value: { stringValue: 'test' } })
  expect(bash.attributes).toContainEqual({ key: 'agent_profiler.exec_ms', value: { intValue: '5000' } })
  expect(first('tool.approval_wait').parentSpanId).toBe(bash.spanId)
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

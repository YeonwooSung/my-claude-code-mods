import { expect, test } from 'claude-code/testing'
import { Profiler } from '../hooks/core/profiler.ts'
import { summarize } from '../hooks/core/analyze.ts'
import { renderReport } from '../hooks/core/report.ts'
import { toOtlp } from '../hooks/core/otlp.ts'

function example(source = 'user_temporary', decision = 'accept', duration: number | null = 400) {
  const p = new Profiler('permissions')
  p.turnStart(0, 't')
  p.toolStart(0, { id: 'a', tool: 'Bash', input: { command: 'npm test' } })
  p.toolDecision('tool_decision', { tool_use_id: 'a', decision, source, unwanted: 'YOUR_API_KEY' }, '1970-01-01T00:00:00.500Z')
  if (duration !== null) p.toolDuration('a', duration)
  p.toolEnd(1000, 'a', { denied: decision === 'reject', isError: false })
  p.turnComplete(1000, 't')
  return p
}

test('permission estimates use the final decision time and leave other overhead separate', () => {
  const p = example()
  const sum = summarize(p.snapshot(1000))
  expect(sum.tools.permissionObserved).toBe(1)
  expect(sum.tools.permissionTimed).toBe(1)
  expect(sum.tools.permissionMs).toBe(500)
  expect(sum.tools.overheadMs).toBe(100)
  expect(sum.tools.execMs).toBe(400)
  expect(sum.wallMs).toBe(1000)
  expect(JSON.stringify(p.snapshot(1000))).not.toContain('YOUR_API_KEY')
})

test('missing or ambiguous permission timing is unavailable rather than a zero measurement', () => {
  for (const p of [example('hook'), example('config'), example('unknown'), example('user_temporary', 'accept', null)]) {
    const sum = summarize(p.snapshot(1000))
    expect(sum.tools.permissionObserved).toBe(1)
    expect(sum.tools.permissionTimed).toBe(0)
    const report = renderReport(sum)
    expect(report).toContain('approval/check wait unavailable')
    expect(report).not.toContain('approval wait 0ms')
    expect(sum.findings.some(f => f.startsWith('Observed approval/check wait'))).toBe(false)
  }
})

test('confirmed rejection has no execution even without a duration event', () => {
  const sum = summarize(example('user_reject', 'reject', null).snapshot(1000))
  expect(sum.tools.execMs).toBe(0)
  expect(sum.tools.permissionMs).toBe(500)
  expect(sum.tools.overheadMs).toBe(500)
  expect(sum.tools.denied).toBe(1)
})

test('classifier decisions are distinguishable from user approvals and other config decisions', () => {
  const p = new Profiler('auto')
  p.toolStart(0, { id: 'a', tool: 'Bash', input: {} })
  p.toolDecision('tool_decision', { tool_use_id: 'a', decision: 'accept', source: 'config', classifier_verdict: 'allow' }, '1970-01-01T00:00:00.600Z')
  p.toolDuration('a', 400)
  p.toolEnd(1000, 'a', { denied: false, isError: false })
  const spans = toOtlp(p.snapshot(1000), 'test').resourceSpans[0]!.scopeSpans[0]!.spans
  const wait = spans.find(s => s.name === 'tool.approval_wait')
  expect(wait?.endTimeUnixNano).toBe('600000000')
  expect(wait?.attributes).toContainEqual({ key: 'agent_profiler.permission_wait_kind', value: { stringValue: 'auto' } })
})

test('unclassified waits never claim to be tool overhead or missing final verdicts', () => {
  const p = example('hook')
  const spans = toOtlp(p.snapshot(1000), 'test').resourceSpans[0]!.scopeSpans[0]!.spans
  expect(spans.some(s => s.name === 'tool.wait_unclassified')).toBe(true)
  expect(spans.some(s => s.name === 'tool.overhead' || s.name === 'tool.approval_wait')).toBe(false)
  const tool = spans.find(s => s.name === 'execute_tool Bash')!
  expect(tool.attributes).toContainEqual({ key: 'agent_profiler.permission_decision', value: { stringValue: 'accept' } })
  expect(tool.attributes).toContainEqual({ key: 'agent_profiler.permission_source', value: { stringValue: 'hook' } })
  expect(tool.attributes.some(a => a.key === 'agent_profiler.permission')).toBe(false)
})

test('malformed, foreign and duplicate observations cannot invent or overwrite a tool verdict', () => {
  const p = example()
  for (const [event, attrs, at] of [
    ['unrelated', { tool_use_id: 'a', decision: 'reject', source: 'user_reject' }, '1970-01-01T00:00:00.600Z'],
    ['tool_decision', { tool_use_id: 'missing', decision: 'reject', source: 'user_reject' }, '1970-01-01T00:00:00.600Z'],
    ['tool_decision', { tool_use_id: 'a', decision: 'allow', source: 'user_reject' }, 'invalid'],
    ['tool_decision', { tool_use_id: 'a', decision: 'reject', source: 'user_reject' }, '1970-01-01T00:00:00.600Z'],
  ] as const) p.toolDecision(event, attrs, at)
  const sum = summarize(p.snapshot(1000))
  expect(sum.tools.denied).toBe(0)
  expect(sum.tools.permissionMs).toBe(500)
  expect(sum.tools.permissionObserved).toBe(1)
})

test('delayed valid observations correlate by id including subagents; out-of-window data is ignored', () => {
  const p = new Profiler('late')
  p.toolStart(100, { id: 'a', tool: 'Read', input: {} })
  p.toolStart(100, { id: 'b', agentId: 'worker', tool: 'Read', input: {} })
  for (const id of ['a', 'b']) { p.toolDuration(id, 100); p.toolEnd(1000, id, { denied: false, isError: false }) }
  p.toolDecision('tool_decision', { tool_use_id: 'a', decision: 'accept', source: 'user_temporary' }, '1970-01-01T00:00:02.000Z')
  p.toolDecision('tool_decision', { tool_use_id: 'a', decision: 'accept', source: 'user_temporary' }, 'invalid')
  p.toolDecision('tool_decision', { tool_use_id: 'a', decision: 'accept', source: 'user_temporary' }, '1970-01-01T00:00:00.050Z')
  expect(p.snapshot(1000).tools[0]!.permission).toBeUndefined()
  p.toolDecision('tool_decision', { tool_use_id: 'b', decision: 'accept', source: 'user_temporary' }, '1970-01-01T00:00:00.600Z')
  expect(p.snapshot(1000).tools[1]!.permission?.decision).toBe('accept')
})

test('mixed coverage reports observed estimates without suggesting the unobserved calls had zero wait', () => {
  const p = example()
  p.toolStart(1000, { id: 'b', tool: 'Read', input: {} })
  p.toolDuration('b', 100)
  p.toolEnd(2000, 'b', { denied: false, isError: false })
  const text = renderReport(summarize(p.snapshot(2000)))
  expect(text).toContain('estimated; 1/2 calls')
  expect(text).toContain('unclassified')
})

test('malformed first observations do not become measured permission results', () => {
  for (const [event, attrs, at] of [
    ['other_event', { tool_use_id: 'a', decision: 'accept', source: 'user_temporary' }, '1970-01-01T00:00:00.500Z'],
    ['tool_decision', { tool_use_id: 'a', decision: 'allow', source: 'config' }, '1970-01-01T00:00:00.500Z'],
    ['tool_decision', { tool_use_id: 'a', decision: 'accept', source: 'config' }, 'invalid'],
    ['tool_decision', { decision: 'accept', source: 'config' }, '1970-01-01T00:00:00.500Z'],
  ] as const) {
    const p = new Profiler('malformed')
    p.toolStart(0, { id: 'a', tool: 'Read', input: {} })
    p.toolDecision(event, attrs, at)
    expect(p.snapshot(1000).tools[0]!.permission).toBeUndefined()
  }
})

test('unknown sources/classifiers are not stored as free text or inferred to be a user wait', () => {
  const p = new Profiler('unrecognized')
  p.toolStart(0, { id: 'a', tool: 'Read', input: {} })
  p.toolDecision('tool_decision', { tool_use_id: 'a', decision: 'accept', source: 'YOUR_API_KEY', classifier_verdict: 'YOUR_API_KEY' }, '1970-01-01T00:00:00.500Z')
  p.toolEnd(1000, 'a', { denied: false, isError: false })
  expect(JSON.stringify(p.snapshot(1000))).not.toContain('YOUR_API_KEY')
  expect(p.snapshot(1000).tools[0]!.permission?.source).toBe('unknown')
  expect(summarize(p.snapshot(1000)).tools.permissionTimed).toBe(0)
})

test('rejected calls export a denial without an execution span', () => {
  const spans = toOtlp(example('user_reject', 'reject', null).snapshot(1000), 'test').resourceSpans[0]!.scopeSpans[0]!.spans
  expect(spans.some(s => s.name === 'tool.exec')).toBe(false)
  expect(spans.find(s => s.name === 'execute_tool Bash')?.status.message).toBe('denied')
})

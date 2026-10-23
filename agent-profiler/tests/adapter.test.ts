import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

test('/profile reports tool calls the mod observed', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.PostToolUse', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' })
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {}, tool_use_id: 'toolu_1', duration_ms: 5 } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const answer = await $.command.run({ command: 'profile', args: '' } as never)
  expect(answer.text).toContain('1 turn(s)')
  expect(answer.text).toContain('Bash npm test')
})

test('tool.call passes the answer through unchanged', async ($, on) => {
  on('tool.call', () => ({ deny: 'nope' }))
  const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'toolu_2' })
  expect(denied.deny).toBe('nope')
})

test('turn.step chunks reach the caller unchanged', async ($, on) => {
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'hm' }
    yield { kind: 'text', index: 1, text: 'hi' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: 't9', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  })
  const kinds: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't9', index: 0, model: 'm', messageCount: 1 })) kinds.push(chunk.kind)
  expect(kinds).toEqual(['thinking', 'text', 'stop'])
})

const DIR = '/Users/u/.claude/agent-profiler/sess-1'

test('StopFailure closes the failed turn before turn.complete arrives', async ($, on) => {
  mock.clock(on)
  const bodies: string[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  mock.env(on, { HOME: '/Users/u' })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.StopFailure', () => ({}))
  on('fs.write', (_$, e) => { bodies.push(e.text); return { value: undefined } })
  await $.turn.start({ text: 'go', turnId: 'limited' })
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await $.command.run({ command: 'profile-export', args: '' } as never)
  const spans = JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0].spans
  const turn = spans.find((s: { name: string }) => s.name === 'turn')
  expect(turn).toBeDefined()
  expect(turn.attributes.some((a: { key: string }) => a.key === 'agent_profiler.incomplete')).toBe(false)
})

// The 2.1.280 test runner ignores per-test plugin options, so these run with the defaults (no endpoint).
function oneSession(on: On, writes: string[] | 'deny') {
  mock.env(on, { HOME: '/Users/u' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', () => ({ sessionId: 'sess-1' }))
  on('fs.write', (_$, e) => {
    if (writes === 'deny') return { deny: 'EACCES' }
    writes.push(e.path)
    return { value: undefined }
  })
}

test('/profile-export writes a full snapshot as chunk files in the session folder', async ($, on) => {
  const writes: string[] = []
  oneSession(on, writes)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_x' })
  const answer = await $.command.run({ command: 'profile-export', args: '' } as never)
  expect(String(answer.text)).toMatch(/^wrote \/Users\/u\/\.claude\/agent-profiler\/sess-1\/[0-9a-z]+-full-1\.otlp\.json$/)
  expect(writes.length).toBe(1)
})

test('turn batches and the session-end batch go to numbered files that never repeat', async ($, on) => {
  const clock = mock.clock(on)
  const writes: string[] = []
  oneSession(on, writes)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_y' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done' } as never)
  await clock.advance(10)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await $.session.end({ reason: 'exit' } as never)
  expect(writes.length).toBe(2)
  expect(writes.every(path => path.startsWith(`${DIR}/`) && /\/[0-9a-z]+-\d{4}\.otlp\.json$/.test(path))).toBe(true)
  expect(new Set(writes).size).toBe(2)
})

test('automatic save failures surface once as a toast', async ($, on) => {
  const clock = mock.clock(on)
  oneSession(on, 'deny')
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  for (const turnId of ['t1', 't2']) {
    await $.turn.start({ text: 'go', turnId })
    await $.turn.complete({ turnId, reason: 'answer', answer: 'done' } as never)
    await clock.advance(10)
  }
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain(`could not write to ${DIR}`)
})

for (const decision of ['accept', 'reject'] as const) {
  test(`collector ${decision} reaches the real report/export path without changing the tool result`, async ($, on) => {
    const engine = $
    mock.clock(on)
    mock.env(on, { HOME: '/Users/u' })
    const bodies: string[] = []
    let forwarded = 0
    on('session.id', () => ({ value: 'permission-session' }))
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    on('fs.write', (_$, e) => { bodies.push(e.text); return { value: undefined } })
    on('telemetry.log', { to: 'collector' }, () => { forwarded++; return { value: undefined } })
    on('classic.PostToolUse', () => ({}))
    on('tool.call', async ($, e) => {
      await engine.telemetry.log({ to: 'collector', event: 'tool_decision', loggedAt: new Date().toISOString(),
        attributes: { tool_use_id: e.tool_use_id!, decision, source: decision === 'accept' ? 'user_temporary' : 'user_reject', ignored: 'YOUR_API_KEY' } })
      if (decision === 'accept') await engine.classic.PostToolUse({ tool_use_id: e.tool_use_id, duration_ms: 0 } as never)
      return decision === 'accept' ? { result: 'unchanged' } : { deny: 'host denied' }
    })
    await $.turn.start({ text: 'test permission observation', turnId: 'permissions' })
    const result = await $.tool.call({ tool: 'Bash', command: 'echo example', tool_use_id: 'observed-tool' })
    expect(result).toEqual(decision === 'accept' ? { result: 'unchanged' } : { deny: 'host denied' })
    const report = await $.command.run({ command: 'profile', args: '' } as never)
    expect(report.text).toContain('estimated; 1/1 calls')
    await $.command.run({ command: 'profile-export', args: '' } as never)
    const spans = JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0].spans
    const tool = spans.find((s: { name: string }) => s.name === 'execute_tool Bash')
    expect(tool.attributes).toContainEqual({ key: 'agent_profiler.permission_decision', value: { stringValue: decision } })
    expect(bodies[0]).not.toContain('YOUR_API_KEY')
    expect(forwarded).toBe(1)
  })
}

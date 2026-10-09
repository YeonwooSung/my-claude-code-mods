import { expect, test } from 'claude-code/testing'

test('/profile reports tool calls the mod observed', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.PostToolUse', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' })
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {}, tool_use_id: 'toolu_1', duration_ms: 5 } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const answer = await $.command.run({ command: 'profile', args: '' })
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

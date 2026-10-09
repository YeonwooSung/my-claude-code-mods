import { expect, mock, test } from 'claude-code/testing'

test('tool.call relays the answer unchanged, deny included', async ($, on) => {
  on('tool.call', () => ({ deny: 'nope' }))
  const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'toolu_d' })
  expect(denied.deny).toBe('nope')
})

test('session.compact returns what next resolved, for a compaction and for a skip', async ($, on) => {
  const after = [{ role: 'user' as const, text: 'Summary', toolUses: [], handle: 'h9' }]
  on('session.compact', (_$, e) => (e.trigger === 'manual' ? { skip: 'vetoed' } : { messages: after, tokensBefore: 10, tokensAfter: 2 }))
  const done = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'a', toolUses: [], handle: 'h1' }] } as never)
  expect(done).toEqual({ messages: after, tokensBefore: 10, tokensAfter: 2 })
  const skipped = await $.session.compact({ trigger: 'manual', messages: [] } as never)
  expect(skipped).toEqual({ skip: 'vetoed' })
})

test('turn.step chunks reach the caller unchanged', async ($, on) => {
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  })
  const kinds: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) kinds.push(chunk.kind)
  expect(kinds).toEqual(['text', 'stop'])
})

test('/context-inspect renders a report after a compaction, even without a usage figure', async ($, on) => {
  on('tool.call', () => ({ result: { type: 'text', file: { filePath: '/a.ts', startLine: 1, numLines: 1, totalLines: 1 } }, text: 'x' }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'Summary mentions a.ts', toolUses: [] }], tokensBefore: 900, tokensAfter: 100 }))
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', tool_use_id: 'toolu_r' })
  await $.session.compact({
    trigger: 'auto',
    messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_r', tool: 'Read', input: { file_path: '/a.ts' } }], handle: 'h1' }],
  } as never)
  const answer = await $.command.run({ command: 'context-inspect', args: 'compactions' } as never)
  const text = String(answer.text)
  expect(text).toContain('Context Inspector — main context')
  // module state may carry over from the earlier compaction test, so the index is not pinned
  expect(text).toMatch(/#\d+ auto @turn \d+  900→100 tokens/)
  expect(text).toContain('read 1/1')
})

test('/context-inspect names an unknown section', async $ => {
  const answer = await $.command.run({ command: 'context-inspect', args: 'bogus' } as never)
  expect(String(answer.text)).toContain("unknown section 'bogus'")
})

test('/context-export writes JSONL into the session folder under HOME', async ($, on) => {
  mock.env(on, { HOME: '/Users/u' })
  on('session.id', () => ({ value: 'sess-1' }))
  const writes: { path: string; body: string }[] = []
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, body: e.text })
    return { value: undefined }
  })
  const answer = await $.command.run({ command: 'context-export', args: '' } as never)
  expect(writes.length).toBe(1)
  expect(writes[0]!.path).toMatch(/^\/Users\/u\/\.claude\/context-inspector\/sess-1\/context-[0-9a-z]+-1\.jsonl$/)
  expect(writes[0]!.body.split('\n')[0]).toContain('"type":"meta"')
  expect(String(answer.text)).toContain('wrote /Users/u/.claude/context-inspector/sess-1/')
})

test('/context-export reports a write failure instead of throwing', async ($, on) => {
  mock.env(on, { HOME: '/Users/u' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', () => ({ deny: 'EACCES' }))
  const answer = await $.command.run({ command: 'context-export', args: '' } as never)
  expect(String(answer.text)).toContain('export failed')
})

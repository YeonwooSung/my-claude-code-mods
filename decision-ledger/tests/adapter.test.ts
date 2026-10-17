import { test, expect } from 'claude-code/testing'
const START = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
test('command records survive reload and remain isolated by session; tools forward once', async ($, on) => {
  let id = 's'; let calls = 0
  const data = new Map<string, unknown>()
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: id }))
  on('store.get', (_$, e) => ({ value: data.get(e.key) }))
  on('store.set', (_$, e) => { data.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '{}' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', () => { calls++; return { deny: 'not allowed' } })
  await $.session.start(START)
  await $.command.run({ command: 'decision', args: "add src/cache.ts#lookup | LRU | Bound memory | Map" } as never)
  expect((await $.command.run({ command: 'decision', args: '' } as never)).text).toContain("Bound memory")
  await $.session.start(START)
  expect((await $.command.run({ command: 'decision', args: '' } as never)).text).toContain("Bound memory")
  id = 'other'
  expect((await $.command.run({ command: 'decision', args: '' } as never)).text).not.toContain("Bound memory")
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/a', content: 'x', tool_use_id: 't' } as never)).deny).toBe('not allowed')
  expect(calls).toBe(1)
})
test('failed durable write returns visible error', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', () => ({ value: undefined })); on('store.set', () => ({ deny: 'disk full' }))
  expect((await $.command.run({ command: 'decision', args: 'reset' } as never)).text).toContain('not saved')
})
test('concurrent engine commands persist every unique decision exactly once', async ($, on) => {
  const saved = new Map<string, unknown>()
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', (_$, e) => ({ value: saved.get(e.key) }))
  on('store.set', (_$, e) => { saved.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => $.command.run({ command: 'decision', args: `add ${i}.ts | engine-choice-${i} | reason` } as never)))
  for (const reply of replies) expect(reply.text).not.toContain('not saved')
  const report = (await $.command.run({ command: 'decision', args: 'list' } as never)).text
  for (let i = 0; i < 8; i++) expect(report).toContain(`engine-choice-${i}`)
  expect(report).toContain('#8')
})
test('engine read-only report survives a write outage after a rejected mutation', async ($, on) => {
  let fail = false
  const saved = new Map<string, unknown>()
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', (_$, e) => ({ value: saved.get(e.key) }))
  on('store.set', (_$, e) => { if (fail) return { deny: 'disk full' }; saved.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  await $.command.run({ command: 'decision', args: 'add a.ts | durable-choice | reason' } as never)
  fail = true
  expect((await $.command.run({ command: 'decision', args: 'add b.ts | unsaved-choice | reason' } as never)).text).toContain('not saved')
  const report = (await $.command.run({ command: 'decision', args: 'list' } as never)).text
  expect(report).toContain('durable-choice')
  expect(report).not.toContain('unsaved-choice')
})

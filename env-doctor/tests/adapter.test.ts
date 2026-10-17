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
  await $.command.run({ command: 'doctor', args: "require DATABASE_URL" } as never)
  expect((await $.command.run({ command: 'doctor', args: '' } as never)).text).toContain("DATABASE_URL")
  await $.session.start(START)
  expect((await $.command.run({ command: 'doctor', args: '' } as never)).text).toContain("DATABASE_URL")
  id = 'other'
  expect((await $.command.run({ command: 'doctor', args: '' } as never)).text).not.toContain("DATABASE_URL")
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/a', content: 'x', tool_use_id: 't' } as never)).deny).toBe('not allowed')
  expect(calls).toBe(1)
})
test('failed durable write returns visible error', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', () => ({ value: undefined })); on('store.set', () => ({ deny: 'disk full' }))
  expect((await $.command.run({ command: 'doctor', args: 'reset' } as never)).text).toContain('not saved')
})

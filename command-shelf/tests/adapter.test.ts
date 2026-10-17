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
  on('tool.call', (_$, e) => { calls++; return e.tool === 'Bash' ? { result: { stdout: '', stderr: '', interrupted: false } } as never : { deny: 'not allowed' } })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'seed' } as never)
  await $.command.run({ command: 'shelf', args: "pin 1 auth tests" } as never)
  expect((await $.command.run({ command: 'shelf', args: '' } as never)).text).toContain("auth tests")
  await $.session.start(START)
  expect((await $.command.run({ command: 'shelf', args: '' } as never)).text).toContain("auth tests")
  id = 'other'
  expect((await $.command.run({ command: 'shelf', args: '' } as never)).text).not.toContain("auth tests")
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/a', content: 'x', tool_use_id: 't' } as never)).deny).toBe('not allowed')
  expect(calls).toBe(2)
})
test('failed durable write returns visible error', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', () => ({ value: undefined })); on('store.set', () => ({ deny: 'disk full' }))
  expect((await $.command.run({ command: 'shelf', args: 'reset' } as never)).text).toContain('not saved')
})
test('explicit replay reaches Bash permission handling once without deadlocking observation', async ($, on) => {
  const data = new Map<string, unknown>(); let calls = 0
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', (_$, e) => ({ value: data.get(e.key) }))
  on('store.set', (_$, e) => { data.set(e.key, e.value); return { value: undefined } })
  on('tool.call', (_$, e) => { calls++; return e.tool === 'Bash' && e.command === 'npm test' ? { result: { stdout: '', stderr: '', interrupted: false } } as never : { deny: 'permission required' } })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'seed' } as never)
  expect((await $.command.run({ command: 'shelf', args: 'show 1' } as never)).text).toContain('npm test')
  expect(calls).toBe(1)
  expect((await $.command.run({ command: 'shelf', args: 'run 1' } as never)).text).toContain('not completed')
  expect(calls).toBe(2)
})

import { test, expect } from 'claude-code/testing'
const START = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
test('registers command, records real tool results once and restores scoped persistence', async ($, on) => {
  let id = 's'; let calls = 0
  const data = new Map<string, unknown>()
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: id }))
  on('store.get', (_$, e) => ({ value: data.get(e.key) }))
  on('store.set', (_$, e) => { data.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', () => ({ value: { command: 'verify' } }))
  on('tool.call', () => { calls++; return { result: { exitCode: 0 } } as never })
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 't1' } as never)
  expect(calls).toBe(1)
  expect((await $.command.run({ command: 'verify', args: '' } as never)).text).toContain('PASS')
  await $.session.start(START)
  expect((await $.command.run({ command: 'verify', args: '' } as never)).text).toContain('npm test')
  id = 'other'
  expect((await $.command.run({ command: 'verify', args: '' } as never)).text).not.toContain('npm test')
})
test('storage failure is visible but cannot rerun or fail the underlying tool', async ($, on) => {
  let calls = 0
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', () => ({ value: undefined })); on('store.set', () => ({ deny: 'disk full' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => { calls++; return { text: 'ok', result: { exitCode: 0 } } as never })
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 't' } as never)).text).toBe('ok')
  expect(calls).toBe(1)
  expect((await $.command.run({ command: 'verify', args: 'reset' } as never)).text).toContain('not saved')
})

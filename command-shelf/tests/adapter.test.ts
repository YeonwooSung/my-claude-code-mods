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

test('irrelevant and unsuccessful calls never access the shelf store or emit storage warnings', async ($, on) => {
  let reads = 0, calls = 0
  const warnings: string[] = []
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', () => { reads++; throw new Error('read unavailable') })
  on('ui.toast', (_$, e) => { warnings.push(e.text); return { value: undefined } })
  on('tool.call', (_$, e) => { calls++; return e.tool === 'Bash' ? { result: { exitCode: 1 } } as never : { result: {} } as never })
  await $.tool.call({ tool: 'Read', file_path: '/repo/a' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' } as never)
  expect(calls).toBe(3); expect(reads).toBe(0); expect(warnings).toEqual([])
})

test('persistent write failures warn once, expose a safe reason on list and rearm after recovery', async ($, on) => {
  const saved = new Map<string, unknown>(), warnings: string[] = []
  let failed = true, calls = 0
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', (_$, e) => ({ value: saved.get(e.key) }))
  on('store.set', (_$, e) => { if (failed) return { deny: 'store exceeds 4194304 bytes FAKE_PRIVATE_STATE' }; saved.set(e.key, e.value); return { value: undefined } })
  on('ui.toast', (_$, e) => { warnings.push(e.text); return { value: undefined } })
  on('tool.call', () => { calls++; return { result: { stdout: '', stderr: '', interrupted: false } } as never })
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Bash', command: `echo ${i}` } as never)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('quota')
  expect(warnings[0]).not.toContain('FAKE_PRIVATE_STATE')
  const report = await $.command.run({ command: 'shelf', args: 'list' } as never)
  expect(report.text).toContain('quota'); expect(report.text).not.toContain('FAKE_PRIVATE_STATE')
  failed = false
  await $.tool.call({ tool: 'Bash', command: 'echo recovered' } as never)
  failed = true
  await $.tool.call({ tool: 'Bash', command: 'echo failed-again' } as never)
  expect(warnings).toHaveLength(2); expect(calls).toBe(6)
})

test('near-limit history continues recording instead of repeatedly failing after entry 8242', async ($, on) => {
  const state = { nextId: 8243, commands: Array.from({ length: 180 }, (_, i) => ({ id: 8063 + i, command: `echo ${i} ` + 'x'.repeat(1500), cwd: '/repo', label: '' })) }
  while (JSON.stringify(state).length > 256 * 1024 - 1500) state.commands.shift()
  let saved: typeof state = structuredClone(state)
  const warnings: string[] = []
  on('session.cwd', () => ({ value: '/repo' })); on('session.id', () => ({ value: 's' }))
  on('store.get', () => ({ value: saved }))
  on('store.set', (_$, e) => { saved = e.value as typeof state; return { value: undefined } })
  on('ui.toast', (_$, e) => { warnings.push(e.text); return { value: undefined } })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } } as never))
  await $.tool.call({ tool: 'Bash', command: 'echo ' + 'y'.repeat(3990) } as never)
  expect(warnings).toEqual([])
  expect(saved.commands.at(-1)?.id).toBe(8243)
  expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThanOrEqual(240 * 1024)
})

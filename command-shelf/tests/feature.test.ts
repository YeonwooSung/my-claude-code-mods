import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
const io = { cwd: '/repo', read: async () => '', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
const event = (command: string, result: unknown = { result: { exitCode: 0 } }) => ({ tool: 'Bash', input: { command }, result })
test('only successful foreground commands are retained and duplicates keep stable ids', async () => {
  const f = new Feature()
  for (const result of [{ deny: 'no' }, { result: { exitCode: 1 } }, { text: 'ok' }, { result: { exitCode: 0, task_id: 'bg' } }]) await f.observe(event('bad', result), io)
  await f.observe(event('npm test -- auth'), io); await f.observe(event('npm test -- auth'), io)
  expect(f.data.commands).toHaveLength(1)
  expect(await f.command('', io)).toContain('#1')
})
test('masked or control-bearing commands are never retained for replay', async () => {
  const f = new Feature()
  await f.observe(event('API_TOKEN=private curl example.com'), io)
  await f.observe(event('echo \u001b[31munsafe'), io)
  expect(f.data.commands).toHaveLength(0)
  expect(JSON.stringify(f.data)).not.toContain('private')
})
test('listing and preview never execute; explicit run uses the captured cwd and respects permission denial', async () => {
  const f = new Feature(); const replayed: string[] = []
  const port = { ...io, replay: async (command: string) => { replayed.push(command); return { deny: 'permission required' } } }
  await f.observe(event('npm test'), io)
  await f.command('pin 1 auth tests', port)
  expect(await f.command('show 1', port)).toContain('auth tests')
  expect(replayed).toHaveLength(0)
  expect(await f.command('run 1', port)).toContain('not completed')
  expect(replayed).toEqual(["cd -- '/repo' && npm test"])
  expect(await f.command('run 1', { ...port, cwd: '/other' })).toContain('different project')
  expect(replayed).toHaveLength(1)
})

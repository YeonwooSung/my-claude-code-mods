import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
const io = { cwd: '/repo', read: async () => '', run: async () => ({ exitCode: 0, stdout: ' M src/auth.ts\0', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
test('handoff preview combines goal, changed paths, remaining tasks and completed tasks after reload', async () => {
  const f = new Feature()
  await f.command('goal Fix login retry', io)
  await f.command('todo Add regression test', io)
  await f.command('todo Check timeout', io)
  await f.command('done 1', io)
  const text = await new Feature(f.data).command('', io)
  for (const part of ['Fix login retry', 'src/auth.ts', '[x] #1 Add regression test', '[ ] #2 Check timeout']) expect(text).toContain(part)
})
test('observed failures and verification include evidence freshness and mask secrets', async () => {
  const f = new Feature()
  await f.observe({ tool: 'Bash', input: { command: 'npm test' }, result: { result: { exitCode: 1 }, text: 'API_TOKEN=private' }, before: 'a', after: 'a' }, io)
  expect(await f.command('', io)).toContain('FAIL npm test')
  expect(JSON.stringify(f.data)).not.toContain('private')
  await f.observe({ tool: 'Bash', input: { command: 'npm test' }, result: { result: { exitCode: 0 } }, before: 'a', after: 'a' }, io)
  expect(await f.command('', { ...io, revision: async () => 'b' })).toContain('STALE npm test')
})
test('denied operations do not become failed attempts; empty sessions and invalid todos are explicit', async () => {
  const f = new Feature()
  await f.observe({ tool: 'Bash', input: { command: 'private-command' }, result: { deny: 'no' } }, io)
  expect(await f.command('', io)).not.toContain('private-command')
  expect(await f.command('done 123', io)).toContain('not found')
  expect(await f.command('export', io)).toContain('Usage')
  expect(await f.command('', io)).toContain('(not set)')
})

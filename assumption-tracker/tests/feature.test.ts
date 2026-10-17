import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
const io = { cwd: '/repo', read: async () => '', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
test('assumptions start unverified and require evidence to confirm or refute', async () => {
  const f = new Feature()
  await f.command('add API timestamps are UTC | src/api.ts', io)
  expect(await f.command('', io)).toContain('UNVERIFIED')
  expect(await f.command('confirm 1', io)).toContain('evidence required')
  expect(await f.command('', io)).toContain('UNVERIFIED')
  await f.command('confirm 1 | API contract section 4', io)
  expect(await new Feature(f.data).command('', io)).toContain('CONFIRMED')
  expect(await f.command('', io)).toContain('API contract section 4')
})
test('new evidence can refute a confirmed assumption while history survives reopening', async () => {
  const f = new Feature()
  await f.command('add UTC', io)
  await f.command('confirm 1 | docs', io)
  await f.command('refute 1 | failing integration test', io)
  expect(await f.command('', io)).toContain('REFUTED')
  await f.command('reopen 1', io)
  expect(await f.command('', io)).toContain('UNVERIFIED')
  expect(await f.command('show 1', io)).toContain('failing integration test')
  expect(await f.command('invent 1', io)).toContain('Usage')
  expect(await f.command('confirm 99 | proof', io)).toContain('not found')
})
test('empty claims are rejected, ids remain stable and evidence is masked before storage', async () => {
  const f = new Feature()
  expect(await f.command('add ', io)).toContain('Usage')
  await f.command('add First', io); await f.command('add Second', io)
  await f.command('confirm 2 | API_TOKEN=private', io)
  expect(await new Feature(f.data).command('', io)).toContain('#2')
  expect(JSON.stringify(f.data)).not.toContain('private')
})

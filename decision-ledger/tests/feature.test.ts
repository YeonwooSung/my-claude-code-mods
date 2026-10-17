import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
import { safeData } from '../hooks/core/runtime.ts'
const io = { cwd: '/repo', read: async () => '', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
test('explicit decisions retain reference, rationale and rejected alternative on reload', async () => {
  const f = new Feature()
  await f.command('add src/cache.ts#lookup | LRU | Bound memory | Unbounded Map', io)
  const report = await new Feature(f.data).command('', io)
  for (const part of ['#1', 'src/cache.ts#lookup', 'LRU', 'Bound memory', 'Unbounded Map']) expect(report).toContain(part)
})
test('missing rationale is rejected and deleting a decision never reuses identifiers', async () => {
  const f = new Feature()
  expect(await f.command('add src/a.ts | choice | ', io)).toContain('Usage')
  await f.command('add src/a.ts | first | reason', io)
  await f.command('remove 1', io)
  await f.command('add src/b.ts | second | reason', io)
  expect(await f.command('', io)).toContain('#2')
  expect(await f.command('remove 999', io)).toContain('not found')
})
test('secret-bearing text and terminal control sequences are masked before persistence', async () => {
  const f = new Feature()
  await f.command('add src/a.ts | API_TOKEN=private | \u001b[31mreason', io)
  const stored = JSON.stringify(f.data)
  expect(stored).not.toContain('private')
  expect(stored).not.toContain('\\u001b')
})
test('JSON state masking preserves structure around quoted secret-bearing values', async () => {
  const state = safeData({ decisions: [{ choice: 'API_TOKEN="private value"', rationale: 'keep this reason' }] })
  expect(JSON.parse(JSON.stringify(state))).toEqual({ decisions: [{ choice: 'API_TOKEN=[REDACTED]', rationale: 'keep this reason' }] })
})

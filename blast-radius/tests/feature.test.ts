import { test, expect } from 'claude-code/testing'
import { Feature, analyze } from '../hooks/core/feature.ts'
const io = { cwd: '/repo', read: async () => '', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
test('reverse dependency traversal includes indirect consumers and tests without looping', () => {
  const files = { 'src/a.ts': "import './b'", 'src/b.ts': "export { x } from './a.js'", 'src/ui.ts': "import { x } from './a'", 'tests/ui.test.ts': "import '../src/ui'" }
  const r = analyze(files, ['src/b.ts'])
  expect(r.affected).toEqual(['src/a.ts', 'src/ui.ts', 'tests/ui.test.ts'])
  expect(r.tests).toEqual(['tests/ui.test.ts'])
})
test('deleted targets, index imports and unresolved aliases remain explicit', () => {
  const r = analyze({ 'a.ts': "import './lib'; import './gone'; import '@/unknown'", 'lib/index.ts': '' }, ['gone.ts', 'lib/index.ts'])
  expect(r.affected).toEqual(['a.ts'])
  expect(r.unresolved).toEqual(['a.ts: @/unknown'])
})
test('watch targets persist and reports explicitly bound the supported analysis', async () => {
  const f = new Feature()
  expect(await f.command('watch ../escape', io)).toContain('Invalid')
  await f.command('watch src/shared.ts', io)
  const report = await new Feature(f.data).command('', io)
  expect(report).toContain('src/shared.ts')
  expect(report).toContain('relative JS/TS')
})
test('static require, dynamic literal imports and re-exports deduplicate affected consumers', () => {
  const result = analyze({ 'shared.ts': '', 'a.ts': "const x = require('./shared'); import('./shared')", 'b.ts': "export * from './a'", 'unrelated.ts': '' }, ['shared.ts'])
  expect(result.affected).toEqual(['a.ts', 'b.ts'])
  expect(result.unresolved).toEqual([])
})
test('unreadable source files preserve known edges and disclose incomplete scanning', async () => {
  const port = { ...io, run: async () => ({ exitCode: 0, stdout: 'shared.ts\0consumer.ts\0unreadable.ts\0', stderr: '' }), read: async (path: string) => { if (path.endsWith('/unreadable.ts')) throw new Error('EACCES'); return path.endsWith('/consumer.ts') ? "import './shared'" : '' } }
  const report = await new Feature().command('shared.ts', port)
  expect(report).toContain('AFFECTED consumer.ts')
  expect(report).toContain('INCOMPLETE')
})
test('oversized source scan stops and explicitly discloses the byte bound', async () => {
  const port = { ...io, run: async () => ({ exitCode: 0, stdout: 'huge.ts\0', stderr: '' }), read: async () => 'x'.repeat(2 * 1024 * 1024 + 1) }
  expect(await new Feature().command('huge.ts', port)).toContain('INCOMPLETE')
})

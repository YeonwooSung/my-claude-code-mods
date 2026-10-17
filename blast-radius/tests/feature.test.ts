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

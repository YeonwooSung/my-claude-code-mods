import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
function fixture() {
  let body = 'first', staged = 'staged diff'
  return { setBody: (s: string) => { body = s }, setStaged: (s: string) => { staged = s }, io: { cwd: '/repo', read: async () => body, run: async (args: readonly string[]) => ({ exitCode: 0, stdout: args.includes('status') ? ' M src/auth.ts\0?? test new.ts\0' : args.includes('--cached') ? staged : 'working diff', stderr: '' }), env: async () => undefined, revision: async () => 'a' } }
}
test('grouping and review status persist, then file edits invalidate only that review', async () => {
  const x = fixture(), f = new Feature()
  await f.command('group Authentication | src/auth.ts', x.io)
  await f.command('mark src/auth.ts', x.io)
  const reloaded = new Feature(f.data)
  expect(await reloaded.command('', x.io)).toContain('REVIEWED src/auth.ts')
  expect(await reloaded.command('', x.io)).toContain('Authentication')
  x.setBody('second')
  expect(await reloaded.command('', x.io)).toContain('STALE src/auth.ts')
  expect(await reloaded.command('', x.io)).toContain('PENDING test new.ts')
})
test('staged edits invalidate a reviewed file even when its working body does not change', async () => {
  const x = fixture(), f = new Feature()
  await f.command('mark src/auth.ts', x.io)
  x.setStaged('different staged diff')
  expect(await f.command('', x.io)).toContain('STALE src/auth.ts')
})
test('invalid paths, unchanged files and incomplete evidence cannot become reviewed', async () => {
  const x = fixture(), f = new Feature()
  expect(await f.command('group Auth | ../outside', x.io)).toContain('Invalid')
  expect(await f.command('mark missing.ts', x.io)).toContain('not changed')
  const broken = { ...x.io, run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: true }) }
  expect(await f.command('mark src/auth.ts', broken)).toContain('INCOMPLETE')
})

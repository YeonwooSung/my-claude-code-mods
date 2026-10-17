import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
import { safeText, relativePath, changedPaths, revision } from '../hooks/core/runtime.ts'

const io = (rev = 'a') => ({ cwd: '/repo', read: async () => '', run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), env: async () => undefined, revision: async () => rev })
const observation = (before: string | undefined, after: string | undefined, result: unknown = { result: { exitCode: 0 } }) => ({ tool: 'Bash', input: { command: 'npm test' }, result, before, after })
test('passing check becomes stale after later changes and revalidation restores it', async () => {
  const f = new Feature()
  await f.observe(observation('a', 'a'), io())
  expect(await f.command('', io())).toContain('PASS')
  expect(await f.command('', io('b'))).toContain('STALE')
  await f.observe(observation('b', 'b'), io('b'))
  expect(await f.command('', io('b'))).toContain('PASS')
})
test('edits during a test and unknown snapshots never produce a current pass', async () => {
  const f = new Feature()
  await f.observe(observation('a', 'b'), io('b'))
  expect(await f.command('', io('b'))).toContain('STALE')
  await f.observe(observation(undefined, undefined), io())
  expect(await f.command('', io())).toContain('UNKNOWN')
})
test('denied, background, missing-exit and failed checks do not pass; ordinary commands are ignored', async () => {
  for (const result of [{ deny: 'no' }, { result: { exitCode: 0, task_id: 'bg' } }, { text: 'looks good' }]) {
    const f = new Feature(); await f.observe(observation('a', 'a', result), io())
    expect(await f.command('', io())).not.toContain('PASS')
  }
  const f = new Feature()
  await f.observe(observation('a', 'a', { result: { exitCode: 1 } }), io())
  expect(await f.command('', io())).toContain('FAIL')
  await f.observe({ ...observation('a', 'a'), input: { command: 'echo npm test' } }, io())
  expect(f.data.checks).toHaveLength(1)
})
test('safe text masks secrets and strips controls; relative paths enforce directory boundaries', () => {
  expect(safeText('API_TOKEN=topsecret\u001b[31m')).not.toContain('topsecret')
  expect(relativePath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
  expect(relativePath('/repo', '/repo-other/a')).toBeUndefined()
  expect(relativePath('/repo', 'src/../../private')).toBeUndefined()
})
test('Git status preserves paths with spaces and both sides of renames', () => {
  expect(changedPaths(' M src/a b.ts\0R  new.ts\0old.ts\0?? new.txt\0')).toEqual(['src/a b.ts', 'new.ts', 'old.ts', 'new.txt'])
})
test('repository revisions include untracked content and refuse incomplete process output', async () => {
  let content = 'first'
  const port = { ...io(), read: async () => content, run: async (argv: readonly string[]) => ({ exitCode: 0, stdout: argv.includes('--others') ? 'new.ts\0' : 'diff', stderr: '' }) }
  const a = await revision(port); content = 'second'
  expect(await revision(port)).not.toBe(a)
  expect(await revision({ ...port, run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: true }) })).toBeUndefined()
})

import { test, expect } from 'claude-code/testing'
import { Feature } from '../hooks/core/feature.ts'
import { safeText, relativePath, changedPaths, revision, reportText } from '../hooks/core/runtime.ts'

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
  const port = { ...io(), read: async () => content, run: async (argv: readonly string[]) => ({ exitCode: 0, stdout: argv.includes('--show-toplevel') ? '/repo' : argv.includes('--others') ? 'new.ts\0' : 'diff', stderr: '' }) }
  const a = await revision(port); content = 'second'
  expect(await revision(port)).not.toBe(a)
  expect(await revision({ ...port, run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: true }) })).toBeUndefined()
})
test('actual Bash envelopes without exitCode report foreground success and explicit tool failure', async () => {
  const f = new Feature()
  await f.observe(observation('a', 'a', { text: '', result: { stdout: '', stderr: '', interrupted: false } }), io())
  expect(await f.command('', io())).toContain('PASS')
  await f.observe(observation('a', 'a', { isError: true, text: 'failed', result: { stdout: '', stderr: 'error', interrupted: false } }), io())
  expect(await f.command('', io())).toContain('FAIL')
})
test('failure summaries and engine-specific timeout/background/truncation flags cannot pass', async () => {
  const f = new Feature()
  await f.observe(observation('a', 'a', { result: { exitCode: 0, stdout: '# tests 2\n# fail 1', stderr: '', interrupted: false } }), io())
  expect(await f.command('', io())).toContain('FAIL')
  for (const extra of [{ timedOutAfterMs: 1000 }, { backgroundedByUser: true }, { backgroundedByTurnAbort: true }, { isStdoutTruncated: true }]) {
    await f.observe(observation('a', 'a', { result: { stdout: 'ok', stderr: '', interrupted: false, ...extra } }), io())
    expect(await f.command('', io())).toContain('UNKNOWN')
  }
})
test('bounded reports explicitly disclose truncation instead of silently hiding evidence', async () => {
  const report = reportText('x'.repeat(40_000))
  expect(report.length).toBeLessThanOrEqual(32 * 1024)
  expect(report).toContain('INCOMPLETE: report truncated')
})
test('oversized single lines are omitted before expensive masking rather than scanned unboundedly', () => {
  expect(safeText('x'.repeat(100_000))).toContain('OMITTED: oversized line')
})

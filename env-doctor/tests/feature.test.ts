import { test, expect } from 'claude-code/testing'
import { Feature, satisfies } from '../hooks/core/feature.ts'
const io = { cwd: '/repo', read: async () => JSON.stringify({ engines: { node: '>=22.19.0' }, packageManager: 'npm@10.8.2' }), run: async (args: readonly string[]) => ({ exitCode: 0, stdout: args[0] === 'node' ? 'v20.0.0\n' : '10.8.2\n', stderr: '' }), env: async () => 'private-value', revision: async () => 'a' }
test('conservative semver comparison handles exact, caret, tilde, comparators and unknown syntax', () => {
  for (const [version, range, result] of [
    ['22.19.0', '>=22.19.0', 'match'], ['20.0.0', '>=22.19.0', 'mismatch'], ['22.20.1', '^22.19.0', 'match'], ['23.0.0', '^22.19.0', 'mismatch'], ['0.3.0', '^0.2.1', 'mismatch'], ['22.20.0', '~22.19.0', 'mismatch'], ['22.19.1', '>=22 <23', 'match'], ['22.0.0', '22.x', 'match'], ['22.0.0-beta', '>=22', 'unknown'], ['22.0.0', 'banana', 'unknown'],
  ]) expect(satisfies(version!, range!)).toBe(result)
})
test('doctor compares installed versions and reports environment presence without exposing values', async () => {
  const f = new Feature()
  await f.command('require DATABASE_URL', io)
  const report = await new Feature(f.data).command('', io)
  expect(report).toContain('MISMATCH >=22.19.0')
  expect(report).toContain('MATCH 10.8.2')
  expect(report).toContain('DATABASE_URL: SET')
  expect(report).not.toContain('private-value')
  expect(JSON.stringify(f.data)).not.toContain('private-value')
})
test('unavailable binaries, malformed manifests and unsupported ranges report unknown honestly', async () => {
  const f = new Feature()
  expect(await f.command('require INVALID-NAME', io)).toContain('Invalid')
  expect(await f.command('', { ...io, read: async () => '{bad' })).toContain('manifest unavailable')
  const failed = await f.command('', { ...io, run: async () => ({ exitCode: 127, stdout: '', stderr: 'missing' }) })
  expect(failed).toContain('UNKNOWN')
  await f.command('require API_TOKEN', io)
  expect(await f.command('', { ...io, env: async () => undefined })).toContain('API_TOKEN: MISSING')
})
test('unsupported partial greater-than and less-or-equal comparators never give wrong semver verdicts', () => {
  for (const range of ['>20', '<=20', '>20.5', '<=20.5']) expect(satisfies('20.5.1', range)).toBe('unknown')
})
test('zero-major caret and tilde boundaries use patch and minor upper limits', () => {
  for (const [version, range, expected] of [['0.0.2', '^0.0.2', 'match'], ['0.0.3', '^0.0.2', 'mismatch'], ['0.2.9', '^0.2.1', 'match'], ['0.3.0', '^0.2.1', 'mismatch'], ['1.4.9', '~1.4.2', 'match'], ['1.5.0', '~1.4.2', 'mismatch'], ['23.1.0', '>=22 <23 || >=24', 'mismatch'], ['24.0.0', '>=22 <23 || >=24', 'match']]) expect(satisfies(version!, range!)).toBe(expected)
})
test('truncated version results and failed environment lookups remain unknown', async () => {
  const f = new Feature()
  await f.command('require DATABASE_URL', io)
  const port = { ...io, run: async () => ({ exitCode: 0, stdout: 'v22.19.0', stderr: '', isStdoutTruncated: true }), env: async () => { throw new Error('cannot inspect') } }
  const report = await f.command('', port)
  expect(report).toContain('UNKNOWN >=22.19.0')
  expect(report).toContain('DATABASE_URL: UNKNOWN')
})
test('JSON primitives are not accepted as a valid package manifest', async () => {
  for (const raw of ['null', '[]', '42']) expect(await new Feature().command('', { ...io, read: async () => raw })).toContain('manifest unavailable')
})

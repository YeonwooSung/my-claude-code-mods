import { test, expect } from 'claude-code/testing'
import { outcome, relativePath, revision, safeText } from '../hooks/core/runtime.ts'

test('root-directory path normalization still enforces a usable project-relative identity', () => {
  expect(relativePath('/', '/tmp/a.ts')).toBe('tmp/a.ts')
  expect(relativePath('/repo', '/repo-other/a.ts')).toBeUndefined()
  expect(relativePath('/repo', 'nested/../../outside')).toBeUndefined()
})
test('quoted multiline credentials are masked as a whole rather than leaked as line fragments', () => {
  for (const input of ['API_TOKEN="FAKE_FIRST\nFAKE_SECOND" command', "curl --token 'FAKE_FIRST\nFAKE_SECOND'", 'Authorization: Bearer FAKE_FIRST\nnormal output']) {
    const result = safeText(input)
    expect(result).not.toContain('FAKE_FIRST')
    if (input.includes('FAKE_SECOND')) expect(result).not.toContain('FAKE_SECOND')
  }
})
test('oversized credential lines cannot expose a multiline secret tail after omission', () => {
  const result = safeText('API_TOKEN="' + 'x'.repeat(9000) + '\nFAKE_SECRET_TAIL"')
  expect(result).not.toContain('FAKE_SECRET_TAIL')
  expect(result).toContain('OMITTED')
})
test('foreground error and unknown results remain distinct across tool envelopes', () => {
  expect(outcome({ isError: true, result: { stdout: '', stderr: '', interrupted: false } })).toBe('fail')
  expect(outcome({ deny: 'not allowed', result: { exitCode: 0 } })).toBe('unknown')
  expect(outcome({ result: { stdout: 'ok', stderr: '', interrupted: true } })).toBe('unknown')
  expect(outcome({ result: { exit_code: 2 } })).toBe('fail')
})
test('truncated stderr and unreadable untracked content never produce complete revisions', async () => {
  const base = { cwd: '/repo', env: async () => undefined, revision: async () => undefined, read: async () => { throw new Error('EACCES') }, run: async (argv: readonly string[]) => ({ exitCode: 0, stdout: argv.includes('--show-toplevel') ? '/repo\n' : argv.includes('--others') ? 'unreadable\0' : '', stderr: '' }) }
  expect(await revision(base)).toBeUndefined()
  expect(await revision({ ...base, run: async () => ({ exitCode: 0, stdout: '', stderr: '', isStderrTruncated: true }) })).toBeUndefined()
})
test('oversized quoted credential forms cannot leak their continuation after line omission', () => {
  for (const prefix of ["curl --user 'name:", "curl -u 'name:", "curl 'https://name:", "mysql -u name -p'"]) {
    const result = safeText(prefix + 'x'.repeat(9000) + "\nPRIVATE_TAIL'")
    expect(result).not.toContain('PRIVATE_TAIL')
    expect(result).toContain('OMITTED')
  }
})

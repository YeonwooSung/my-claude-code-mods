import { expect, test } from 'claude-code/testing'
import { compareOutputs } from '../hooks/core/compare.ts'
import { callInput, isMutating, relPath, resultText, summarizeInput, summarizeResult, targetOf } from '../hooks/core/tools.ts'

test('result heads and rerun comparisons mask long quoted secrets before clipping', () => {
  const raw = '--password "FAKE_LONG_SECRET' + 'x'.repeat(3000) + '" --verbose'
  const result = summarizeResult({ text: raw })
  expect(result.head).toBe('--password [REDACTED] --verbose')
  expect(result.chars).toBe(raw.length)
  const compared = compareOutputs(undefined, raw)
  expect(compared.added).toEqual(['--password [REDACTED] --verbose'])
})

test('token flags and serialized credentials make stored inputs lossy', () => {
  for (const input of [
    { command: 'gh api --token FAKE_TOKEN' },
    { file_path: '/r/.env', content: 'DATABASE_URL=postgres://alice:FAKE_PASSWORD@db/app' },
    { content: '{"token":"FAKE_JSON"}' },
    { headers: { 'x-api-key': 'FAKE_HEADER' } },
  ]) {
    const stored = summarizeInput(input)
    expect(stored.lossy).toBe(true)
    expect(JSON.stringify(stored.input)).not.toContain('FAKE_')
  }
})


test('secret keys mask entire values in nested objects and arrays without masking ordinary fields', () => {
  const raw = { api_key: 'demo', nested: [{ password: 'pw', Authorization: { bearer: 'secret' }, accessToken: 123, refresh_token: null, 'private-key': ['x'] }], token_count: 12, keyboard: 'keep' }
  const result = summarizeInput(raw)
  expect(result.input).toEqual({ api_key: '[REDACTED]', nested: [{ password: '[REDACTED]', Authorization: '[REDACTED]', accessToken: '[REDACTED]', refresh_token: '[REDACTED]', 'private-key': '[REDACTED]' }], token_count: 12, keyboard: 'keep' })
  expect(result.lossy).toBe(true)
  expect(raw.api_key).toBe('demo')
  expect(callInput(raw).api_key).toBe('demo')
})

test('mutating tools: edits, every Bash by default, unknown and MCP tools', () => {
  expect(isMutating('Edit', {})).toBe(true)
  expect(isMutating('Write', {})).toBe(true)
  expect(isMutating('Read', {})).toBe(false)
  expect(isMutating('Grep', {})).toBe(false)
  expect(isMutating('Bash', { command: 'rg foo' })).toBe(true)
  expect(isMutating('Bash', { command: 'rg foo' }, true)).toBe(false)
  expect(isMutating('Bash', { command: 'npm test' }, true)).toBe(true)
  expect(isMutating('mcp__db__write', {})).toBe(true)
})

test('targets are root-relative paths, redacted commands, patterns', () => {
  expect(relPath('/r', '/r/src/a.py')).toBe('src/a.py')
  expect(relPath('/r/', '/other/a.py')).toBe('/other/a.py')
  expect(targetOf('Edit', { file_path: '/r/auth.py' }, '/r')).toBe('auth.py')
  expect(targetOf('NotebookEdit', { notebook_path: '/r/n.ipynb' }, '/r')).toBe('n.ipynb')
  expect(targetOf('Grep', { pattern: 'JWT' }, '/r')).toBe('JWT')
  const bash = targetOf('Bash', { command: 'curl -H "Authorization: Bearer abc123" https://x' }, '/r')!
  expect(bash).not.toContain('abc123')
  expect(targetOf('TodoWrite', {}, '/r')).toBeUndefined()
})

test('summarizeInput drops engine keys, cuts long strings, flags lossy input', () => {
  const plain = summarizeInput({ tool: 'Edit', tool_use_id: 't', agentId: 'a', file_path: '/r/a.py', old_string: 'x', new_string: 'y' })
  expect(plain).toEqual({ input: { file_path: '/r/a.py', old_string: 'x', new_string: 'y' }, lossy: false })
  const long = summarizeInput({ content: 'z'.repeat(5_000) })
  expect(String(long.input.content).startsWith('z'.repeat(4_096) + '…(+904 chars, #')).toBe(true)
  expect(long.lossy).toBe(true)
  expect(summarizeInput({ command: 'export API_KEY=sekret' }).lossy).toBe(true)
  expect(callInput({ tool: 'Bash', tool_use_id: 't', command: 'ls' })).toEqual({ command: 'ls' })
})

test('results: text, deny, error, redacted head', () => {
  expect(resultText({ text: 'hi' })).toBe('hi')
  expect(resultText({ deny: 'no' })).toBe('no')
  expect(summarizeResult({ deny: 'no' })).toEqual({ isError: true, denied: true, chars: 2, hash: expect.any(String), head: 'no' })
  const r = summarizeResult({ isError: true, text: `TOKEN=abc ${'x'.repeat(3_000)}` })
  expect(r.isError).toBe(true)
  expect(r.head.length).toBeLessThanOrEqual(2_048 + 20)
  expect(r.head).not.toContain('abc')
  expect(r.chars).toBe(3_010)
})

test('summarizeInput flags depth-truncated input as lossy', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
  const r = summarizeInput(deep)
  expect(r.lossy).toBe(true)
  expect(JSON.stringify(r.input)).toContain('{…}')
})

test('free-text targets are one line, bounded and redacted', () => {
  const grep = targetOf('Grep', { pattern: `a\nb${'x'.repeat(500)}` }, '/r')!
  expect(grep).not.toContain('\n')
  expect(grep.length).toBeLessThanOrEqual(120)
  const url = targetOf('WebFetch', { url: 'https://x/?api_key=sekret123' }, '/r')!
  expect(url).not.toContain('sekret123')
  expect(url).toContain('[REDACTED]')
})

test('summarizeInput and callInput drop the engine key consent', () => {
  expect(summarizeInput({ tool: 'Bash', command: 'ls', consent: { granted: true } }).input).toEqual({ command: 'ls' })
  expect(callInput({ tool: 'Bash', command: 'ls', consent: 'x' })).toEqual({ command: 'ls' })
})

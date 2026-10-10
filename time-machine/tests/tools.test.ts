import { expect, test } from 'claude-code/testing'

import { callInput, isMutating, relPath, resultText, summarizeInput, summarizeResult, targetOf } from '../hooks/core/tools.ts'

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

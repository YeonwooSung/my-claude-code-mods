import { expect, test } from 'claude-code/testing'
import { classifyResult, display, hash } from '../hooks/core/fingerprint.ts'

test('success printing error text is not a failure', () => {
  expect(classifyResult({ result: { stdout: 'Error: expected 2', stderr: '', exitCode: 0 } }).kind).toBe('success')
  expect(classifyResult({ result: { stdout: '0 failed, 12 passed', stderr: '' } }).kind).toBe('success')
})

test('explicit errors and nonzero structured exit codes are failures', () => {
  for (const answer of [
    { isError: true, text: 'expected 2' },
    { result: { stdout: '', stderr: 'expected 2', exitCode: 1 } },
    { result: { stdout: 'expected 2', exit_code: 1 } },
  ]) expect(classifyResult(answer).kind).toBe('failure')
})

test('test failure summaries override a zero shell exit code', () => {
  for (const text of [
    '# pass 4\n# fail 1', 'Tests: 1 failed, 4 passed, 5 total',
    ' Tests  1 failed | 4 passed (5)', '=== 1 failed, 4 passed in 0.31s ===',
    'test result: FAILED. 4 passed; 1 failed;', '--- FAIL: TestFoo (0.01s)\nFAIL package 0.01s',
  ]) expect(classifyResult({ result: { stdout: text, stderr: '', exitCode: 0 } }).kind).toBe('failure')
})

test('only narrow timing noise and ANSI formatting are normalized', () => {
  const a = classifyResult({ isError: true, text: '\u001b[31mError: expected 2\u001b[0m\r\n=== 1 failed in 0.31s ===\n  duration_ms: 12.2\n# fail 1\nTests: 1 failed\n✕ case (14 ms)' })
  const b = classifyResult({ isError: true, text: 'Error: expected 2\n=== 1 failed in 9.23s ===\n  duration_ms: 50\n# fail 1\nTests: 1 failed\n✕ case (17 ms)' })
  expect(a.signature).toBe(b.signature)
  expect(classifyResult({ isError: true, text: 'expected 2' }).signature).not.toBe(classifyResult({ isError: true, text: 'expected 3' }).signature)
  expect(classifyResult({ isError: true, text: '# fail 2' }).signature).not.toBe(classifyResult({ isError: true, text: '# fail 1' }).signature)
  expect(hash('a\nb')).not.toBe(hash('a b'))
})

test('millisecond assertions and arbitrary timing fields preserve semantic values', () => {
  for (const [a, b] of [
    ['AssertionError: expected (2 ms), received (1 ms)', 'AssertionError: expected (3 ms), received (1 ms)'],
    ['Error: wrong timeout\nTime: 2 s', 'Error: wrong timeout\nTime: 3 s'],
    ['Error: wrong duration\n  duration_ms: 2', 'Error: wrong duration\n  duration_ms: 3'],
    ['Tests: 1 failed\nAssertionError: expected (2 ms)', 'Tests: 1 failed\nAssertionError: expected (3 ms)'],
  ]) expect(classifyResult({ isError: true, text: a }).signature).not.toBe(classifyResult({ isError: true, text: b }).signature)
})

test('denial, cancellation, unknown, background and huge results are not evidence', () => {
  for (const answer of [
    { deny: 'no' }, {}, null, { isError: true, text: '' },
    { result: { stdout: 'Error', interrupted: true }, isError: true },
    { result: { stdout: 'Error', timed_out: true }, isError: true },
    { result: { stdout: 'Error', backgroundTaskId: 'job' }, isError: true },
    { result: { stdout: 'Error', task_id: 'job' }, isError: true },
    { result: { stdout: 'Error', truncated: true }, isError: true },
    { result: { stdout: 'Error', exitCode: NaN } },
    { isError: true, text: 'x'.repeat(65_537) },
  ]) expect(classifyResult(answer).kind).toBe('unknown')
})

test('real framework summary runtimes do not split otherwise identical failures', () => {
  const cases = [
    ['not ok 1 - auth\n  duration_ms: 1.23\n# fail 1\n# duration_ms 15.6', 'not ok 1 - auth\n  duration_ms: 8.45\n# fail 1\n# duration_ms 95.1'],
    ['Tests: 1 failed, 2 passed\nTime: 0.31 s, estimated 1 s', 'Tests: 1 failed, 2 passed\nTime: 9.3 s, estimated 10 s'],
    [' Tests  1 failed | 2 passed (3)\n Duration  1.23s (transform 12ms, setup 0ms, tests 16ms)', ' Tests  1 failed | 2 passed (3)\n Duration  8.9s (transform 90ms, setup 0ms, tests 67ms)'],
    ['test result: FAILED. 0 passed; 1 failed; 0 ignored; finished in 0.01s', 'test result: FAILED. 0 passed; 1 failed; 0 ignored; finished in 0.98s'],
  ]
  for (const [a, b] of cases) expect(classifyResult({ isError: true, text: a }).signature).toBe(classifyResult({ isError: true, text: b }).signature)
})

test('redaction happens before truncation and display strips terminal controls', () => {
  const text = 'API_KEY=secret123 TOKEN="secret spaced" --password=secret456 Authorization: Bearer secret789\npassword: secret000'
  const out = display(text, 1000)
  for (const secret of ['secret123', 'secret spaced', 'secret456', 'secret789', 'secret000']) expect(out).not.toContain(secret)
  expect(display('TOKEN=longsecretvalue', 12)).not.toContain('longsecret')
  expect(display('\u001b]0;evil\u0007\u001b[2Jhello\r\nworld\u0000')).toBe('hello world')
  expect(display('x'.repeat(1000), 20).length).toBeLessThanOrEqual(20)
  const result = classifyResult({ isError: true, text: 'Error: TOKEN=secret123' })
  expect(result.excerpt).not.toContain('secret123')
})

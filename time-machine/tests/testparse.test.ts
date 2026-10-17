import { expect, test } from 'claude-code/testing'
import { Recorder } from '../hooks/core/timeline.ts'
import { ChunkWriter } from '../hooks/core/store.ts'

import { parseTestOutput, sameFile, testIdentity } from '../hooks/core/testparse.ts'

test('test identity folds horizontal whitespace outside quotes but preserves suite, quoted spaces and shell newlines', () => {
  expect(testIdentity('  pytest   integration/  ', '/r')).toEqual(testIdentity('pytest integration/', '/r'))
  expect(testIdentity('pytest "a  b"', '/r')).not.toEqual(testIdentity('pytest "a b"', '/r'))
  expect(testIdentity('pytest "$(printf "suite  name")"', '/r')).not.toEqual(testIdentity('pytest "$(printf "suite name")"', '/r'))
  expect(testIdentity('pytest\nunit/', '/r')).not.toEqual(testIdentity('pytest unit/', '/r'))
  expect(testIdentity('pytest integration/', '/r')).not.toEqual(testIdentity('pytest unit/', '/r'))
  const run = parseTestOutput('1 passed in 0.1s', false, { command: 'pytest', cwd: '/r' })
  expect(run.identity).toEqual(testIdentity('pytest', '/r'))
})

const PYTEST = `============================= test session starts ==============================
collected 15 items

tests/test_auth.py F..F                                                  [ 26%]
tests/test_mw.py F                                                       [ 33%]

=================================== FAILURES ===================================
__________________________________ test_login __________________________________

    def test_login():
>       assert login("a", "b")
E       AssertionError

tests/test_auth.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_auth.py::test_login - AssertionError
FAILED tests/test_auth.py::test_logout - KeyError: 'jwt'
FAILED tests/test_mw.py::test_mw
========================= 3 failed, 12 passed in 0.42s =========================`

test('pytest: counts, failures with file and line, locations, paths', () => {
  const t = parseTestOutput(PYTEST, true)
  expect(t.framework).toBe('pytest')
  expect([t.failed, t.passed, t.ok]).toEqual([3, 12, false])
  expect(t.failures[0]).toEqual({ name: 'tests/test_auth.py::test_login', file: 'tests/test_auth.py', line: 12 })
  expect(t.failures.map(f => f.name)).toEqual(['tests/test_auth.py::test_login', 'tests/test_auth.py::test_logout', 'tests/test_mw.py::test_mw'])
  expect(t.locations).toContainEqual({ file: 'tests/test_auth.py', line: 12 })
  expect(t.paths).toContain('tests/test_mw.py')
  const ok = parseTestOutput('12 passed in 0.10s', false)
  expect([ok.framework, ok.passed, ok.ok]).toEqual(['pytest', 12, true])
})

test('jest and vitest', () => {
  const jest = parseTestOutput(
    `FAIL src/auth.test.ts\n  ● auth › logs in\n\n    expect(received).toBe(expected)\n\n      at Object.<anonymous> (src/auth.test.ts:14:20)\n\nTests:       1 failed, 4 passed, 5 total`,
    true,
  )
  expect([jest.framework, jest.failed, jest.passed]).toEqual(['jest', 1, 4])
  expect(jest.failures).toEqual([{ name: 'auth › logs in' }])
  expect(jest.locations).toContainEqual({ file: 'src/auth.test.ts', line: 14 })
  const vitest = parseTestOutput(
    ` FAIL  src/a.test.ts > math > adds\nAssertionError: expected 2 to be 3\n ❯ src/a.test.ts:5:17\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)`,
    true,
  )
  expect([vitest.framework, vitest.failed, vitest.passed]).toEqual(['vitest', 1, 2])
  expect(vitest.failures).toEqual([{ name: 'src/a.test.ts > math > adds', file: 'src/a.test.ts', line: 5 }])
})

test('cargo, go and node:test', () => {
  const cargo = parseTestOutput(
    `running 2 tests\ntest tests::adds ... FAILED\n\nfailures:\n\n---- tests::adds stdout ----\nthread 'tests::adds' panicked at src/lib.rs:10:9:\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`,
    true,
  )
  expect([cargo.framework, cargo.failed, cargo.passed, cargo.failures[0]?.name]).toEqual(['cargo', 1, 1, 'tests::adds'])
  expect(cargo.locations).toContainEqual({ file: 'src/lib.rs', line: 10 })
  const go = parseTestOutput(`--- FAIL: TestAdd (0.00s)\n    math_test.go:9: got 2, want 3\n--- PASS: TestSub (0.00s)\nFAIL\nFAIL\texample.com/m\t0.002s`, true)
  expect([go.framework, go.failed, go.passed, go.failures[0]?.name]).toEqual(['go', 1, 1, 'TestAdd'])
  expect(go.locations).toContainEqual({ file: 'math_test.go', line: 9 })
  const node = parseTestOutput(
    `not ok 1 - adds\n  ---\n  location: '/tmp/x/a.test.js:1:65'\n  ...\nok 2 - ok\n1..2\n# tests 2\n# pass 1\n# fail 1`,
    true,
  )
  expect([node.framework, node.failed, node.passed, node.failures[0]?.name]).toEqual(['node:test', 1, 1, 'adds'])
  expect(node.locations).toContainEqual({ file: '/tmp/x/a.test.js', line: 1 })
})

test('unknown output falls back to the error flag; vendor paths are ignored', () => {
  expect(parseTestOutput('boom', true)).toEqual({ framework: 'unknown', ok: false, failures: [], locations: [], paths: [] })
  expect(parseTestOutput('all good', false).ok).toBe(true)
  const t = parseTestOutput('at f (node_modules/x/index.js:3:1)\nat g (src/app.js:7:2)', true)
  expect(t.locations).toEqual([{ file: 'src/app.js', line: 7 }])
  expect(t.paths).toEqual(['src/app.js'])
})

test('sameFile matches relative, absolute and ./ spellings by path suffix', () => {
  expect(sameFile('tests/a.py', '/repo/tests/a.py')).toBe(true)
  expect(sameFile('./src/a.ts', 'src/a.ts')).toBe(true)
  expect(sameFile('a.py', 'data.py')).toBe(false)
})

test('long inputs stay fast and still find locations in the middle', () => {
  const time = (text: string) => {
    const t0 = performance.now()
    const run = parseTestOutput(text, true)
    return { ms: performance.now() - t0, run }
  }
  expect(time('a'.repeat(1_000_000)).ms).toBeLessThan(500)
  const mid = time('x'.repeat(100_000) + ' src/app.js:7 ' + 'y'.repeat(300_000))
  expect(mid.ms).toBeLessThan(500)
  expect(mid.run.locations).toContainEqual({ file: 'src/app.js', line: 7 })
})
test('failure credentials are masked before timeline serialization without changing counts or identity', () => {
  const run = parseTestOutput('not ok 1 - API_KEY=FAKE_TEST_NAME\n# pass 0\n# fail 1', true, { command: 'node --test', cwd: '/repo' })
  expect(run.failures).toEqual([{ name: 'API_KEY=[REDACTED]' }])
  expect(run.failed).toBe(1)
  expect(run.identity).toEqual(testIdentity('node --test', '/repo'))
  const r = new Recorder({ sessionId: 'audit', root: '/repo', startedAt: 0, loadId: 'test' })
  r.finish(r.begin({ id: 'test', tool: 'Bash', at: 0 }), 1, { test: run })
  const writer = new ChunkWriter('audit')
  const bodies = r.drain().map(record => writer.add(record).body).join('')
  expect(bodies).not.toContain('FAKE_TEST_NAME')
  expect(bodies).toContain('[REDACTED]')
})

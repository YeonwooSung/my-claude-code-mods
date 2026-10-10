import { expect, test } from 'claude-code/testing'

import { why } from '../hooks/core/causality.ts'
import { compare, compareOutputs } from '../hooks/core/compare.ts'
import { circled, renderCompare, renderRerun, renderRestorePlan, renderSessions, renderStep, renderTimeline, renderWhy, statusLine, testSummary } from '../hooks/core/render.ts'
import { Recorder } from '../hooks/core/timeline.ts'
import type { SnapshotRef, TestRun } from '../hooks/core/types.ts'

const session = { sessionId: '8201ea2b-079a', root: '/r', startedAt: 1, loadId: 'L' }
const snap = (commit: string, ...paths: string[]): SnapshotRef => ({ commit, changed: true, files: paths.map(path => ({ status: 'M', path })), filesTotal: paths.length, ms: 41 })
const failed: TestRun = { framework: 'pytest', ok: false, failed: 3, passed: 12, failures: [{ name: 'tests/test_auth.py::test_login', file: 'tests/test_auth.py', line: 12 }], locations: [{ file: 'auth.py', line: 12 }], paths: ['auth.py'] }
const passed: TestRun = { framework: 'pytest', ok: true, passed: 12, failures: [], locations: [], paths: [] }

function example(): Recorder {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c000000000', changed: true, files: [], filesTotal: 9, ms: 30 })
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}${r.size}`, tool, target, input: { file_path: `/r/${target}` }, at: 10 }), 52, extra)
  }
  add('Read', 'auth.py')
  add('Grep', 'JWT')
  add('Edit', 'auth.py', { snapshot: snap('3a4f1c2aaaa', 'auth.py') })
  add('Bash', 'pytest', { test: failed })
  add('Edit', 'middleware.py', { snapshot: snap('9bd0e11bbbb', 'middleware.py') })
  add('Bash', 'pytest', { test: passed })
  return r
}

test('circled numbers and test summaries', () => {
  expect([circled(0), circled(1), circled(20), circled(21)]).toEqual(['⓪', '①', '⑳', '(21)'])
  expect(testSummary(failed)).toBe('✗ 3 failed, 12 passed')
  expect(testSummary({ framework: 'unknown', ok: true, failures: [], locations: [], paths: [] })).toBe('✓ passed')
})

test('the timeline draws the session as a tree with snapshots and test results under their steps', () => {
  const text = renderTimeline(example(), { snapMs: [41, 41] })
  const lines = text.split('\n')
  expect(lines[0]).toBe('Session 8201ea2b · branch main · 6 step(s) · 2 snapshot(s), avg 41ms')
  expect(text).toContain('├── ① Read auth.py')
  expect(text).toContain('├── ③ Edit auth.py\n│       └── snapshot 3a4f1c2 · M auth.py')
  expect(text).toContain('├── ④ Bash pytest\n│       └── ✗ 3 failed, 12 passed')
  expect(lines.at(-2)).toBe('└── ⑥ Bash pytest')
  expect(lines.at(-1)).toBe('        └── ✓ 12 passed')
})

test('branches are marked where they start; snapshots-off and empty sessions say so', () => {
  const r = example()
  r.fork('b1', 4, 60)
  r.finish(r.begin({ id: 'z', tool: 'Edit', target: 'auth.py', at: 61 }), 62, { snapshot: snap('aaaaaaa1', 'auth.py') })
  expect(renderTimeline(r)).toContain('│  ⑂ branch b1 (from ④)\n└── ⑦ Edit auth.py')
  const off = renderTimeline(new Recorder(session), { off: 'git unavailable' })
  expect(off).toContain('snapshots off: git unavailable')
  expect(off).toContain('No tool calls recorded yet.')
})

test('step detail shows input, result head, snapshot files and failures', () => {
  const r = example()
  const text = renderStep(r.get(4)!)
  expect(text.split('\n')[0]).toBe('④ Bash pytest')
  expect(text).toContain('input:\n  file_path: /r/pytest')
  expect(text).toContain('test (pytest): ✗ 3 failed, 12 passed')
  expect(text).toContain('  ✗ tests/test_auth.py::test_login (tests/test_auth.py:12)')
  expect(renderStep(r.get(3)!)).toContain('snapshot: 3a4f1c2aaaa · 41ms\n  M auth.py')
})

test('why, compare, rerun, restore plan, sessions and the status line', () => {
  const r = example()
  const w = renderWhy(why(r.path())!, n => (r.get(n) ? `${circled(n)} ${r.get(n)!.tool} ${r.get(n)!.target}` : undefined))
  expect(w).toContain('Why did ④ Bash pytest fail? ✗ 3 failed, 12 passed (pytest)')
  expect(w).toContain('1. auth.py')
  expect(w).toContain('Fixed by: ⑤ Edit middleware.py → ⑥ Bash pytest ✓ 12 passed')
  expect(w).toContain('inferred')
  r.fork('b1', 3, 60)
  r.finish(r.begin({ id: 'z', tool: 'Edit', target: 'utils.py', at: 61 }), 62, { snapshot: snap('aaaaaaa1', 'utils.py') })
  const c = renderCompare('main', 'b1', compare(r.path('main'), r.path('b1')), ' auth.py | 2 +-')
  expect(c).toContain('Shared start: 3 step(s)')
  expect(c).toContain('Diverged at: main ④ Bash pytest · b1 ⑦ Edit utils.py')
  expect(c).toContain(' auth.py | 2 +-')
  const was = r.get(4)!
  const rerun = renderRerun(was, compareOutputs(was.result, 'x', was.test, passed), 'here, against the current files')
  expect(rerun).toContain('Rerun of ④ Bash pytest (here, against the current files)')
  expect(rerun).toContain('Test: ✗ 3 failed, 12 passed → ✓ 12 passed')
  const plan = renderRestorePlan(r.get(3)!, r.get(3)!, [{ status: 'M', path: 'auth.py' }, { status: 'D', path: 'new.txt' }], false)
  expect(plan).toContain('2 file(s) would change')
  expect(plan).toContain('  D new.txt')
  expect(plan).toContain('/tm restore 3 --yes')
  expect(renderRestorePlan(r.get(3)!, r.get(3)!, [], true, 'b2')).toContain("branch 'b2'")
  expect(renderSessions([{ id: 'abc', startedAt: 0, current: true }])).toContain('abc (this session)')
  expect(statusLine(r, [40, 42])).toBe('tm ⑦ · 3 snaps · 41ms')
  expect(statusLine(r, [], 'git unavailable')).toBe('tm ⑦ · snapshots off')
})

test('labels, failure names and fixed-by are bounded and honest', () => {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 0, ms: 1 })
  r.finish(r.begin({ id: 'a', tool: 'Grep', target: 'x'.repeat(300), at: 2 }), 3)
  expect(renderStep(r.get(1)!).split('\n')[0]!.length).toBeLessThanOrEqual(90)
  const long = 'n'.repeat(10000)
  const t: TestRun = { framework: 'pytest', ok: false, failed: 1, failures: [{ name: long }], locations: [], paths: [] }
  r.finish(r.begin({ id: 'b', tool: 'Bash', target: 'pytest', at: 4 }), 5, { test: t })
  expect(renderStep(r.get(2)!).length).toBeLessThan(900)
  r.finish(r.begin({ id: 'c', tool: 'Bash', target: 'pytest', at: 6 }), 7, { test: passed })
  const w = renderWhy(why(r.path())!)
  expect(w.length).toBeLessThan(900)
  expect(w).toContain('Passed later at ③ Bash pytest ✓ 12 passed with no file changes in between')
  expect(w).not.toContain('Fixed by:  →')
})

test('without labels, fixed-by lists the files once', () => {
  const r = example()
  expect(renderWhy(why(r.path())!)).toContain('Fixed by: ⑤ (middleware.py) → ⑥ Bash pytest ✓ 12 passed')
})

test('restore plan says when the model note could not be added', () => {
  const s = example().get(3)!
  expect(renderRestorePlan(s, s, [], true, undefined, true)).toContain('The model was told the files changed.')
  expect(renderRestorePlan(s, s, [], true, undefined, false)).toContain('could not be added; tell it the files changed')
})

test('a branch restore shows how the work tree changed, though its snapshot lists no files', () => {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 1, ms: 9 })
  r.finish(r.begin({ id: 'e', tool: 'Edit', target: 'a.js', at: 2 }), 3, { snapshot: snap('c1', 'a.js') })
  r.restoreStep({ at: 4, to: 0, from: 'c1', commit: 'cR00000', files: [{ status: 'D', path: 'a.js' }], branch: 'b1' })
  expect(renderTimeline(r)).toContain('└── snapshot cR00000 · work tree: D a.js')
})

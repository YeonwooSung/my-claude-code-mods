import { expect, test } from 'claude-code/testing'

import { changesBetween, why } from '../hooks/core/causality.ts'
import { compare, compareOutputs, keyOf, lcsPairs } from '../hooks/core/compare.ts'
import { contentHash } from '../hooks/core/hash.ts'
import { Recorder } from '../hooks/core/timeline.ts'
import { testIdentity } from '../hooks/core/testparse.ts'
import type { SnapshotRef, TestRun } from '../hooks/core/types.ts'

const session = { sessionId: 's1', root: '/r', startedAt: 1, loadId: 'L' }
const snap = (commit: string, ...paths: string[]): SnapshotRef => ({ commit, changed: true, files: paths.map(path => ({ status: 'M', path })), filesTotal: paths.length, ms: 5 })
const failing = (failed: number, paths: string[], locations: { file: string; line: number }[] = []): TestRun => ({ framework: 'pytest', identity: testIdentity('pytest', '/r'), ok: false, failed, passed: 12, failures: [{ name: 'tests/test_auth.py::test_login', file: 'tests/test_auth.py' }], locations, paths })
const passing: TestRun = { framework: 'pytest', identity: testIdentity('pytest', '/r'), ok: true, passed: 15, failures: [], locations: [], paths: [] }

test('why does not connect unrelated test commands as baseline, fix or improvement', () => {
  const r = new Recorder(session)
  r.baseline(1)
  const add = (command: string, result: TestRun): void => {
    r.finish(r.begin({ id: `t${r.size}`, tool: 'Bash', input: { command }, at: 2 }), 3, { test: { ...result, identity: testIdentity(command, '/r') } })
  }
  add('pytest tests/test_unrelated.py', passing)
  add('pytest integration/', failing(3, []))
  add('pytest tests/test_unrelated.py', passing)
  add('pytest unit/', failing(1, []))
  const w = why(r.path(), 2)!
  expect(w.base!.n).toBe(0)
  expect(w.fixedBy).toBeUndefined()
  expect(w.improved).toBeUndefined()
})

test('why compares only the same framework, cwd and agent, and leaves legacy runs unlinked', () => {
  const r = new Recorder(session)
  r.baseline(1)
  const add = (test: TestRun, agentId?: string): void => {
    r.finish(r.begin({ id: `t${r.size}`, tool: 'Bash', at: 2, agentId }), 3, { test })
  }
  add(failing(3, []))
  add({ ...passing, identity: testIdentity('pytest', '/other') })
  add({ ...passing, framework: 'jest' })
  add(passing, 'a1')
  add({ ...passing, identity: undefined })
  expect(why(r.path(), 1)!.fixedBy).toBeUndefined()
  add(passing)
  expect(why(r.path(), 1)!.fixedBy!.run.n).toBe(6)
})

// The spec's example: ① Read ② Grep ③ Edit auth.py ④ pytest ✗ ⑤ Edit middleware.py ⑥ pytest ✓
function session184(): Recorder {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 9, ms: 9 })
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}-${target}`, tool, target, at: 2 }), 3, extra)
  }
  add('Read', 'auth.py')
  add('Grep', 'JWT')
  add('Edit', 'auth.py', { snapshot: snap('c3', 'auth.py') })
  add('Edit', 'utils.py', { snapshot: snap('c4', 'utils.py') })
  add('Bash', 'pytest', { test: failing(3, ['tests/test_auth.py', 'auth.py'], [{ file: 'auth.py', line: 12 }]) })
  add('Edit', 'middleware.py', { snapshot: snap('c6', 'middleware.py') })
  add('Bash', 'pytest', { test: passing })
  return r
}

test('changesBetween collects files changed after one index up to another, with their steps', () => {
  const path = session184().path()
  expect([...changesBetween(path, 0, 5).entries()]).toEqual([
    ['auth.py', [3]],
    ['utils.py', [4]],
  ])
})

test('why: suspects ranked by mention in the failure output, then recency; fixed-by names the edit in between', () => {
  const w = why(session184().path())!
  expect(w.run.n).toBe(5)
  expect(w.base!.n).toBe(0)
  expect(w.suspects.map(s => s.path)).toEqual(['auth.py', 'utils.py'])
  expect(w.suspects[0]!.reasons).toContain('named in the failure output')
  expect(w.suspects[0]!.reasons).toContain('a failure location points into it')
  expect(w.suspects[0]!.steps).toEqual([3])
  expect(w.suspects[0]!.score).toBeGreaterThan(w.suspects[1]!.score)
  expect(w.fixedBy).toEqual({ run: expect.objectContaining({ n: 7 }), files: ['middleware.py'], steps: [6] })
})

test('why: the base is the last passing run before; improved when failures drop; undefined without runs', () => {
  const r = new Recorder(session)
  r.baseline(1)
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}-${target}-${r.size}`, tool, target, at: 2 }), 3, extra)
  }
  add('Edit', 'a.py', { snapshot: snap('c1', 'a.py') })
  add('Bash', 'pytest', { test: passing })
  add('Edit', 'b.py', { snapshot: snap('c3', 'b.py') })
  add('Bash', 'pytest', { test: failing(3, []) })
  add('Edit', 'b.py', { snapshot: snap('c5', 'b.py') })
  add('Bash', 'pytest', { test: failing(1, []) })
  const w = why(r.path(), 4)!
  expect(w.base!.n).toBe(2)
  expect(w.suspects.map(s => s.path)).toEqual(['b.py'])
  expect(w.improved).toEqual({ run: expect.objectContaining({ n: 6 }), from: 3, to: 1 })
  expect(w.fixedBy).toBeUndefined()
  expect(why(new Recorder(session).path())).toBeUndefined()
})

test('lcsPairs and compare: shared prefix, divergence, steps only on each side, last tests', () => {
  expect(lcsPairs(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e'])).toEqual([
    [0, 0],
    [2, 1],
    [3, 2],
  ])
  const r = session184()
  r.fork('b1', 3, 9)
  r.finish(r.begin({ id: 'x', tool: 'Edit', target: 'middleware.py', at: 10 }), 11, { snapshot: snap('c9', 'middleware.py') })
  r.finish(r.begin({ id: 'y', tool: 'Bash', target: 'pytest', at: 12 }), 13, { test: passing })
  const c = compare(r.path('main'), r.path('b1'))
  expect(c.common).toBe(3)
  expect(keyOf(c.divergeA!)).toBe('Edit utils.py')
  expect(keyOf(c.divergeB!)).toBe('Edit middleware.py')
  expect(c.onlyA.map(keyOf)).toEqual(['Edit utils.py', 'Bash pytest'])
  expect(c.onlyB.map(keyOf)).toEqual([])
  expect(c.lastTestA!.n).toBe(7)
  expect(c.lastTestB!.test!.ok).toBe(true)
})

test('compareOutputs: identical by hash, else line differences on the first 2 KiB', () => {
  const was = { isError: false, denied: false, chars: 7, hash: contentHash('a\nb\nc'), head: 'a\nb\nc' }
  expect(compareOutputs(was, 'a\nb\nc').identical).toBe(true)
  const c = compareOutputs(was, 'a\nB\nc\nd', undefined, passing)
  expect([c.identical, c.addedCount, c.removedCount]).toEqual([false, 2, 1])
  expect(c.added).toEqual(['B', 'd'])
  expect(c.removed).toEqual(['b'])
  expect(c.now).toBe(passing)
})

test('why on a branch does not blame a file changed only on the branch it left', () => {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 2, ms: 9 })
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}-${target}`, tool, target, at: 2 }), 3, extra)
  }
  add('Edit', 'app.js', { snapshot: snap('c1', 'app.js') })
  add('Bash', 'node --test', { test: passing })
  add('Edit', 'main-only.js', { snapshot: snap('c3', 'main-only.js') })
  add('Bash', 'node --test', { test: failing(1, []) })
  const restored = r.restoreStep({ at: 5, to: 2, from: 'c3', commit: 'cR', files: [{ status: 'D', path: 'main-only.js' }], branch: 'fixb' })
  expect([restored.n, restored.parent, restored.branch]).toEqual([5, 2, 'fixb'])
  expect(restored.snapshot).toEqual({ commit: 'cR', changed: true, files: [], filesTotal: 0, ms: 0 })
  expect(restored.input).toEqual({ to: 2, from: 'c3', workTree: [{ status: 'D', path: 'main-only.js' }] })
  add('Edit', 'other.js', { snapshot: snap('c6', 'other.js') })
  add('Bash', 'node --test', { test: failing(1, []) })
  const w = why(r.path())!
  expect(w.run.n).toBe(7)
  expect(w.suspects.map(s => s.path)).toEqual(['other.js'])
})

test('a restore on the same branch keeps the files it changed, which are on the path', () => {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 2, ms: 9 })
  r.finish(r.begin({ id: 'e', tool: 'Edit', target: 'a.js', at: 2 }), 3, { snapshot: snap('c1', 'a.js') })
  const restored = r.restoreStep({ at: 4, to: 0, from: 'c1', commit: 'cR', files: [{ status: 'D', path: 'a.js' }] })
  expect([restored.parent, restored.branch]).toEqual([1, 'main'])
  expect(restored.snapshot).toEqual({ commit: 'cR', changed: true, files: [{ status: 'D', path: 'a.js' }], filesTotal: 1, ms: 0 })
  expect(restored.input).toEqual({ to: 0, from: 'c1' })
})

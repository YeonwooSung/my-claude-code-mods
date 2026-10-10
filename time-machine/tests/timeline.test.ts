import { expect, test } from 'claude-code/testing'

import { Recorder } from '../hooks/core/timeline.ts'
import type { SnapshotRef } from '../hooks/core/types.ts'

const session = { sessionId: 's1', root: '/r', startedAt: 1, loadId: 'L' }
const snap = (commit: string, path = 'a.py'): SnapshotRef => ({ commit, changed: true, files: [{ status: 'M', path }], filesTotal: 1, ms: 5 })

function sample(): Recorder {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 3, ms: 9 })
  r.startTurn(2, 'fix auth')
  for (const [tool, target, s] of [
    ['Read', 'auth.py', undefined],
    ['Grep', 'JWT', undefined],
    ['Edit', 'auth.py', snap('c3', 'auth.py')],
    ['Bash', 'pytest', undefined],
  ] as const) {
    const step = r.begin({ id: `t-${tool}`, tool, target, at: 3 })
    r.finish(step, 4, s ? { snapshot: s } : {})
  }
  return r
}

test('steps are numbered from 1 after the baseline, each parented to the one before', () => {
  const r = sample()
  expect(r.all().map(s => [s.n, s.parent, s.tool])).toEqual([
    [0, 0, 'baseline'],
    [1, 0, 'Read'],
    [2, 1, 'Grep'],
    [3, 2, 'Edit'],
    [4, 3, 'Bash'],
  ])
  expect(r.get(3)!.turn).toBe(1)
  expect(r.path().map(s => s.n)).toEqual([0, 1, 2, 3, 4])
})

test('drain hands each record out once, steps only when finished', () => {
  const r = new Recorder(session)
  expect(r.drain().map(x => x.type)).toEqual(['session'])
  const step = r.begin({ id: 'x', tool: 'Read', at: 1 })
  expect(r.drain()).toEqual([])
  r.finish(step, 2, { result: { isError: false, denied: false, chars: 1, hash: 'h', head: 'x' } })
  const out = r.drain()
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({ type: 'step', n: 1, endedAt: 2 })
  expect(r.drain()).toEqual([])
})

test('snapshotAt walks back along the ancestry to the nearest snapshot', () => {
  const r = sample()
  expect(r.snapshotAt(4)!.n).toBe(3)
  expect(r.snapshotAt(2)!.n).toBe(0)
  expect(r.lastSnapshot()!.snapshot!.commit).toBe('c3')
  expect(r.snapshotAt(99)).toBeUndefined()
})

test('a fork grows from a step; each branch path keeps its own history', () => {
  const r = sample()
  expect(r.nextBranchName()).toBe('b1')
  r.fork('b1', 2, 5)
  const s = r.begin({ id: 'x', tool: 'Edit', target: 'mw.py', at: 6 })
  r.finish(s, 7, { snapshot: snap('c5', 'mw.py') })
  expect([s.n, s.parent, s.branch]).toEqual([5, 2, 'b1'])
  expect(r.path('b1').map(x => x.n)).toEqual([0, 1, 2, 5])
  expect(r.path('main').map(x => x.n)).toEqual([0, 1, 2, 3, 4])
  expect(r.head('main')).toBe(4)
  expect(() => r.fork('b1', 1, 8)).toThrow()
  expect(() => r.fork('b9', 42, 8)).toThrow()
  expect(r.nextBranchName()).toBe('b2')
})

test('turns count up; the prompt head is kept only when asked', () => {
  const r = new Recorder(session)
  expect(r.startTurn(1, 'hello').prompt).toEqual({ chars: 5, hash: expect.any(String) })
  expect(r.startTurn(2, 'x'.repeat(300), true).prompt.head).toBe('x'.repeat(200))
  expect(r.turn).toBe(2)
})

test('fromRecords rebuilds steps, branches, the current branch, turns and numbering', () => {
  const r = sample()
  r.fork('b1', 2, 5)
  r.finish(r.begin({ id: 'y', tool: 'Write', target: 'n.py', at: 6 }), 7, { snapshot: snap('c5', 'n.py') })
  r.addModel({ turn: 1, index: 0, model: 'm', stopReason: 'end_turn', usage: null, text: { chars: 1, hash: 'h' }, toolUses: [] })
  const back = Recorder.fromRecords(r.drain())!
  expect(back.all().map(s => [s.n, s.branch])).toEqual(r.all().map(s => [s.n, s.branch]))
  expect(back.branch).toBe('b1')
  expect(back.turn).toBe(1)
  expect(back.models.length).toBe(1)
  expect(back.drain()).toEqual([])
  expect(back.begin({ id: 'z', tool: 'Read', at: 9 }).n).toBe(6)
  expect(Recorder.fromRecords([])).toBeUndefined()
})

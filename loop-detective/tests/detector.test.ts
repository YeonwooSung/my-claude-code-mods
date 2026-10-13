import { expect, test } from 'claude-code/testing'
import { Detector } from '../hooks/core/detector.ts'

const fail = { isError: true, text: 'Error: expected 2, got 1' }
const ok = { result: { stdout: 'passed', stderr: '', exitCode: 0 } }
function run(d: Detector, answer: unknown = fail, agent?: string, cwd = '/repo', command = 'npm test') {
  return d.finish(d.begin('Bash', { command }, agent, cwd), answer)
}
function edit(d: Detector, path = '/repo/a.ts', agent?: string, answer: unknown = { result: { success: true } }) {
  d.finish(d.begin('Edit', { file_path: path }, agent), answer)
}

test('opens once at threshold and updates the same case', () => {
  const d = new Detector()
  expect(run(d)).toEqual([])
  expect(run(d)).toEqual([])
  expect(run(d)[0]!.count).toBe(3)
  expect(run(d)).toEqual([])
  expect(d.snapshot().active[0]!.count).toBe(4)
  expect(d.snapshot().active[0]!.firstSeq).toBe(1)
  expect(d.snapshot().active[0]!.lastSeq).toBe(4)
})

test('edit-retry needs two edited transitions and lists observed paths', () => {
  const d = new Detector()
  run(d); edit(d); run(d); edit(d, '/repo/b.ts'); run(d)
  const c = d.snapshot().active[0]!
  expect(c.kind).toBe('edit-retry')
  expect(c.editRetries).toBe(2)
  expect(c.files).toEqual(['/repo/a.ts', '/repo/b.ts'])
})

test('failed, denied and read-only edits are not credited', () => {
  const d = new Detector()
  run(d); edit(d, '/a', undefined, { isError: true, text: 'no' }); run(d)
  edit(d, '/b', undefined, { deny: 'no' }); edit(d, '/c', undefined, { result: {}, isReadOnly: true }); run(d)
  expect(d.snapshot().active[0]!.editRetries).toBe(0)
})

test('successful command resolves and history records recovery', () => {
  const d = new Detector()
  run(d); run(d); run(d); run(d, ok)
  expect(d.snapshot().active).toEqual([])
  expect(d.snapshot().history[0]!.status).toBe('recovered')
  run(d); run(d)
  expect(d.snapshot().active).toEqual([])
})

test('changed assertion or decreasing failure count restarts rather than extending', () => {
  const d = new Detector()
  run(d); run(d); run(d)
  run(d, { isError: true, text: 'Error: expected 3, got 1' })
  expect(d.snapshot().history[0]!.status).toBe('changed')
  expect(d.snapshot().active).toEqual([])
  const e = new Detector()
  run(e, { isError: true, text: '# fail 3' }); run(e, { isError: true, text: '# fail 2' }); run(e, { isError: true, text: '# fail 1' })
  expect(e.snapshot().active).toEqual([])
})

test('unknown result breaks continuity without claiming recovery', () => {
  const d = new Detector()
  run(d); run(d); run(d); run(d, { deny: 'permission' })
  expect(d.snapshot().history[0]!.status).toBe('unknown')
  run(d); run(d)
  expect(d.snapshot().active).toEqual([])
})

test('agent, cwd and exact command are isolated; other command success cannot resolve', () => {
  const d = new Detector()
  run(d); run(d)
  run(d, fail, 'child'); run(d, fail, undefined, '/other'); run(d, fail, undefined, '/repo', 'npm  test')
  expect(d.snapshot().active).toEqual([])
  run(d); run(d, ok, undefined, '/repo', 'echo ok')
  expect(d.snapshot().active.length).toBe(1)
  edit(d, '/child.ts', 'child'); run(d)
  expect(d.snapshot().active[0]!.editRetries).toBe(0)
})

test('missing cwd and unsupported tool failures cannot open cases', () => {
  const d = new Detector()
  for (let i = 0; i < 3; i++) {
    d.finish(d.begin('Bash', { command: 'npm test' }), fail)
    d.finish(d.begin('Read', { file_path: '/a' }, undefined, '/repo'), fail)
  }
  expect(d.snapshot().active).toEqual([])
})

test('parallel completions drain in invocation order and duplicate completions are ignored', () => {
  const d = new Detector()
  const a = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  const b = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  const c = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  d.finish(c, fail); d.finish(b, fail)
  expect(d.snapshot().active).toEqual([])
  expect(d.finish(a, fail)[0]!.count).toBe(3)
  d.finish(a, fail); d.finish(c, fail)
  expect(d.snapshot().active[0]!.count).toBe(3)
})

test('edits completing after invocation start are not credited to that invocation', () => {
  const d = new Detector()
  run(d)
  const e = d.begin('Edit', { file_path: '/a' })
  const test = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  d.finish(e, { result: {} }); d.finish(test, fail); run(d)
  expect(d.snapshot().active[0]!.editRetries).toBe(1)
  expect(d.snapshot().active[0]!.kind).toBe('retry')
})

test('edit epochs are reserved before delayed cwd metadata resolves', () => {
  const d = new Detector()
  run(d)
  const delayed = d.reserve('Bash', { command: 'npm test' })
  edit(d)
  d.locate(delayed, '/repo')
  d.finish(delayed, fail)
  run(d)
  expect(d.snapshot().active[0]!.editRetries).toBe(1)
  expect(d.snapshot().active[0]!.kind).toBe('retry')
})

test('unknown cwd closes a previous case without bridging its streak', () => {
  const d = new Detector()
  run(d); run(d); run(d)
  d.finish(d.begin('Bash', { command: 'npm test' }), fail)
  expect(d.snapshot().active).toEqual([])
  expect(d.snapshot().history[0]!.status).toBe('unknown')
  run(d); run(d)
  expect(d.snapshot().active).toEqual([])
})

test('snapshot copies cannot mutate detector evidence', () => {
  const d = new Detector()
  run(d); edit(d); run(d); edit(d); run(d)
  const snap = d.snapshot()
  snap.active[0]!.count = 900
  snap.active[0]!.files.push('/fake')
  expect(d.snapshot().active[0]!.count).toBe(3)
  expect(d.snapshot().active[0]!.files).not.toContain('/fake')
})

test('idle cases expire after 200 later tool starts', () => {
  const d = new Detector()
  run(d); run(d); run(d)
  for (let i = 0; i < 199; i++) d.finish(d.begin('Read', {}), ok)
  expect(d.snapshot().active.length).toBe(1)
  d.finish(d.begin('Read', {}), ok)
  expect(d.snapshot().active).toEqual([])
  expect(d.snapshot().history[0]!.status).toBe('expired')
})

test('out-of-order failures cannot bridge an earlier successful invocation', () => {
  const d = new Detector()
  const a = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  const b = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  const c = d.begin('Bash', { command: 'npm test' }, undefined, '/repo')
  d.finish(c, fail); d.finish(a, fail); d.finish(b, ok)
  run(d)
  expect(d.snapshot().active).toEqual([])
  run(d)
  expect(d.snapshot().active[0]!.count).toBe(3)
})

test('20,000 calls retain bounded records and no raw command or failure secrets', () => {
  const d = new Detector()
  for (let i = 0; i < 20_000; i++) run(d, { isError: true, text: 'Error: TOKEN=private-value' }, undefined, '/repo', `TOKEN=private-value test ${i % 25}`)
  const snap = d.snapshot()
  expect(snap.groups).toBeLessThanOrEqual(512)
  expect(snap.history.length).toBeLessThanOrEqual(100)
  expect(snap.active.length).toBe(25)
  expect(snap.active[0]!.count).toBe(800)
  expect(JSON.stringify(snap)).not.toContain('private-value')
})

test('bounded groups, scopes and history expire old evidence', () => {
  const d = new Detector()
  for (let i = 0; i < 520; i++) run(d, fail, undefined, '/repo', `test ${i}`)
  expect(d.snapshot().groups).toBeLessThanOrEqual(512)
  for (let i = 0; i < 140; i++) run(d, fail, `agent-${i}`)
  expect(d.snapshot().contexts).toBeLessThanOrEqual(128)
  for (let i = 0; i < 110; i++) { run(d); run(d); run(d); run(d, ok) }
  expect(d.snapshot().history.length).toBe(100)
})

test('pending overflow invalidates older tickets and bounds queue', () => {
  const d = new Detector()
  const tickets = Array.from({ length: 17 }, () => d.begin('Bash', { command: 'npm test' }, undefined, '/repo'))
  expect(d.snapshot().pending).toBe(1)
  for (const t of tickets) d.finish(t, fail)
  expect(d.snapshot().active).toEqual([])
  run(d); run(d)
  expect(d.snapshot().active[0]!.count).toBe(3)
  expect(d.snapshot().pending).toBe(0)
})

test('threshold validates configuration and displayed paths are bounded/redacted', () => {
  const d = new Detector(4)
  run(d); run(d); run(d)
  expect(d.snapshot().active).toEqual([])
  run(d)
  expect(d.snapshot().active[0]!.count).toBe(4)
  const e = new Detector(1.5)
  run(e)
  for (let i = 0; i < 30; i++) edit(e, `/repo/TOKEN=secret${i}`)
  run(e); edit(e); run(e)
  expect(e.snapshot().active[0]!.files.length).toBeLessThanOrEqual(20)
  expect(JSON.stringify(e.snapshot())).not.toContain('secret')
})

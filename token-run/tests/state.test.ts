import { test, expect } from 'claude-code/testing'
import { RequestState, Scores, type ScoreDocument } from '../hooks/core/state.ts'

test('main error invites play, response restores status, opaque markers do not', () => {
  const state = new RequestState()
  state.begin('t1')
  state.complete('t1', 'error')
  expect(state.snapshot().status).toBe('failed')
  state.begin('t2')
  state.observe('t2', 'engine')
  expect(state.snapshot().status).toBe('failed')
  state.observe('t2', 'text')
  expect(state.snapshot()).toMatchObject({ status: 'available', recovered: true })
})

test('subagent, aborted, refused and old-turn events do not corrupt main status', () => {
  const state = new RequestState()
  state.begin('t1')
  state.complete('t1', 'aborted')
  state.complete('t1', 'refusal')
  state.complete('a1', 'error', 'worker')
  expect(state.snapshot().status).toBe('unknown')
  state.begin('t2')
  state.complete('t1', 'error')
  expect(state.snapshot().status).toBe('unknown')
  state.complete('t2', 'error')
  state.observe('t2', 'text', 'worker')
  expect(state.snapshot().status).toBe('failed')
  state.complete('t2', 'answer')
  expect(state.snapshot().recovered).toBe(true)
})

test('generation invalidates in-flight observations on reset even if turn id is reused', () => {
  const state = new RequestState()
  state.begin('same')
  const old = state.snapshot().generation
  state.reset(); state.begin('same')
  state.complete('same', 'error', undefined, old)
  state.observe('same', 'text', undefined, old)
  expect(state.snapshot().status).toBe('unknown')
})

test('scores restore and merge concurrent submissions monotonically', async () => {
  let saved: unknown = { version: 1, best: 40 }
  const scores = new Scores({ get: async () => saved, set: async (_key, value) => { saved = value } })
  await scores.load()
  expect(scores.snapshot().best).toBe(40)
  await Promise.all([scores.save(12), scores.save(80), scores.save(20)])
  expect(scores.snapshot().best).toBe(80)
  expect(saved).toEqual({ version: 1, best: 80 })
  saved = { version: 1, best: 90 }
  await scores.save(81)
  expect(saved).toEqual({ version: 1, best: 90 })
  expect(scores.snapshot().best).toBe(90)
})

test('invalid records and submitted scores are bounded without accepting coercion', async () => {
  for (const stored of [undefined, null, [], {version:2,best:3}, {version:1,best:'9'}, {version:1,best:-1}, {version:1,best:Infinity}, {version:1,best:1.5}]) {
    const scores = new Scores({ get: async () => stored, set: async () => {} })
    await scores.load()
    expect(scores.snapshot().best).toBe(0)
    for (const bad of [NaN, Infinity, -1, 1.5, 1000000]) await expect(scores.save(bad)).rejects.toThrow()
    await scores.save(999999)
    expect(scores.snapshot().best).toBe(999999)
  }
})

test('failed reads never overwrite an unseen best; failures retain playable memory and recover', async () => {
  let readFail = true, writeFail = false
  let saved: ScoreDocument = { version: 1, best: 30 }
  const scores = new Scores({
    get: async () => { if (readFail) throw new Error('disk unavailable'); return saved },
    set: async (_key, value) => { if (writeFail) throw new Error('disk full'); saved = value },
  })
  await scores.load(); await scores.save(10)
  expect(scores.snapshot().error).toBeTruthy()
  expect(saved.best).toBe(30)
  readFail = false; writeFail = true
  await scores.save(50)
  expect(scores.snapshot().best).toBe(50)
  expect(scores.snapshot().error).toBeTruthy()
  expect(saved.best).toBe(30)
  writeFail = false
  await scores.save(20)
  expect(saved.best).toBe(50)
  expect(scores.snapshot().error).toBeUndefined()
})

test('a delayed queued load cannot erase a newer score', async () => {
  let release!: (value: unknown) => void
  let stored: unknown = { version: 1, best: 4 }
  let first = true
  const scores = new Scores({ get: () => { if (first) { first = false; return new Promise(resolve => { release = resolve }) }; return Promise.resolve(stored) }, set: async (_key, value) => { stored = value } })
  const load = scores.load()
  await Promise.resolve()
  const save = scores.save(25)
  release({ version: 1, best: 4 })
  await Promise.all([load, save])
  expect(scores.snapshot().best).toBe(25)
  expect(stored).toEqual({ version: 1, best: 25 })
})

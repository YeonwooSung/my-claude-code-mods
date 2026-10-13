import { test, expect } from 'claude-code/testing'
import { MemoController, storeKey } from '../hooks/core/controller.ts'
import { emptyDocument } from '../hooks/core/memo.ts'

function memory() {
  const data = new Map<string, unknown>()
  return { data, get: async (k: string) => data.get(k), set: async (k: string, v: unknown) => { data.set(k, JSON.parse(JSON.stringify(v))) } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

test('restores identical folder/session after reload and isolates other identities', async () => {
  const storage = memory()
  const a = new MemoController(storage)
  await a.activate('/repo/', 's1')
  await a.run('[ ] saved')
  await a.run('check 1')
  const b = new MemoController(storage)
  await b.activate('/repo', 's1')
  expect(b.snapshot().document?.items).toEqual([{ id: 1, text: 'saved', checked: true }])
  await b.activate('/other', 's1')
  expect(b.snapshot().document?.items).toEqual([])
  await b.activate('/repo', 's2')
  expect(b.snapshot().document?.items).toEqual([])
  await b.activate('/repo', 's1')
  expect(b.snapshot().document?.items.length).toBe(1)
  expect(storeKey('/a:b', 'c')).not.toBe(storeKey('/a', 'b:c'))
})

test('serializes rapid mutations and preserves state when a write fails', async () => {
  const storage = memory()
  let fail = false
  const c = new MemoController({ get: storage.get, set: async (k, v) => { if (fail) throw new Error('disk full'); await storage.set(k, v) } })
  await c.activate('/repo', 's')
  await c.run('[ ] task')
  await Promise.all([c.run('toggle 1'), c.run('toggle 1'), c.run('other')])
  expect(c.snapshot().document?.items).toEqual([{ id: 1, text: 'task', checked: false }, { id: 2, text: 'other', checked: null }])
  fail = true
  await expect(c.run('check 1')).rejects.toThrow('저장')
  expect(c.snapshot().document?.items[0]?.checked).toBe(false)
  fail = false
  await c.run('check 1')
  expect(c.snapshot().document?.items[0]?.checked).toBe(true)
  expect(c.snapshot().error).toBe(undefined)
})

test('read errors and corrupt documents block overwrites until explicit clear', async () => {
  const storage = memory()
  storage.data.set(storeKey('/repo', 's'), { version: 99 })
  const c = new MemoController(storage)
  await c.activate('/repo', 's')
  expect(c.snapshot().error).toBeDefined()
  await expect(c.run('new')).rejects.toThrow()
  expect(storage.data.get(storeKey('/repo', 's'))).toEqual({ version: 99 })
  await c.run('clear')
  expect(c.snapshot().document).toEqual(emptyDocument())
  let broken = true
  const d = new MemoController({ get: async k => { if (broken) throw new Error('unavailable'); return storage.get(k) }, set: storage.set })
  await d.activate('/repo', 's')
  await expect(d.run('new')).rejects.toThrow()
  broken = false
  await d.activate('/repo', 's')
  await d.run('new')
  expect(d.snapshot().document?.items[0]?.text).toBe('new')
})

test('commands wait for initial load and stale loads cannot replace new session', async () => {
  const storage = memory()
  const slow = deferred<unknown>()
  const c = new MemoController({ get: async k => k === storeKey('/repo', 'old') ? slow.promise : storage.get(k), set: storage.set })
  const loading = c.activate('/repo', 'old')
  const queued = c.run('old note')
  await c.activate('/repo', 'new')
  await c.run('new note')
  slow.resolve(emptyDocument())
  await loading
  await expect(queued).rejects.toThrow('세션')
  expect(c.snapshot().document?.items[0]?.text).toBe('new note')
})

test('old UI key and detached identities cannot modify a new session', async () => {
  const c = new MemoController(memory())
  await c.activate('/repo', 'old')
  await c.run('[ ] task')
  const oldKey = c.snapshot().key!
  c.detach()
  expect(c.snapshot().document).toBe(undefined)
  await expect(c.run('new')).rejects.toThrow()
  await c.activate('/repo', 'new')
  await c.run('[ ] new task')
  await expect(c.run('toggle 1', oldKey)).rejects.toThrow('세션')
  expect(c.snapshot().document?.items[0]?.checked).toBe(false)
})

test('delayed old write stays under old key and new activation waits for it', async () => {
  const storage = memory()
  const started = deferred<void>()
  const release = deferred<void>()
  const c = new MemoController({ get: storage.get, set: async (k, v) => { started.resolve(); await release.promise; await storage.set(k, v) } })
  await c.activate('/repo', 'old')
  const writing = c.run('old note')
  await started.promise
  const loading = c.activate('/repo', 'new')
  release.resolve()
  await writing
  await loading
  expect(c.snapshot().document?.items).toEqual([])
  expect(storage.data.get(storeKey('/repo', 'old'))).toEqual({ version: 1, nextId: 2, items: [{ id: 1, text: 'old note', checked: null }] })
})

test('an add arriving during a successful load preserves previously saved notes', async () => {
  const storage = memory()
  const read = deferred<unknown>()
  const c = new MemoController({ get: async () => read.promise, set: storage.set })
  const loading = c.activate('/repo', 's')
  const adding = c.run('second')
  read.resolve({ version: 1, nextId: 2, items: [{ id: 1, text: 'first', checked: null }] })
  await loading
  await adding
  expect(c.snapshot().document?.items).toEqual([{ id: 1, text: 'first', checked: null }, { id: 2, text: 'second', checked: null }])
})

test('distinct POSIX folder names ending in a backslash do not share persistence keys', () => {
  expect(storeKey('/repo\\', 's')).not.toBe(storeKey('/repo', 's'))
  expect(storeKey('/', 's')).toBe('pin-memo:v1:["/","s"]')
})

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
  expect(storeKey('/', 's')).toMatch(/^pin-memo:v2:[0-9a-f]{16}$/)
})

test('long POSIX and escaped Windows identities use bounded keys and survive reload', async () => {
  for (const cwd of ['/workspace/' + 'nested/'.repeat(50), 'C:\\' + 'nested\\'.repeat(40)]) {
    const data = new Map<string, unknown>()
    const check = (key: string) => { if (key.length > 256) throw new Error('store key exceeds 256') }
    const storage = { get: async (key: string) => { check(key); return data.get(key) }, set: async (key: string, value: unknown) => { check(key); data.set(key, value) } }
    const first = new MemoController(storage)
    await first.activate(cwd, 'session')
    expect(first.snapshot().error).toBeUndefined()
    await first.run('long-path note')
    const reloaded = new MemoController(storage); await reloaded.activate(cwd, 'session')
    expect(reloaded.snapshot().document?.items[0]?.text).toBe('long-path note')
    expect(storeKey(cwd, 'session').length).toBeLessThanOrEqual(256)
    expect(storeKey(cwd, 'session')).not.toBe(storeKey(cwd, 'other-session'))
  }
})

test('bounded legacy fallback migrates on mutation and never queries a 257-character key', async () => {
  for (const length of [256, 257]) {
    const legacy = (cwd: string) => `pin-memo:v1:${JSON.stringify([cwd, 's'])}`
    const cwd = '/' + 'x'.repeat(length - legacy('/').length), key = legacy(cwd)
    expect(key.length).toBe(length)
    const data = new Map<string, unknown>(), reads: string[] = []
    if (length === 256) data.set(key, { version: 1, nextId: 2, items: [{ id: 1, text: 'legacy', checked: null }] })
    const c = new MemoController({ get: async k => { reads.push(k); if (k.length > 256) throw new Error('oversized key'); return data.get(k) }, set: async (k, v) => { data.set(k, v) } })
    await c.activate(cwd, 's')
    expect(c.snapshot().error).toBeUndefined()
    expect(c.snapshot().document?.items.length).toBe(length === 256 ? 1 : 0)
    expect(reads.includes(key)).toBe(length === 256)
    await c.run('new note')
    expect(storeKey(cwd, 's')).not.toBe(key)
    expect(data.has(storeKey(cwd, 's'))).toBe(true)
    const restored = new MemoController({ get: async k => data.get(k), set: async () => {} })
    await restored.activate(cwd, 's')
    expect(restored.snapshot().document?.items.map(m => m.text)).toEqual(length === 256 ? ['legacy', 'new note'] : ['new note'])
  }
})

test('a corrupt legacy document stays protected until explicit clear under the new key', async () => {
  const data = new Map<string, unknown>([['pin-memo:v1:["/repo","s"]', { version: 99 }]])
  const c = new MemoController({ get: async k => data.get(k), set: async (k, v) => { data.set(k, v) } })
  await c.activate('/repo', 's')
  expect(c.snapshot().error).toBeDefined()
  await expect(c.run('new note')).rejects.toThrow()
  await c.run('clear')
  expect(c.snapshot().document?.items).toEqual([])
  expect(data.get('pin-memo:v1:["/repo","s"]')).toEqual({ version: 99 })
})

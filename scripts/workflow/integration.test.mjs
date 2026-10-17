import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { revision } from '../../verify-board/hooks/core/runtime.ts'
import { Feature as Verify } from '../../verify-board/hooks/core/feature.ts'
import { Feature as Review } from '../../review-queue/hooks/core/feature.ts'
import { Feature as Deps } from '../../dependency-lens/hooks/core/feature.ts'
import { register as registerShelf } from '../../command-shelf/hooks/register.ts'
import { register as registerDecision } from '../../decision-ledger/hooks/register.ts'
async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-mods-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const run = async argv => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 10_000 })
    if (r.error) throw r.error
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
  }
  const git = async (...args) => { const r = await run(['git', ...args]); assert.equal(r.exitCode, 0, r.stderr); return r.stdout.trim() }
  await git('init', '-q'); await git('config', 'user.name', 'Workflow Test'); await git('config', 'user.email', 'workflow@example.invalid')
  const io = { cwd, read: path => readFile(path, 'utf8'), bytes: async path => (await readFile(path)).toString('base64'), run, env: async () => undefined, revision: () => revision(io) }
  return { cwd, io, git, write: (path, body) => writeFile(join(cwd, path), body) }
}
test('verification becomes stale after switching between distinct clean commits', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'first'); await r.git('add', '.'); await r.git('commit', '-qm', 'first')
  const f = new Verify(), before = await r.io.revision()
  await f.observe({ tool: 'Bash', input: { command: 'npm test' }, result: { result: { stdout: '', stderr: '', interrupted: false } }, before, after: before }, r.io)
  assert.match(await f.command('', r.io), /PASS/)
  await r.write('a.ts', 'second'); await r.git('add', '.'); await r.git('commit', '-qm', 'second')
  assert.match(await f.command('', r.io), /STALE/)
})
test('untracked binary bytes affect revision even when UTF-8 decoding looks identical', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'first'); await r.git('add', '.'); await r.git('commit', '-qm', 'first')
  await r.write('asset.bin', Buffer.from([0xff])); const before = await r.io.revision()
  await r.write('asset.bin', Buffer.from([0xfe])); assert.notEqual(await r.io.revision(), before)
})
test('real staged and unstaged changes invalidate file reviews independently', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'first'); await r.git('add', '.'); await r.git('commit', '-qm', 'first')
  await r.write('a.ts', 'second'); const f = new Review()
  await f.command('mark a.ts', r.io); assert.match(await f.command('', r.io), /REVIEWED a.ts/)
  await r.git('add', 'a.ts'); assert.match(await f.command('', r.io), /STALE a.ts/)
  await f.command('mark a.ts', r.io); await r.write('a.ts', 'third'); assert.match(await f.command('', r.io), /STALE a.ts/)
})
test('real Git dependency baseline compares scoped direct and transitive package changes', async t => {
  const r = await repository(t)
  await r.write('package.json', JSON.stringify({ dependencies: { '@scope/pkg': '1' } }))
  await r.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@scope/pkg': { version: '1' } } }))
  await r.git('add', '.'); await r.git('commit', '-qm', 'first')
  await r.write('package.json', JSON.stringify({ dependencies: { '@scope/pkg': '2' } }))
  await r.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@scope/pkg': { version: '2' }, 'node_modules/child': { version: '1', hasInstallScript: true } } }))
  const text = await new Deps().command('', r.io)
  assert.match(text, /DIRECT dependencies @scope\/pkg: 1 -> 2/); assert.match(text, /INSTALL-SCRIPT node_modules\/child/)
})
test('untracked binary changes invalidate review marks', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  await r.write('asset.bin', Buffer.from([0xff])); const f = new Review()
  await f.command('mark asset.bin', r.io); assert.match(await f.command('', r.io), /REVIEWED asset.bin/)
  await r.write('asset.bin', Buffer.from([0xfe])); assert.match(await f.command('', r.io), /STALE asset.bin/)
})

function deferredAdapter(register) {
  const hooks = new Map(), saved = new Map(); let id = 'A', first = true, release, entered
  const started = new Promise(resolve => { entered = resolve })
  register((name, ...args) => hooks.set(name, args.at(-1)))
  const $ = { session: { cwd: async () => '/repo', id: async () => id }, store: {
    get: async key => { if (first) { first = false; entered(); await new Promise(resolve => { release = resolve }) } return saved.get(key) },
    set: async (key, value) => { saved.set(key, value) },
  }, ui: { toast: () => {} }, fs: { read: async () => '', list: async () => [] }, process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } }
  return { hooks, $, saved, started, switchSession: () => { id = 'B'; release() } }
}
test('queued tool observations never persist into a later session identity', async () => {
  const x = deferredAdapter(registerShelf)
  const blocked = x.hooks.get('command.run')(x.$, { args: '' })
  await x.started
  const observed = x.hooks.get('tool.call')(x.$, { tool: 'Bash', command: 'echo belongs-to-A' }, async () => ({ result: { exitCode: 0 } }))
  for (let i = 0; i < 30; i++) await Promise.resolve()
  x.switchSession(); await Promise.all([blocked, observed])
  for (const [key, value] of x.saved) if (key.includes('"B"')) assert.doesNotMatch(JSON.stringify(value), /belongs-to-A/)
})
test('commands capture their session before waiting in the persistence queue', async () => {
  const x = deferredAdapter(registerDecision)
  const blocked = x.hooks.get('command.run')(x.$, { args: '' }); await x.started
  const queued = x.hooks.get('command.run')(x.$, { args: 'add a.ts | decision-for-A | because' })
  for (let i = 0; i < 30; i++) await Promise.resolve()
  x.switchSession(); await Promise.all([blocked, queued])
  for (const [key, value] of x.saved) if (key.includes('"B"')) assert.doesNotMatch(JSON.stringify(value), /decision-for-A/)
})

test('subdirectory verification includes untracked changes elsewhere in the same repository', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  await mkdir(join(r.cwd, 'sub'))
  const sub = { ...r.io, cwd: join(r.cwd, 'sub') }; sub.revision = () => revision(sub)
  await r.write('asset.bin', Buffer.from([1])); const before = await sub.revision()
  await r.write('asset.bin', Buffer.from([2])); assert.notEqual(await sub.revision(), before)
})

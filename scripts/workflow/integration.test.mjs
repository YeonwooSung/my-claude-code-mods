import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { revision, statusPaths } from '../../verify-board/hooks/core/runtime.ts'
import { Feature as Scope } from '../../scope-guard/hooks/core/feature.ts'
import { ShadowGit } from '../../time-machine/hooks/git.ts'
import { Feature as Verify } from '../../verify-board/hooks/core/feature.ts'
import { Feature as Review } from '../../review-queue/hooks/core/feature.ts'
import { Feature as Deps } from '../../dependency-lens/hooks/core/feature.ts'
import { register as registerShelf } from '../../command-shelf/hooks/register.ts'
import { register as registerDecision } from '../../decision-ledger/hooks/register.ts'
async function repository(t, directory) {
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-mods-'))
  const cwd = directory ? join(temporary, directory) : temporary
  if (directory) await mkdir(cwd)
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const run = async argv => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 10_000 })
    if (r.error) throw r.error
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
  }
  const git = async (...args) => { const r = await run(['git', ...args]); assert.equal(r.exitCode, 0, r.stderr); return r.stdout.trim() }
  await git('init', '-q'); await git('config', 'user.name', 'Workflow Test'); await git('config', 'user.email', 'workflow@example.invalid')
  const io = { cwd, stat: async path => ({ isLink: (await lstat(path)).isSymbolicLink() }), read: path => readFile(path, 'utf8'), bytes: async path => (await readFile(path)).toString('base64'), run, env: async () => undefined, revision: () => revision(io) }
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

test('different staged source is detected even when the working file is restored to HEAD', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  await r.write('a.ts', 'staged-one'); await r.git('add', 'a.ts'); await r.write('a.ts', 'base')
  const first = await r.io.revision(); assert.ok(first)
  await r.write('a.ts', 'staged-two'); await r.git('add', 'a.ts'); await r.write('a.ts', 'base')
  assert.notEqual(await r.io.revision(), first)
})
test('dirty submodule content is unknown rather than a reusable revision signature', async t => {
  const r = await repository(t), nested = join(r.cwd, 'nested')
  await mkdir(nested)
  for (const args of [['init', '-q'], ['config', 'user.name', 'Nested Test'], ['config', 'user.email', 'nested@example.invalid']]) assert.equal((await r.io.run(['git', '-C', nested, ...args])).exitCode, 0)
  await writeFile(join(nested, 'a.ts'), 'base')
  for (const args of [['add', '.'], ['commit', '-qm', 'nested base']]) assert.equal((await r.io.run(['git', '-C', nested, ...args])).exitCode, 0)
  await r.git('add', 'nested'); await r.git('commit', '-qm', 'parent base')
  assert.ok(await r.io.revision())
  await r.git('config', 'diff.ignoreSubmodules', 'all')
  await writeFile(join(nested, 'a.ts'), 'dirty')
  assert.equal(await r.io.revision(), undefined)
})
test('repository paths ending in a space retain their exact identity', async t => {
  const r = await repository(t, "owner's project ")
  await r.write('a.ts', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  const first = await r.io.revision(); assert.ok(first)
  await r.write('a.ts', 'changed'); assert.notEqual(await r.io.revision(), first)
})
test('untracked symlinks do not cause snapshot or review reads outside the repository', async t => {
  const r = await repository(t)
  await r.write('a.ts', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  const outside = await mkdtemp(join(tmpdir(), 'workflow-outside-')); t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'private'), 'PRIVATE_FIXTURE')
  await symlink(join(outside, 'private'), join(r.cwd, 'linked'))
  let reads = 0
  const port = { ...r.io, bytes: async path => { if (path.endsWith('/linked')) reads++; return r.io.bytes(path) } }; port.revision = () => revision(port)
  assert.equal(await port.revision(), undefined)
  assert.match(await new Review().command('mark linked', port), /INCOMPLETE/)
  assert.equal(reads, 0)
})
test('real rename and deletion reviews retain exact spaced paths', async t => {
  const r = await repository(t)
  await r.write('old  name.ts', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  await r.git('mv', 'old  name.ts', 'new  name.ts')
  const f = new Review()
  assert.match(await f.command('mark old  name.ts', r.io), /REVIEWED old  name.ts/)
  assert.match(await f.command('mark new  name.ts', r.io), /REVIEWED new  name.ts/)
  await r.write('new  name.ts', 'changed')
  assert.match(await f.command('', r.io), /STALE new  name.ts/)
  await r.git('rm', '-f', 'new  name.ts')
  assert.match(await f.command('mark old  name.ts', r.io), /REVIEWED old  name.ts/)
})
test('ignored secret files are excluded from snapshot reads', async t => {
  const r = await repository(t)
  await r.write('.gitignore', '.env\n'); await r.git('add', '.gitignore'); await r.git('commit', '-qm', 'ignore local env')
  await r.write('.env', 'API_TOKEN=FIRST_FAKE')
  const port = { ...r.io, bytes: async path => { assert.ok(!path.endsWith('/.env')); return r.io.bytes(path) } }
  const before = await revision(port); await r.write('.env', 'API_TOKEN=SECOND_FAKE')
  assert.equal(await revision(port), before)
})
test('snapshot count limits reject evidence before reading excess untracked files', async t => {
  const r = await repository(t)
  await r.write('base', 'base'); await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  await Promise.all(Array.from({ length: 201 }, (_, i) => r.write(`new-${i}`, 'body')))
  let reads = 0
  assert.equal(await revision({ ...r.io, bytes: async () => { reads++; return '' } }), undefined)
  assert.equal(reads, 0)
})

test('nested sessions normalize status paths and never review files outside cwd', async t => {
  const r = await repository(t), cwd = join(r.cwd, 'packages/app')
  await mkdir(cwd, { recursive: true })
  await r.write('packages/app/a.ts', 'base'); await r.write('outside.ts', 'base')
  await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  let outsideReads = 0
  const io = { ...r.io, cwd, bytes: async path => { if (path.includes('/../')) outsideReads++; return r.io.bytes(path) } }
  const scope = new Scope(); await scope.command('allow .', io)
  await r.write('packages/app/a.ts', 'changed'); await r.write('outside.ts', 'changed')
  assert.deepEqual(await statusPaths(io), ['../../outside.ts', 'a.ts'])
  const scoped = await scope.command('list', io)
  assert.match(scoped, /IN-SCOPE a\.ts/); assert.match(scoped, /OUTSIDE \.\.\/\.\.\/outside\.ts/)
  const review = new Review(), report = await review.command('mark a.ts', io)
  assert.match(report, /REVIEWED a\.ts/); assert.match(report, /OUTSIDE \.\.\/\.\.\/outside\.ts/)
  assert.equal(outsideReads, 0)
  await r.git('mv', 'packages/app/a.ts', 'packages/app/new.ts')
  const paths = await statusPaths(io)
  assert.ok(paths.includes('a.ts')); assert.ok(paths.includes('new.ts'))
})

test('dependency baseline resolves the same nested package as the working manifest', async t => {
  const r = await repository(t), cwd = join(r.cwd, 'packages/app')
  await mkdir(cwd, { recursive: true })
  const manifest = name => JSON.stringify({ dependencies: { [name]: '1.0.0' } })
  const lock = name => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [`node_modules/${name}`]: { version: '1.0.0' } } })
  for (const [prefix, name] of [['', 'root-only'], ['packages/app/', 'app-only']]) {
    await r.write(prefix + 'package.json', manifest(name)); await r.write(prefix + 'package-lock.json', lock(name))
  }
  await r.git('add', '.'); await r.git('commit', '-qm', 'base')
  const io = { ...r.io, cwd }, deps = new Deps()
  const clean = await deps.command('', io)
  assert.match(clean, /Lock delta: \+0 -0 ~0/); assert.doesNotMatch(clean, /root-only|DIRECT /)
  await r.write('packages/app/package.json', JSON.stringify({ dependencies: { 'app-only': '2.0.0' } }))
  assert.match(await deps.command('', io), /app-only: 1\.0\.0 -> 2\.0\.0/)
  await rm(join(cwd, 'package.json')); await rm(join(cwd, 'package-lock.json'))
  const removed = await deps.command('', { ...io, list: path => import('node:fs/promises').then(fs => fs.readdir(path)) })
  assert.match(removed, /app-only: 1\.0\.0 -> \(absent\)/); assert.doesNotMatch(removed, /root-only/)
})

test('Time Machine refuses truncated ignored-file evidence without overwriting the real working file', async t => {
  const r = await repository(t), base = await mkdtemp(join(tmpdir(), 'tm-safety-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'index'))
  let truncate = false
  const runner = async (argv, options = {}) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd ?? r.cwd, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: 10_000 })
    if (result.error) throw result.error
    if (truncate && argv.includes('ls-files') && argv.includes('--others')) return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: true }
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, isStdoutTruncated: false, isStderrTruncated: false }
  }
  const shadow = new ShadowGit(runner, join(base, 'shadow.git'), r.cwd, join(base, 'index/s'))
  await shadow.init(); await r.write('.env', 'old snapshot\n')
  const target = await shadow.snapshot(undefined, 'base', 'refs/tm/s/main')
  await r.write('.env', 'new ignored content\n'); await r.write('.gitignore', '.env\n')
  const from = await shadow.snapshot(target.commit, 'ignore env', 'refs/tm/s/main')
  truncate = true
  await assert.rejects(shadow.restore(target.commit, 'refs/tm/s/main', from.commit, 'restore'), /truncated/)
  assert.equal(await readFile(join(r.cwd, '.env'), 'utf8'), 'new ignored content\n')
})

import { expect, test } from 'claude-code/testing'

import { GitError, ignoredConflicts, ignoredDirsToExpand, isInside, parseNameStatus, ShadowGit, type RunResult, type Runner } from '../hooks/git.ts'

type Call = { argv: readonly string[]; env?: Record<string, string>; cwd?: string }

// `rev-parse --verify` (a ref lookup) is its own subcommand here, `verify`; unanswered, the ref is absent.
const subOf = (args: readonly string[]): string => (args[0] === 'rev-parse' && args[1] === '--verify' ? 'verify' : (args[0] ?? ''))

// A scripted git: answers by subcommand, records every call.
function fake(answer: (sub: string, args: readonly string[]) => Partial<RunResult> | undefined = () => undefined) {
  const calls: Call[] = []
  const runner: Runner = async (argv, opts) => {
    calls.push({ argv, env: opts?.env, cwd: opts?.cwd })
    await Promise.resolve()
    const i = argv.indexOf('core.quotepath=off')
    const all = i >= 0 ? argv.slice(i + 1) : argv.slice(1)
    const args = all[0] === '--literal-pathspecs' ? all.slice(1) : all
    const sub = subOf(args)
    const r = answer(sub, args) ?? (sub === 'verify' ? { exitCode: 1 } : {})
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  const subs = (): string[] =>
    calls.map(c => {
      const i = c.argv.indexOf('core.quotepath=off')
      const args = c.argv.slice(i + 1)
      return i >= 0 ? subOf(args[0] === '--literal-pathspecs' ? args.slice(1) : args) : c.argv[1]!
    })
  return { runner, calls, subs }
}

const G = (f: ReturnType<typeof fake>): ShadowGit => new ShadowGit(f.runner, '/s/shadow.git', '/r', '/s/index/s1')

test('the first snapshot commits the tree and counts its files', async () => {
  const f = fake((sub, args) => {
    if (sub === 'write-tree') return { stdout: 'tree1\n' }
    if (sub === 'commit-tree') return { stdout: 'commit1\n' }
    if (sub === 'ls-tree') return { stdout: 'a.py\nb.py\n' }
    return args.length ? undefined : undefined
  })
  const s = await G(f).snapshot(undefined, 'baseline', 'refs/tm/s1/main')
  expect(s).toEqual({ commit: 'commit1', changed: true, files: [], filesTotal: 2 })
  expect(f.subs()).toEqual(['verify', 'add', 'write-tree', 'commit-tree', 'update-ref', 'ls-tree'])
  const first = f.calls[0]!
  expect(first.argv.slice(0, 3)).toEqual(['git', '--git-dir=/s/shadow.git', '--work-tree=/r'])
  expect(first.env!.GIT_INDEX_FILE).toBe('/s/index/s1')
  expect(first.env!.GIT_AUTHOR_NAME).toBe('time-machine')
  expect(first.cwd).toBe('/r')
  expect(f.calls[3]!.argv.slice(-3)).toEqual(['tree1', '-m', 'baseline'])
})

test('an unchanged tree makes no commit; a changed one lists its files', async () => {
  const same = fake(sub => (sub === 'write-tree' || sub === 'rev-parse' ? { stdout: 'treeX\n' } : undefined))
  expect(await G(same).snapshot('c1', 'step 2', 'refs/tm/s1/main')).toEqual({ commit: 'c1', changed: false, files: [], filesTotal: 0 })
  expect(same.subs()).toEqual(['verify', 'add', 'write-tree', 'rev-parse'])
  const changed = fake(sub => {
    if (sub === 'write-tree') return { stdout: 'treeB\n' }
    if (sub === 'rev-parse') return { stdout: 'treeA\n' }
    if (sub === 'commit-tree') return { stdout: 'c2\n' }
    if (sub === 'diff') return { stdout: 'M\tauth.py\nR100\told.py\tnew.py\nD\tjunk.txt\n' }
    return undefined
  })
  const s = await G(changed).snapshot('c1', 'step 3', 'refs/tm/s1/main')
  expect(s.files).toEqual([
    { status: 'M', path: 'auth.py' },
    { status: 'R', path: 'new.py' },
    { status: 'D', path: 'junk.txt' },
  ])
  expect(changed.calls.find(c => c.argv.includes('commit-tree'))!.argv.slice(-5)).toEqual(['treeB', '-p', 'c1', '-m', 'step 3'])
})

test('a failing git call throws GitError with the first stderr line', async () => {
  const f = fake(sub => (sub === 'add' ? { exitCode: 128, stderr: 'fatal: not a git repository\nmore' } : undefined))
  let error: unknown
  try {
    await G(f).snapshot(undefined, 'x', 'r')
  } catch (e) {
    error = e
  }
  expect(error instanceof GitError).toBe(true)
  expect(String((error as Error).message)).toBe('git add failed (128): fatal: not a git repository')
})

test('operations run one at a time, in the order they were asked', async () => {
  const f = fake(sub => (sub === 'write-tree' ? { stdout: 't\n' } : sub === 'rev-parse' ? { stdout: 't\n' } : undefined))
  const g = G(f)
  await Promise.all([g.snapshot('c1', 'a', 'r'), g.snapshot('c1', 'b', 'r')])
  expect(f.subs()).toEqual(['verify', 'add', 'write-tree', 'rev-parse', 'verify', 'add', 'write-tree', 'rev-parse'])
})

test('a snapshot takes its parent from the ref when it runs, so parallel snapshots chain', async () => {
  let ref: string | undefined
  let n = 0
  const f = fake((sub, args) => {
    if (sub === 'verify') return ref === undefined ? { exitCode: 1 } : { stdout: `${ref}\n` }
    if (sub === 'write-tree') return { stdout: `tree${n}\n` }
    if (sub === 'rev-parse') return { stdout: 'old-tree\n' }
    if (sub === 'commit-tree') {
      n += 1
      return { stdout: `c${n}\n` }
    }
    if (sub === 'update-ref') ref = args[2]
    return undefined
  })
  const g = G(f)
  const [a, b] = await Promise.all([g.snapshot('c0', 'a', 'refs/tm/s1/main'), g.snapshot('c0', 'b', 'refs/tm/s1/main')])
  expect(a.commit).toBe('c1')
  expect(b.commit).toBe('c2')
  const commits = f.calls.filter(c => c.argv.includes('commit-tree')).map(c => c.argv.slice(-4))
  expect(commits).toEqual([
    ['-p', 'c0', '-m', 'a'],
    ['-p', 'c1', '-m', 'b'],
  ])
})

test('an operation runs with the runner set when it was asked for', async () => {
  const a = fake()
  const b = fake()
  const g = new ShadowGit(a.runner, '/s/shadow.git', '/r', '/s/index/s1')
  const done = g.nameStatus('x', 'y')
  g.runner = b.runner
  await done
  expect(a.subs()).toEqual(['diff'])
  expect(b.calls.length).toBe(0)
})

test('restore, export, init, deleteRefs and gc issue the expected commands', async () => {
  const f = fake(sub =>
    sub === 'for-each-ref'
      ? { stdout: 'refs/tm/old/main\nrefs/tm/old/b1\n' }
      : sub === 'write-tree' || sub === 'rev-parse'
        ? { stdout: 't\n' }
        : sub === 'commit-tree'
          ? { stdout: 'c4\n' }
          : undefined,
  )
  const g = G(f)
  expect(await g.restore('c3', 'refs/tm/s1/main', 'c2', 'restore to step 3')).toBe('c4')
  expect(f.subs()).toEqual(['add', 'write-tree', 'rev-parse', 'ls-files', 'ls-tree', 'commit-tree', 'read-tree', 'update-ref'])
  expect(f.calls[3]!.argv.slice(-6)).toEqual(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  expect(f.calls[4]!.argv.slice(-5)).toEqual(['ls-tree', '-r', '-z', '--name-only', 'c3'])
  expect(f.calls[5]!.argv.slice(-8)).toEqual(['commit-tree', 'c3^{tree}', '-p', 'c2', '-p', 'c3', '-m', 'restore to step 3'])
  expect(f.calls[6]!.argv.slice(-4)).toEqual(['read-tree', '-u', '--reset', 'c3'])
  expect(f.calls[7]!.argv.slice(-3)).toEqual(['update-ref', 'refs/tm/s1/main', 'c4'])
  await g.exportTo('c3', '/s/tmp/x')
  const exp = f.calls[8]!
  expect(exp.argv).toContain('--work-tree=/s/tmp/x')
  expect(exp.env!.GIT_INDEX_FILE).toBe('/s/tmp/x.index')
  expect(exp.cwd).toBe('/s/tmp/x')
  await g.init()
  expect(f.calls[9]!.argv).toEqual(['git', 'init', '--bare', '--quiet', '/s/shadow.git'])
  expect(f.calls[10]!.argv).toEqual([
    'sh',
    '-c',
    'if [ -f "$1" ]; then mkdir -p "$(dirname "$2")" && cp "$1" "$2"; fi',
    'tm-sync',
    '/r/.git/info/exclude',
    '/s/shadow.git/info/exclude',
  ])
  await g.deleteRefs('refs/tm/old/')
  expect(f.calls.slice(12).map(c => c.argv.slice(-3))).toEqual([
    ['update-ref', '-d', 'refs/tm/old/main'],
    ['update-ref', '-d', 'refs/tm/old/b1'],
  ])
  await g.gc()
  expect(f.calls.at(-1)!.argv.slice(-3)).toEqual(['gc', '--auto', '--quiet'])
})

test('parseNameStatus and isInside', () => {
  expect(parseNameStatus('A\ta.py\nC75\tx.py\ty.py\n\n')).toEqual([
    { status: 'A', path: 'a.py' },
    { status: 'C', path: 'y.py' },
  ])
  expect(isInside('/s/tmp/x', '/s/tmp')).toBe(true)
  expect(isInside('/s/tmp', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmp/../etc', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmpx/a', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmp/x/', '/s/tmp')).toBe(true)
  expect(isInside('/s/tmp/', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmp/.', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmp//x', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmp/./x', '/s/tmp')).toBe(false)
  expect(isInside('/a', '/')).toBe(false)
  expect(isInside('/a', '')).toBe(false)
})

test('every git call pins the repository, objects and index through its environment', async () => {
  const f = fake(sub => (sub === 'write-tree' ? { stdout: 't\n' } : sub === 'commit-tree' ? { stdout: 'c\n' } : undefined))
  await G(f).snapshot(undefined, 'b', 'r')
  for (const c of f.calls) {
    expect(c.env!.GIT_DIR).toBe('/s/shadow.git')
    expect(c.env!.GIT_WORK_TREE).toBe('/r')
    expect(c.env!.GIT_OBJECT_DIRECTORY).toBe('/s/shadow.git/objects')
    expect(c.env!.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe('')
    expect(c.env!.GIT_NAMESPACE).toBe('')
    expect(c.env!.GIT_INDEX_FILE).toBe('/s/index/s1')
  }
})

test('restore refuses, touching nothing, when the work tree moved past the snapshot', async () => {
  const f = fake(sub => (sub === 'write-tree' ? { stdout: 'now\n' } : sub === 'rev-parse' ? { stdout: 'then\n' } : undefined))
  let error: unknown
  try {
    await G(f).restore('c3', 'r', 'c2', 'm')
  } catch (e) {
    error = e
  }
  expect(String((error as Error).message)).toBe('the work tree changed since the last snapshot; run the restore again')
  expect(f.subs()).toEqual(['add', 'write-tree', 'rev-parse'])
})

test('GitError prefers the fatal or error line over warnings', () => {
  const e = new GitError(['add'], { exitCode: 1, stdout: '', stderr: 'warning: adding embedded git repository\nhint: x\nfatal: boom\n' })
  expect(e.message).toBe('git add failed (1): fatal: boom')
})

test('restore onto a new branch refuses, touching nothing, when its ref already exists', async () => {
  const f = fake(sub => (sub === 'verify' ? { stdout: 'c9\n' } : sub === 'write-tree' || sub === 'rev-parse' ? { stdout: 't\n' } : undefined))
  let error: unknown
  try {
    await G(f).restore('c3', 'refs/tm/s1/Main', 'c2', 'm', true)
  } catch (e) {
    error = e
  }
  expect(String((error as Error).message)).toBe('branch ref already exists')
  expect(f.subs()).toEqual(['verify'])
  const absent = fake(sub => (sub === 'write-tree' || sub === 'rev-parse' ? { stdout: 't\n' } : sub === 'commit-tree' ? { stdout: 'c4\n' } : undefined))
  expect(await G(absent).restore('c3', 'refs/tm/s1/b1', 'c2', 'm', true)).toBe('c4')
  expect(absent.subs()).toEqual(['verify', 'add', 'write-tree', 'rev-parse', 'ls-files', 'ls-tree', 'commit-tree', 'read-tree', 'update-ref'])
})

test('a ref that cannot be moved after the files were restored is reported as such', async () => {
  const f = fake(sub =>
    sub === 'write-tree' || sub === 'rev-parse' ? { stdout: 't\n' } : sub === 'commit-tree' ? { stdout: 'c4\n' } : sub === 'update-ref' ? { exitCode: 128, stderr: 'fatal: disk full' } : undefined,
  )
  let error: unknown
  try {
    await G(f).restore('c3', 'r', 'c2', 'm')
  } catch (e) {
    error = e
  }
  expect(String((error as Error).message)).toBe('files were restored but the restore could not be recorded: git update-ref failed (128): fatal: disk full')
})

test('restore refuses, touching nothing, when the target would overwrite ignored files no snapshot holds', async () => {
  const f = fake(sub =>
    sub === 'write-tree' || sub === 'rev-parse'
      ? { stdout: 't\n' }
      : sub === 'ls-files'
        ? { stdout: '.env\0out/\0keep.log\0' }
        : sub === 'ls-tree'
          ? { stdout: '.env\0a.txt\0out\0' }
          : undefined,
  )
  let error: unknown
  try {
    await G(f).restore('c3', 'r', 'c2', 'm')
  } catch (e) {
    error = e
  }
  expect(String((error as Error).message)).toBe('restore would overwrite ignored files that no snapshot holds: .env, out; move them aside and run the restore again')
  expect(f.subs()).toEqual(['add', 'write-tree', 'rev-parse', 'ls-files', 'ls-tree'])
})

test('ignoredConflicts: equal paths, and one path a directory prefix of the other', () => {
  expect(ignoredConflicts(['keep.log', 'build/'], ['a.txt', 'src/x.ts'])).toEqual([])
  expect(ignoredConflicts(['.env'], ['.env'])).toEqual(['.env'])
  expect(ignoredConflicts(['out/'], ['out'])).toEqual(['out'])
  expect(ignoredConflicts(['out/'], ['out/x/y.js'])).toEqual(['out'])
  expect(ignoredConflicts(['d'], ['d/f'])).toEqual(['d'])
  expect(ignoredConflicts(['a/b.log'], ['a'])).toEqual(['a/b.log'])
  expect(ignoredConflicts(['a/b.log'], ['a/c.ts'])).toEqual([])
  expect(ignoredConflicts(['ab'], ['a', 'abc/d'])).toEqual([])
})

test('every git call overrides an inherited common dir and config parameters', async () => {
  const f = fake(sub => (sub === 'write-tree' ? { stdout: 't\n' } : sub === 'commit-tree' ? { stdout: 'c\n' } : undefined))
  await G(f).snapshot(undefined, 'b', 'r')
  for (const c of f.calls) {
    expect(c.env!.GIT_COMMON_DIR).toBe('/s/shadow.git')
    expect(c.env!.GIT_CONFIG_PARAMETERS).toBe('')
  }
})

test('a wholly ignored directory that only holds a target path is judged by the files inside it', async () => {
  expect(ignoredDirsToExpand(['pkg/', 'out/', '.env', 'b/'], ['pkg/a.py', 'out', 'b'])).toEqual(['pkg/'])
  const answer = (inside: string) => (sub: string, args: readonly string[]) =>
    sub === 'write-tree' || sub === 'rev-parse'
      ? { stdout: 't\n' }
      : sub === 'ls-files'
        ? { stdout: args.includes('--directory') ? 'pkg/\0' : inside }
        : sub === 'ls-tree'
          ? { stdout: 'pkg/a.py\0' }
          : sub === 'commit-tree'
            ? { stdout: 'c4\n' }
            : undefined
  const ok = fake(answer('pkg/__pycache__/a.pyc\0'))
  expect(await G(ok).restore('c3', 'r', 'c2', 'm')).toBe('c4')
  expect(ok.calls[5]!.argv.slice(-8)).toEqual(['--literal-pathspecs', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', 'pkg/'])
  const clash = fake(answer('pkg/a.py\0'))
  let error: unknown
  try {
    await G(clash).restore('c3', 'r', 'c2', 'm')
  } catch (e) {
    error = e
  }
  expect(String((error as Error).message)).toContain('restore would overwrite ignored files that no snapshot holds: pkg/a.py;')
  expect(clash.subs()).not.toContain('read-tree')
})

test('a snapshot blocked by a stale lock removes it and tries once more; a fresh lock fails the snapshot', async () => {
  const locked = (removed: boolean) => {
    let adds = 0
    return fake((sub, args) => {
      if (args.includes('-mmin')) return { stdout: removed ? '/s/index/s1.lock\n' : '' }
      if (sub === 'add' && (adds += 1) === 1) return { exitCode: 128, stderr: "fatal: Unable to create '/s/index/s1.lock': File exists.\n" }
      if (sub === 'write-tree') return { stdout: 't1\n' }
      if (sub === 'commit-tree') return { stdout: 'c1\n' }
      return undefined
    })
  }
  const stale = locked(true)
  expect((await G(stale).snapshot(undefined, 'b', 'refs/tm/s1/main')).commit).toBe('c1')
  const find = stale.calls.find(c => c.argv[0] === 'find')!
  expect(find.argv).toEqual(['find', '/s/index/s1.lock', '-maxdepth', '0', '-type', 'f', '-mmin', '+2', '-delete', '-print'])
  const fresh = locked(false)
  let error: unknown
  try {
    await G(fresh).snapshot(undefined, 'b', 'refs/tm/s1/main')
  } catch (e) {
    error = e
  }
  expect(error).toBeInstanceOf(GitError)
  const other = fake(sub => (sub === 'add' ? { exitCode: 128, stderr: "fatal: Unable to create '/elsewhere/x.lock': File exists.\n" } : undefined))
  try {
    await G(other).snapshot(undefined, 'b', 'refs/tm/s1/main')
  } catch {
    // refused
  }
  expect(other.calls.some(c => c.argv[0] === 'find')).toBe(false)
})

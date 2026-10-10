import { expect, test } from 'claude-code/testing'

import { GitError, isInside, parseNameStatus, ShadowGit, type RunResult, type Runner } from '../hooks/git.ts'

type Call = { argv: readonly string[]; env?: Record<string, string>; cwd?: string }

// A scripted git: answers by subcommand, records every call.
function fake(answer: (sub: string, args: readonly string[]) => Partial<RunResult> | undefined = () => undefined) {
  const calls: Call[] = []
  const runner: Runner = async (argv, opts) => {
    calls.push({ argv, env: opts?.env, cwd: opts?.cwd })
    await Promise.resolve()
    const i = argv.indexOf('core.quotepath=off')
    const args = i >= 0 ? argv.slice(i + 1) : argv.slice(1)
    const r = answer(args[0] ?? '', args) ?? {}
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  const subs = (): string[] =>
    calls.map(c => {
      const i = c.argv.indexOf('core.quotepath=off')
      return i >= 0 ? c.argv[i + 1]! : c.argv[1]!
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
  expect(f.subs()).toEqual(['add', 'write-tree', 'commit-tree', 'update-ref', 'ls-tree'])
  const first = f.calls[0]!
  expect(first.argv.slice(0, 3)).toEqual(['git', '--git-dir=/s/shadow.git', '--work-tree=/r'])
  expect(first.env!.GIT_INDEX_FILE).toBe('/s/index/s1')
  expect(first.env!.GIT_AUTHOR_NAME).toBe('time-machine')
  expect(first.cwd).toBe('/r')
  expect(f.calls[2]!.argv.slice(-3)).toEqual(['tree1', '-m', 'baseline'])
})

test('an unchanged tree makes no commit; a changed one lists its files', async () => {
  const same = fake(sub => (sub === 'write-tree' || sub === 'rev-parse' ? { stdout: 'treeX\n' } : undefined))
  expect(await G(same).snapshot('c1', 'step 2', 'refs/tm/s1/main')).toEqual({ commit: 'c1', changed: false, files: [], filesTotal: 0 })
  expect(same.subs()).toEqual(['add', 'write-tree', 'rev-parse'])
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
  expect(f.subs()).toEqual(['add', 'write-tree', 'rev-parse', 'add', 'write-tree', 'rev-parse'])
})

test('restore, export, init, deleteRefs and gc issue the expected commands', async () => {
  const f = fake(sub => (sub === 'for-each-ref' ? { stdout: 'refs/tm/old/main\nrefs/tm/old/b1\n' } : undefined))
  const g = G(f)
  await g.restore('c3', 'refs/tm/s1/main')
  expect(f.calls[0]!.argv.slice(-4)).toEqual(['read-tree', '-u', '--reset', 'c3'])
  expect(f.calls[1]!.argv.slice(-3)).toEqual(['update-ref', 'refs/tm/s1/main', 'c3'])
  await g.exportTo('c3', '/s/tmp/x')
  const exp = f.calls[2]!
  expect(exp.argv).toContain('--work-tree=/s/tmp/x')
  expect(exp.env!.GIT_INDEX_FILE).toBe('/s/tmp/x.index')
  expect(exp.cwd).toBe('/s/tmp/x')
  await g.init()
  expect(f.calls[3]!.argv).toEqual(['git', 'init', '--bare', '--quiet', '/s/shadow.git'])
  await g.deleteRefs('refs/tm/old/')
  expect(f.calls.slice(5).map(c => c.argv.slice(-3))).toEqual([
    ['update-ref', '-d', 'refs/tm/old/main'],
    ['update-ref', '-d', 'refs/tm/old/b1'],
  ])
  await g.gc()
  expect(f.calls.at(-1)!.argv.slice(-3)).toEqual(['gc', '--prune=now', '--quiet'])
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
})

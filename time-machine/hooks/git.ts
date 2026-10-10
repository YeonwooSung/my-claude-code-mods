import { type FileChange, MAX_FILES } from './core/types.ts'

export { MAX_FILES }

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunOptions = { env?: Record<string, string>; cwd?: string; timeoutMs?: number }
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>
export type SnapResult = { commit: string; changed: boolean; files: FileChange[]; filesTotal: number }

type GitOptions = { index?: string; workTree?: string; timeoutMs?: number; runner?: Runner }

const TIMEOUT_MS = 30_000
const STALE_LOCK_MS = 120_000
const IDENTITY = {
  GIT_AUTHOR_NAME: 'time-machine',
  GIT_AUTHOR_EMAIL: 'tm@local',
  GIT_COMMITTER_NAME: 'time-machine',
  GIT_COMMITTER_EMAIL: 'tm@local',
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    const lines = result.stderr.split('\n').map(l => l.trim()).filter(l => l !== '')
    const line = lines.find(l => l.startsWith('fatal:') || l.startsWith('error:')) ?? lines[0] ?? ''
    super(`git ${args[0] ?? ''} failed (${result.exitCode}): ${line}`)
  }
}

// `--name-status` lines: `M\tpath`, `R100\told\tnew`, `C75\tfrom\tto`; the path kept is the new one.
export function parseNameStatus(out: string): FileChange[] {
  const files: FileChange[] = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    files.push({ status: parts[0]!.charAt(0), path: parts[parts.length - 1]! })
  }
  return files
}

// A path strictly below `parent`, spelled without empty, `.` or `..` segments; guards `rm -rf`.
export function isInside(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, '')
  if (base === '') return false
  const c = child.replace(/\/+$/, '')
  if (!c.startsWith(`${base}/`) || c.length === base.length + 1) return false
  return !c.split('/').slice(1).some(seg => seg === '' || seg === '.' || seg === '..')
}

// Ignored, untracked paths (`ls-files --directory`: a wholly ignored directory as `dir/`) that a tree's
// paths would overwrite or delete: an equal path, or one a directory prefix of the other.
export function ignoredConflicts(ignored: readonly string[], target: readonly string[]): string[] {
  const ign = new Set(ignored.map(p => p.replace(/\/+$/, '')).filter(p => p !== ''))
  const tgt = new Set(target.filter(p => p !== ''))
  const dirsOf = (path: string): string[] => {
    const parts = path.split('/')
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'))
  }
  const out = new Set<string>()
  for (const t of tgt) for (const p of [t, ...dirsOf(t)]) if (ign.has(p)) out.add(p)
  for (const i of ign) if (dirsOf(i).some(d => tgt.has(d))) out.add(i)
  return [...out].sort()
}

// Wholly ignored directories (`dir/`) that only hold a target path, without being one: whether they
// conflict depends on the ignored files inside them, so they are listed file by file before judging.
// A leftover `pkg/__pycache__/` beside a restored `pkg/a.py` is not a conflict.
export function ignoredDirsToExpand(ignored: readonly string[], target: readonly string[]): string[] {
  const tgt = new Set(target.filter(p => p !== ''))
  const holders = new Set<string>()
  for (const t of tgt) {
    const parts = t.split('/')
    for (let i = 1; i < parts.length; i += 1) holders.add(parts.slice(0, i).join('/'))
  }
  return ignored.filter(p => {
    if (!p.endsWith('/')) return false
    const dir = p.replace(/\/+$/, '')
    return holders.has(dir) && !tgt.has(dir)
  })
}

const MAX_NAMED = 10

// A bare repository beside the project: its own index per session, the project as work tree, so the
// user's .git is never read or written. The host's `.gitignore` files apply.
export class ShadowGit {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    // Any live hook's `$.process.run`; set again by each hook that uses git.
    public runner: Runner,
    readonly gitDir: string,
    readonly workTree: string,
    readonly indexFile: string,
  ) {}

  // One operation at a time: parallel tool calls share the index. The runner is the one set when the
  // operation was asked for, not whichever hook set it last by the time the operation runs.
  serial<T>(fn: (run: Runner) => Promise<T>): Promise<T> {
    const runner = this.runner
    const go = (): Promise<T> => fn(runner)
    const run = this.queue.then(go, go)
    this.queue = run.catch(() => undefined)
    return run
  }

  async git(args: readonly string[], opts: GitOptions = {}): Promise<string> {
    const result = await this.exec(args, opts)
    if (result.exitCode !== 0) throw new GitError(args, result)
    return result.stdout
  }

  // The raw result, a nonzero exit included.
  exec(args: readonly string[], opts: GitOptions = {}): Promise<RunResult> {
    const { argv, options } = this.invocation(args, opts)
    return (opts.runner ?? this.runner)(argv, options)
  }

  private invocation(args: readonly string[], opts: GitOptions): { argv: string[]; options: RunOptions } {
    const workTree = opts.workTree ?? this.workTree
    const argv = ['git', `--git-dir=${this.gitDir}`, `--work-tree=${workTree}`, '-c', 'core.quotepath=off', ...args]
    return {
      argv,
      options: {
        cwd: workTree,
        env: {
          ...IDENTITY,
          GIT_DIR: this.gitDir,
          GIT_WORK_TREE: workTree,
          GIT_COMMON_DIR: this.gitDir,
          GIT_OBJECT_DIRECTORY: `${this.gitDir}/objects`,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
          GIT_NAMESPACE: '',
          // Empty clears `-c` settings inherited from a parent git; empty GIT_COMMON_DIR would break git.
          GIT_CONFIG_PARAMETERS: '',
          GIT_INDEX_FILE: opts.index ?? this.indexFile,
        },
        timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      },
    }
  }

  // Idempotent: re-running init on an existing repository leaves it as it is.
  async init(): Promise<void> {
    const args = ['init', '--bare', '--quiet', this.gitDir]
    const result = await this.runner(['git', ...args], {
      env: { GIT_COMMON_DIR: this.gitDir, GIT_OBJECT_DIRECTORY: `${this.gitDir}/objects`, GIT_ALTERNATE_OBJECT_DIRECTORIES: '', GIT_NAMESPACE: '', GIT_CONFIG_PARAMETERS: '' },
      timeoutMs: TIMEOUT_MS,
    })
    if (result.exitCode !== 0) throw new GitError(args, result)
    await this.syncExcludes()
  }

  // The user's local `.git/info/exclude` applies to the shadow repository too.
  async syncExcludes(): Promise<void> {
    const src = `${this.workTree}/.git/info/exclude`
    const dst = `${this.gitDir}/info/exclude`
    const args = ['sh', '-c', 'if [ -f "$1" ]; then mkdir -p "$(dirname "$2")" && cp "$1" "$2"; fi', 'tm-sync', src, dst]
    const result = await this.runner(args, { timeoutMs: TIMEOUT_MS })
    if (result.exitCode !== 0) throw new GitError(['sync-excludes'], result)
  }

  // Stage the work tree; commit only when its tree differs from the parent's. The parent is the ref's
  // commit when it is read, in turn, so parallel snapshots chain; `parent` is used only while the ref
  // does not exist yet (undefined for the baseline).
  snapshot(parent: string | undefined, message: string, ref: string): Promise<SnapResult> {
    return this.serial(async runner => {
      try {
        return await this.snapshotNow(parent, message, ref, runner)
      } catch (error) {
        if (!(await this.clearStaleLock(error, runner))) throw error
        return this.snapshotNow(parent, message, ref, runner)
      }
    })
  }

  // A lock git left behind (a git killed by its timeout, a crashed process) blocks every later
  // snapshot. Removed only when it is this repository's or this session's index's, and older than
  // any live git would hold it: every call here times out well within STALE_LOCK_MS.
  private async clearStaleLock(error: unknown, runner: Runner): Promise<boolean> {
    if (!(error instanceof GitError)) return false
    const lock = /Unable to create '([^']+\.lock)': File exists/.exec(error.result.stderr)?.[1]
    if (lock === undefined || !(lock === `${this.indexFile}.lock` || isInside(lock, this.gitDir))) return false
    const mins = String(Math.ceil(STALE_LOCK_MS / 60_000))
    const r = await runner(['find', lock, '-maxdepth', '0', '-type', 'f', '-mmin', `+${mins}`, '-delete', '-print'], { timeoutMs: TIMEOUT_MS })
    return r.exitCode === 0 && r.stdout.trim() !== ''
  }

  private async snapshotNow(parent: string | undefined, message: string, ref: string, runner: Runner): Promise<SnapResult> {
    const at = await this.exec(['rev-parse', '--verify', '-q', ref], { runner })
    const base = at.exitCode === 0 && at.stdout.trim() !== '' ? at.stdout.trim() : parent
    await this.git(['add', '-A'], { runner })
    const tree = (await this.git(['write-tree'], { runner })).trim()
    if (base !== undefined) {
      const baseTree = (await this.git(['rev-parse', `${base}^{tree}`], { runner })).trim()
      if (baseTree === tree) return { commit: base, changed: false, files: [], filesTotal: 0 }
    }
    const commit = (await this.git(['commit-tree', tree, ...(base !== undefined ? ['-p', base] : []), '-m', message], { runner })).trim()
    await this.git(['update-ref', ref, commit], { runner })
    if (base === undefined) {
      const listed = (await this.git(['ls-tree', '-r', '--name-only', commit], { runner })).split('\n').filter(l => l !== '')
      return { commit, changed: true, files: [], filesTotal: listed.length }
    }
    const files = parseNameStatus(await this.git(['diff', '--name-status', '-M', base, commit], { runner }))
    return { commit, changed: true, files: files.slice(0, MAX_FILES), filesTotal: files.length }
  }

  nameStatus(a: string, b: string): Promise<FileChange[]> {
    return this.serial(async runner => parseNameStatus(await this.git(['diff', '--name-status', '-M', a, b], { runner })))
  }

  // The patch's first `maxLines` lines and whether there were more: `head` ends git early, so a huge
  // diff (a lockfile, a generated bundle) is neither read whole nor left to run into the timeout.
  diffText(a: string, b: string, maxLines = Number.POSITIVE_INFINITY): Promise<{ stat: string; patch: string; more: boolean }> {
    return this.serial(async runner => {
      const stat = await this.git(['diff', '--stat', a, b], { runner })
      if (!Number.isFinite(maxLines)) return { stat, patch: await this.git(['diff', a, b], { runner }), more: false }
      const { argv, options } = this.invocation(['diff', a, b], {})
      const r = await runner(['sh', '-c', 'set -o pipefail 2>/dev/null; "$@" | head -n "$TM_LINES"; s=$?; [ "$s" -eq 141 ] && s=0; exit $s', 'tm-diff', ...argv], {
        ...options,
        env: { ...options.env, TM_LINES: String(maxLines + 1) },
      })
      if (r.exitCode !== 0) throw new GitError(['diff', a, b], r)
      const lines = r.stdout.replace(/\n$/, '').split('\n')
      const more = lines.length > maxLines
      return { stat, patch: (more ? lines.slice(0, maxLines) : lines).join('\n'), more }
    })
  }

  // The work tree made to match `target`: tracked files rewritten, files `target` lacks removed, ignored
  // files untouched. `from` is the commit the caller just snapshotted; if the work tree no longer
  // matches it, nothing is touched, so unsnapshotted work is never lost. The result is a new commit with
  // `target`'s tree and both `from` and `target` as parents, so nothing recorded becomes unreachable;
  // `ref` points at it and it is returned. With `createRef`, `ref` is a new branch's and must not exist
  // yet (refs are files: on a case-insensitive disk `Main` is `main`). The commit is made before the
  // files are touched, so only moving the ref can fail after them. Ignored files are never snapshotted:
  // one `target` would overwrite or delete makes the restore refuse, touching nothing.
  restore(target: string, ref: string, from: string, message: string, createRef = false): Promise<string> {
    return this.serial(async runner => {
      if (createRef && (await this.exec(['rev-parse', '--verify', '-q', ref], { runner })).exitCode === 0) throw new Error('branch ref already exists')
      await this.git(['add', '-A'], { runner })
      const tree = (await this.git(['write-tree'], { runner })).trim()
      const fromTree = (await this.git(['rev-parse', `${from}^{tree}`], { runner })).trim()
      if (tree !== fromTree) throw new Error('the work tree changed since the last snapshot; run the restore again')
      const nul = (out: string): string[] => out.split('\0').filter(p => p !== '')
      // Directory names are paths, never globs: `--literal-pathspecs` keeps `[`, `*` or `:` in them literal.
      const listIgnored = async (more: string[]): Promise<string[]> =>
        nul(await this.git([...(more.includes('--') ? ['--literal-pathspecs'] : []), 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...more], { runner }))
      let ignored = await listIgnored(['--directory'])
      const targetPaths = nul(await this.git(['ls-tree', '-r', '-z', '--name-only', target], { runner }))
      const expand = ignoredDirsToExpand(ignored, targetPaths)
      if (expand.length > 0) {
        const drop = new Set(expand)
        ignored = [...ignored.filter(p => !drop.has(p)), ...(await listIgnored(['--', ...expand]))]
      }
      const conflicts = ignoredConflicts(ignored, targetPaths)
      if (conflicts.length > 0) {
        const more = conflicts.length > MAX_NAMED ? ` (and ${conflicts.length - MAX_NAMED} more)` : ''
        throw new Error(`restore would overwrite ignored files that no snapshot holds: ${conflicts.slice(0, MAX_NAMED).join(', ')}${more}; move them aside and run the restore again`)
      }
      const commit = (await this.git(['commit-tree', `${target}^{tree}`, '-p', from, '-p', target, '-m', message], { runner })).trim()
      await this.git(['read-tree', '-u', '--reset', target], { runner })
      try {
        await this.git(['update-ref', ref, commit], { runner })
      } catch (error) {
        throw new Error(`files were restored but the restore could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
      }
      return commit
    })
  }

  updateRef(ref: string, commit: string): Promise<void> {
    return this.serial(async runner => {
      await this.git(['update-ref', ref, commit], { runner })
    })
  }

  // A snapshot's files written into `dir` (existing and empty) through a throwaway index beside it.
  exportTo(commit: string, dir: string): Promise<void> {
    return this.serial(async runner => {
      await this.git(['read-tree', '-u', '--reset', commit], { index: `${dir}.index`, workTree: dir, runner })
    })
  }

  deleteRefs(prefix: string): Promise<void> {
    return this.serial(async runner => {
      const refs = (await this.git(['for-each-ref', '--format=%(refname)', prefix], { runner })).split('\n').filter(l => l !== '')
      for (const ref of refs) await this.git(['update-ref', '-d', ref], { runner })
    })
  }

  // Only when git judges it due; never prunes recent loose objects.
  gc(): Promise<void> {
    return this.serial(async runner => {
      await this.git(['gc', '--auto', '--quiet'], { timeoutMs: 120_000, runner })
    })
  }
}

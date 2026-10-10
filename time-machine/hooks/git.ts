import type { FileChange } from './core/types.ts'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunOptions = { env?: Record<string, string>; cwd?: string; timeoutMs?: number }
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>
export type SnapResult = { commit: string; changed: boolean; files: FileChange[]; filesTotal: number }

export const MAX_FILES = 200
const TIMEOUT_MS = 30_000
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

  // One operation at a time: parallel tool calls share the index.
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  async git(args: readonly string[], opts: { index?: string; workTree?: string; timeoutMs?: number } = {}): Promise<string> {
    const workTree = opts.workTree ?? this.workTree
    const argv = ['git', `--git-dir=${this.gitDir}`, `--work-tree=${workTree}`, '-c', 'core.quotepath=off', ...args]
    const result = await this.runner(argv, {
      cwd: workTree,
      env: {
        ...IDENTITY,
        GIT_DIR: this.gitDir,
        GIT_WORK_TREE: workTree,
        GIT_OBJECT_DIRECTORY: `${this.gitDir}/objects`,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
        GIT_NAMESPACE: '',
        GIT_INDEX_FILE: opts.index ?? this.indexFile,
      },
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    })
    if (result.exitCode !== 0) throw new GitError(args, result)
    return result.stdout
  }

  // Idempotent: re-running init on an existing repository leaves it as it is.
  async init(): Promise<void> {
    const args = ['init', '--bare', '--quiet', this.gitDir]
    const result = await this.runner(['git', ...args], {
      env: { GIT_OBJECT_DIRECTORY: `${this.gitDir}/objects`, GIT_ALTERNATE_OBJECT_DIRECTORIES: '', GIT_NAMESPACE: '' },
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

  // Stage the work tree; commit only when its tree differs from `parent`'s.
  snapshot(parent: string | undefined, message: string, ref: string): Promise<SnapResult> {
    return this.serial(async () => {
      await this.git(['add', '-A'])
      const tree = (await this.git(['write-tree'])).trim()
      if (parent !== undefined) {
        const parentTree = (await this.git(['rev-parse', `${parent}^{tree}`])).trim()
        if (parentTree === tree) return { commit: parent, changed: false, files: [], filesTotal: 0 }
      }
      const commit = (await this.git(['commit-tree', tree, ...(parent !== undefined ? ['-p', parent] : []), '-m', message])).trim()
      await this.git(['update-ref', ref, commit])
      if (parent === undefined) {
        const listed = (await this.git(['ls-tree', '-r', '--name-only', commit])).split('\n').filter(l => l !== '')
        return { commit, changed: true, files: [], filesTotal: listed.length }
      }
      const files = parseNameStatus(await this.git(['diff', '--name-status', '-M', parent, commit]))
      return { commit, changed: true, files: files.slice(0, MAX_FILES), filesTotal: files.length }
    })
  }

  nameStatus(a: string, b: string): Promise<FileChange[]> {
    return this.serial(async () => parseNameStatus(await this.git(['diff', '--name-status', '-M', a, b])))
  }

  diffText(a: string, b: string): Promise<{ stat: string; patch: string }> {
    return this.serial(async () => ({ stat: await this.git(['diff', '--stat', a, b]), patch: await this.git(['diff', a, b]) }))
  }

  // The work tree made to match `target`: tracked files rewritten, files `target` lacks removed, ignored
  // files untouched. `from` is the commit the caller just snapshotted; if the work tree no longer
  // matches it, nothing is touched, so unsnapshotted work is never lost.
  restore(target: string, ref: string, from: string): Promise<void> {
    return this.serial(async () => {
      await this.git(['add', '-A'])
      const tree = (await this.git(['write-tree'])).trim()
      const fromTree = (await this.git(['rev-parse', `${from}^{tree}`])).trim()
      if (tree !== fromTree) throw new Error('the work tree changed since the last snapshot; run the restore again')
      await this.git(['read-tree', '-u', '--reset', target])
      await this.git(['update-ref', ref, target])
    })
  }

  updateRef(ref: string, commit: string): Promise<void> {
    return this.serial(async () => {
      await this.git(['update-ref', ref, commit])
    })
  }

  // A snapshot's files written into `dir` (existing and empty) through a throwaway index beside it.
  exportTo(commit: string, dir: string): Promise<void> {
    return this.serial(async () => {
      await this.git(['read-tree', '-u', '--reset', commit], { index: `${dir}.index`, workTree: dir })
    })
  }

  deleteRefs(prefix: string): Promise<void> {
    return this.serial(async () => {
      const refs = (await this.git(['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(l => l !== '')
      for (const ref of refs) await this.git(['update-ref', '-d', ref])
    })
  }

  gc(): Promise<void> {
    return this.serial(async () => {
      await this.git(['gc', '--prune=now', '--quiet'], { timeoutMs: 120_000 })
    })
  }
}

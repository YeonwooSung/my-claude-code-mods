import { redactSecrets } from './redact.ts'
export type ProcessResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }
export type Port = {
  cwd: string
  read(path: string): Promise<string>
  run(argv: readonly string[]): Promise<ProcessResult>
  env(name: string): Promise<string | undefined>
  revision(): Promise<string | undefined>
  replay?(command: string): Promise<unknown>
}
export type Observation = { tool: string; input: Record<string, unknown>; result: unknown; before?: string; after?: string }
export function object(v: unknown): Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {} }
export function safeText(v: unknown, limit = 4000): string {
  return redactSecrets(String(v ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')).slice(0, limit)
}
export function hash(text: string): string {
  return [0, 0x9747b28c].map(seed => {
    let h = (0x811c9dc5 ^ seed) >>> 0
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    return (h >>> 0).toString(16).padStart(8, '0')
  }).join('')
}
export function relativePath(root: string, path: string): string | undefined {
  const normalize = (p: string) => {
    const parts: string[] = []
    for (const s of p.replace(/\\/g, '/').split('/')) {
      if (!s || s === '.') continue
      if (s === '..') { if (!parts.length) return undefined; parts.pop() } else parts.push(s)
    }
    return parts.join('/')
  }
  const base = normalize(root); if (base === undefined) return undefined
  const full = normalize(path.startsWith('/') ? path : `${root}/${path}`)
  if (full === undefined || !(full === base || full.startsWith(base + '/'))) return undefined
  return full.slice(base.length).replace(/^\//, '')
}
export function changedPaths(status: string): string[] {
  const entries = status.split('\0'); const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]!; if (line.length < 4) continue
    paths.push(line.slice(3))
    if (/[RC]/.test(line.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]!)
  }
  return [...new Set(paths)]
}
export async function git(io: Port, args: string[]): Promise<string> {
  const r = await io.run(['git', '-C', io.cwd, ...args])
  if (r.exitCode !== 0 || r.isStdoutTruncated || r.isStderrTruncated) throw new Error('Git evidence unavailable or incomplete')
  if (r.stdout.length > 2 * 1024 * 1024) throw new Error('Git evidence exceeds 2 MiB limit')
  return r.stdout
}
export async function statusPaths(io: Port): Promise<string[]> { return changedPaths(await git(io, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) }
export async function revision(io: Port): Promise<string | undefined> {
  try {
    const diff = await git(io, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'])
    const status = await git(io, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const paths = (await git(io, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort()
    if (paths.length > 200) return undefined
    const bodies: string[] = [diff, status]; let size = diff.length + status.length
    for (const path of paths) {
      if (relativePath(io.cwd, path) !== path) return undefined
      const body = await io.read(`${io.cwd}/${path}`); size += body.length
      if (size > 2 * 1024 * 1024) return undefined
      bodies.push(path, body)
    }
    return hash(JSON.stringify(bodies))
  } catch { return undefined }
}
export function outcome(result: unknown): 'pass' | 'fail' | 'unknown' {
  const a = object(result), r = object(a.result)
  if (a.deny !== undefined) return 'unknown'
  for (const v of [a, r]) {
    if (['interrupted', 'cancelled', 'canceled', 'timedOut', 'timed_out', 'truncated', 'output_truncated'].some(k => v[k] === true)) return 'unknown'
    if (['task_id', 'taskId', 'backgroundTaskId', 'background_task_id'].some(k => v[k] !== undefined && v[k] !== null && v[k] !== '')) return 'unknown'
  }
  if (a.isError === true) return 'fail'
  const code = r.exitCode ?? r.exit_code
  return typeof code === 'number' && Number.isInteger(code) ? code === 0 ? 'pass' : 'fail' : 'unknown'
}
export function isCheck(command: string): boolean {
  // Conservative whole-command allowlist; compound shell programs are not proof of a check.
  return /^(?:(?:npm|pnpm|yarn) (?:run )?(?:test(?::[\w-]+)?|typecheck|lint)|npx (?:tsc|vitest|jest|eslint)|(?:pytest|vitest|jest|tsc|eslint)|cargo (?:test|check|clippy)|go test)\b[^;&|<>\n]*$/.test(command.trim())
}
export function restore<T extends object>(value: unknown, defaults: T): T {
  const v = object(value); const out = { ...defaults } as Record<string, unknown>
  for (const [k, fallback] of Object.entries(defaults)) {
    const item = v[k]
    if (Array.isArray(fallback) ? Array.isArray(item) : typeof item === typeof fallback && item !== null) out[k] = item
  }
  return out as T
}
export const entries = (args: string): string[] => args.split('|').map(s => s.trim())
export function bounded<T>(items: T[]): T[] { return items.slice(-200) }
// Clean string leaves before JSON serialization, never regex-rewrite serialized JSON syntax.
export function safeData(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value)
  if (Array.isArray(value)) return value.map(safeData)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeData(v)]))
  return value
}

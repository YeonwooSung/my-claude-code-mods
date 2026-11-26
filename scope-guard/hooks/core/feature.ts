import { bounded, object, pathIdentity, relativePath, restore, safeText, statusPaths, type Observation, type Port } from './runtime.ts'
export class Feature {
  data: { allowed: string[]; baseline: string[]; baselineIncomplete: boolean; writes: string[] }
  constructor(value?: unknown) { this.data = restore(value, { allowed: [] as string[], baseline: [] as string[], baselineIncomplete: false, writes: [] as string[] }) }
  async observe(e: Observation, io: Port): Promise<void> {
    if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.tool) || object(e.result).deny !== undefined || object(e.result).isError === true) return
    const target = e.input.file_path ?? e.input.notebook_path
    if (typeof target === 'string') this.data.writes = bounded([...new Set([...this.data.writes, safeText(relativePath(io.cwd, target) ?? target)])])
  }
  async command(args: string, io: Port): Promise<string> {
    const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
    const verb = parsed?.[1] ?? '', path = parsed?.[2] ?? ''
    if (verb === 'allow') {
      const rel = relativePath(io.cwd, path)
      if (!path || rel === undefined || /(^|\/)\.\.(\/|$)/.test(path)) return 'Invalid project-relative scope path'
      if (!this.data.allowed.length) { const baseline = await statusPaths(io); this.data.baseline = bounded(baseline); this.data.baselineIncomplete = baseline.length > 200 }
      this.data.allowed = bounded([...new Set([...this.data.allowed, rel || '.'])])
    } else if (verb === 'help') return '/scope [allow <path> | list | reset] — warnings only, existing changes labelled; . allows the project.'
    else if (verb && verb !== 'list') return 'Usage: /scope [allow <path> | list | reset]'
    if (!this.data.allowed.length) return 'Scope Guard: No scope configured. /scope allow <path>'
    const key = (path: string) => {
      const identity = pathIdentity(io.cwd, path)
      return identity === undefined ? `raw:${path}` : `path:${identity}`
    }
    const seen = new Set<string>(), baseline = new Set(this.data.baseline.map(key)), writes = new Set(this.data.writes.map(key))
    const paths = [...await statusPaths(io), ...this.data.writes].filter(path => {
      const id = key(path)
      if (seen.has(id)) return false
      seen.add(id); return true
    })
    return ['Scope Guard — allowed: ' + this.data.allowed.join(', '), ...paths.slice(0, 200).map(path => {
      const allowed = this.data.allowed.some(a => a === '.' ? relativePath(io.cwd, path) !== undefined : path === a || path.startsWith(a + '/'))
      return `${baseline.has(key(path)) && !writes.has(key(path)) ? 'PRE-EXISTING' : allowed ? 'IN-SCOPE' : this.data.baselineIncomplete && !writes.has(key(path)) ? 'BASELINE-UNKNOWN' : 'OUTSIDE'} ${safeText(path)}`
    }), ...(this.data.baselineIncomplete ? ['INCOMPLETE: pre-existing baseline exceeded 200 paths; unrecorded original changes cannot be distinguished'] : []), ...(paths.length > 200 ? ['INCOMPLETE: more than 200 changed paths'] : [])].join('\n')
  }
}

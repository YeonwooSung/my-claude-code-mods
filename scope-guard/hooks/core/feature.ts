import { bounded, object, relativePath, restore, safeText, statusPaths, type Observation, type Port } from './runtime.ts'
export class Feature {
  data: { allowed: string[]; baseline: string[]; writes: string[] }
  constructor(value?: unknown) { this.data = restore(value, { allowed: [] as string[], baseline: [] as string[], writes: [] as string[] }) }
  async observe(e: Observation, io: Port): Promise<void> {
    if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.tool) || object(e.result).deny !== undefined || object(e.result).isError === true) return
    const target = e.input.file_path ?? e.input.notebook_path
    if (typeof target === 'string') this.data.writes = bounded([...new Set([...this.data.writes, safeText(relativePath(io.cwd, target) ?? target)])])
  }
  async command(args: string, io: Port): Promise<string> {
    const [verb, ...rest] = args.trim().split(/\s+/); const path = rest.join(' ')
    if (verb === 'allow') {
      const rel = relativePath(io.cwd, path)
      if (!path || rel === undefined || /(^|\/)\.\.(\/|$)/.test(path)) return 'Invalid project-relative scope path'
      if (!this.data.allowed.length) this.data.baseline = bounded(await statusPaths(io))
      this.data.allowed = bounded([...new Set([...this.data.allowed, rel || '.'])])
    } else if (verb === 'help') return '/scope [allow <path> | list | reset] — warnings only, existing changes labelled; . allows the project.'
    else if (verb && verb !== 'list') return 'Usage: /scope [allow <path> | list | reset]'
    if (!this.data.allowed.length) return 'Scope Guard: No scope configured. /scope allow <path>'
    const paths = [...new Set([...await statusPaths(io), ...this.data.writes])]
    return ['Scope Guard — allowed: ' + this.data.allowed.join(', '), ...paths.slice(0, 200).map(path => {
      const allowed = this.data.allowed.some(a => a === '.' ? relativePath(io.cwd, path) !== undefined : path === a || path.startsWith(a + '/'))
      return `${this.data.baseline.includes(path) && !this.data.writes.includes(path) ? 'PRE-EXISTING' : allowed ? 'IN-SCOPE' : 'OUTSIDE'} ${safeText(path)}`
    }), ...(paths.length > 200 ? ['INCOMPLETE: more than 200 changed paths'] : [])].join('\n')
  }
}

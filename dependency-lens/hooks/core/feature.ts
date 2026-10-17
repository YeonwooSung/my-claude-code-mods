import { git, object, restore, safeText, type Port } from './runtime.ts'
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  return value
}
function validPackages(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => item !== null && typeof item === 'object' && !Array.isArray(item))
}
export function compare(beforeValue: unknown, afterValue: unknown, oldValue: unknown, newValue: unknown): string[] {
  const before = object(beforeValue), after = object(afterValue), old = object(oldValue), next = object(newValue), lines: string[] = [], direct = new Set<string>()
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const a = object(before[section]), b = object(after[section])
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      direct.add(`node_modules/${name}`)
      if (a[name] !== b[name]) lines.push(`DIRECT ${section} ${safeText(name)}: ${safeText(a[name] ?? '(absent)')} -> ${safeText(b[name] ?? '(absent)')}`)
    }
  }
  const aScripts = object(before.scripts), bScripts = object(after.scripts)
  for (const name of ['preinstall', 'install', 'postinstall']) if (aScripts[name] !== bScripts[name]) lines.push(`LIFECYCLE ${name}: ${aScripts[name] === undefined ? 'added' : bScripts[name] === undefined ? 'removed' : 'changed'}`)
  if (![2, 3].includes(Number(old.lockfileVersion)) || ![2, 3].includes(Number(next.lockfileVersion)) || !validPackages(old.packages) || !validPackages(next.packages)) {
    lines.push('INCOMPLETE: npm package-lock v2/v3 required on both sides; manifest comparison only')
    return lines.length > 200 ? [...lines.slice(0, 200), 'INCOMPLETE: report limited to 200 entries'] : lines
  }
  const a = object(old.packages), b = object(next.packages); let added = 0, removed = 0, changed = 0
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!path) continue
    const av = object(a[path]), bv = object(b[path])
    if (JSON.stringify(stable(av)) === JSON.stringify(stable(bv))) continue
    const kind = a[path] === undefined ? 'ADDED' : b[path] === undefined ? 'REMOVED' : 'CHANGED'
    if (kind === 'ADDED') added++; else if (kind === 'REMOVED') removed++; else changed++
    lines.push(`${direct.has(path) ? 'DIRECT-LOCK' : 'TRANSITIVE'} ${kind} ${safeText(path)}: ${safeText(av.version ?? '(absent)')} -> ${safeText(bv.version ?? '(absent)')}`)
    if (bv.hasInstallScript === true) lines.push(`INSTALL-SCRIPT ${safeText(path)}`)
  }
  lines.unshift(`Lock delta: +${added} -${removed} ~${changed}; install-script markers are metadata, not a security verdict.`)
  return lines.length > 200 ? [...lines.slice(0, 200), 'INCOMPLETE: report limited to 200 entries'] : lines
}
function parse(text: string): Record<string, unknown> {
  if (text.length > 2 * 1024 * 1024) throw new Error('JSON exceeds 2 MiB limit')
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}
export class Feature {
  data: { base: string }
  constructor(value?: unknown) { this.data = restore(value, { base: 'HEAD' }) }
  async command(args: string, io: Port): Promise<string> {
    if (args.trim() === 'help') return '/deps [base <git-ref> | list | reset] — compares HEAD (or explicit ref) with working npm manifest and package-lock v2/v3; never installs packages.'
    if (args.trim().startsWith('base ')) {
      const ref = args.trim().slice(5).trim()
      if (!/^[A-Za-z0-9_][A-Za-z0-9_./~^{}@-]{0,199}$/.test(ref)) return 'Invalid Git base ref'
      this.data.base = ref
    } else if (args.trim() && args.trim() !== 'list') return 'Usage: /deps [base <git-ref> | list | reset]'
    const title = `Dependency Lens — base: ${safeText(this.data.base)}`
    try {
      await git(io, ['rev-parse', '--verify', `${this.data.base}^{commit}`])
      const oldFile = async (path: string) => {
        const names = await git(io, ['ls-tree', '-z', '--name-only', this.data.base, '--', path])
        if (!names.split('\0').includes(path)) return undefined
        return parse(await git(io, ['show', `${this.data.base}:${path}`]))
      }
      const newFile = async (path: string) => {
        let body: string
        try { body = await io.read(`${io.cwd}/${path}`) } catch (error) {
          if (object(error).code === 'ENOENT') return undefined
          if (io.list && !(await io.list(io.cwd)).includes(path)) return undefined
          throw new Error(`${path} unavailable; absence could not be established`)
        }
        return parse(body)
      }
      const before = await oldFile('package.json'), after = await newFile('package.json')
      if (!before && !after) throw new Error('package.json unavailable on both sides')
      const oldLock = await oldFile('package-lock.json'), newLock = await newFile('package-lock.json')
      return [title, ...compare(before, after, oldLock, newLock)].join('\n')
    } catch (error) { return `${title}\nINCOMPLETE: ${safeText(error instanceof Error ? error.message : error)}` }
  }
}

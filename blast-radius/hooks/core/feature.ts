import { bounded, git, relativePath, restore, safeText, statusPaths, type Port } from './runtime.ts'
export function analyze(files: Record<string, string>, changed: string[]): { affected: string[]; tests: string[]; unresolved: string[] } {
  const known = new Set([...Object.keys(files), ...changed]), reverse = new Map<string, Set<string>>(), unresolved: string[] = []
  for (const [path, body] of Object.entries(files)) {
    // Candidate graph, not a parser/LSP: only static relative JS/TS import strings are resolved.
    const source = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const pattern = /\b(?:import\s*(?:[^'";\n]*?\sfrom\s*)?|export\s+[^'";\n]*?\sfrom\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]!
      if (!specifier.startsWith('.')) { if (/^[@~]\//.test(specifier)) unresolved.push(`${path}: ${specifier}`); continue }
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
      const base = relativePath('/project', dir + specifier)
      if (base === undefined) { unresolved.push(`${path}: ${specifier}`); continue }
      const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js'].map(ext => stem + ext)]
      const target = candidates.find(candidate => known.has(candidate))
      if (!target) { unresolved.push(`${path}: ${specifier}`); continue }
      if (!reverse.has(target)) reverse.set(target, new Set())
      reverse.get(target)!.add(path)
    }
  }
  const visited = new Set(changed), queue = [...changed]
  for (let i = 0; i < queue.length; i++) for (const path of reverse.get(queue[i]!) ?? []) if (!visited.has(path)) { visited.add(path); queue.push(path) }
  const affected = [...visited].filter(path => !changed.includes(path)).sort()
  return { affected, tests: [...new Set([...affected, ...changed])].filter(path => /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)).sort(), unresolved: [...new Set(unresolved)].sort() }
}
export class Feature {
  data: { targets: string[] }
  constructor(value?: unknown) { this.data = restore(value, { targets: [] as string[] }) }
  async command(args: string, io: Port): Promise<string> {
    if (args.trim() === 'help') return '/blast [watch <path> | <path> | reset] — relative JS/TS import candidates, not complete semantic reachability.'
    const watch = args.trim().startsWith('watch '), target = args.trim().replace(/^watch\s+/, '')
    if (target) {
      const rel = relativePath(io.cwd, target)
      if (!rel || /(^|\/)\.\.(\/|$)/.test(target)) return 'Invalid project-relative target'
      if (watch) this.data.targets = bounded([...new Set([...this.data.targets, rel])])
    }
    const changed = target ? [relativePath(io.cwd, target)!] : [...new Set([...this.data.targets, ...await statusPaths(io)])]
    const all = (await git(io, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    const paths = [...new Set(all)].filter(p => /\.[cm]?[jt]sx?$/.test(p)); const files: Record<string, string> = {}; let size = 0, incomplete = paths.length > 2000
    for (const path of paths.slice(0, 2000)) {
      if (relativePath(io.cwd, path) !== path) { incomplete = true; continue }
      try { const body = await io.read(`${io.cwd}/${path}`); size += body.length; if (size > 2 * 1024 * 1024) { incomplete = true; break } files[path] = body }
      catch { incomplete = true }
    }
    const r = analyze(files, changed)
    return ['Blast Radius — relative JS/TS static import candidates only', 'Targets: ' + (changed.map(p => safeText(p)).join(', ') || '(none)'), ...r.affected.slice(0, 200).map(p => 'AFFECTED ' + safeText(p)), ...r.tests.slice(0, 200).map(p => 'TEST ' + safeText(p)), ...r.unresolved.slice(0, 200).map(p => 'UNRESOLVED ' + safeText(p)), ...(incomplete || r.affected.length > 200 || r.unresolved.length > 200 ? ['INCOMPLETE: scan/report limit reached or unreadable files'] : [])].join('\n')
  }
}

import { bounded, object, restore, safeText, type Port } from './runtime.ts'
type Match = 'match' | 'mismatch' | 'unknown'
export function satisfies(version: string, range: string): Match {
  const v = version.trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(v)) return 'unknown'
  const actual = v.split('.').map(Number)
  const compare = (expected: number[]) => { for (let i = 0; i < 3; i++) { const diff = actual[i]! - (expected[i] ?? 0); if (diff) return Math.sign(diff) } return 0 }
  const r = range.trim()
  if (r.includes('||')) {
    const results = r.split('||').map(part => satisfies(v, part))
    return results.includes('match') ? 'match' : results.includes('unknown') ? 'unknown' : 'mismatch'
  }
  if (r === '*') return 'match'
  if (/^\d+(?:\.(?:\d+|x|\*)){0,2}$/.test(r)) {
    const parts = r.split('.')
    const wildcard = parts.findIndex(p => p === 'x' || p === '*')
    if (wildcard >= 0 && parts.slice(wildcard).some(p => p !== 'x' && p !== '*')) return 'unknown'
    return parts.every((p, i) => p === 'x' || p === '*' || Number(p) === actual[i]) ? 'match' : 'mismatch'
  }
  const checks: boolean[] = []
  for (const token of r.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=|\^|~)(\d+(?:\.\d+){0,2})$/.exec(token)
    if (!match) return 'unknown'
    const p = match[2]!.split('.').map(Number), cmp = compare(p)
    switch (match[1]) {
      case '>=': checks.push(cmp >= 0); break
      case '<=': checks.push(cmp <= 0); break
      case '>': checks.push(cmp > 0); break
      case '<': checks.push(cmp < 0); break
      case '=': if (p.length !== 3) return 'unknown'; checks.push(cmp === 0); break
      case '^': {
        if (p.length !== 3) return 'unknown'
        const upper = [...p], index = p.findIndex(n => n !== 0)
        const bump = index < 0 ? 2 : index
        upper[bump] = upper[bump]! + 1
        for (let i = bump + 1; i < 3; i++) upper[i] = 0
        checks.push(cmp >= 0 && compare(upper) < 0); break
      }
      case '~': if (p.length !== 3) return 'unknown'; checks.push(cmp >= 0 && compare([p[0]!, p[1]! + 1, 0]) < 0); break
    }
  }
  return checks.length && checks.every(Boolean) ? 'match' : 'mismatch'
}
export class Feature {
  data: { requiredEnv: string[] }
  constructor(value?: unknown) { this.data = restore(value, { requiredEnv: [] as string[] }) }
  async command(args: string, io: Port): Promise<string> {
    const [verb, ...rest] = args.trim().split(/\s+/)
    if (verb === 'help') return '/doctor [check | require <ENV_NAME> | reset] — Node/package-manager versions and variable presence only. Ranges: exact/major/x, comparisons, full ^/~, ||; other syntax UNKNOWN.'
    if (verb === 'require') {
      const name = rest.join(' ')
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'Invalid environment variable name'
      this.data.requiredEnv = bounded([...new Set([...this.data.requiredEnv, name])])
    } else if (verb && verb !== 'check') return 'Usage: /doctor [check | require <ENV_NAME> | reset]'
    let manifest: Record<string, unknown>
    try { manifest = object(JSON.parse(await io.read(`${io.cwd}/package.json`))) }
    catch { return 'Env Doctor: package.json manifest unavailable or malformed' }
    const engines = object(manifest.engines), lines = ['Env Doctor — presence only; no environment values retained']
    const inspect = async (binary: string, range: string) => {
      try {
        const r = await io.run([binary, '--version'])
        const version = r.stdout.trim()
        const match = r.exitCode !== 0 || r.isStdoutTruncated || !range ? 'unknown' : satisfies(version, range)
        lines.push(`${binary}: ${safeText(version || '(unavailable)', 100)} — ${match.toUpperCase()} ${safeText(range || '(no requirement)')}`)
      } catch { lines.push(`${binary}: UNKNOWN (binary unavailable)`) }
    }
    await inspect('node', typeof engines.node === 'string' ? engines.node : '')
    const declared = typeof manifest.packageManager === 'string' ? /^(npm|pnpm|yarn)@([^+]+)(?:\+.*)?$/.exec(manifest.packageManager) : undefined
    if (declared) await inspect(declared[1]!, declared[2]!)
    else for (const binary of ['npm', 'pnpm', 'yarn']) if (typeof engines[binary] === 'string') await inspect(binary, engines[binary] as string)
    if (manifest.packageManager && !declared) lines.push('Package manager: UNKNOWN unsupported declaration')
    for (const name of this.data.requiredEnv) {
      try { lines.push(`${name}: ${await io.env(name) ? 'SET' : 'MISSING'}`) }
      catch { lines.push(`${name}: UNKNOWN (presence unavailable)`) }
    }
    return lines.join('\n')
  }
}

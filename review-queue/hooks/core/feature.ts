import { bounded, entries, git, hash, relativePath, restore, safeText, statusPaths, type Port } from './runtime.ts'
type Group = { purpose: string; path: string }
type Review = { path: string; signature: string }
async function signature(io: Port, path: string): Promise<string | undefined> {
  try {
    const staged = await git(io, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached', 'HEAD', '--', path])
    const unstaged = await git(io, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--', path])
    if (io.stat) {
      try { if ((await io.stat(`${io.cwd}/${path}`)).isLink) return undefined } catch { /* Deleted files can still have complete diff evidence. */ }
    }
    let body: string | undefined
    try { body = await (io.bytes ?? io.read)(`${io.cwd}/${path}`); if (body.length > 2 * 1024 * 1024) return undefined } catch { /* Deleted files have complete binary diff evidence. */ }
    if (body === undefined && !staged && !unstaged) return undefined
    return hash(JSON.stringify([staged, unstaged, body]))
  } catch { return undefined }
}
export class Feature {
  data: { groups: Group[]; reviews: Review[] }
  constructor(value?: unknown) { this.data = restore(value, { groups: [] as Group[], reviews: [] as Review[] }) }
  async command(args: string, io: Port): Promise<string> {
    const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
    const verb = parsed?.[1] ?? '', text = parsed?.[2] ?? ''
    if (verb === 'help') return '/review-queue [group <purpose> | <path>] [mark <path> | unmark <path> | list | reset] — file-level review; staged and unstaged edits invalidate marks.'
    if (verb === 'group') {
      const [purpose, path = ''] = entries(text), rel = relativePath(io.cwd, path)
      if (!purpose || !path || !rel || /(^|\/)\.\.(\/|$)/.test(path) || safeText(rel) !== rel) return 'Invalid group/path: group <purpose> | <project-relative path>'
      this.data.groups = bounded([...this.data.groups.filter(g => g.path !== rel), { purpose: safeText(purpose, 500), path: rel }])
    } else if (verb === 'mark' || verb === 'unmark') {
      const path = relativePath(io.cwd, text)
      if (!path || /(^|\/)\.\.(\/|$)/.test(text) || safeText(path) !== path) return 'Invalid project-relative path'
      if (verb === 'unmark') this.data.reviews = this.data.reviews.filter(r => r.path !== path)
      else {
        let paths: string[]
        try { paths = await statusPaths(io) } catch { return 'INCOMPLETE: changed files unavailable; review not marked' }
        if (!paths.includes(path)) return 'File not changed; review not marked'
        const current = await signature(io, path)
        if (!current) return 'INCOMPLETE: diff evidence unavailable; review not marked'
        this.data.reviews = bounded([...this.data.reviews.filter(r => r.path !== path), { path, signature: current }])
      }
    } else if (verb && verb !== 'list') return 'Usage: /review-queue [group <purpose> | <path>] [mark <path> | unmark <path> | list | reset]'
    let paths: string[]
    try { paths = await statusPaths(io) } catch { return 'Review Queue: INCOMPLETE changed files unavailable' }
    const sections = new Map<string, string[]>(); let incomplete = paths.length > 200
    for (const path of paths.slice(0, 200)) {
      const purpose = this.data.groups.find(g => g.path === path)?.purpose ?? 'Ungrouped'
      const current = await signature(io, path), previous = this.data.reviews.find(r => r.path === path)
      if (!current) incomplete = true
      const state = !current ? 'UNKNOWN' : !previous ? 'PENDING' : previous.signature === current ? 'REVIEWED' : 'STALE'
      if (!sections.has(purpose)) sections.set(purpose, [])
      sections.get(purpose)!.push(`${state} ${safeText(path)}`)
    }
    return ['Review Queue — file-level purpose groups', 'Configured groups: ' + (this.data.groups.map(g => `${g.purpose} (${safeText(g.path)})`).join(', ') || '(none)'), ...[...sections].flatMap(([purpose, lines]) => ['', `[${purpose}]`, ...lines]), ...(paths.length ? [] : ['No changed files.']), ...(incomplete ? ['INCOMPLETE: unreadable evidence or 200-file limit'] : [])].join('\n')
  }
}

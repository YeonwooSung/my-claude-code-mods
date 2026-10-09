import type { CompactionView } from './analyze/compaction.ts'
import type { Rereads } from './analyze/rereads.ts'
import type { Cluster } from './analyze/similar.ts'
import { fmtCount } from './format.ts'
import type { ContextItem } from './types.ts'

export type Severity = 'high' | 'medium' | 'low'
export type Advice = { id: string; severity: Severity; title: string; evidence: string; action: string; savings: number }
export type BreakdownLite = {
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles: { path: string; tokens: number }[]
}
export type AdviceInput = {
  items: readonly ContextItem[]
  k: number
  rereads: Rereads
  clusters: readonly Cluster[]
  compactions: readonly CompactionView[]
  breakdown?: BreakdownLite
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export function severityOf(savings: number): Severity {
  return savings >= 10_000 ? 'high' : savings >= 3_000 ? 'medium' : 'low'
}

const tok = (n: number): string => `≈${fmtCount(n)}`
const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
const short = (s: string): string => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

function list<T>(xs: readonly T[], show: (x: T) => string, n = 3): string {
  const head = xs.slice(0, n).map(show).join(', ')
  return xs.length > n ? `${head}, +${xs.length - n} more` : head
}

// Rule-based recommendations (spec §4.6); every one names its evidence and an estimated saving.
export function advise(input: AdviceInput): Advice[] {
  const { items, k, rereads, clusters, compactions, breakdown } = input
  const est = (i: ContextItem): number => Math.round(i.est * k)
  const out: Advice[] = []
  const push = (a: Omit<Advice, 'severity'>, floor?: Severity): void => {
    let severity = severityOf(a.savings)
    if (floor && RANK[floor] < RANK[severity]) severity = floor
    out.push({ ...a, severity })
  }

  const rereadFiles = rereads.files.filter(
    f => (f.classes['unchanged-live'] ?? 0) > 0 && (f.wasteEst >= 2_000 || f.reads - (f.classes['engine-deduped'] ?? 0) >= 3),
  )
  if (rereadFiles.length > 0)
    push({
      id: 'reread-unchanged',
      title: 'Unchanged files read again while the earlier copy is still in context',
      evidence: list(rereadFiles, f => `${base(f.path)} ×${f.reads} (${tok(f.wasteEst)})`),
      action: 'Refer to the earlier result; for one part, Grep or Read with offset/limit',
      savings: rereadFiles.reduce((s, f) => s + f.wasteEst, 0),
    })

  const bigReads = items.filter(i => i.category === 'Read' && i.target?.full === true && est(i) >= 8_000).sort((a, b) => b.est - a.est)
  if (bigReads.length > 0)
    push({
      id: 'large-read',
      title: 'Whole large files read into context',
      evidence: list(bigReads, i => `${base(i.target!.value)} (${tok(est(i))})`),
      action: 'Grep for the symbol first, then Read with offset/limit',
      savings: bigReads.reduce((s, i) => s + est(i) - 2_000, 0),
    })

  const bigBash = items.filter(i => i.category === 'Bash' && est(i) >= 5_000).sort((a, b) => b.est - a.est)
  if (bigBash.length > 0)
    push({
      id: 'large-bash',
      title: 'Long command output',
      evidence: list(bigBash, i => `${short(i.target?.value ?? 'Bash')} (${tok(est(i))})`),
      action: 'Pipe through tail or grep, or use quiet flags (-q, --silent)',
      savings: bigBash.reduce((s, i) => s + est(i) - 1_000, 0),
    })

  const repeated = clusters.filter(c => c.size >= 3 || c.wasteEst >= 3_000)
  if (repeated.length > 0)
    push({
      id: 'repeated-output',
      title: 'Near-identical tool output repeated',
      evidence: list(repeated, c => `${c.category} ${short(c.label)} ×${c.size} (${tok(c.wasteEst)})`),
      action: 'Narrow the rerun (only the failing test, a filter) or refer back to one result',
      savings: repeated.reduce((s, c) => s + c.wasteEst, 0),
    })

  const lost = compactions.filter(c => c.lostEdited.length > 0)
  if (lost.length > 0)
    push(
      {
        id: 'compaction-lost-edits',
        title: 'Compaction summaries dropped files that were edited',
        evidence: list(lost.flatMap(c => c.lostEdited), base, 5),
        action: 'Say what to keep: /compact keep <files and plan>, or keep the plan in a file',
        savings: lost.reduce((s, c) => s + c.reflowEst, 0),
      },
      'medium',
    )

  const reflow = compactions.reduce((s, c) => s + c.reflowEst, 0)
  if (reflow >= 5_000)
    push({
      id: 'compaction-reflow',
      title: 'Files read again after compaction',
      evidence: list(compactions.filter(c => c.reflowEst > 0), c => `${c.trigger} @turn ${c.turn} (${tok(c.reflowEst)})`),
      action: 'Compact with instructions naming the key files, or compact at a task boundary',
      savings: reflow,
    })

  const verbose = items.filter(i => (i.category === 'Agent' || i.category === 'Task') && est(i) >= 4_000).sort((a, b) => b.est - a.est)
  if (verbose.length > 0)
    push({
      id: 'agent-verbose',
      title: 'Subagents returned long results',
      evidence: list(verbose, i => `${short(i.target?.value ?? i.category)} (${tok(est(i))})`),
      action: 'Ask subagents for a short summary with file:line pointers',
      savings: verbose.reduce((s, i) => s + est(i) - 1_000, 0),
    })

  if (breakdown) {
    const used = new Set(items.map(i => i.category))
    const servers = new Map<string, { tokens: number; used: boolean }>()
    for (const t of breakdown.mcpTools) {
      if (!t.isLoaded) continue
      const s = servers.get(t.serverName) ?? { tokens: 0, used: false }
      s.tokens += t.tokens
      s.used ||= used.has(t.name)
      servers.set(t.serverName, s)
    }
    const idle = [...servers.entries()].filter(([, s]) => !s.used && s.tokens >= 3_000).sort((a, b) => b[1].tokens - a[1].tokens)
    if (idle.length > 0)
      push({
        id: 'mcp-unused',
        title: 'MCP tool schemas loaded but never called',
        evidence: list(idle, ([name, s]) => `${name} (${tok(s.tokens)})`),
        action: 'Disable the server for this project (/mcp), or let tool schemas load on demand',
        savings: idle.reduce((s, [, x]) => s + x.tokens, 0),
      })
    const memory = breakdown.memoryFiles.filter(f => f.tokens >= 4_000).sort((a, b) => b.tokens - a.tokens)
    if (memory.length > 0)
      push({
        id: 'memory-large',
        title: 'Large memory files loaded with every request',
        evidence: list(memory, f => `${base(f.path)} (${tok(f.tokens)})`),
        action: 'Trim CLAUDE.md; move rarely needed detail into files it links to',
        savings: memory.reduce((s, f) => s + f.tokens - 2_000, 0),
      })
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.savings - a.savings)
}

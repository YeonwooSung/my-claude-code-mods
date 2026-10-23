import { toolTiming } from './permission.ts'
import { classifyCommand, type BashCategory } from './classify.ts'
import { clip, fmtMs, pct } from './format.ts'
import { MAIN, isAgentTool, toolLabel } from './profiler.ts'
import type { Snapshot, ToolRec } from './types.ts'

export type Interval = [number, number]
export type Category = 'model' | 'subagent' | 'tool' | 'engine'
export type Scope = 'session' | 'turn'

export type Summary = {
  scope: Scope
  turns: number
  wallMs: number
  exclusive: Record<Category, number>
  model: {
    requests: number
    ttftAvg: number
    ttftP95: number
    thinkingMs: number
    outputMs: number
    inputTokens: number
    cacheReadTokens: number
    outputTokens: number
    tokensPerSec: number | null
  }
  tools: {
    calls: number
    sumMs: number
    unionMs: number
    execMs: number
    permissionObserved: number
    permissionTimed: number
    permissionMs: number
    // Approval wait as a share of agent time: the union of the waits inside main turns, so at most 1.
    permissionShare: number
    overheadMs: number
    errors: number
    denied: number
    byTool: { tool: string; calls: number; ms: number }[]
    slowest: { tool: string; label: string; ms: number; waitMs: number; ctx: string }[]
  }
  // testMs sums every test run; testShare is the union of test execution inside main turns over agent time (≤ 1).
  bash: { byCategory: { category: BashCategory; calls: number; ms: number }[]; testMs: number; testShare: number }
  reads: { path: string; reads: number; redundant: number }[]
  agents: { id: string; agentType: string; wallMs: number; modelMs: number; toolMs: number; requests: number; tools: number; blocking: boolean; done: boolean }[]
  findings: string[]
  incomplete: number
  droppedTurns: number
  droppedSpans: number
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const PRIORITY: Category[] = ['model', 'subagent', 'tool']

// Sorted, disjoint cover of the intervals.
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Interval[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

export function unionLength(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + b - a, 0)
}

// Length of (∪ intervals) ∩ (∪ windows).
export function overlapLength(intervals: Interval[], windows: Interval[]): number {
  const xs = mergeIntervals(intervals)
  const ws = mergeIntervals(windows)
  let total = 0
  for (let i = 0, j = 0; i < xs.length && j < ws.length; ) {
    const x = xs[i] as Interval
    const w = ws[j] as Interval
    total += Math.max(0, Math.min(x[1], w[1]) - Math.max(x[0], w[0]))
    if (x[1] < w[1]) i += 1
    else j += 1
  }
  return total
}

// Sweep line over the window: at every moment the highest-priority active category gets the time,
// and moments with nothing active are engine time. O(n log n) in the number of intervals.
export function attribute(window: Interval, tagged: { cat: Category; iv: Interval }[]): Record<Category, number> {
  const out: Record<Category, number> = { model: 0, subagent: 0, tool: 0, engine: 0 }
  const [w0, w1] = window
  if (w1 <= w0) return out
  const events: { t: number; d: number; cat: Category }[] = []
  for (const x of tagged) {
    const a = Math.max(w0, x.iv[0])
    const b = Math.min(w1, x.iv[1])
    if (b > a) events.push({ t: a, d: 1, cat: x.cat }, { t: b, d: -1, cat: x.cat })
  }
  events.sort((p, q) => p.t - q.t)
  const active: Record<Category, number> = { model: 0, subagent: 0, tool: 0, engine: 0 }
  const top = (): Category => PRIORITY.find(cat => active[cat] > 0) ?? 'engine'
  let at = w0
  for (const ev of events) {
    if (ev.t > at) {
      out[top()] += ev.t - at
      at = ev.t
    }
    active[ev.cat] += ev.d
  }
  if (w1 > at) out[top()] += w1 - at
  return out
}

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (k === undefined) continue
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
}

function scopeAgents(s: Snapshot, mainTools: ToolRec[], scope: Scope, toolById: Map<string, ToolRec>): Set<string> {
  if (scope === 'session') return new Set(s.agents.map(a => a.id))
  const toolIds = new Set(mainTools.map(t => t.id))
  const ids = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const agent of s.agents) {
      if (ids.has(agent.id) || !agent.parentToolId) continue
      const parent = toolById.get(agent.parentToolId)
      if (toolIds.has(agent.parentToolId) || (parent && ids.has(parent.ctx))) {
        ids.add(agent.id)
        grew = true
      }
    }
  }
  return ids
}

export function summarize(s: Snapshot, scope: Scope = 'session'): Summary {
  const end = (x: { end?: number }) => x.end ?? s.now
  let mainTurns = s.turns.filter(t => t.ctx === MAIN).sort((a, b) => a.start - b.start)
  if (scope === 'turn') mainTurns = mainTurns.slice(-1)
  const turnIds = new Set(mainTurns.map(t => t.id))
  const inScope = (turnId: string | undefined) => scope === 'session' || (turnId !== undefined && turnIds.has(turnId))
  const mainTools = s.tools.filter(t => t.ctx === MAIN && inScope(t.turnId))
  const toolById = new Map(s.tools.map(t => [t.id, t]))
  const agentIds = scopeAgents(s, mainTools, scope, toolById)
  const steps = s.steps.filter(x => (x.ctx === MAIN ? inScope(x.turnId) : agentIds.has(x.ctx)))
  const tools = [...mainTools, ...s.tools.filter(x => x.ctx !== MAIN && agentIds.has(x.ctx))]
  const agents = s.agents.filter(a => agentIds.has(a.id))

  const stepsByTurn = groupBy(steps, x => (x.ctx === MAIN ? x.turnId : undefined))
  const toolsByTurn = groupBy(mainTools, x => x.turnId)
  const exclusive: Record<Category, number> = { model: 0, subagent: 0, tool: 0, engine: 0 }
  let wallMs = 0
  for (const turn of mainTurns) {
    const window: Interval = [turn.start, end(turn)]
    wallMs += window[1] - window[0]
    const tagged = [
      ...(stepsByTurn.get(turn.id) ?? []).map(x => ({ cat: 'model' as Category, iv: [x.start, end(x)] as Interval })),
      ...(toolsByTurn.get(turn.id) ?? []).map(x => ({
        cat: (isAgentTool(x.tool) && x.launchedAsync !== true ? 'subagent' : 'tool') as Category,
        iv: [x.start, end(x)] as Interval,
      })),
    ]
    const part = attribute(window, tagged)
    for (const cat of Object.keys(part) as Category[]) exclusive[cat] += part[cat]
  }

  const ttfts = steps.filter(x => x.firstContent !== undefined).map(x => (x.firstContent as number) - x.start).sort((a, b) => a - b)
  let thinkingMs = 0
  let outputMs = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  let streamTokens = 0
  let streamMs = 0
  for (const x of steps) {
    if (x.thinkFirst !== undefined && x.thinkLast !== undefined) thinkingMs += x.thinkLast - x.thinkFirst
    if (x.outFirst !== undefined) outputMs += end(x) - x.outFirst
    if (x.usage) {
      inputTokens += x.usage.input_tokens + x.usage.cache_read_input_tokens + x.usage.cache_creation_input_tokens
      cacheReadTokens += x.usage.cache_read_input_tokens
      outputTokens += x.usage.output_tokens
      if (x.firstContent !== undefined) {
        streamTokens += x.usage.output_tokens
        streamMs += end(x) - x.firstContent
      }
    }
  }

  const plain = tools.filter(x => !isAgentTool(x.tool))
  const timed = plain.map(x => ({ x, ...toolTiming(x, s.now) }))
  const testIntervals: Interval[] = []
  const waitIntervals: Interval[] = []
  let execMs = 0
  let permissionMs = 0
  let overheadMs = 0
  let sumMs = 0
  const byTool = new Map<string, { tool: string; calls: number; ms: number }>()
  const byCategory = new Map<BashCategory, { category: BashCategory; calls: number; ms: number }>()
  for (const { x, wall, exec, wait, approval, otherWait } of timed) {
    sumMs += wall
    execMs += exec
    if (approval !== undefined) {
      permissionMs += approval
      waitIntervals.push([x.start, x.start + approval])
    }
    overheadMs += otherWait
    const row = byTool.get(x.tool) ?? { tool: x.tool, calls: 0, ms: 0 }
    row.calls += 1
    row.ms += wall
    byTool.set(x.tool, row)
    if (x.tool === 'Bash') {
      const category = classifyCommand(x.input.command ?? '')
      const cat = byCategory.get(category) ?? { category, calls: 0, ms: 0 }
      cat.calls += 1
      cat.ms += exec
      byCategory.set(category, cat)
      if (category === 'test') testIntervals.push([x.start + wait, x.start + wall])
    }
  }
  const testMs = byCategory.get('test')?.ms ?? 0
  const windows = mainTurns.map(t => [t.start, end(t)] as Interval)
  const share = (intervals: Interval[]) => (wallMs > 0 ? overlapLength(intervals, windows) / wallMs : 0)

  const seen = new Map<string, { path: string; reads: number; redundant: number; ranges: Set<string> }>()
  for (const x of [...tools].sort((a, b) => a.start - b.start)) {
    const path = x.input.path
    if (!path) continue
    if (x.tool === 'Read') {
      const row = seen.get(path) ?? { path, reads: 0, redundant: 0, ranges: new Set<string>() }
      const range = x.input.range ?? ''
      if (row.ranges.has(range)) row.redundant += 1
      row.ranges.add(range)
      row.reads += 1
      seen.set(path, row)
    } else if (WRITE_TOOLS.has(x.tool)) {
      seen.get(path)?.ranges.clear()
    }
  }

  const stepsByCtx = groupBy(s.steps, x => x.ctx)
  const toolsByCtx = groupBy(s.tools, x => x.ctx)
  const summary: Summary = {
    scope,
    turns: mainTurns.length,
    wallMs,
    exclusive,
    model: {
      requests: steps.length,
      ttftAvg: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0,
      ttftP95: ttfts[Math.max(0, Math.ceil(ttfts.length * 0.95) - 1)] ?? 0,
      thinkingMs,
      outputMs,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      tokensPerSec: streamMs > 0 && streamTokens > 0 ? streamTokens / (streamMs / 1_000) : null,
    },
    tools: {
      calls: plain.length,
      sumMs,
      unionMs: unionLength(plain.map(x => [x.start, end(x)] as Interval)),
      execMs,
      permissionObserved: plain.filter(x => x.permission !== undefined).length,
      permissionTimed: timed.filter(x => x.approval !== undefined).length,
      permissionMs,
      permissionShare: share(waitIntervals),
      overheadMs,
      errors: plain.filter(x => x.isError).length,
      denied: plain.filter(x => x.denied || x.permission?.decision === 'reject').length,
      byTool: [...byTool.values()].sort((a, b) => b.ms - a.ms),
      slowest: [...timed]
        .sort((a, b) => b.wall - a.wall)
        .slice(0, 5)
        .map(({ x, wall, wait }) => ({ tool: x.tool, label: toolLabel(x), ms: wall, waitMs: wait, ctx: x.ctx })),
    },
    bash: { byCategory: [...byCategory.values()].sort((a, b) => b.ms - a.ms), testMs, testShare: share(testIntervals) },
    reads: [...seen.values()]
      .filter(r => r.reads >= 2)
      .sort((a, b) => b.redundant - a.redundant || b.reads - a.reads)
      .slice(0, 10)
      .map(({ path, reads, redundant }) => ({ path, reads, redundant })),
    agents: agents
      .map(agent => {
        const parent = agent.parentToolId ? toolById.get(agent.parentToolId) : undefined
        const ownSteps = stepsByCtx.get(agent.id) ?? []
        const ownTools = toolsByCtx.get(agent.id) ?? []
        return {
          id: agent.id,
          agentType: agent.agentType,
          wallMs: end(agent) - agent.start,
          modelMs: unionLength(ownSteps.map(x => [x.start, end(x)] as Interval)),
          toolMs: unionLength(ownTools.map(x => [x.start, end(x)] as Interval)),
          requests: ownSteps.length,
          tools: ownTools.length,
          blocking: parent !== undefined && parent.launchedAsync !== true,
          done: agent.end !== undefined,
        }
      })
      .sort((a, b) => b.wallMs - a.wallMs),
    findings: [],
    incomplete: [...mainTurns, ...steps, ...tools, ...agents].filter(x => x.end === undefined).length,
    droppedTurns: s.droppedTurns,
    droppedSpans: s.droppedSpans,
  }
  summary.findings = buildFindings(summary)
  return summary
}

function buildFindings(sum: Summary): string[] {
  const wall = sum.wallMs
  const out: string[] = []
  if (wall < 1_000) return out
  if (sum.exclusive.model / wall >= 0.7) {
    out.push(`Waiting for the model is ${pct(sum.exclusive.model, wall)} of agent time (TTFT p95 ${fmtMs(sum.model.ttftP95)}); tools are not the bottleneck.`)
  }
  if (sum.bash.testShare >= 0.25) {
    const runs = sum.bash.byCategory.find(c => c.category === 'test')?.calls ?? 0
    out.push(`Tests took ${pct(sum.bash.testShare, 1)} of agent time (${fmtMs(sum.bash.testMs)} over ${runs} run(s)).`)
  }
  if (sum.tools.permissionShare >= 0.2) {
    out.push(`Observed approval/check wait accounts for ${pct(sum.tools.permissionShare, 1)} of agent time (${fmtMs(sum.tools.permissionMs)}, estimated from ${sum.tools.permissionTimed}/${sum.tools.calls} calls; includes pre-decision checks and hooks).`)
  }
  for (const r of sum.reads) {
    if (r.redundant >= 2) out.push(`${clip(r.path, 80)} was read ${r.reads}× (${r.redundant}× with no edit in between).`)
  }
  for (const a of sum.agents) {
    if (a.blocking && a.wallMs / wall >= 0.5) out.push(`Subagent ${a.agentType} blocked the main loop for ${pct(a.wallMs, wall)} (${fmtMs(a.wallMs)}).`)
  }
  const top = sum.tools.slowest[0]
  if (top && top.ms / wall >= 0.3) out.push(`One call took ${pct(top.ms, wall)}: ${clip(top.label, 60)} (${fmtMs(top.ms)}).`)
  if (sum.exclusive.engine / wall >= 0.25) {
    out.push(`${pct(sum.exclusive.engine, wall)} of the time is outside model requests and tools (hooks, context building, compaction).`)
  }
  return out
}

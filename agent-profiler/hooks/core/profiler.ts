import type { AgentRec, Outcome, Snapshot, StepRec, ToolInputSummary, ToolRec, TurnRec, Usage } from './types.ts'
import { redactSecrets } from './redact.ts'

export const MAIN = 'main'

export type RunningItem = { kind: 'model' | 'tool' | 'agent'; label: string; ctx: string; ms: number }

export function isAgentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

export function toolLabel(tool: ToolRec): string {
  const detail = tool.input.command ?? tool.input.path ?? tool.input.pattern ?? tool.input.subagentType ?? ''
  return redactSecrets(detail ? `${tool.tool} ${detail}` : tool.tool)
}

function text(value: unknown, n: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, n) : undefined
}

function safeText(value: unknown, n: number): string | undefined {
  return typeof value === 'string' ? redactSecrets(value).slice(0, n) : undefined
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function summarizeInput(tool: string, input: Record<string, unknown>): ToolInputSummary {
  switch (tool) {
    case 'Bash':
      return defined({ command: safeText(input.command, 512), description: safeText(input.description, 120) })
    case 'Read': {
      const paged = input.offset !== undefined || input.limit !== undefined
      return defined({ path: text(input.file_path, 512), range: paged ? `${input.offset ?? ''}:${input.limit ?? ''}` : undefined })
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return defined({ path: text(input.file_path, 512) })
    case 'NotebookEdit':
      return defined({ path: text(input.notebook_path, 512) })
    case 'Glob':
    case 'Grep':
      return defined({ pattern: safeText(input.pattern, 200), path: text(input.path, 512) })
    case 'Agent':
    case 'Task':
      return defined({ subagentType: safeText(input.subagent_type, 80), description: safeText(input.description, 120) })
    default:
      return {}
  }
}

export function toolOutcome(answer: unknown): Outcome {
  const value = (answer ?? {}) as { deny?: unknown; isError?: unknown; result?: unknown }
  const result = (value.result ?? {}) as { agentId?: unknown; status?: unknown }
  return {
    denied: typeof value.deny === 'string',
    isError: value.isError === true,
    launchedAgentId: typeof result.agentId === 'string' ? result.agentId : undefined,
    launchedAsync: result.status === 'async_launched',
  }
}

export class Profiler {
  sessionId: string
  private readonly maxSpans: number
  private readonly turns = new Map<string, TurnRec>()
  private readonly steps = new Map<string, StepRec>()
  private readonly tools = new Map<string, ToolRec>()
  private readonly agents = new Map<string, AgentRec>()
  private readonly openTurns = new Map<string, string[]>()
  private readonly pendingExec = new Map<string, number>()
  private readonly openSteps = new Set<string>()
  private readonly openTools = new Set<string>()
  private readonly openAgents = new Set<string>()
  private droppedTurns = 0
  private droppedSpans = 0
  private started: number | undefined
  // Bumped on every change, so callers can cache what they derive from a snapshot.
  version = 0

  get isLive(): boolean {
    return this.openSteps.size > 0 || this.openTools.size > 0 || this.openAgents.size > 0 || [...this.openTurns.values()].some(turns => turns.length > 0)
  }

  constructor(sessionId = 'unknown', maxSpans = 20_000) {
    this.sessionId = sessionId
    this.maxSpans = maxSpans
  }

  // A profiler created before the session id was known (a reload mid-session) takes it on later.
  adoptSessionId(id: string): void {
    if (this.sessionId !== 'unknown' || !id) return
    this.sessionId = id
    this.version += 1
  }

  turnStart(t: number, turnId: string, prompt = '', ctx = MAIN): void {
    if (this.turns.has(turnId)) return
    this.turns.set(turnId, { id: turnId, ctx, start: t, prompt: redactSecrets(prompt).slice(0, 120) })
    this.seen(t)
    this.stack(ctx).push(turnId)
    this.version += 1
  }

  turnComplete(t: number, turnId: string, reason?: string): void {
    const turn = this.turns.get(turnId)
    if (!turn) return
    if (turn.end === undefined) turn.end = t
    if (reason !== undefined) turn.reason = reason
    // Completion is authoritative even when a stream/tool's cleanup arrives late.
    for (const id of [...this.openSteps]) {
      if (this.steps.get(id)?.turnId === turnId) this.stepEnd(turn.end, id)
    }
    for (const id of [...this.openTools]) {
      const tool = this.tools.get(id)
      if (tool?.turnId !== turnId) continue
      tool.end = turn.end
      this.openTools.delete(id)
    }
    this.unstack(turn.ctx, turnId)
    this.version += 1
  }

  // StopFailure can arrive before turn.complete after a terminal API error.
  // Only settle that loop: independent background agents may still be working.
  stopFailure(t: number, ctx = MAIN): void {
    for (const turnId of [...(this.openTurns.get(ctx) ?? [])]) this.turnComplete(t, turnId, 'error')
    if (ctx !== MAIN) this.subagentStop(t, ctx)
    for (const id of [...this.openSteps]) {
      if (this.steps.get(id)?.ctx === ctx) this.stepEnd(t, id)
    }
    for (const id of [...this.openTools]) {
      const tool = this.tools.get(id)
      if (tool?.ctx !== ctx) continue
      tool.end = t
      this.openTools.delete(id)
      this.version += 1
    }
  }

  stepStart(t: number, args: { turnId: string; index: number; model: string; effort?: string | number; agentId?: string }): string {
    const ctx = args.agentId ?? MAIN
    const turn = this.turns.get(args.turnId)
    if (!turn) {
      this.turnStart(t, args.turnId, '', ctx)
    } else if (turn.ctx !== ctx) {
      // The engine may raise turn.start for a subagent's loop too; the step tells us whose turn it is.
      this.unstack(turn.ctx, turn.id)
      turn.ctx = ctx
      if (turn.end === undefined) this.stack(ctx).push(turn.id)
    }
    let id = `${args.turnId}#${args.index}`
    for (let n = 1; this.steps.has(id); n += 1) id = `${args.turnId}#${args.index}.${n}`
    const step: StepRec = { id, ctx, turnId: args.turnId, index: args.index, model: args.model, start: t }
    if (args.effort !== undefined) step.effort = String(args.effort)
    this.steps.set(id, step)
    this.openSteps.add(id)
    this.seen(t)
    this.version += 1
    this.trim()
    return id
  }

  stepChunk(t: number, stepId: string, kind: string): void {
    const step = this.steps.get(stepId)
    if (!step || step.end !== undefined || kind === 'engine' || kind === 'stop') return
    if (kind !== 'thinking' && step.outFirst !== undefined) return
    if (step.firstContent === undefined) step.firstContent = t
    if (kind === 'thinking') {
      if (step.thinkFirst === undefined) step.thinkFirst = t
      step.thinkLast = t
    } else {
      step.outFirst = t
    }
    this.version += 1
  }

  stepUsage(stepId: string, usage: Usage | null | undefined, stopReason?: string | null): void {
    const step = this.steps.get(stepId)
    if (!step) return
    if (usage) step.usage = { ...usage }
    if (stopReason) step.stopReason = stopReason
    this.version += 1
  }

  stepEnd(t: number, stepId: string): void {
    const step = this.steps.get(stepId)
    if (!step || step.end !== undefined) return
    step.end = t
    this.openSteps.delete(stepId)
    this.version += 1
  }

  toolStart(t: number, args: { id: string; tool: string; agentId?: string; input: ToolInputSummary }): void {
    if (this.tools.has(args.id)) return
    const ctx = args.agentId ?? MAIN
    const tool: ToolRec = { id: args.id, ctx, tool: args.tool, input: args.input, start: t }
    const turnId = this.currentTurn(ctx)
    if (turnId !== undefined) tool.turnId = turnId
    const exec = this.pendingExec.get(args.id)
    if (exec !== undefined) {
      tool.execMs = exec
      this.pendingExec.delete(args.id)
    }
    this.tools.set(args.id, tool)
    this.openTools.add(args.id)
    this.seen(t)
    this.version += 1
    this.trim()
  }

  toolCheck(id: string, decision: string): void {
    const tool = this.tools.get(id)
    if (!tool) return
    tool.decision = decision
    this.version += 1
  }

  toolDuration(id: string, ms: unknown): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return
    const tool = this.tools.get(id)
    if (tool) {
      tool.execMs = ms
      this.version += 1
    } else if (this.pendingExec.size < 1_000) this.pendingExec.set(id, ms)
  }

  toolEnd(t: number, id: string, outcome: Outcome): void {
    const tool = this.tools.get(id)
    if (!tool || tool.end !== undefined) return
    tool.end = t
    this.openTools.delete(id)
    this.version += 1
    tool.denied = outcome.denied
    tool.isError = outcome.isError
    if (outcome.launchedAgentId) {
      tool.launchedAgentId = outcome.launchedAgentId
      tool.launchedAsync = outcome.launchedAsync
      const agent = this.agents.get(outcome.launchedAgentId)
      if (agent) agent.parentToolId = id
    }
  }

  subagentStart(t: number, agentId: string, agentType: string): void {
    if (this.agents.has(agentId)) return
    const claimed = new Set([...this.agents.values()].map(agent => agent.parentToolId))
    let parent: ToolRec | undefined
    for (const tool of this.tools.values()) {
      if (!isAgentTool(tool.tool) || claimed.has(tool.id)) continue
      if (tool.launchedAgentId !== undefined && tool.launchedAgentId !== agentId) continue
      if (tool.end !== undefined && t - tool.end > 2_000) continue
      if (!parent || tool.start > parent.start) parent = tool
    }
    const agent: AgentRec = { id: agentId, agentType, start: t }
    if (parent) agent.parentToolId = parent.id
    this.agents.set(agentId, agent)
    this.openAgents.add(agentId)
    this.seen(t)
    this.version += 1
  }

  subagentStop(t: number, agentId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) return
    if (agent.end === undefined) agent.end = t
    this.openAgents.delete(agentId)
    // Whatever the agent left open ended with it, so running() and the ticker settle.
    for (const id of [...this.openSteps]) {
      const step = this.steps.get(id)
      if (step?.ctx === agentId) this.stepEnd(t, id)
    }
    for (const id of [...this.openTools]) {
      const tool = this.tools.get(id)
      if (tool?.ctx !== agentId) continue
      tool.end = t
      this.openTools.delete(id)
    }
    this.version += 1
    for (const turnId of [...(this.openTurns.get(agentId) ?? [])]) this.turnComplete(t, turnId, 'agent-stop')
  }

  running(now: number): RunningItem[] {
    // Walks only the open spans, so the once-a-second ticker stays cheap however long the session.
    const items: RunningItem[] = []
    for (const id of this.openSteps) {
      const step = this.steps.get(id)
      if (step) items.push({ kind: 'model', label: `model ${step.model}`, ctx: step.ctx, ms: now - step.start })
    }
    for (const id of this.openTools) {
      const tool = this.tools.get(id)
      if (tool) items.push({ kind: 'tool', label: toolLabel(tool), ctx: tool.ctx, ms: now - tool.start })
    }
    for (const id of this.openAgents) {
      const agent = this.agents.get(id)
      if (agent) items.push({ kind: 'agent', label: `agent ${agent.agentType}`, ctx: agent.id, ms: now - agent.start })
    }
    return items.sort((a, b) => b.ms - a.ms)
  }

  snapshot(now: number): Snapshot {
    return {
      sessionId: this.sessionId,
      now,
      turns: [...this.turns.values()].map(turn => ({ ...turn })),
      steps: [...this.steps.values()].map(step => ({ ...step, ...(step.usage ? { usage: { ...step.usage } } : {}) })),
      tools: [...this.tools.values()].map(tool => ({ ...tool, input: { ...tool.input } })),
      agents: [...this.agents.values()].map(agent => ({ ...agent })),
      ...(this.started !== undefined ? { started: this.started } : {}),
      droppedTurns: this.droppedTurns,
      droppedSpans: this.droppedSpans,
    }
  }

  private currentTurn(ctx: string): string | undefined {
    const open = this.openTurns.get(ctx)
    return open && open.length > 0 ? open[open.length - 1] : undefined
  }

  private stack(ctx: string): string[] {
    let open = this.openTurns.get(ctx)
    if (!open) {
      open = []
      this.openTurns.set(ctx, open)
    }
    return open
  }

  private unstack(ctx: string, turnId: string): void {
    const open = this.openTurns.get(ctx)
    const at = open ? open.indexOf(turnId) : -1
    if (open && at >= 0) open.splice(at, 1)
  }

  private seen(t: number): void {
    if (this.started === undefined || t < this.started) this.started = t
  }

  // Past the cap, drop whole finished main turns, oldest first, with their requests and tools and the
  // subagents launched from them (and those subagents' own work). Dropping a turn's spans without the
  // turn would show their time as engine overhead.
  private trim(): void {
    if (this.steps.size + this.tools.size <= this.maxSpans) return
    const target = Math.floor(this.maxSpans * 0.9)
    const byTurn = new Map<string, { steps: string[]; tools: string[] }>()
    const byCtx = new Map<string, { steps: string[]; tools: string[]; turns: string[] }>()
    const slot = <K, V>(map: Map<K, V>, key: K, make: () => V): V => {
      let value = map.get(key)
      if (!value) {
        value = make()
        map.set(key, value)
      }
      return value
    }
    for (const step of this.steps.values()) {
      if (step.ctx === MAIN) slot(byTurn, step.turnId, () => ({ steps: [], tools: [] })).steps.push(step.id)
      else slot(byCtx, step.ctx, () => ({ steps: [], tools: [], turns: [] })).steps.push(step.id)
    }
    for (const tool of this.tools.values()) {
      if (tool.ctx !== MAIN) slot(byCtx, tool.ctx, () => ({ steps: [], tools: [], turns: [] })).tools.push(tool.id)
      else if (tool.turnId !== undefined) slot(byTurn, tool.turnId, () => ({ steps: [], tools: [] })).tools.push(tool.id)
    }
    for (const turn of this.turns.values()) {
      if (turn.ctx !== MAIN) slot(byCtx, turn.ctx, () => ({ steps: [], tools: [], turns: [] })).turns.push(turn.id)
    }
    const launched = new Map<string, string[]>()
    for (const agent of this.agents.values()) {
      if (agent.parentToolId !== undefined) slot(launched, agent.parentToolId, () => [] as string[]).push(agent.id)
    }

    for (const turn of [...this.turns.values()]) {
      if (this.steps.size + this.tools.size <= target) return
      if (turn.ctx !== MAIN || turn.end === undefined) continue
      const own = byTurn.get(turn.id) ?? { steps: [], tools: [] }
      const steps = [...own.steps]
      const tools = [...own.tools]
      const turns = [turn.id]
      const agents: string[] = []
      for (let i = 0; i < tools.length; i += 1) {
        for (const agentId of launched.get(tools[i] as string) ?? []) {
          if (agents.includes(agentId)) continue
          agents.push(agentId)
          const work = byCtx.get(agentId)
          if (!work) continue
          steps.push(...work.steps)
          tools.push(...work.tools)
          turns.push(...work.turns)
        }
      }
      const busy =
        steps.some(id => this.openSteps.has(id)) || tools.some(id => this.openTools.has(id)) || agents.some(id => this.openAgents.has(id))
      if (busy) continue
      for (const id of steps) this.steps.delete(id)
      for (const id of tools) this.tools.delete(id)
      for (const id of agents) this.agents.delete(id)
      for (const id of turns) this.turns.delete(id)
      this.droppedTurns += 1
      this.droppedSpans += steps.length + tools.length + agents.length
      this.version += 1
    }
  }
}

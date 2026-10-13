import { classifyResult, display, hash, type Outcome } from './fingerprint.ts'

export type CaseStatus = 'active' | 'recovered' | 'changed' | 'unknown' | 'expired'
export type Case = {
  id: number; agent: string; isMain: boolean; cwd: string; command: string
  kind: 'retry' | 'edit-retry'; status: CaseStatus; count: number
  firstSeq: number; lastSeq: number; editRetries: number; files: string[]; excerpt: string
}
export type Snapshot = { active: Case[]; history: Case[]; groups: number; contexts: number; pending: number; queues: number; threshold: number }
type Context = { alive: boolean; epoch: number; edits: { epoch: number; path: string }[] }
type Group = {
  key: string; baseKey: string; context: Context; agent: string; isMain: boolean; cwd: string; command: string
  touched: number; signature?: string; count: number; firstSeq: number
  previousEpoch: number; editRetries: number; files: string[]; case?: Case
}
export type Ticket = {
  seq: number; epoch: number; context: Context; path?: string
  completed: boolean; located: boolean; invalid?: boolean; outcome?: Outcome; groupKey?: string; cwd?: string
  metadata?: { baseKey: string; queue: Ticket[]; agent: string; isMain: boolean; command: string }
}
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const copy = (c: Case): Case => ({ ...c, files: [...c.files] })

export class Detector {
  private seq = 0
  private caseId = 0
  private readonly groups = new Map<string, Group>()
  private readonly contexts = new Map<string, Context>()
  // Reserve order before asynchronous cwd lookup; different directories may share a short queue.
  private readonly waiting = new Map<string, Ticket[]>()
  private readonly history: Case[] = []
  readonly threshold: number

  constructor(threshold: unknown = 3) {
    this.threshold = typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 3 && threshold <= 10 ? threshold : 3
  }

  private close(group: Group, status: Exclude<CaseStatus, 'active'>): void {
    if (group.case) {
      this.history.push({ ...copy(group.case), status })
      if (this.history.length > 100) this.history.shift()
    }
    group.case = undefined
    group.signature = undefined
    group.count = 0
    group.editRetries = 0
    group.files = []
  }

  private evict(group: Group): void {
    this.close(group, 'expired')
    this.groups.delete(group.key)
    for (const queue of this.waiting.values()) for (const t of queue) if (t.groupKey === group.key) t.invalid = true
  }

  begin(tool: string, input: Record<string, unknown>, agent?: string, cwd?: string): Ticket {
    const ticket = this.reserve(tool, input, agent)
    this.locate(ticket, cwd)
    return ticket
  }

  reserve(tool: string, input: Record<string, unknown>, agent?: string): Ticket {
    this.seq++
    for (const group of this.groups.values()) if (this.seq - group.touched >= 200) this.evict(group)
    for (const [key, queue] of this.waiting) if (this.seq - queue[0]!.seq >= 200) this.waiting.delete(key)
    const scope = agent === undefined ? '@main' : `agent:${hash(agent)}`
    let context = this.contexts.get(scope)
    if (!context) {
      if (this.contexts.size >= 128) {
        const [oldKey, old] = this.contexts.entries().next().value!
        old.alive = false
        for (const group of this.groups.values()) if (group.context === old) this.evict(group)
        for (const [key, queue] of this.waiting) if (queue[0]!.context === old) this.waiting.delete(key)
        this.contexts.delete(oldKey)
      }
      context = { alive: true, epoch: 0, edits: [] }
      this.contexts.set(scope, context)
    } else {
      // Scope retention uses least recently started activity.
      this.contexts.delete(scope)
      this.contexts.set(scope, context)
    }
    const ticket: Ticket = { seq: this.seq, epoch: context.epoch, context, completed: false, located: false }
    if (EDIT_TOOLS.has(tool)) {
      const path = input.file_path ?? input.notebook_path
      if (typeof path === 'string') ticket.path = display(path)
    }
    if (tool !== 'Bash' || typeof input.command !== 'string' || input.command.length > 65_536) return ticket
    const baseKey = hash(JSON.stringify([scope, hash(input.command)]))
    let queue = this.waiting.get(baseKey)
    if (queue && queue.length >= 16) {
      for (const g of this.groups.values()) if (g.baseKey === baseKey) this.evict(g)
      this.waiting.delete(baseKey)
      queue = undefined
    }
    if (!queue) {
      if (this.waiting.size >= 512) this.waiting.delete(this.waiting.keys().next().value!)
      queue = []
      this.waiting.set(baseKey, queue)
    }
    ticket.metadata = { baseKey, queue, agent: agent === undefined ? 'main' : display(agent), isMain: agent === undefined, command: display(input.command) }
    queue.push(ticket)
    return ticket
  }

  locate(ticket: Ticket, cwd?: string): void {
    if (ticket.located) return
    ticket.located = true
    if (!ticket.metadata || !cwd) return
    ticket.cwd = display(cwd)
    ticket.groupKey = hash(JSON.stringify([ticket.metadata.baseKey, hash(cwd)]))
    const group = this.groups.get(ticket.groupKey)
    if (group) group.touched = this.seq
  }

  finish(ticket: Ticket, answer: unknown): Case[] {
    if (ticket.completed || !ticket.context.alive) return []
    ticket.completed = true
    if (ticket.path !== undefined) {
      const a = answer !== null && typeof answer === 'object' ? answer as Record<string, unknown> : {}
      if (a.result !== undefined && a.deny === undefined && a.isError !== true && a.isReadOnly !== true) {
        const ctx = ticket.context
        ctx.edits.push({ epoch: ++ctx.epoch, path: ticket.path })
        if (ctx.edits.length > 100) ctx.edits.shift()
      }
    }
    const metadata = ticket.metadata
    if (!metadata || this.waiting.get(metadata.baseKey) !== metadata.queue) return []
    ticket.outcome = classifyResult(answer)
    const opened: Case[] = []
    const queue = metadata.queue
    while (queue[0]?.completed && queue[0].located) {
      const t = queue.shift()!
      if (t.invalid) continue
      if (!t.groupKey) {
        // Unknown location cannot justify carrying a previous failure streak through this call.
        for (const g of this.groups.values()) if (g.baseKey === metadata.baseKey) this.close(g, 'unknown')
        continue
      }
      let group = this.groups.get(t.groupKey)
      if (!group) {
        if (this.groups.size >= 512) this.evict(this.groups.values().next().value!)
        const m = t.metadata!
        group = {
          key: t.groupKey, baseKey: m.baseKey, context: t.context, agent: m.agent, isMain: m.isMain,
          command: m.command, cwd: t.cwd!, touched: this.seq, count: 0, firstSeq: t.seq,
          previousEpoch: t.epoch, editRetries: 0, files: [],
        }
        this.groups.set(group.key, group)
      }
      group.touched = this.seq
      const outcome = t.outcome!
      if (outcome.kind !== 'failure') {
        this.close(group, outcome.kind === 'success' ? 'recovered' : 'unknown')
        continue
      }
      if (group.signature !== outcome.signature) {
        this.close(group, 'changed')
        group.signature = outcome.signature
        group.firstSeq = t.seq
        group.previousEpoch = t.epoch
      } else if (t.epoch > group.previousEpoch) {
        group.editRetries++
        for (const edit of group.context.edits) {
          if (edit.epoch > group.previousEpoch && edit.epoch <= t.epoch && group.files.length < 20 && !group.files.includes(edit.path)) group.files.push(edit.path)
        }
      }
      group.previousEpoch = t.epoch
      group.count++
      if (group.count < this.threshold) continue
      const fresh = group.case === undefined
      group.case = {
        id: group.case?.id ?? ++this.caseId, agent: group.agent, isMain: group.isMain, cwd: group.cwd, command: group.command,
        kind: group.editRetries >= 2 ? 'edit-retry' : 'retry', status: 'active', count: group.count,
        firstSeq: group.firstSeq, lastSeq: t.seq, editRetries: group.editRetries, files: [...group.files], excerpt: outcome.excerpt!,
      }
      if (fresh) opened.push(copy(group.case))
    }
    if (!queue.length) this.waiting.delete(metadata.baseKey)
    return opened
  }

  snapshot(): Snapshot {
    return {
      active: [...this.groups.values()].flatMap(g => g.case ? [copy(g.case)] : []),
      history: this.history.map(copy), groups: this.groups.size, contexts: this.contexts.size, threshold: this.threshold,
      pending: [...this.waiting.values()].reduce((sum, q) => sum + q.length, 0), queues: this.waiting.size,
    }
  }
}

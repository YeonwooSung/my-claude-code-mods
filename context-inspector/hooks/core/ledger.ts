import type { CompactionRec, ContextItem, EditRec, Sample, Snapshot, Target } from './types.ts'

export type ToolInfo = {
  tool: string
  ctx: string
  target?: Target
  // Lines an edit tool changes, counted from its input; recorded once the call succeeds.
  lines?: number
  deduped?: boolean
  isError?: boolean
}

export type ToolOutcome = { deduped?: boolean; isError?: boolean; full?: boolean }

export type NewItem = Omit<ContextItem, 'seq' | 'turn' | 'born' | 'epoch' | 'live'>

const MAX_TOOLS = 2_000

export class Ledger {
  version = 0
  turn = 0
  dropped = 0
  droppedLive = 0
  // One counter orders items, edits, samples and compactions.
  private seq = 0
  private items: ContextItem[] = []
  private byUuid = new Map<string, ContextItem>()
  private edits: EditRec[] = []
  private samples: Sample[] = []
  private compactions: CompactionRec[] = []
  private epochs = new Map<string, number>()
  private tools = new Map<string, ToolInfo>()

  constructor(readonly maxItems = 20_000) {}

  get size(): number {
    return this.items.length
  }

  epochOf(ctx: string): number {
    return this.epochs.get(ctx) ?? 0
  }

  nextTurn(): void {
    this.turn += 1
    this.version += 1
  }

  // A row the engine appends again (after a compaction) is live once more, in the current epoch.
  revive(row: string): boolean {
    let item = this.byUuid.get(row)
    if (!item) return false
    for (let n = 1; item; n += 1) {
      item.live = true
      item.epoch = this.epochOf(item.ctx)
      item = this.byUuid.get(`${row}#${n}`)
    }
    this.version += 1
    return true
  }

  toolStart(id: string, info: ToolInfo): void {
    this.tools.set(id, info)
    if (this.tools.size > MAX_TOOLS) {
      const oldest = this.tools.keys().next().value
      if (oldest !== undefined) this.tools.delete(oldest)
    }
  }

  tool(id: string): ToolInfo | undefined {
    return this.tools.get(id)
  }

  // The call's result is known: a Read learns whether it was whole or deduplicated; an edit that went through counts.
  toolEnd(id: string, outcome: ToolOutcome): void {
    const info = this.tools.get(id)
    if (!info) return
    info.deduped = outcome.deduped
    info.isError = outcome.isError
    if (info.target && outcome.full !== undefined) info.target = { ...info.target, full: outcome.full }
    if (!outcome.isError && info.lines !== undefined && info.target?.kind === 'file') this.edit(info.ctx, info.target.value, info.lines)
  }

  forgetTool(id: string): void {
    this.tools.delete(id)
  }

  add(item: NewItem): ContextItem {
    this.seq += 1
    const epoch = this.epochOf(item.ctx)
    const full: ContextItem = { ...item, seq: this.seq, turn: this.turn, born: epoch, epoch, live: true }
    this.items.push(full)
    this.byUuid.set(full.uuid, full)
    this.version += 1
    if (this.items.length > this.maxItems) this.trim()
    return full
  }

  edit(ctx: string, path: string, lines: number): void {
    this.seq += 1
    this.edits.push({ seq: this.seq, ctx, turn: this.turn, path, lines })
    if (this.edits.length > this.maxItems) this.edits.splice(0, this.edits.length - this.maxItems)
    this.version += 1
  }

  sample(ctx: string, input: number): void {
    if (!Number.isFinite(input) || input <= 0) return
    this.seq += 1
    this.samples.push({ seq: this.seq, ctx, turn: this.turn, epoch: this.epochOf(ctx), input })
    if (this.samples.length > this.maxItems) this.samples.splice(0, this.samples.length - this.maxItems)
    this.version += 1
  }

  // Live items of `ctx` that neither sit in a kept row nor answer a kept tool call leave the window.
  compacted(
    ctx: string,
    keptRows: ReadonlySet<string>,
    keptTools: ReadonlySet<string>,
    rec: Pick<CompactionRec, 'trigger' | 'tokensBefore' | 'tokensAfter' | 'entities'>,
  ): CompactionRec {
    const epoch = this.epochOf(ctx) + 1
    this.epochs.set(ctx, epoch)
    let keptItems = 0
    let droppedItems = 0
    let droppedEst = 0
    for (const item of this.items) {
      if (item.ctx !== ctx || !item.live) continue
      if (keptRows.has(item.row) || (item.toolUseId !== undefined && keptTools.has(item.toolUseId))) {
        item.epoch = epoch
        keptItems += 1
      } else {
        item.live = false
        droppedItems += 1
        droppedEst += item.est
      }
    }
    this.seq += 1
    const full: CompactionRec = { ...rec, seq: this.seq, ctx, turn: this.turn, keptItems, droppedItems, droppedEst }
    this.compactions.push(full)
    this.version += 1
    return full
  }

  markBackfilled(): void {
    for (const item of this.items) item.backfilled = true
    this.version += 1
  }

  snapshot(): Snapshot {
    return {
      items: this.items,
      edits: this.edits,
      samples: this.samples,
      compactions: this.compactions,
      turn: this.turn,
      dropped: this.dropped,
      droppedLive: this.droppedLive,
    }
  }

  // Down to 90% of the cap: the oldest items already out of the window first, then the oldest live ones.
  private trim(): void {
    let excess = this.items.length - Math.floor(this.maxItems * 0.9)
    const keep: ContextItem[] = []
    for (const item of this.items) {
      if (excess > 0 && !item.live) {
        this.byUuid.delete(item.uuid)
        this.dropped += 1
        excess -= 1
      } else {
        keep.push(item)
      }
    }
    if (excess > 0) {
      for (const item of keep.splice(0, excess)) {
        this.byUuid.delete(item.uuid)
        this.droppedLive += 1
      }
    }
    this.items = keep
  }
}

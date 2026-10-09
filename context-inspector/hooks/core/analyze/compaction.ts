import type { CompactionRec, EntityType } from '../types.ts'
import type { RereadRow } from './rereads.ts'

export type EntityStat = { total: number; kept: number }
export type CompactionView = {
  seq: number
  ctx: string
  turn: number
  trigger: string
  tokensBefore?: number
  tokensAfter?: number
  keptItems: number
  droppedItems: number
  droppedEst: number
  stats: Record<EntityType, EntityStat>
  lostEdited: string[]
  // Estimated tokens of files read again (or restored by the engine) because this compaction dropped them.
  reflowEst: number
}

const TYPES: EntityType[] = ['edited-file', 'read-file', 'error', 'requirement']

export function compactionViews(recs: readonly CompactionRec[], rows: readonly RereadRow[], k: number): CompactionView[] {
  const views: CompactionView[] = recs.map(rec => {
    const stats = Object.fromEntries(TYPES.map(t => [t, { total: 0, kept: 0 }])) as Record<EntityType, EntityStat>
    for (const e of rec.entities) {
      stats[e.type].total += 1
      if (e.kept) stats[e.type].kept += 1
    }
    return {
      seq: rec.seq,
      ctx: rec.ctx,
      turn: rec.turn,
      trigger: rec.trigger,
      tokensBefore: rec.tokensBefore,
      tokensAfter: rec.tokensAfter,
      keptItems: rec.keptItems,
      droppedItems: rec.droppedItems,
      droppedEst: Math.round(rec.droppedEst * k),
      stats,
      lostEdited: rec.entities.filter(e => e.type === 'edited-file' && !e.kept).map(e => e.value),
      reflowEst: 0,
    }
  })
  for (const row of rows) {
    if (row.cls !== 'after-compaction' && row.cls !== 'restored') continue
    let owner: CompactionView | undefined
    for (const v of views) if (v.ctx === row.ctx && v.seq < row.seq && (!owner || v.seq > owner.seq)) owner = v
    if (owner) owner.reflowEst += row.est
  }
  return views
}

import { advise, type Advice, type BreakdownLite } from './advice.ts'
import { compactionViews, type CompactionView } from './analyze/compaction.ts'
import { efficiency, type Efficiency } from './analyze/efficiency.ts'
import { occupancy, type Occupancy } from './analyze/occupancy.ts'
import { rereads, type Rereads } from './analyze/rereads.ts'
import { similar, type Similar } from './analyze/similar.ts'
import { calibrate } from './tokens.ts'
import { MAIN, type Snapshot } from './types.ts'

export type Scope = 'main' | 'all'

export type Summary = {
  scope: Scope
  k: number
  segments: number
  turns: number
  occupancy: Occupancy
  rereads: Rereads
  similar: Similar
  compactions: CompactionView[]
  efficiency: Efficiency
  advice: Advice[]
  // Waste still in the window: unchanged re-reads whose copy is live plus near-duplicate live outputs,
  // each item counted once.
  wasteEst: number
  // Every unchanged re-read of the session, in the window or not.
  sessionRereadEst: number
  dropped: number
  droppedLive: number
  hasBreakdown: boolean
}

export function summarize(s: Snapshot, scope: Scope, breakdown?: BreakdownLite): Summary {
  const inScope = (ctx: string): boolean => scope === 'all' || ctx === MAIN
  const items = s.items.filter(i => inScope(i.ctx))
  // Calibration uses every context: more segments, and k is a property of the tokenizer, not the scope.
  const { k, segments } = calibrate(s.samples, s.items)
  const rr = rereads(items, s.edits, k)
  const sim = similar(items, k, rr.wasteSeqs)
  const comps = compactionViews(s.compactions.filter(c => inScope(c.ctx)), rr.rows, k)
  return {
    scope,
    k,
    segments,
    turns: s.turn,
    occupancy: occupancy(items, k),
    rereads: rr,
    similar: sim,
    compactions: comps,
    efficiency: efficiency(s.samples, s.edits),
    advice: advise({ items, k, rereads: rr, clusters: sim.clusters, compactions: comps, breakdown }),
    wasteEst: rr.currentWasteEst + sim.wasteEst,
    sessionRereadEst: rr.wasteEst,
    dropped: s.dropped,
    droppedLive: s.droppedLive,
    hasBreakdown: breakdown !== undefined,
  }
}

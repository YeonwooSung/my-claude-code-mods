import type { ContextItem, EditRec } from '../types.ts'

export type RereadClass =
  | 'first'
  | 'engine-deduped'
  | 'restored'
  | 'different-range'
  | 'after-edit'
  | 'after-compaction'
  | 'changed-externally'
  | 'unchanged-live'

export type RereadRow = { seq: number; ctx: string; path: string; cls: RereadClass; est: number }
export type FileRereads = { path: string; reads: number; wasteEst: number; classes: Partial<Record<RereadClass, number>> }
export type Rereads = { rows: RereadRow[]; files: FileRereads[]; wasteEst: number; compactionEst: number; deduped: number; wasteSeqs: Set<number> }

// The first rule that matches wins (spec §4.2 and §10).
function classify(r: ContextItem, prior: readonly ContextItem[], edits: readonly number[]): RereadClass {
  if (prior.length === 0) return 'first'
  if (r.deduped) return 'engine-deduped'
  const sameRange = prior.findLast(p => p.target?.range === r.target?.range)
  const p = sameRange ?? prior[prior.length - 1]!
  // p.epoch is the last epoch p was live in; r.born the epoch r arrived in.
  if (r.attached && p.epoch < r.born) return 'restored'
  if (!sameRange) return 'different-range'
  if (edits.some(seq => seq > p.seq && seq < r.seq)) return 'after-edit'
  if (p.epoch < r.born) return 'after-compaction'
  if (p.hash !== r.hash) return 'changed-externally'
  return 'unchanged-live'
}

export function rereads(items: readonly ContextItem[], edits: readonly EditRec[], k: number): Rereads {
  const reads = items.filter(i => i.target?.kind === 'file' && (i.category === 'Read' || i.attached)).sort((a, b) => a.seq - b.seq)
  const editSeqs = new Map<string, number[]>()
  for (const e of edits) {
    const key = `${e.ctx}\u0000${e.path}`
    const list = editSeqs.get(key)
    if (list) list.push(e.seq)
    else editSeqs.set(key, [e.seq])
  }
  const history = new Map<string, ContextItem[]>()
  const rows: RereadRow[] = []
  for (const r of reads) {
    const path = r.target!.value
    const key = `${r.ctx}\u0000${path}`
    const prior = history.get(key) ?? []
    rows.push({ seq: r.seq, ctx: r.ctx, path, cls: classify(r, prior, editSeqs.get(key) ?? []), est: Math.round(r.est * k) })
    prior.push(r)
    history.set(key, prior)
  }
  const files = new Map<string, FileRereads>()
  const wasteSeqs = new Set<number>()
  let wasteEst = 0
  let compactionEst = 0
  let deduped = 0
  for (const row of rows) {
    const f = files.get(row.path) ?? { path: row.path, reads: 0, wasteEst: 0, classes: {} }
    f.reads += 1
    f.classes[row.cls] = (f.classes[row.cls] ?? 0) + 1
    if (row.cls === 'unchanged-live') {
      f.wasteEst += row.est
      wasteEst += row.est
      wasteSeqs.add(row.seq)
    }
    if (row.cls === 'after-compaction' || row.cls === 'restored') compactionEst += row.est
    if (row.cls === 'engine-deduped') deduped += 1
    files.set(row.path, f)
  }
  return {
    rows,
    files: [...files.values()].filter(f => f.reads > 1).sort((a, b) => b.wasteEst - a.wasteEst || b.reads - a.reads || a.path.localeCompare(b.path)),
    wasteEst,
    compactionEst,
    deduped,
    wasteSeqs,
  }
}

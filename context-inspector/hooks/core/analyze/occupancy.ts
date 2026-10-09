import type { ContextItem } from '../types.ts'

export type Row = { key: string; est: number; count: number }
export type TopItem = { seq: number; category: string; label: string; est: number; turn: number }
export type Occupancy = { liveEst: number; liveItems: number; byCategory: Row[]; byTarget: Row[]; top: TopItem[] }

export function label(item: ContextItem): string {
  return item.target ? item.target.value : item.category
}

function bump(map: Map<string, Row>, key: string, est: number): void {
  const row = map.get(key)
  if (row) {
    row.est += est
    row.count += 1
  } else {
    map.set(key, { key, est, count: 1 })
  }
}

const sorted = (map: Map<string, Row>): Row[] => [...map.values()].sort((a, b) => b.est - a.est || a.key.localeCompare(b.key))

// What the window holds now, by category (tool, attachment kind, door) and by target (file, command…).
export function occupancy(items: readonly ContextItem[], k: number, top = 20): Occupancy {
  const categories = new Map<string, Row>()
  const targets = new Map<string, Row>()
  const live: ContextItem[] = []
  let liveEst = 0
  for (const item of items) {
    if (!item.live) continue
    live.push(item)
    const est = Math.round(item.est * k)
    liveEst += est
    bump(categories, item.category, est)
    if (item.target) bump(targets, item.target.value, est)
  }
  live.sort((a, b) => b.est - a.est || a.seq - b.seq)
  return {
    liveEst,
    liveItems: live.length,
    byCategory: sorted(categories),
    byTarget: sorted(targets),
    top: live.slice(0, top).map(i => ({ seq: i.seq, category: i.category, label: label(i), est: Math.round(i.est * k), turn: i.turn })),
  }
}

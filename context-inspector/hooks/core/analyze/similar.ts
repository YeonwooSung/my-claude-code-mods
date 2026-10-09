import { bands, hamming } from '../hash.ts'
import type { ContextItem } from '../types.ts'
import { label } from './occupancy.ts'

export const NEAR_BITS = 3
export const MIN_SIMILAR_CHARS = 200
// Performance bound, not an exactness guarantee: each band bucket compares against at most this many
// earlier members, so near pairs among more than 256 distinct outputs sharing one band value may be
// missed (an approximation, spec section 4.3).
const BUCKET_CAP = 256

export type Cluster = { kind: 'exact' | 'near' | 'mixed'; category: string; label: string; size: number; seqs: number[]; totalEst: number; wasteEst: number }
export type Similar = { clusters: Cluster[]; wasteEst: number }

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
}

// Tool outputs that are byte-identical (same hash) or lexically near-identical (SimHash within 3 bits).
// `exclude`: items already counted as re-read waste, so they are not counted again here.
export function similar(items: readonly ContextItem[], k: number, exclude: ReadonlySet<number> = new Set()): Similar {
  const cand = items.filter(i => i.door === 'tool-result' && i.chars >= MIN_SIMILAR_CHARS)
  const parent = cand.map((_, i) => i)
  const find = (i: number): number => {
    let x = i
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const firstByHash = new Map<string, number>()
  const reps: number[] = []
  cand.forEach((item, i) => {
    const first = firstByHash.get(item.hash)
    if (first === undefined) {
      firstByHash.set(item.hash, i)
      reps.push(i)
    } else {
      union(first, i)
    }
  })
  const buckets = new Map<string, number[]>()
  for (const i of reps) {
    const h = cand[i]!.simhash
    if (h === undefined) continue
    const tried = new Set<number>()
    for (const band of bands(h)) {
      let bucket = buckets.get(band)
      if (!bucket) {
        bucket = []
        buckets.set(band, bucket)
      }
      for (const j of bucket) {
        if (tried.has(j)) continue
        tried.add(j)
        if (hamming(h, cand[j]!.simhash!) <= NEAR_BITS) union(j, i)
      }
      if (bucket.length < BUCKET_CAP) bucket.push(i)
    }
  }
  const groups = new Map<number, ContextItem[]>()
  cand.forEach((item, i) => {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(item)
    else groups.set(root, [item])
  })
  const clusters: Cluster[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const hashes = new Set(members.map(m => m.hash)).size
    const est = (m: ContextItem): number => Math.round(m.est * k)
    // Excluded items are re-reads already counted as waste; the copy kept is a non-excluded one.
    const live = members.filter(m => m.live && !exclude.has(m.seq))
    const liveSum = live.reduce((s, m) => s + est(m), 0)
    const largest = live.reduce((s, m) => Math.max(s, est(m)), 0)
    clusters.push({
      kind: hashes === 1 ? 'exact' : hashes === members.length ? 'near' : 'mixed',
      category: mostCommon(members.map(m => m.category)),
      label: label(members[0]!),
      size: members.length,
      seqs: members.map(m => m.seq),
      totalEst: members.reduce((s, m) => s + est(m), 0),
      wasteEst: Math.max(0, liveSum - largest),
    })
  }
  clusters.sort((a, b) => b.wasteEst - a.wasteEst || b.totalEst - a.totalEst || a.seqs[0]! - b.seqs[0]!)
  return { clusters, wasteEst: clusters.reduce((s, c) => s + c.wasteEst, 0) }
}

import type { ContextItem, Sample } from './types.ts'

export const CHARS_PER_TOKEN = 4
export const IMAGE_TOKENS = 1_500
// A calibration segment counts only when its items add up to at least this many estimated tokens.
export const MIN_SEGMENT_EST = 2_000

export function estimate(chars: number, images = 0): number {
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS
}

// What a request was answered over: uncached, cache-written and cache-read input together.
export function inputOf(usage: unknown): number {
  const u = (usage ?? {}) as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
}

export type Calibration = { k: number; segments: number }

// Per context and epoch, the measured growth between its first and last request over the estimated
// tokens of the items that arrived in between. Telescoping makes the order of rows and stop chunks
// inside the segment irrelevant. A span whose first sample precedes `trimmedThrough` may have lost
// items to the ledger cap, so it is skipped.
export function calibrate(samples: readonly Sample[], items: readonly Pick<ContextItem, 'ctx' | 'seq' | 'est'>[], trimmedThrough = 0): Calibration {
  const spans = new Map<string, { a: Sample; b: Sample }>()
  for (const s of samples) {
    const key = `${s.ctx}\u0000${s.epoch}`
    const span = spans.get(key)
    if (!span) spans.set(key, { a: s, b: s })
    else span.b = s
  }
  let growth = 0
  let est = 0
  let segments = 0
  for (const { a, b } of spans.values()) {
    if (b.seq === a.seq || b.input <= a.input || a.seq < trimmedThrough) continue
    let sum = 0
    for (const item of items) if (item.ctx === a.ctx && item.seq > a.seq && item.seq <= b.seq) sum += item.est
    if (sum < MIN_SEGMENT_EST) continue
    growth += b.input - a.input
    est += sum
    segments += 1
  }
  if (segments === 0) return { k: 1, segments: 0 }
  return { k: Math.min(2, Math.max(0.5, growth / est)), segments }
}

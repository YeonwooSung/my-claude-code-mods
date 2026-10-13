import { summarize, type Scope, type Summary } from './analyze.ts'
import type { Profiler } from './profiler.ts'

// Share summary work between status, pane and ticker.
export class SummaryCache {
  private readonly summaries = new Map<Scope, { profiler: Profiler; version: number; bucket: number; sum: Summary }>()

  get(profiler: Profiler, scope: Scope = 'session', now = Date.now()): Summary {
    const hit = this.summaries.get(scope)
    const bucket = profiler.isLive ? Math.floor(now / 500) : -1
    if (hit && hit.profiler === profiler && hit.version === profiler.version && hit.bucket === bucket) return hit.sum
    const sum = summarize(profiler.snapshot(now), scope)
    this.summaries.set(scope, { profiler, version: profiler.version, bucket, sum })
    return sum
  }
}

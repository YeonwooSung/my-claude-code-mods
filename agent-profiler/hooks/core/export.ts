import type { OtlpRequest, OtlpSpan } from './otlp.ts'
import { recordKey } from './otlp.ts'
import { MAIN } from './profiler.ts'
import type { Snapshot } from './types.ts'

// $.fs.write refuses more than 4 MiB; stay well under it.
export const MAX_EXPORT_BYTES = Math.floor(3.5 * 1024 * 1024)

// Keys of the records not exported yet: finished ones only for a per-turn batch, open ones too
// (exported as incomplete) for the final batch at session end.
export function pendingKeys(s: Snapshot, exported: ReadonlySet<string>, withOpen: boolean): string[] {
  const out: string[] = []
  const take = (key: string, finished: boolean) => {
    if (!exported.has(key) && (withOpen || finished)) out.push(key)
  }
  for (const t of s.turns) if (t.ctx === MAIN) take(recordKey('turn', t.id), t.end !== undefined)
  for (const a of s.agents) take(recordKey('agent', a.id), a.end !== undefined)
  for (const x of s.steps) take(recordKey('step', x.id), x.end !== undefined)
  for (const x of s.tools) take(recordKey('tool', x.id), x.end !== undefined)
  return out
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// Splits a request into requests whose JSON stays within maxBytes (a single span larger than that
// goes alone). Every part keeps the resource and scope; no spans means no parts.
export function splitRequest(req: OtlpRequest, maxBytes: number): OtlpRequest[] {
  const resource = req.resourceSpans[0]
  const scope = resource?.scopeSpans[0]
  if (!resource || !scope || scope.spans.length === 0) return []
  const wrap = (spans: OtlpSpan[]): OtlpRequest => ({
    resourceSpans: [{ resource: resource.resource, scopeSpans: [{ scope: scope.scope, spans }] }],
  })
  if (byteLength(JSON.stringify(req)) <= maxBytes) return [req]
  const envelope = byteLength(JSON.stringify(wrap([])))
  const parts: OtlpRequest[] = []
  let current: OtlpSpan[] = []
  let size = envelope
  for (const span of scope.spans) {
    const bytes = byteLength(JSON.stringify(span)) + 1 // the comma between spans
    if (current.length > 0 && size + bytes > maxBytes) {
      parts.push(wrap(current))
      current = []
      size = envelope
    }
    current.push(span)
    size += bytes
  }
  if (current.length > 0) parts.push(wrap(current))
  return parts
}

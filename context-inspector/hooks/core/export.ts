import { contentHash } from './hash.ts'
import { redactSecrets } from './redact.ts'
import type { Summary } from './summary.ts'
import type { Snapshot, Target } from './types.ts'

// Under `$.fs.write`'s 4 MiB limit with room to spare.
export const MAX_EXPORT_BYTES = Math.floor(3.5 * 1024 * 1024)

export type ExportMeta = { sessionId: string; version: string; at: string }

// Paths stay; everything else (agent names from descriptions, command lines, patterns and URLs) is redacted and cut to 200 characters.
function exportTarget(t: Target | undefined): Target | undefined {
  if (!t) return undefined
  const value = t.kind === 'file' ? t.value : redactSecrets(t.value).slice(0, 200)
  return { ...t, value }
}

// One JSON record per line: meta, items, edits, samples, compactions, summary. No row content, and
// entity values only for files (errors and user identifiers are hashed).
export function exportLines(s: Snapshot, sum: Summary, meta: ExportMeta): string[] {
  const out: string[] = [JSON.stringify({ type: 'meta', schema: 'context-inspector/1', ...meta })]
  for (const i of s.items)
    out.push(
      JSON.stringify({
        type: 'item',
        seq: i.seq,
        ctx: i.ctx,
        turn: i.turn,
        door: i.door,
        category: i.category,
        toolUseId: i.toolUseId,
        target: exportTarget(i.target),
        chars: i.chars,
        est: i.est,
        hash: i.hash,
        simhash: i.simhash,
        born: i.born,
        epoch: i.epoch,
        live: i.live,
        isError: i.isError,
        deduped: i.deduped,
        attached: i.attached,
        backfilled: i.backfilled,
      }),
    )
  for (const e of s.edits) out.push(JSON.stringify({ type: 'edit', ...e }))
  for (const x of s.samples) out.push(JSON.stringify({ type: 'sample', ...x }))
  for (const c of s.compactions)
    out.push(
      JSON.stringify({
        type: 'compaction',
        ...c,
        entities: c.entities.map(e =>
          e.type === 'edited-file' || e.type === 'read-file' ? { type: e.type, kept: e.kept, value: e.value } : { type: e.type, kept: e.kept, hash: contentHash(e.value) },
        ),
      }),
    )
  out.push(
    JSON.stringify({
      type: 'summary',
      k: sum.k,
      segments: sum.segments,
      liveEst: sum.occupancy.liveEst,
      wasteEst: sum.wasteEst,
      currentWasteEst: sum.rereads.currentWasteEst,
      sessionRereadEst: sum.sessionRereadEst,
      rereadWasteEst: sum.rereads.wasteEst,
      similarWasteEst: sum.similar.wasteEst,
      compactionReflowEst: sum.rereads.compactionEst,
      advice: sum.advice.map(a => ({ id: a.id, severity: a.severity, savings: a.savings })),
    }),
  )
  return out
}

// Newline-terminated chunks of whole lines, each at most `max` bytes (a single longer line goes alone).
export function chunkLines(lines: readonly string[], max = MAX_EXPORT_BYTES): string[] {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const line of lines) {
    const bytes = encoder.encode(line).length + 1
    if (current.length > 0 && size + bytes > max) {
      chunks.push(`${current.join('\n')}\n`)
      current = []
      size = 0
    }
    current.push(line)
    size += bytes
  }
  if (current.length > 0) chunks.push(`${current.join('\n')}\n`)
  return chunks
}

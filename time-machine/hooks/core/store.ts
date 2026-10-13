import { hash32 } from './hash.ts'
import type { Rec } from './types.ts'

// One timeline file stays under this. `$.fs.write` rewrites a file whole, so each record's write costs
// up to a chunk: small chunks keep a long session's writes linear in its records.
export const CHUNK_BYTES = 256 * 1024

// `<last path segment>-<8 hex of the whole path>`: readable, and distinct for same-named folders.
export function projectKey(root: string): string {
  const trimmed = root.replace(/\/+$/, '') || '/'
  const last = trimmed.split('/').filter(Boolean).at(-1) ?? 'root'
  return `${last.replace(/[^\w.-]/g, '_')}-${hash32(trimmed).toString(16).padStart(8, '0')}`
}

export function chunkName(loadId: string, index: number): string {
  return `${loadId}-${String(index).padStart(4, '0')}.jsonl`
}

const encoder = new TextEncoder()

// One module load's records. The host has no append, so each add returns the current chunk's whole
// body to write; past `max` bytes the next record starts a new chunk.
export class ChunkWriter {
  private lines: string[] = []
  private bytes = 0
  private index = 1

  constructor(
    readonly loadId: string,
    readonly max = CHUNK_BYTES,
  ) {}

  add(rec: Rec): { name: string; body: string } {
    const line = JSON.stringify(rec)
    const size = encoder.encode(line).length + 1
    if (this.lines.length > 0 && this.bytes + size > this.max) {
      this.index += 1
      this.lines = []
      this.bytes = 0
    }
    this.lines.push(line)
    this.bytes += size
    return { name: chunkName(this.loadId, this.index), body: `${this.lines.join('\n')}\n` }
  }
}

export type RecordingStatus = { state: 'recording' | 'degraded' | 'not persisted'; pending: number; error?: string }

// Keep the latest full body of every dirty file, including rolled-over chunks. Failed writes
// remain dirty until acknowledged; concurrent flushes cannot overwrite a newer body with an older one.
export class DurableWriter {
  private readonly pending = new Map<string, string>()
  private writing = Promise.resolve()
  private saved = false
  private error: string | undefined

  constructor(private readonly chunks: ChunkWriter) {}

  queueFile(name: string, body: string): void {
    this.pending.set(name, body)
  }

  add(records: readonly Rec[]): void {
    for (const rec of records) {
      const { name, body } = this.chunks.add(rec)
      this.queueFile(name, body)
    }
  }

  get status(): RecordingStatus {
    return {
      state: this.error === undefined ? 'recording' : this.saved ? 'degraded' : 'not persisted',
      pending: this.pending.size,
      ...(this.error !== undefined ? { error: this.error } : {}),
    }
  }

  flush(write: (name: string, body: string) => Promise<void>): Promise<void> {
    this.writing = this.writing.then(async () => {
      try {
        for (const [name, body] of this.pending) {
          await write(name, body)
          if (name.endsWith('.jsonl')) this.saved = true
          if (this.pending.get(name) === body) this.pending.delete(name)
        }
        this.error = undefined
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
      }
    })
    return this.writing
  }
}

// A session's chunks in write order (load id, then chunk number); lines that are not records are skipped.
export function parseChunks(files: readonly { name: string; text: string }[]): Rec[] {
  const out: Rec[] = []
  const chunks = files.filter(f => f.name.endsWith('.jsonl')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const file of chunks) {
    for (const line of file.text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const rec = JSON.parse(line) as Rec
        if (rec && typeof rec === 'object' && typeof rec.type === 'string') out.push(rec)
      } catch {
        // a torn or foreign line
      }
    }
  }
  return out
}

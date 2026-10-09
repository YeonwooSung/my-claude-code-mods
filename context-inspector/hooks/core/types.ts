// The main conversation's context key; a subagent's is its agentId.
export const MAIN = 'main'

export type TargetKind = 'file' | 'command' | 'pattern' | 'url' | 'agent'

export type Target = {
  kind: TargetKind
  value: string
  // Read only: 'offset:limit' from the call's input; absent for a whole-file read.
  range?: string
  // Read only: the result covered the whole file (startLine <= 1 and numLines >= totalLines).
  full?: boolean
}

export type ContextItem = {
  seq: number
  // Unique per item: the row uuid for a row's first item, '<row>#<n>' for its later ones.
  uuid: string
  row: string
  ctx: string
  turn: number
  door: string
  // The tool's name for a tool result, 'attachment:<name>' for attachments and hook context, else the door.
  category: string
  toolUseId?: string
  target?: Target
  chars: number
  est: number
  hash: string
  simhash?: string
  // The epoch the item arrived in, and the last epoch it was live in.
  born: number
  epoch: number
  live: boolean
  isError?: boolean
  // A Read the engine answered with "file unchanged" instead of the content.
  deduped?: boolean
  // File content the engine attached itself (a `file` attachment: an @-mention, or restored after compaction).
  attached?: boolean
  backfilled?: boolean
}

export type EditRec = { seq: number; ctx: string; turn: number; path: string; lines: number }

// One request's measured input: uncached + cache-written + cache-read tokens.
export type Sample = { seq: number; ctx: string; turn: number; epoch: number; input: number }

export type EntityType = 'edited-file' | 'read-file' | 'error' | 'requirement'
export type Entity = { type: EntityType; value: string; kept: boolean }

export type CompactionRec = {
  seq: number
  ctx: string
  turn: number
  trigger: string
  tokensBefore?: number
  tokensAfter?: number
  entities: Entity[]
  keptItems: number
  droppedItems: number
  droppedEst: number
}

export type Snapshot = {
  items: readonly ContextItem[]
  edits: readonly EditRec[]
  samples: readonly Sample[]
  compactions: readonly CompactionRec[]
  turn: number
  dropped: number
  droppedLive: number
}

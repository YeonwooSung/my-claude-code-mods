import { extractEntities, flattenMessages, isMentioned, type MessageLike } from './entities.ts'
import { contentHash, simhash64 } from './hash.ts'
import { Ledger, type ToolInfo } from './ledger.ts'
import { changedLines, EDIT_TOOLS } from './lines.ts'
import { blockText, HASH_CHARS, normalize } from './text.ts'
import { estimate } from './tokens.ts'
import { MAIN, type Target } from './types.ts'

// The parts of a `session.append` input the ledger reads.
export type AppendLike = {
  door: string
  uuid: string
  agentId?: string
  origin?: { kind: string; tool?: string }
  message: { type: string; name?: string; role?: string; content: unknown }
}

export type CompactIn = { trigger: string; agentId?: string; messages: readonly MessageLike[] }
export type CompactOut = { messages?: readonly MessageLike[]; tokensBefore?: number; tokensAfter?: number; skip?: string }

const SIMHASH_MIN_CHARS = 200
const FILE_ATTACHMENT = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

export function targetOf(tool: string, input: Record<string, unknown>): Target | undefined {
  switch (tool) {
    case 'Read': {
      const path = str(input.file_path)
      if (!path) return undefined
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      if (offset === undefined && limit === undefined) return { kind: 'file', value: path }
      return { kind: 'file', value: path, range: `${offset ?? 1}:${limit ?? 'all'}` }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = str(input.file_path)
      return path ? { kind: 'file', value: path } : undefined
    }
    case 'NotebookEdit': {
      const path = str(input.notebook_path)
      return path ? { kind: 'file', value: path } : undefined
    }
    case 'Bash': {
      const command = str(input.command)
      return command ? { kind: 'command', value: command } : undefined
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern)
      if (!pattern) return undefined
      const where = str(input.path)
      return { kind: 'pattern', value: where ? `${pattern} in ${where}` : pattern }
    }
    case 'WebFetch': {
      const url = str(input.url)
      return url ? { kind: 'url', value: url } : undefined
    }
    case 'WebSearch': {
      const query = str(input.query)
      return query ? { kind: 'pattern', value: query } : undefined
    }
    case 'Agent':
    case 'Task': {
      const agent = str(input.subagent_type) ?? str(input.description)
      return agent ? { kind: 'agent', value: agent } : undefined
    }
    default:
      return undefined
  }
}

// Before the call runs: what it targets and, for an edit, how many lines it changes.
export function ingestToolCall(l: Ledger, id: string, tool: string, agentId: string | undefined, input: Record<string, unknown>): void {
  const info: ToolInfo = { tool, ctx: agentId ?? MAIN, target: targetOf(tool, input) }
  if (EDIT_TOOLS.has(tool)) info.lines = changedLines(tool, input)
  l.toolStart(id, info)
}

// After the call: an engine-deduplicated Read, whether a Read was whole, an error or a deny.
export function ingestToolResult(l: Ledger, id: string, answer: unknown): void {
  const a = (answer ?? {}) as Record<string, unknown>
  const result = (a.result ?? {}) as Record<string, unknown>
  const file = (result.file ?? {}) as Record<string, unknown>
  const { startLine, numLines, totalLines } = file
  const full =
    typeof startLine === 'number' && typeof numLines === 'number' && typeof totalLines === 'number'
      ? startLine <= 1 && numLines >= totalLines
      : undefined
  l.toolEnd(id, {
    deduped: result.type === 'file_unchanged',
    isError: a.isError === true || typeof a.deny === 'string',
    full,
  })
}

function measure(text: string, images: number, tool: boolean): { chars: number; est: number; hash: string; simhash?: string } {
  const cut = text.length > HASH_CHARS ? text.slice(0, HASH_CHARS) : text
  return {
    chars: text.length,
    est: estimate(text.length, images),
    hash: contentHash(cut),
    simhash: tool && text.length >= SIMHASH_MIN_CHARS ? simhash64(normalize(cut)) : undefined,
  }
}

// One row entering a conversation: one item per tool_result block, one for the rest of the row.
export function ingestAppend(l: Ledger, e: AppendLike): void {
  if (e.message.role === undefined) return // a notice or a record no request carries
  if (l.revive(e.uuid)) return // re-appended after a compaction
  const ctx = e.agentId ?? MAIN
  if (ctx === MAIN && e.door === 'prompt') l.nextTurn()
  const blocks: unknown[] = Array.isArray(e.message.content) ? e.message.content : [e.message.content]
  let made = 0
  const nextUuid = (): string => {
    made += 1
    return made === 1 ? e.uuid : `${e.uuid}#${made - 1}`
  }
  const rest: unknown[] = []
  for (const raw of blocks) {
    const block = (raw ?? {}) as Record<string, unknown>
    if (block.type !== 'tool_result') {
      rest.push(raw)
      continue
    }
    const id = str(block.tool_use_id)
    const info = id ? l.tool(id) : undefined
    const { text, images } = blockText(block.content)
    if (id) l.forgetTool(id)
    if (text === '' && images === 0) continue
    l.add({
      uuid: nextUuid(),
      row: e.uuid,
      ctx,
      door: e.door,
      category: info?.tool ?? e.origin?.tool ?? 'tool',
      toolUseId: id,
      target: info?.target,
      ...measure(text, images, true),
      isError: block.is_error === true || info?.isError === true || undefined,
      deduped: info?.deduped || undefined,
    })
  }
  const { text, images } = blockText(rest)
  if (text === '' && images === 0) return
  const attachment = e.message.type === 'attachment'
  const name = e.message.name ?? 'unknown'
  const filePath = attachment && name === 'file' ? FILE_ATTACHMENT.exec(text)?.[1] : undefined
  l.add({
    uuid: nextUuid(),
    row: e.uuid,
    ctx,
    door: e.door,
    category: attachment ? `attachment:${name}` : e.door,
    target: filePath ? { kind: 'file', value: unescapeJson(filePath) } : undefined,
    ...measure(text, images, false),
    attached: filePath ? true : undefined,
  })
}

// A compaction that stands: which items stay in the window, and which entities the result still mentions.
export function ingestCompaction(l: Ledger, e: CompactIn, r: CompactOut): void {
  if (e.trigger === 'precompute' || typeof r.skip === 'string' || !r.messages) return
  const before = new Set(e.messages.flatMap(m => (typeof m.handle === 'string' ? [m.handle] : [])))
  const keptRows = new Set<string>()
  const keptTools = new Set<string>()
  for (const m of r.messages) {
    // The summary carries a handle too, but not one of the messages it replaced.
    if (m.handle === undefined || !before.has(m.handle)) continue
    keptRows.add(m.handle)
    for (const u of m.toolUses) keptTools.add(u.tool_use_id)
    for (const t of m.toolResults ?? []) keptTools.add(t.tool_use_id)
  }
  const after = flattenMessages(r.messages)
  const entities = extractEntities(e.messages).map(found => ({ ...found, kept: isMentioned(after, found) }))
  l.compacted(e.agentId ?? MAIN, keptRows, keptTools, { trigger: e.trigger, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter, entities })
}

// After a reload or resume: what the main conversation already holds (no attachments, no timing).
export function backfill(l: Ledger, messages: readonly MessageLike[]): void {
  messages.forEach((m, i) => {
    const row = `backfill-${i}`
    if (m.role === 'assistant') {
      for (const u of m.toolUses) {
        ingestToolCall(l, u.tool_use_id, u.tool, undefined, u.input)
        ingestToolResult(l, u.tool_use_id, { isError: u.isError === true, result: (u as { result?: unknown }).result })
      }
      const content = [{ type: 'text', text: m.text }, ...m.toolUses.map(u => ({ type: 'tool_use', name: u.tool, input: u.input }))]
      ingestAppend(l, { door: 'response', uuid: row, message: { type: 'assistant', role: 'assistant', content } })
    } else if ((m.toolResults?.length ?? 0) > 0) {
      const content = (m.toolResults ?? []).map(t => ({ type: 'tool_result', tool_use_id: t.tool_use_id, content: t.text, is_error: t.isError }))
      ingestAppend(l, { door: 'tool-result', uuid: row, message: { type: 'user', role: 'user', content } })
    } else {
      ingestAppend(l, { door: 'prompt', uuid: row, message: { type: 'user', role: 'user', content: m.text } })
    }
  })
  l.markBackfilled()
}

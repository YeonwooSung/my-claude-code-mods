import { ingestAppend, ingestToolCall, ingestToolResult, type AppendLike } from '../hooks/core/ingest.ts'
import type { Ledger } from '../hooks/core/ledger.ts'

let rows = 0
const nextRow = (): string => `row-${(rows += 1)}`

export const okLines = (n: number, word = 'ok'): string =>
  Array.from({ length: n }, (_, i) => `${word} ${i} test case passed in the suite`).join('\n')

// Unrelated words: far from okLines in SimHash space.
export const letters = (n: number): string =>
  Array.from({ length: n }, (_, i) => `q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}x`).join(' ')

export function toolResultRow(id: string, text: string, o: { agentId?: string; tool?: string; isError?: boolean; uuid?: string } = {}): AppendLike {
  return {
    door: 'tool-result',
    uuid: o.uuid ?? nextRow(),
    agentId: o.agentId,
    origin: { kind: 'tool', tool: o.tool ?? 'Read' },
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(o.isError ? { is_error: true } : {}) }] },
  }
}

export function promptRow(text: string, uuid = nextRow()): AppendLike {
  return { door: 'prompt', uuid, origin: { kind: 'unclassified' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text }] } }
}

export function attachmentRow(name: string, text: string, uuid = nextRow()): AppendLike {
  return { door: 'attachment', uuid, origin: { kind: 'engine' }, message: { type: 'attachment', name, role: 'user', content: [{ type: 'text', text }] } }
}

const UNCHANGED = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.'

export function readFile(
  l: Ledger,
  id: string,
  path: string,
  text: string,
  o: { offset?: number; limit?: number; unchanged?: boolean; agentId?: string; total?: number; uuid?: string } = {},
): void {
  const input: Record<string, unknown> = { file_path: path }
  if (o.offset !== undefined) input.offset = o.offset
  if (o.limit !== undefined) input.limit = o.limit
  ingestToolCall(l, id, 'Read', o.agentId, input)
  const numLines = text.split('\n').length
  ingestToolResult(
    l,
    id,
    o.unchanged
      ? { result: { type: 'file_unchanged', file: { filePath: path } }, text: UNCHANGED }
      : { result: { type: 'text', file: { filePath: path, startLine: o.offset ?? 1, numLines, totalLines: o.total ?? numLines } }, text },
  )
  ingestAppend(l, toolResultRow(id, o.unchanged ? UNCHANGED : text, { agentId: o.agentId, uuid: o.uuid }))
}

export function editFile(l: Ledger, id: string, path: string, before: string, after: string, agentId?: string): void {
  ingestToolCall(l, id, 'Edit', agentId, { file_path: path, old_string: before, new_string: after })
  ingestToolResult(l, id, { result: {}, text: 'The file has been updated.' })
  ingestAppend(l, toolResultRow(id, 'The file has been updated.', { tool: 'Edit', agentId }))
}

export function runBash(l: Ledger, id: string, command: string, output: string, agentId?: string): void {
  ingestToolCall(l, id, 'Bash', agentId, { command })
  ingestToolResult(l, id, { result: { stdout: output }, text: output })
  ingestAppend(l, toolResultRow(id, output, { tool: 'Bash', agentId }))
}

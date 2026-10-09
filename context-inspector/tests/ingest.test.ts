import { expect, test } from 'claude-code/testing'

import { extractEntities, isMentioned, type MessageLike } from '../hooks/core/entities.ts'
import { backfill, ingestAppend, ingestCompaction, ingestToolCall, ingestToolResult, needsBackfill } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { attachmentRow, editFile, okLines, promptRow, readFile, runBash, toolResultRow } from './fixtures.ts'

test('a Read becomes one item joined to its call: category, target, size, whole-file flag', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('fix the bug'))
  readFile(l, 't1', '/src/a.ts', okLines(10))
  const items = l.snapshot().items
  expect(items.length).toBe(2)
  const read = items[1]!
  expect(read.category).toBe('Read')
  expect(read.door).toBe('tool-result')
  expect(read.toolUseId).toBe('t1')
  expect(read.target).toEqual({ kind: 'file', value: '/src/a.ts', full: true })
  expect(read.est).toBe(Math.ceil(okLines(10).length / 4))
  expect(read.simhash).toMatch(/^[0-9a-f]{16}$/)
  expect(read.turn).toBe(1)
  expect(read.live).toBe(true)
})

test('offset/limit become the range key; a partial result is not whole', () => {
  const l = new Ledger()
  readFile(l, 't1', '/a', okLines(5), { offset: 10, limit: 5, total: 100 })
  expect(l.snapshot().items[0]!.target).toEqual({ kind: 'file', value: '/a', range: '10:5', full: false })
})

test('an engine-deduplicated Read is flagged', () => {
  const l = new Ledger()
  readFile(l, 't1', '/a', okLines(5))
  readFile(l, 't2', '/a', '', { unchanged: true })
  expect(l.snapshot().items[1]!.deduped).toBe(true)
})

test('a result with no recorded call keeps origin.tool and no target', () => {
  const l = new Ledger()
  ingestAppend(l, toolResultRow('unknown', 'some output', { tool: 'Grep' }))
  const item = l.snapshot().items[0]!
  expect(item.category).toBe('Grep')
  expect(item.target).toBeUndefined()
})

test('images in a tool result add 1,500 estimated tokens each', () => {
  const l = new Ledger()
  ingestAppend(l, {
    door: 'tool-result',
    uuid: 'r1',
    origin: { kind: 'tool', tool: 'Read' },
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'abcd' }, { type: 'image', source: {} }] }] },
  })
  expect(l.snapshot().items[0]!.est).toBe(1 + 1_500)
})

test('rows without a role, and empty rows, make no items', () => {
  const l = new Ledger()
  ingestAppend(l, { door: 'notice', uuid: 'n', message: { type: 'system', name: 'compact_boundary', content: [{ type: 'text', text: 'x' }] } })
  ingestAppend(l, attachmentRow('credential_org', ''))
  expect(l.size).toBe(0)
})

test('attachments are categorized by name; a file attachment carries its path and is marked attached', () => {
  const l = new Ledger()
  ingestAppend(l, attachmentRow('skill_listing', 'skills…'))
  ingestAppend(l, attachmentRow('file', '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/src/b.ts"}\nResult: …'))
  const [skills, file] = l.snapshot().items
  expect(skills!.category).toBe('attachment:skill_listing')
  expect(file!.target).toEqual({ kind: 'file', value: '/src/b.ts' })
  expect(file!.attached).toBe(true)
})

test('only main prompts advance the turn; subagent rows get their own context', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('one'))
  ingestAppend(l, { ...promptRow('sub'), agentId: 'a1' })
  ingestAppend(l, promptRow('two'))
  expect(l.turn).toBe(2)
  expect(l.snapshot().items.map(i => i.ctx)).toEqual(['main', 'a1', 'main'])
})

test('a successful edit is recorded with its changed lines; a failed one is not', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('edit'))
  editFile(l, 'e1', '/a.ts', 'a\nb', 'a\nc')
  const edits = l.snapshot().edits
  expect(edits.length).toBe(1)
  expect(edits[0]).toEqual({ seq: edits[0]!.seq, ctx: 'main', turn: 1, path: '/a.ts', lines: 2 })
})

test('a compaction keeps items in kept rows or answering kept calls; a re-appended row revives', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('go', 'p1'))
  readFile(l, 'r1', '/a.ts', okLines(20), { uuid: 'row-a' })
  runBash(l, 'b1', 'npm test', okLines(30))
  const before: MessageLike[] = [
    { role: 'user', text: 'go', toolUses: [], handle: 'p1' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }], handle: 'h-a' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: '…', isError: false }], handle: 'row-a' },
  ]
  const after: MessageLike[] = [
    { role: 'user', text: 'Summary: worked on a.ts', toolUses: [], handle: 'summary-row' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: '…', isError: false }], handle: 'row-a' },
  ]
  ingestCompaction(l, { trigger: 'auto', messages: before }, { messages: after, tokensBefore: 900, tokensAfter: 100 })
  const s = l.snapshot()
  const live = s.items.filter(i => i.live).map(i => i.category)
  expect(live).toEqual(['Read'])
  expect(s.compactions.length).toBe(1)
  expect(s.compactions[0]!.droppedItems).toBe(2)
  expect(s.compactions[0]!.entities).toContainEqual({ type: 'read-file', value: '/a.ts', kept: true })
  expect(l.epochOf('main')).toBe(1)
  // the engine re-appends the prompt row with its uuid: revived, not duplicated
  const size = l.size
  ingestAppend(l, promptRow('go', 'p1'))
  expect(l.size).toBe(size)
  expect(l.snapshot().items[0]!.live).toBe(true)
  expect(l.turn).toBe(1)
})

test('a skipped or precompute compaction changes nothing', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a', okLines(5))
  const v = l.version
  ingestCompaction(l, { trigger: 'manual', messages: [] }, { skip: 'vetoed' })
  ingestCompaction(l, { trigger: 'precompute', messages: [] }, { messages: [] })
  expect(l.version).toBe(v)
  expect(l.snapshot().compactions.length).toBe(0)
})

test('entities: edited files, other reads, errors, user identifiers; mentions by path or base name', () => {
  const messages: MessageLike[] = [
    { role: 'user', text: 'Rename `parseConfig` in src/config.ts <system-reminder>ignore_me_please</system-reminder>', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: '1', tool: 'Read', input: { file_path: '/r/src/config.ts' } },
        { tool_use_id: '2', tool: 'Edit', input: { file_path: '/r/src/config.ts' } },
        { tool_use_id: '3', tool: 'Read', input: { file_path: '/r/README.md' } },
      ],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: '4', text: '<tool_use_error>File not found: x.ts</tool_use_error>', isError: true }] },
  ]
  const found = extractEntities(messages)
  expect(found).toContainEqual({ type: 'edited-file', value: '/r/src/config.ts' })
  expect(found).toContainEqual({ type: 'read-file', value: '/r/README.md' })
  expect(found.some(f => f.type === 'read-file' && f.value === '/r/src/config.ts')).toBe(false)
  expect(found).toContainEqual({ type: 'error', value: 'File not found: x.ts' })
  expect(found).toContainEqual({ type: 'requirement', value: 'parseConfig' })
  expect(found).toContainEqual({ type: 'requirement', value: 'src/config.ts' })
  expect(found.some(f => f.value === 'ignore_me_please')).toBe(false)
  expect(isMentioned('we changed config.ts', { type: 'edited-file', value: '/r/src/config.ts' })).toBe(true)
  expect(isMentioned('nothing here', { type: 'read-file', value: '/r/README.md' })).toBe(false)
})

test('backfill rebuilds turns, tool results with targets, and edits, all marked backfilled', () => {
  const l = new Ledger()
  backfill(l, [
    { role: 'user', text: 'start', toolUses: [] },
    { role: 'assistant', text: 'reading', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }, { tool_use_id: 'e1', tool: 'Write', input: { file_path: '/b.ts', content: 'x\ny\n' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: okLines(3), isError: false }, { tool_use_id: 'e1', text: 'written', isError: false }] },
  ])
  const s = l.snapshot()
  expect(l.turn).toBe(1)
  expect(s.items.every(i => i.backfilled === true)).toBe(true)
  expect(s.items.find(i => i.toolUseId === 'r1')!.target).toEqual({ kind: 'file', value: '/a.ts' })
  expect(s.edits.map(e => [e.path, e.lines])).toEqual([['/b.ts', 2]])
})

test('the ledger trims to 90% of its cap, out-of-window items first', () => {
  const l = new Ledger(10)
  for (let i = 0; i < 6; i += 1) runBash(l, `b${i}`, 'ls', `out ${i}`)
  ingestCompaction(l, { trigger: 'manual', messages: [] }, { messages: [] }) // all six leave the window
  for (let i = 6; i < 11; i += 1) runBash(l, `b${i}`, 'ls', `out ${i}`)
  const s = l.snapshot()
  expect(s.items.length).toBe(9)
  expect(l.dropped).toBe(2)
  expect(l.droppedLive).toBe(0)
})

test('born stays at the first epoch; a kept item moves epoch, a dropped one does not, a later item is born in the new epoch', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('keep me', 'p1'))
  runBash(l, 'b1', 'ls', 'dropped output', undefined)
  const before: MessageLike[] = [{ role: 'user', text: 'keep me', toolUses: [], handle: 'p1' }]
  ingestCompaction(l, { trigger: 'auto', messages: before }, { messages: before })
  runBash(l, 'b2', 'ls', 'later output')
  const [kept, dropped, later] = l.snapshot().items
  expect([kept!.born, kept!.epoch, kept!.live]).toEqual([0, 1, true])
  expect([dropped!.born, dropped!.epoch, dropped!.live]).toEqual([0, 0, false])
  expect([later!.born, later!.epoch, later!.live]).toEqual([1, 1, true])
})

test('revive resets epoch to the current one for an item a compaction dropped', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('x', 'p2'))
  ingestCompaction(l, { trigger: 'auto', messages: [] }, { messages: [] })
  const item = l.snapshot().items[0]!
  expect([item.epoch, item.live]).toEqual([0, false])
  ingestAppend(l, promptRow('x', 'p2'))
  expect(l.size).toBe(1)
  expect([item.epoch, item.live, item.born]).toEqual([1, true, 0])
})

test('an item whose row is not kept stays live when its tool_use_id answers a kept message', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('go', 'p1'))
  runBash(l, 'b1', 'ls', 'output')
  const call: MessageLike = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'ls' } }], handle: 'h-call' }
  const before: MessageLike[] = [{ role: 'user', text: 'go', toolUses: [], handle: 'p1' }, call]
  const after: MessageLike[] = [{ role: 'user', text: 'go', toolUses: [], handle: 'p1' }, call]
  ingestCompaction(l, { trigger: 'auto', messages: before }, { messages: after })
  const bash = l.snapshot().items.find(i => i.toolUseId === 'b1')!
  expect(bash.live).toBe(true)
  expect(bash.epoch).toBe(1)
  expect(l.snapshot().compactions[0]!.droppedItems).toBe(0)
})

test('a subagent compaction drops only its own context and bumps only its epoch', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('main prompt', 'pm'))
  ingestAppend(l, { ...promptRow('sub prompt', 'ps'), agentId: 'a1' })
  runBash(l, 'bs', 'ls', 'sub output', 'a1')
  ingestCompaction(l, { trigger: 'auto', agentId: 'a1', messages: [] }, { messages: [] })
  const s = l.snapshot()
  expect(s.items.filter(i => i.ctx === 'main').every(i => i.live)).toBe(true)
  expect(s.items.filter(i => i.ctx === 'a1').every(i => !i.live)).toBe(true)
  expect(l.epochOf('a1')).toBe(1)
  expect(l.epochOf('main')).toBe(0)
  expect(s.compactions[0]!.ctx).toBe('a1')
  expect(s.compactions[0]!.droppedItems).toBe(2)
})

test('a denied or errored edit is not recorded', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('edit'))
  const input = { file_path: '/a.ts', old_string: 'a', new_string: 'b' }
  ingestToolCall(l, 'e1', 'Edit', undefined, input)
  ingestToolResult(l, 'e1', { deny: 'no' })
  ingestToolCall(l, 'e2', 'Edit', undefined, input)
  ingestToolResult(l, 'e2', { isError: true })
  expect(l.snapshot().edits.length).toBe(0)
  ingestToolCall(l, 'e3', 'Edit', undefined, input)
  ingestToolResult(l, 'e3', { result: {} })
  expect(l.snapshot().edits.length).toBe(1)
})

test('backfill skips tool results the ledger already holds, so rows that arrived first are not doubled', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(3))
  editFile(l, 'e1', '/b.ts', 'x', 'y')
  backfill(l, [
    { role: 'user', text: 'start', toolUses: [] },
    { role: 'assistant', text: 'working', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }, { tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/b.ts', old_string: 'x', new_string: 'y' } }, { tool_use_id: 'r2', tool: 'Read', input: { file_path: '/c.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: okLines(3), isError: false }, { tool_use_id: 'e1', text: 'updated', isError: false }, { tool_use_id: 'r2', text: okLines(2), isError: false }] },
  ])
  const s = l.snapshot()
  expect(s.items.filter(i => i.toolUseId === 'r1').length).toBe(1)
  expect(s.items.filter(i => i.toolUseId === 'e1').length).toBe(1)
  expect(s.items.filter(i => i.toolUseId === 'r2').length).toBe(1)
  expect(s.edits.length).toBe(1)
  expect(s.items.filter(i => i.door === 'prompt').length).toBe(1)
  // the rows recorded live keep their flag off; only the read-back ones are marked
  expect(s.items.filter(i => i.backfilled).map(i => i.toolUseId ?? i.door)).toEqual(['prompt', 'response', 'r2'])
})

test('needsBackfill: yes while the ledger holds no prompt or response, no once it does', () => {
  const l = new Ledger()
  expect(needsBackfill(l)).toBe(true)
  readFile(l, 'r1', '/a.ts', okLines(3))
  ingestAppend(l, attachmentRow('hook_context', 'some context'))
  expect(needsBackfill(l)).toBe(true)
  ingestAppend(l, promptRow('go'))
  expect(needsBackfill(l)).toBe(false)
  const r = new Ledger()
  ingestAppend(r, { door: 'response', uuid: 'a1', message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
  expect(needsBackfill(r)).toBe(false)
})

import { test, expect } from 'claude-code/testing'
import { emptyDocument, decodeDocument, execute } from '../hooks/core/memo.ts'

const run = (args: string) => execute(emptyDocument(), args).document

test('adds plain and checked notes while preserving multiline Unicode', () => {
  expect(run('  한글\nsecond  ').items).toEqual([{ id: 1, text: '한글\nsecond', checked: null }])
  expect(run('- [ ] 배포').items[0]).toEqual({ id: 1, text: '배포', checked: false })
  expect(run('[X] done').items[0]?.checked).toBe(true)
  expect(run('add clear').items[0]?.text).toBe('clear')
  expect(run('add \x1b[31mred\x1b[0m\x07').items[0]?.text).toBe('red')
})

test('edits kind, checks idempotently, toggles and removes without mutating previous state', () => {
  const a = run('[ ] test')
  const b = execute(a, 'check 1').document
  expect(a.items[0]?.checked).toBe(false)
  expect(execute(b, 'check 1').changed).toBe(false)
  expect(execute(b, 'uncheck 1').document.items[0]?.checked).toBe(false)
  expect(execute(b, 'toggle 1').document.items[0]?.checked).toBe(false)
  expect(execute(b, 'edit 1 hello').document.items[0]?.checked).toBe(null)
  expect(execute(b, 'edit 1 - [ ] new').document.items[0]?.text).toBe('new')
  const removed = execute(b, 'remove 1').document
  expect(execute(removed, 'next').document.items[0]?.id).toBe(2)
  expect(execute(execute(b, 'clear').document, 'next').document.items[0]?.id).toBe(2)
})

test('lists all content and rejects invalid command arguments without mutation', () => {
  const doc = run('one\ntwo')
  expect(execute(doc, '').text).toContain('one\ntwo')
  expect(execute(doc, 'list').changed).toBe(false)
  expect(execute(doc, 'help').text).toContain('/pin')
  for (const args of ['add', '[ ]', 'toggle 1', 'check 1', 'remove 99', 'edit 1', 'remove 1x', 'list extra', 'clear extra', 'check 0', 'add \x07']) {
    expect(() => execute(doc, args)).toThrow()
  }
  expect(doc.items).toEqual([{ id: 1, text: 'one\ntwo', checked: null }])
})

test('enforces limits in Unicode code points and item count', () => {
  expect(run('😀'.repeat(2000)).items[0]?.text.length).toBe(4000)
  expect(() => run('😀'.repeat(2001))).toThrow()
  let doc = emptyDocument()
  for (let i = 0; i < 100; i++) doc = execute(doc, `memo ${i}`).document
  expect(() => execute(doc, 'overflow')).toThrow()
  expect(execute(doc, 'edit 1 changed').document.items.length).toBe(100)
})

test('validates restored documents and prevents ambiguous or unsupported state', () => {
  expect(decodeDocument(undefined)).toEqual({ version: 1, nextId: 1, items: [] })
  const valid = { version: 1, nextId: 4, items: [{ id: 3, text: 'memo', checked: null }] }
  expect(decodeDocument(valid)).toEqual(valid)
  for (const bad of [null, {}, { ...valid, version: 2 }, { ...valid, nextId: 3 }, { ...valid, items: [valid.items[0], valid.items[0]] }, { ...valid, items: [{ id: 3, text: '', checked: null }] }, { ...valid, items: [{ id: 3, text: 'x', checked: 'yes' }] }, { ...valid, items: [{ id: 3, text: '\x1b[31mred', checked: null }] }]) {
    expect(() => decodeDocument(bad)).toThrow()
  }
})

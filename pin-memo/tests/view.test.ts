import { test, expect } from 'claude-code/testing'
import { buildView, cellWidth, fit } from '../hooks/core/view.ts'
import { emptyDocument, execute } from '../hooks/core/memo.ts'

const doc = execute(execute(emptyDocument(), '한글\n긴 내용 😀😀').document, '[x] done').document

test('counts completion and preserves originals while narrowing each visible row', () => {
  const v = buildView(doc, undefined, 50, 10)!
  expect(v.border).toBe(true)
  expect(v.title).toContain('핀 2 (완료 1)')
  expect(v.rows[1]?.checked).toBe(true)
  for (const width of [1, 8, 29, 30, 50]) {
    const view = buildView(doc, undefined, width, 3)!
    expect(cellWidth(view.title)).toBeLessThanOrEqual(view.innerWidth)
    for (const row of view.rows) expect(cellWidth(row.prefix + row.text)).toBeLessThanOrEqual(view.innerWidth)
  }
  expect(doc.items[0]?.text).toBe('한글\n긴 내용 😀😀')
})

test('yields empty or unavailable space and uses compact layout below boundary', () => {
  expect(buildView(emptyDocument(), undefined, 80, 5)).toBe(undefined)
  for (const width of [0, -1, Number.NaN]) expect(buildView(doc, undefined, width, 5)).toBe(undefined)
  expect(buildView(doc, undefined, 80, 0)).toBe(undefined)
  for (const height of [1, 2]) expect(buildView(doc, undefined, 30, height)?.border).toBe(false)
  expect(buildView(doc, undefined, 29, 3)?.border).toBe(false)
  expect(buildView(doc, undefined, 30, 3)?.border).toBe(true)
  expect(buildView(undefined, '저장 오류', 80, 5)?.error).toContain('저장 오류')
})

test('handles wide graphemes, combined characters and many items without dropping data', () => {
  expect(cellWidth('한글😀')).toBe(6)
  expect(cellWidth('e\u0301')).toBe(1)
  expect(cellWidth('👩‍💻')).toBe(2)
  let many = emptyDocument()
  for (let i = 0; i < 100; i++) many = execute(many, `item ${i}`).document
  expect(buildView(many, undefined, 60, 5)?.rows.length).toBe(100)
})

// Literal cell budgets catch omissions in the width helper itself.
test('supplementary East Asian wide characters never exceed literal truncation budgets', () => {
  for (const ch of ['𛀀', '𛀁', '𖿠', '𗀀']) expect(cellWidth(ch)).toBe(2)
  expect(fit('𛀀a', 2)).toBe('…')
  expect(fit('𛀀a', 3)).toBe('𛀀a')
})

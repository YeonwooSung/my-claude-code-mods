import type { MemoDocument } from './memo.ts'
export type MemoView = { border: boolean; innerWidth: number; title: string; error?: string; rows: { id: number; checked: boolean | null; prefix: string; text: string }[] }

function clusters(text: string): string[] {
  const out: string[] = []
  for (const ch of text) {
    const last = out.at(-1)
    if (last && (/^[\p{Mark}\u200d\ufe0f\u{1f3fb}-\u{1f3ff}]$/u.test(ch) || last.endsWith('\u200d')
      || (/^\p{Regional_Indicator}$/u.test(ch) && /^\p{Regional_Indicator}$/u.test(last)))) out[out.length - 1] += ch
    else out.push(ch)
  }
  return out
}
function clusterWidth(ch: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\ufe0f/u.test(ch)) return 2
  let width = 0
  for (const c of ch) {
    const p = c.codePointAt(0)!
    if (/\p{Mark}|\p{Format}/u.test(c)) continue
    width += p >= 0x1100 && (p <= 0x115f || p === 0x2329 || p === 0x232a
      || (p >= 0x2e80 && p <= 0xa4cf && p !== 0x303f) || (p >= 0xac00 && p <= 0xd7a3)
      || (p >= 0xf900 && p <= 0xfaff) || (p >= 0xfe10 && p <= 0xfe6f)
      || (p >= 0xff00 && p <= 0xff60) || (p >= 0xffe0 && p <= 0xffe6)
      || (p >= 0x16fe0 && p <= 0x16fe4) || (p >= 0x16ff0 && p <= 0x16ff6)
      || (p >= 0x17000 && p <= 0x18dff) || (p >= 0x1aff0 && p <= 0x1afff)
      || (p >= 0x1b000 && p <= 0x1b2ff) || (p >= 0x1f200 && p <= 0x1f251)
      || (p >= 0x20000 && p <= 0x3fffd)) ? 2 : 1
  }
  return width
}
export function cellWidth(text: string): number { return clusters(text).reduce((n, ch) => n + clusterWidth(ch), 0) }
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  if (cellWidth(text) <= width) return text
  let result = '', used = 0
  for (const ch of clusters(text)) {
    const w = clusterWidth(ch)
    if (used + w > width - 1) break
    result += ch; used += w
  }
  return result + '…'
}

export function buildView(doc: MemoDocument | undefined, error: string | undefined, width: number, maxRows: number): MemoView | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(maxRows) || width < 1 || maxRows < 1 || (!doc?.items.length && !error)) return undefined
  width = Math.floor(width)
  const border = width >= 30 && maxRows >= 3
  const innerWidth = border ? width - 4 : width
  return {
    border, innerWidth,
    title: fit(`📌 핀 ${doc?.items.length ?? 0} (완료 ${doc?.items.filter(m => m.checked === true).length ?? 0})`, innerWidth),
    ...(error ? { error: fit(error.replace(/\s+/g, ' '), innerWidth) } : {}),
    rows: (doc?.items ?? []).map(m => {
      const fullPrefix = m.checked === null ? `${m.id} · ` : `${m.checked ? '[x]' : '[ ]'} ${m.id} `
      const prefix = fit(fullPrefix, innerWidth)
      return { id: m.id, checked: m.checked, prefix, text: fit(m.text.replace(/\s+/g, ' '), innerWidth - cellWidth(prefix)) }
    }),
  }
}

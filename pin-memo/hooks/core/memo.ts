export type Memo = { id: number; text: string; checked: boolean | null }
export type MemoDocument = { version: 1; nextId: number; items: Memo[] }
export type CommandResult = { document: MemoDocument; changed: boolean; text: string }

export function emptyDocument(): MemoDocument { return { version: 1, nextId: 1, items: [] } }

export function cleanText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim()
}

function content(raw: string): Pick<Memo, 'text' | 'checked'> {
  const clean = cleanText(raw)
  const match = /^(?:-\s+)?\[([ xX])\](?:\s+|$)([\s\S]*)$/.exec(clean)
  const text = (match ? match[2]! : clean).trim()
  if (!text) throw new Error('메모 내용을 입력하세요. /pin help')
  if (Array.from(text).length > 2000) throw new Error('메모는 최대 2,000자입니다.')
  return { text, checked: match ? match[1]!.toLowerCase() === 'x' : null }
}

export function decodeDocument(value: unknown): MemoDocument {
  if (value === undefined) return emptyDocument()
  const bad = () => { throw new Error('저장된 메모 형식이 올바르지 않습니다. /pin clear로 초기화할 수 있습니다.') }
  if (!value || typeof value !== 'object') return bad()
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !Number.isSafeInteger(v.nextId) || (v.nextId as number) < 1 || !Array.isArray(v.items) || v.items.length > 100) return bad()
  const ids = new Set<number>()
  const items: Memo[] = []
  for (const item of v.items) {
    if (!item || typeof item !== 'object') return bad()
    const m = item as Memo
    if (!Number.isSafeInteger(m.id) || m.id < 1 || m.id >= (v.nextId as number) || ids.has(m.id)
      || typeof m.text !== 'string' || !m.text || cleanText(m.text) !== m.text || Array.from(m.text).length > 2000
      || (m.checked !== null && typeof m.checked !== 'boolean')) return bad()
    ids.add(m.id)
    items.push({ id: m.id, text: m.text, checked: m.checked })
  }
  return { version: 1, nextId: v.nextId as number, items }
}

export const HELP = '/pin <memo> | /pin - [ ] <todo>\n/pin add <memo> | list | help\n/pin toggle|check|uncheck|remove <id>\n/pin edit <id> <memo> | clear'
export function listText(doc: MemoDocument): string {
  return doc.items.length ? doc.items.map(m => `${m.id} ${m.checked === null ? '·' : m.checked ? '[x]' : '[ ]'} ${m.text}`).join('\n') : '핀 메모가 없습니다. /pin <memo>'
}

export function execute(doc: MemoDocument, args: string): CommandResult {
  const raw = args.trim()
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  const command = match?.[1] ?? 'list'
  const rest = match?.[2] ?? ''
  const unchanged = (text: string): CommandResult => ({ document: doc, changed: false, text })
  if (command === 'help' || command === 'list') {
    if (rest) throw new Error(HELP)
    return unchanged(command === 'help' ? HELP : listText(doc))
  }
  if (command === 'clear') {
    if (rest) throw new Error(HELP)
    return { document: { ...doc, items: [] }, changed: doc.items.length > 0, text: '핀 메모를 비웠습니다.' }
  }
  if (['toggle', 'check', 'uncheck', 'remove', 'edit'].includes(command)) {
    const idMatch = /^(\d+)(?:\s+([\s\S]*))?$/.exec(rest)
    if (!idMatch || (command !== 'edit' && idMatch[2]) || (command === 'edit' && !idMatch[2])) throw new Error(HELP)
    const id = Number(idMatch[1])
    const item = doc.items.find(m => m.id === id)
    if (!item) throw new Error(`메모 #${id}가 없습니다.`)
    if (command === 'remove') return { document: { ...doc, items: doc.items.filter(m => m.id !== id) }, changed: true, text: `메모 #${id} 삭제` }
    if (command !== 'edit' && item.checked === null) throw new Error('일반 메모에는 체크 상태가 없습니다. /pin edit로 체크 항목으로 바꾸세요.')
    const updated = command === 'edit' ? { ...item, ...content(idMatch[2]!) }
      : { ...item, checked: command === 'toggle' ? !item.checked : command === 'check' }
    if (updated.text === item.text && updated.checked === item.checked) return unchanged(`메모 #${id} 상태 유지`)
    return { document: { ...doc, items: doc.items.map(m => m.id === id ? updated : m) }, changed: true, text: `메모 #${id} 변경` }
  }
  const memo = content(command === 'add' ? rest : raw)
  if (doc.items.length >= 100) throw new Error('핀 메모는 최대 100개입니다.')
  if (doc.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('메모 번호 한도를 초과했습니다.')
  return { document: { ...doc, nextId: doc.nextId + 1, items: [...doc.items, { id: doc.nextId, ...memo }] }, changed: true, text: `메모 #${doc.nextId} 고정` }
}

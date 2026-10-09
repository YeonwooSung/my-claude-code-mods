import { EDIT_TOOLS } from './lines.ts'
import type { Entity, EntityType } from './types.ts'

// One message as `session.compact` and `$.session.messages()` hand it over.
export type MessageLike = {
  role: string
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: boolean }[]
  toolResults?: readonly { tool_use_id: string; text: string; isError: boolean }[]
  handle?: string
}

export type Found = Omit<Entity, 'kept'>

const MAX_ERRORS = 20
const MAX_REQUIREMENTS = 50
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const BACKTICK = /`([^`\n]{4,80})`/g
const PATH = /(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|rb|md|json|ya?ml|toml|sh|c|cc|cpp|h|hpp|css|html|sql)\b/g
const IDENT = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g

const pathOf = (input: Record<string, unknown>): string | undefined =>
  typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined

function errorLine(text: string): string {
  const line = text
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '')
  return (line ?? '').slice(0, 120)
}

// What a compaction should keep: edited files, other files read, tool errors, identifiers the user typed.
export function extractEntities(messages: readonly MessageLike[]): Found[] {
  const out: Found[] = []
  const seen = new Set<string>()
  const add = (type: EntityType, value: string): boolean => {
    const key = `${type}\u0000${value}`
    if (value === '' || seen.has(key)) return false
    seen.add(key)
    out.push({ type, value })
    return true
  }
  const edited = new Set<string>()
  for (const m of messages)
    for (const u of m.toolUses) {
      const path = pathOf(u.input)
      if (path && EDIT_TOOLS.has(u.tool) && !u.isError) edited.add(path)
    }
  for (const path of edited) add('edited-file', path)
  for (const m of messages)
    for (const u of m.toolUses) {
      const path = pathOf(u.input)
      if (u.tool === 'Read' && path && !edited.has(path)) add('read-file', path)
    }
  let errors = 0
  for (const m of messages) {
    const failed = [
      ...(m.toolResults ?? []).filter(r => r.isError).map(r => r.text),
      ...m.toolUses.flatMap(u => (u.isError && u.text ? [u.text] : [])),
    ]
    for (const text of failed) if (errors < MAX_ERRORS && add('error', errorLine(text))) errors += 1
  }
  let requirements = 0
  for (const m of messages) {
    if (m.role !== 'user' || (m.toolResults?.length ?? 0) > 0) continue
    const text = m.text.replace(REMINDER, ' ')
    for (const re of [BACKTICK, PATH, IDENT])
      for (const match of text.matchAll(re)) {
        const value = (match[1] ?? match[0]).trim()
        if (requirements < MAX_REQUIREMENTS && value.length >= 4 && add('requirement', value)) requirements += 1
      }
  }
  return out
}

// Everything the model will read after the compaction, as one string to search.
export function flattenMessages(messages: readonly MessageLike[]): string {
  const parts: string[] = []
  for (const m of messages) {
    parts.push(m.text)
    for (const u of m.toolUses) {
      parts.push(JSON.stringify(u.input) ?? '')
      if (u.text) parts.push(u.text)
    }
    for (const r of m.toolResults ?? []) parts.push(r.text)
  }
  return parts.join('\n')
}

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

// A file counts as kept when its path or its base name appears; an error by its first 40 characters.
export function isMentioned(text: string, entity: Found): boolean {
  switch (entity.type) {
    case 'edited-file':
    case 'read-file':
      return text.includes(entity.value) || text.includes(basename(entity.value))
    case 'error':
      return text.includes(entity.value.slice(0, 40))
    case 'requirement':
      return text.includes(entity.value)
  }
}

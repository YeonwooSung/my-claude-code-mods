import { classifyCommand } from './classify.ts'
import { contentHash } from './hash.ts'
import { isSecretKey, redactSecrets } from './redact.ts'
import type { StepResult } from './types.ts'

export const MUTATING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
export const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch', 'Skill',
  'SendMessage', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'BashOutput', 'KillShell',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'NotebookRead',
])
// Not snapshotted (whatever they change arrives as steps of their own), but running one again acts:
// a subagent or skill edits files and runs commands, a message reaches an agent, a shell is killed.
export const ACTING_TOOLS = new Set(['Task', 'Agent', 'Skill', 'SendMessage', 'KillShell'])
export const INPUT_STRING_MAX = 4096
export const RESULT_HEAD_MAX = 2048
const ENGINE_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// Unknown and MCP tools count as mutating: a snapshot that finds nothing changed costs one tree hash.
// Every Bash counts unless asked otherwise: a "search" command can still write through a redirect.
export function isMutating(tool: string, input: Record<string, unknown>, skipSearchBash = false): boolean {
  if (tool === 'Bash') return !skipSearchBash || classifyCommand(str(input.command) ?? '') !== 'search'
  if (MUTATING_TOOLS.has(tool)) return true
  return !READ_ONLY_TOOLS.has(tool)
}

export function relPath(root: string, path: string): string {
  const base = root.replace(/\/+$/, '')
  return base !== '' && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

// A free-text target: secrets masked, whitespace collapsed to one line, cut to 120 chars.
const oneLine = (text: string | undefined): string | undefined => (text ? redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 120) : undefined)

export function targetOf(tool: string, input: Record<string, unknown>, root: string): string | undefined {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = str(input.file_path)
      return path ? relPath(root, path) : undefined
    }
    case 'NotebookEdit': {
      const path = str(input.notebook_path)
      return path ? relPath(root, path) : undefined
    }
    case 'Bash': {
      return oneLine(str(input.command))
    }
    case 'Grep':
    case 'Glob':
      return oneLine(str(input.pattern))
    case 'WebFetch':
      return oneLine(str(input.url))
    case 'WebSearch':
      return oneLine(str(input.query))
    case 'Agent':
    case 'Task':
      return oneLine(str(input.subagent_type) ?? str(input.description))
    default:
      return undefined
  }
}

// The input as stored: engine keys dropped, secrets masked, long strings cut (the snapshot holds the files).
export function summarizeInput(input: Record<string, unknown>): { input: Record<string, unknown>; lossy: boolean } {
  let lossy = false
  const field = (key: string, value: unknown, depth: number): unknown => {
    if (isSecretKey(key)) {
      lossy = true
      return '[REDACTED]'
    }
    return walk(value, depth)
  }
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const masked = redactSecrets(value)
      if (masked !== value) lossy = true
      if (masked.length <= INPUT_STRING_MAX) return masked
      lossy = true
      return `${masked.slice(0, INPUT_STRING_MAX)}…(+${masked.length - INPUT_STRING_MAX} chars, #${contentHash(value)})`
    }
    if (Array.isArray(value)) {
      if (depth > 4) {
        lossy = true
        return '[…]'
      }
      return value.map(v => walk(v, depth + 1))
    }
    if (value && typeof value === 'object') {
      if (depth > 4) {
        lossy = true
        return '{…}'
      }
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, field(k, v, depth + 1)]))
    }
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) if (!ENGINE_KEYS.has(key)) out[key] = field(key, value, 0)
  return { input: out, lossy }
}

// The input exactly as the tool got it, engine keys aside: what a rerun passes back.
export function callInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !ENGINE_KEYS.has(key)))
}

export function resultText(answer: unknown): string {
  const a = (answer ?? {}) as Record<string, unknown>
  if (typeof a.text === 'string') return a.text
  if (typeof a.deny === 'string') return a.deny
  return ''
}

export function summarizeResult(answer: unknown): StepResult {
  const a = (answer ?? {}) as Record<string, unknown>
  const denied = typeof a.deny === 'string'
  const text = resultText(answer)
  return {
    isError: denied || a.isError === true,
    denied,
    chars: text.length,
    hash: contentHash(text),
    head: redactSecrets(text).slice(0, RESULT_HEAD_MAX),
  }
}

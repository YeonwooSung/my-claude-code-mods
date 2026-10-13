export type Outcome = { kind: 'failure' | 'success' | 'unknown'; signature?: string; excerpt?: string }
const MAX_OUTPUT = 65_536
const UNKNOWN: Outcome = { kind: 'unknown' }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

// Two seeded FNV-1a hashes over UTF-16, with a murmur finalizer. Not cryptographic.
export function hash(text: string): string {
  return [0, 0x9747b28c].map(seed => {
    let h = (0x811c9dc5 ^ seed) >>> 0
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
    return ((h ^ (h >>> 16)) >>> 0).toString(16).padStart(8, '0')
  }).join('')
}

const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s'"]+)`
export function display(text: string, max = 160): string {
  const clean = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .replace(/(\bauthorization\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(new RegExp(String.raw`(--(?:password|token|api-key)(?:=|\s+))` + VALUE, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(String.raw`\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=` + VALUE, 'gi'), '$1=[REDACTED]')
    .replace(new RegExp(String.raw`((?:["']?)(?:password|token|api[_-]?key|secret)(?:["']?)\s*:\s*)` + VALUE, 'gi'), '$1[REDACTED]')
    .replace(/\s+/g, ' ').trim()
  const limit = Math.max(1, Math.floor(max))
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
}

function failedTests(text: string): boolean {
  // Only framework summary shapes, never a generic occurrence of "error" or "failed".
  return /^# fail [1-9]\d*\s*$/m.test(text)
    || /^[ \t]*Tests(?::|[ \t]+)[^\n]*\b[1-9]\d* failed\b/m.test(text)
    || /^=+[ \t]+[^\n]*\b[1-9]\d* (?:failed|errors?)\b[^\n]* in [\d.]+s\b/m.test(text)
    || /^test result: FAILED\.[^\n]*\b[1-9]\d* failed\b/m.test(text)
    || /^[ \t]*--- FAIL: \S+/m.test(text)
}

function normalized(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*m/g, '').replace(/\r\n/g, '\n').trim()
    .replace(/^([ \t]*duration_ms:[ \t]*)[\d.]+[ \t]*$/gm, '$1<time>')
    .replace(/^(# duration_ms )[\d.]+[ \t]*$/gm, '$1<time>')
    .replace(/^(=+[^\n]*\b(?:failed|passed|errors?|skipped)\b[^\n]* in )[\d.]+s/gm, '$1<time>')
    .replace(/\([\d.]+ ms\)/g, '(<time>)')
    .replace(/^((?:Time:|[ \t]*Duration[ \t]+)[^\n]*)$/gm, line => line.replace(/\b[\d.]+\s*(?:ms|s)\b/g, '<time>'))
    .replace(/^(test result: [^\n]* finished in )[\d.]+s[ \t]*$/gm, '$1<time>')
    .replace(/^(\s*--- (?:FAIL|PASS): [^\n]* )\([\d.]+s\)$/gm, '$1(<time>)')
    .replace(/^((?:ok|FAIL)\s+\S+\s+)[\d.]+s\s*$/gm, '$1<time>')
}

export function classifyResult(answer: unknown): Outcome {
  const a = record(answer)
  const r = record(a.result)
  if (a.deny !== undefined) return UNKNOWN
  for (const o of [a, r]) {
    if (['interrupted', 'cancelled', 'canceled', 'timedOut', 'timed_out', 'truncated', 'output_truncated'].some(k => o[k] === true)) return UNKNOWN
    if (['backgroundTaskId', 'background_task_id', 'task_id', 'taskId'].some(k => o[k] !== undefined && o[k] !== null && o[k] !== '')) return UNKNOWN
  }
  const streams = [r.stdout, r.stderr].filter((v): v is string => typeof v === 'string')
  if (streams.reduce((sum, v) => sum + v.length, 0) > MAX_OUTPUT) return UNKNOWN
  const raw = typeof a.text === 'string' ? a.text
    : typeof a.result === 'string' ? a.result : streams.join('\n')
  if (raw.length > MAX_OUTPUT) return UNKNOWN
  const text = normalized(raw)
  const code = r.exitCode ?? r.exit_code
  if (code !== undefined && (typeof code !== 'number' || !Number.isFinite(code))) return UNKNOWN
  const frameworkText = raw.replace(/\x1b\[[0-?]*[ -/]*m/g, '').replace(/\r\n/g, '\n')
  if (a.isError === true || (typeof code === 'number' && code !== 0) || failedTests(frameworkText)) {
    if (!text) return UNKNOWN
    const evidence = text.split('\n').find(line => /error|fail|expected|not ok/i.test(line)) ?? text
    return { kind: 'failure', signature: hash(text), excerpt: display(evidence) }
  }
  if (code === 0 || a.isError === false || streams.length > 0) return { kind: 'success' }
  return UNKNOWN
}

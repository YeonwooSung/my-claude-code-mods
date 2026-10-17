// Canonical source; run node scripts/sync-redactors.mjs after editing.
// Best-effort removal of obvious secrets from command lines before they are exported.
const VALUE = String.raw`("(?:\\.|[^"\\])*"|'[^']*'|[^\s'"]+)`
// Only match user:password arguments, leaving username-only options (e.g. mysql -u) alone.
const CREDENTIAL = String.raw`("(?:\\.|[^"\\])*:(?:\\.|[^"\\])*"|'[^']*:[^']*'|[^\s'"]*:[^\s'"]*)`
const RULES: [RegExp, string][] = [
  [/(\bauthorization\s*:\s*)[^'"\n]+/gi, '$1[REDACTED]'],
  [new RegExp(String.raw`((?:["']?)(?:password|token|api[_-]?key|secret)(?:["']?)\s*:\s*)` + VALUE, 'gi'), '$1[REDACTED]'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [new RegExp(String.raw`(--(?:password|token|api-key|secret)(?:=|\s+))` + VALUE, 'gi'), '$1[REDACTED]'],
  [/(\b[a-z0-9][a-z0-9-]*-(?:key|token|secret)\s*:\s*)[^'"\r\n]+/gi, '$1[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]*:)[^\s/@'"]*@/gi, '$1[REDACTED]@'],
  [new RegExp(String.raw`(\s(?:--user(?:=|\s+)|-u\s*))` + CREDENTIAL, 'g'), '$1[REDACTED]'],
  [/(\bmysql\w*\b[^\n;&|]*?\s-p)(?=\S)("[^"]*"|'[^']*'|\S+)/g, '$1[REDACTED]'],
  [new RegExp(String.raw`\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=` + VALUE, 'gi'), '$1=[REDACTED]'],
]

export function redactSecrets(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}

// Match complete key names, including common camelCase/underscore/hyphen spellings.
// Do not match ordinary names such as token_count or keyboard.
export function isSecretKey(key: string): boolean {
  return /^(?:password|passwd|pwd|authorization|proxyauthorization|apikey|accesskey|secretkey|privatekey|clientsecret|secret|token|accesstoken|refreshtoken|idtoken|sessiontoken|authtoken|credential|credentials|cookie|setcookie)$/i.test(key.replace(/[_\s-]/g, '')) || /^[a-z0-9][a-z0-9-]*-(?:key|token|secret)$/i.test(key)
}

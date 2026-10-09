export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

export function pct(part: number, whole: number): string {
  // part * 100 first: (6050 / 10000) * 100 is 60.49999… in floating point.
  return whole > 0 ? `${Math.round((part * 100) / whole)}%` : '0%'
}

export function clip(text: string, n: number): string {
  const line = text.replace(/[\r\n\t]+/g, ' ')
  return line.length <= n ? line : `${line.slice(0, Math.max(0, n - 1))}…`
}

export function bar(share: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function fmtCount(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}

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
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

// OTLP rejects an all-zero span id.
export function spanId(kind: string, recordId: string): string {
  const id = fnv1a64(`${kind}:${recordId}`)
  return id === '0000000000000000' ? '0000000000000001' : id
}

export function traceIdFromSession(sessionId: string): string {
  const hex = sessionId.replace(/-/g, '').toLowerCase()
  if (/^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex)) return hex
  return fnv1a64(`trace:${sessionId}`) + fnv1a64(`trace2:${sessionId}`)
}

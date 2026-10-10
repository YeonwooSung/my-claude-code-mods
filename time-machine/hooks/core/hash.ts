// FNV-1a over UTF-16 code units with a murmur3 finalizer; `seed` picks an independent function.
export function hash32(text: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

export function contentHash(text: string): string {
  return hex(hash32(text, 0)) + hex(hash32(text, 0x9747b28c))
}

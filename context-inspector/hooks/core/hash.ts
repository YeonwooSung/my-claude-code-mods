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

const MAX_WORDS = 20_000

// 64-bit SimHash over word 3-shingles of normalized text: near-identical texts land a few bits apart.
// Lexical locality-sensitive hashing, not semantic similarity.
export function simhash64(normalized: string): string {
  const words = normalized.split(' ').filter(w => w !== '').slice(0, MAX_WORDS)
  const counts = new Int32Array(64)
  const shingles = Math.max(1, words.length - 2)
  for (let i = 0; i < shingles; i += 1) {
    const shingle = words.slice(i, i + 3).join(' ')
    const hi = hash32(shingle, 1)
    const lo = hash32(shingle, 2)
    for (let b = 0; b < 32; b += 1) {
      counts[b]! += (hi >>> b) & 1 ? 1 : -1
      counts[b + 32]! += (lo >>> b) & 1 ? 1 : -1
    }
  }
  let hi = 0
  let lo = 0
  for (let b = 0; b < 32; b += 1) {
    if (counts[b]! > 0) hi |= 1 << b
    if (counts[b + 32]! > 0) lo |= 1 << b
  }
  return hex(hi) + hex(lo)
}

function popcount(n: number): number {
  let x = n - ((n >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24
}

export function hamming(a: string, b: string): number {
  const hi = (parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0
  const lo = (parseInt(a.slice(8, 16), 16) ^ parseInt(b.slice(8, 16), 16)) >>> 0
  return popcount(hi) + popcount(lo)
}

// Four 16-bit bands, tagged by position: two hashes within 3 bits of each other agree on at least one.
export function bands(h: string): string[] {
  return [0, 4, 8, 12].map(i => `${i}:${h.slice(i, i + 4)}`)
}

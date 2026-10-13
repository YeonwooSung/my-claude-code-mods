// Upper bound for lexical similarity work; exact hashes and character counts cover the whole row.
export const HASH_CHARS = 256 * 1024

export type Extracted = { text: string; images: number }

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// What the model reads from a row's blocks: text, tool inputs and results; images and documents counted apart.
export function blockText(content: unknown): Extracted {
  const parts: string[] = []
  let images = 0
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value !== '') parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v)
      return
    }
    if (!value || typeof value !== 'object') return
    const block = value as Record<string, unknown>
    switch (block.type) {
      case 'text':
        walk(block.text)
        return
      case 'tool_result':
        walk(block.content)
        return
      case 'tool_use':
        parts.push(`${String(block.name ?? '')} ${safeJson(block.input)}`)
        return
      case 'thinking':
        walk(block.thinking)
        return
      case 'image':
      case 'document':
        images += 1
        return
      default:
        return
    }
  }
  walk(content)
  return { text: parts.join('\n'), images }
}

// For similarity only: case and spacing folded, digit runs as '#', so runs differing in timings or counts match.
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

// Lines removed plus lines added, after the lines both sides share at the start and at the end.
export function diffLines(before: string, after: string): number {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return a.length - head - tail + (b.length - head - tail)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function changedLines(tool: string, input: Record<string, unknown>): number {
  switch (tool) {
    case 'Edit':
      return diffLines(str(input.old_string), str(input.new_string))
    case 'MultiEdit':
      if (!Array.isArray(input.edits)) return 0
      return input.edits.reduce((sum: number, edit: unknown) => {
        const e = (edit ?? {}) as Record<string, unknown>
        return sum + diffLines(str(e.old_string), str(e.new_string))
      }, 0)
    case 'Write':
      return lineCount(str(input.content))
    case 'NotebookEdit':
      return lineCount(str(input.new_source))
    default:
      return 0
  }
}

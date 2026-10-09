import { expect, test } from 'claude-code/testing'

import { bands, contentHash, hamming, hash32, simhash64 } from '../hooks/core/hash.ts'
import { changedLines, diffLines } from '../hooks/core/lines.ts'
import { blockText, normalize } from '../hooks/core/text.ts'
import { calibrate, estimate, inputOf } from '../hooks/core/tokens.ts'
import type { Sample } from '../hooks/core/types.ts'

const lettersText = (n: number): string =>
  Array.from({ length: n }, (_, i) => `q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}x`).join(' ')
const okLines = (n: number): string => Array.from({ length: n }, (_, i) => `ok ${i} test case passed in the suite`).join('\n')

test('blockText joins text, tool results and tool inputs; images are counted apart', () => {
  const r = blockText([
    { type: 'text', text: 'hello' },
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'inner' }, { type: 'image', source: {} }] },
    { type: 'tool_use', id: 'u', name: 'Read', input: { file_path: '/a' } },
    { type: 'thinking', thinking: '', signature: 'zzz' },
  ])
  expect(r.text).toBe('hello\ninner\nRead {"file_path":"/a"}')
  expect(r.images).toBe(1)
  expect(blockText('plain').text).toBe('plain')
  expect(blockText([]).text).toBe('')
})

test('normalize folds case, spacing and digit runs', () => {
  expect(normalize('  Ran 12 tests\n\tin 3.5s ')).toBe('ran # tests in #.#s')
})

test('hash32 and contentHash are deterministic and seed-dependent', () => {
  expect(hash32('abc')).toBe(hash32('abc'))
  expect(hash32('abc', 1)).not.toBe(hash32('abc', 2))
  expect(contentHash('abc')).toMatch(/^[0-9a-f]{16}$/)
  expect(contentHash('abc')).not.toBe(contentHash('abd'))
})

test('simhash: identical after normalization is distance 0; unrelated text is far', () => {
  const a = simhash64(normalize(`${okLines(80)}\nTime: 1.23s`))
  const b = simhash64(normalize(`${okLines(80)}\nTime: 4.56s`))
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(hamming(a, b)).toBe(0)
  const c = simhash64(normalize(lettersText(300)))
  expect(hamming(a, c)).toBeGreaterThan(3)
})

test('hamming counts differing bits; bands split 16 bits each and are position-tagged', () => {
  expect(hamming('0000000000000000', '0000000000000007')).toBe(3)
  expect(hamming('ffffffff00000000', '0000000000000000')).toBe(32)
  expect(bands('0123456789abcdef')).toEqual(['0:0123', '4:4567', '8:89ab', '12:cdef'])
})

test('estimate and inputOf', () => {
  expect(estimate(0)).toBe(0)
  expect(estimate(9)).toBe(3)
  expect(estimate(4, 2)).toBe(3_001)
  expect(inputOf({ input_tokens: 2, cache_read_input_tokens: 19_834, cache_creation_input_tokens: 25_350, output_tokens: 9 })).toBe(45_186)
  expect(inputOf(undefined)).toBe(0)
})

const sample = (seq: number, input: number, epoch = 0, ctx = 'main'): Sample => ({ seq, ctx, turn: 1, epoch, input })

test('calibrate telescopes per context and epoch, skips thin segments, clamps', () => {
  const items = [
    { ctx: 'main', seq: 2, est: 1_500 },
    { ctx: 'main', seq: 3, est: 1_500 },
    { ctx: 'main', seq: 6, est: 900 },
  ]
  // main epoch 0: samples at 1 and 4 → growth 3,300 over est 3,000 → k 1.1
  expect(calibrate([sample(1, 10_000), sample(4, 13_300)], items)).toEqual({ k: 1.1, segments: 1 })
  // a segment whose items sum under 2,000 is skipped → no calibration
  expect(calibrate([sample(5, 10_000), sample(7, 11_000)], items)).toEqual({ k: 1, segments: 0 })
  // clamped to 2
  expect(calibrate([sample(1, 10_000), sample(4, 30_000)], items).k).toBe(2)
  // different epochs never pair
  expect(calibrate([sample(1, 10_000, 0), sample(4, 13_300, 1)], items).segments).toBe(0)
})

test('diffLines drops shared head and tail lines', () => {
  expect(diffLines('a\nb\nc', 'a\nB\nc')).toBe(2)
  expect(diffLines('', 'x\ny')).toBe(2)
  expect(diffLines('same', 'same')).toBe(0)
})

test('changedLines per edit tool', () => {
  expect(changedLines('Edit', { old_string: 'a\nb', new_string: 'a\nc\nd' })).toBe(3)
  expect(changedLines('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y' }, { old_string: '', new_string: 'z' }] })).toBe(3)
  expect(changedLines('Write', { content: 'one\ntwo\n' })).toBe(2)
  expect(changedLines('NotebookEdit', { new_source: 'print(1)' })).toBe(1)
  expect(changedLines('Read', {})).toBe(0)
})

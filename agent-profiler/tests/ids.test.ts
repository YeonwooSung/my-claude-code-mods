import { expect, test } from 'claude-code/testing'

import { fnv1a64, spanId, traceIdFromSession } from '../hooks/core/ids.ts'

test('fnv1a64 matches the reference vectors', () => {
  expect(fnv1a64('')).toBe('cbf29ce484222325')
  expect(fnv1a64('a')).toBe('af63dc4c8601ec8c')
})

test('span ids are deterministic, kind-scoped and 16 hex digits', () => {
  expect(spanId('tool', 'x')).toBe(spanId('tool', 'x'))
  expect(spanId('tool', 'x')).not.toBe(spanId('step', 'x'))
  expect(spanId('tool', 'x')).toMatch(/^[0-9a-f]{16}$/)
})

test('trace id is the session uuid without dashes, or a hash otherwise', () => {
  expect(traceIdFromSession('8201ea2b-079a-467e-9ef6-a14e37417dde')).toBe('8201ea2b079a467e9ef6a14e37417dde')
  expect(traceIdFromSession('unknown')).toMatch(/^[0-9a-f]{32}$/)
})

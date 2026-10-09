import { expect, test } from 'claude-code/testing'

import { Ledger } from '../hooks/core/ledger.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, readFile, runBash } from './fixtures.ts'

test('summarize over 20k items stays fast', () => {
  const l = new Ledger()
  for (let i = 0; i < 10_000; i += 1) {
    readFile(l, `r${i}`, `/src/f${i % 500}.ts`, `${okLines(3)}\n${i}`)
    runBash(l, `b${i}`, 'npm test', `${okLines(12, `w${i % 50}`)}`)
    if (i % 100 === 0) l.sample('main', 10_000 + i * 50)
  }
  expect(l.size).toBe(20_000)
  const t0 = Date.now()
  const s = summarize(l.snapshot(), 'all')
  const ms = Date.now() - t0
  expect(s.occupancy.liveItems).toBe(20_000)
  expect(ms).toBeLessThan(1_000)
})

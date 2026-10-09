import { expect, test } from 'claude-code/testing'

import { summarize } from '../hooks/core/analyze.ts'
import { Profiler } from '../hooks/core/profiler.ts'
import { paneLines, renderReport, statusLine } from '../hooks/core/report.ts'
import { session } from './fixtures.ts'

test('report names categories, the slow call, re-reads and the observability legend', () => {
  const text = renderReport(summarize(session().snapshot(20_000)))
  expect(text).toContain('1 turn(s)')
  expect(text).toContain('Model response wait')
  expect(text).toContain('npm test')
  expect(text).toContain('/a.ts')
  expect(text).toContain('Findings')
  expect(text).toContain("not the model's internal compute time")
})

test('an empty session says so', () => {
  expect(renderReport(summarize(new Profiler('s').snapshot(0)))).toContain('No turns recorded yet.')
})

test('status line shows shares and the longest running call', () => {
  const p = session()
  p.toolStart(20_000, { id: 'x', tool: 'Bash', input: { command: 'pytest' } })
  expect(statusLine(summarize(p.snapshot(23_000)), p.running(23_000))).toBe('⏱ model 30% · tools 61% · ▶ Bash pytest 3.0s')
})

test('pane lines start with the total and stay within the width', () => {
  const lines = paneLines(summarize(session().snapshot(20_000)), [], 40)
  expect(lines[0]).toEqual({ text: '10.0s agent time · 1 turn(s)', bold: true })
  expect(lines.every(line => line.text.length <= 80)).toBe(true)
})

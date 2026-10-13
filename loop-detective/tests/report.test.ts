import { expect, test } from 'claude-code/testing'
import { Detector } from '../hooks/core/detector.ts'
import { paneLines, renderReport, statusLine } from '../hooks/core/report.ts'

function repeated(d: Detector, agent?: string) {
  for (let i = 0; i < 3; i++) d.finish(d.begin('Bash', { command: 'npm test' }, agent, '/repo'), { isError: true, text: 'Error: expected 2' })
}
test('report includes evidence and tentative suggestions with main-only default', () => {
  const d = new Detector()
  repeated(d); repeated(d, 'worker')
  const text = renderReport(d.snapshot(), '')
  expect(text).toContain('3 identical failures')
  expect(text).toContain('npm test')
  expect(text).toContain('Error: expected 2')
  expect(text).toContain('Possible next checks')
  expect(text).not.toContain('worker')
  expect(renderReport(d.snapshot(), '--agents')).toContain('worker')
  expect(paneLines(d.snapshot()).join('\n')).toContain('3 identical failures')
  expect(statusLine(d.snapshot())).toContain('1 active')
})
test('history is opt-in and invalid arguments show usage', () => {
  const d = new Detector()
  repeated(d)
  d.finish(d.begin('Bash', { command: 'npm test' }, undefined, '/repo'), { result: { stdout: 'ok', stderr: '' } })
  expect(renderReport(d.snapshot(), '')).not.toContain('recovered')
  expect(renderReport(d.snapshot(), '--history')).toContain('recovered')
  expect(renderReport(d.snapshot(), '--agents --history')).toContain('recovered')
  expect(renderReport(d.snapshot(), 'bogus')).toContain('Usage:')
  expect(statusLine(d.snapshot())).toBe('loop: no active cases')
})
test('edit-retry report describes observed edits without assigning blame', () => {
  const d = new Detector()
  for (let i = 0; i < 3; i++) {
    if (i) d.finish(d.begin('Edit', { file_path: '/repo/a.ts' }), { result: {} })
    d.finish(d.begin('Bash', { command: 'npm test' }, undefined, '/repo'), { isError: true, text: 'Error: expected 2' })
  }
  const text = renderReport(d.snapshot(), '')
  expect(text).toContain('edit-retry')
  expect(text).toContain('/repo/a.ts')
  expect(text).toContain('2 edit/retry transitions')
  expect(text).toContain('test expectations')
  expect(text).not.toContain('root cause')
})

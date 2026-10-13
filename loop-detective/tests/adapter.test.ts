import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const fail = { isError: true as const, result: { stdout: 'Error: expected 2', stderr: '' }, text: 'Error: expected 2' }
const ok = { result: { stdout: 'ok', stderr: '' }, text: 'ok' }
const clear = { reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never

function environment(on: On, toasts?: string[], failUi = false, getCwd?: () => Promise<string>) {
  on('session.cwd', async () => ({ value: getCwd ? await getCwd() : '/repo' }))
  on('ui.status', () => {
    if (failUi) throw new Error('UI unavailable')
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    if (failUi) throw new Error('UI unavailable')
    toasts?.push(e.text)
    return { value: undefined }
  })
  return mock.clock(on)
}

test('repeated Bash failures are reported and answers are unchanged', async ($, on) => {
  environment(on)
  on('tool.call', () => fail)
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 3; i++) {
    const answer = await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: `f${i}` })
    expect(answer).toEqual(fail)
  }
  const answer = await $.command.run({ command: 'loop-report', args: '' } as never)
  expect(answer.text).toContain('3 identical failures')
  expect(answer.text).toContain('Error: expected 2')
})

test('delayed cwd metadata cannot reorder invocations', async ($, on) => {
  let entered!: () => void
  let release!: (cwd: string) => void
  let first = true
  const started = new Promise<void>(resolve => { entered = resolve })
  environment(on, undefined, false, async () => {
    if (!first) return '/repo'
    first = false
    entered()
    return await new Promise<string>(resolve => { release = resolve })
  })
  on('tool.call', (_$, e) => e.tool_use_id === 'first' ? ok : fail)
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  const pending = $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'first' })
  await started
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: `later-${i}` })
  release('/repo')
  await pending
  const answer = await $.command.run({ command: 'loop-report', args: '' } as never)
  expect(answer.text).toContain('3 identical failures')
})

test('successful edits make an edit-retry case; success closes it', async ($, on) => {
  environment(on)
  let pass = false
  on('tool.call', (_$, e) => e.tool === 'Bash' ? pass ? ok : fail : { result: {} })
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 3; i++) {
    if (i) await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b', tool_use_id: `e${i}` } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: `t${i}` })
  }
  expect((await $.command.run({ command: 'loop-report', args: '' } as never)).text).toContain('edit-retry')
  pass = true
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'pass' })
  expect((await $.command.run({ command: 'loop-report', args: '--history' } as never)).text).toContain('recovered')
})

test('denial is unchanged and never opens a case', async ($, on) => {
  environment(on)
  on('tool.call', () => ({ deny: 'nope' }))
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 3; i++) expect(await $.tool.call({ tool: 'Bash', command: 'npm test' })).toEqual({ deny: 'nope' })
  expect((await $.command.run({ command: 'loop-report', args: '' } as never)).text).toContain('No active cases')
})

test('clear resets evidence and passes session.end through', async ($, on) => {
  environment(on)
  on('tool.call', () => fail)
  on('session.end', () => ({ sessionId: 'old' }))
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await $.session.end(clear)).toEqual({ sessionId: 'old' })
  expect((await $.command.run({ command: 'loop-report', args: '--history' } as never)).text).not.toContain('identical failures')
})

test('late result from before reset cannot enter the new detector', async ($, on) => {
  environment(on)
  let entered!: () => void
  let finish!: (answer: typeof fail) => void
  let first = true
  const started = new Promise<void>(resolve => { entered = resolve })
  on('tool.call', async () => {
    if (!first) return fail
    first = false
    entered()
    return await new Promise<typeof fail>(resolve => { finish = resolve })
  })
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  const pending = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await started
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  finish(fail)
  expect(await pending).toEqual(fail)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect((await $.command.run({ command: 'loop-report', args: '' } as never)).text).toContain('No active cases')
})

test('case opening notifies once; later repetition is quiet', async ($, on) => {
  const toasts: string[] = []
  const clock = environment(on, toasts)
  on('tool.call', () => fail)
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(1)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('/loop-report')
})

test('UI failure cannot change an already completed tool result', async ($, on) => {
  const clock = environment(on, undefined, true)
  on('tool.call', () => fail)
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 3; i++) expect(await $.tool.call({ tool: 'Bash', command: 'npm test' })).toEqual(fail)
  await clock.advance(1)
})

test('pane opens and invalid report args show usage', async ($, on) => {
  const opened: string[] = []
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  await $.command.run({ command: 'loop-pane', args: '' } as never)
  expect(opened).toEqual(['loop-detective'])
  expect((await $.command.run({ command: 'loop-report', args: 'bogus' } as never)).text).toContain('Usage:')
})

test('startup registers commands, resets observations and returns the underlying result', async ($, on) => {
  environment(on)
  const commands: string[] = []
  on('command.register', (_$, e) => { commands.push(e.name); return { value: { command: e.name } } as never })
  on('session.start', () => ({ cwd: '/repo' }))
  on('tool.call', () => fail)
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)).toEqual({ cwd: '/repo' })
  expect(commands).toEqual(['loop-report', 'loop-pane', 'loop-reset'])
  expect((await $.command.run({ command: 'loop-report', args: '--history' } as never)).text).toContain('No active cases')
})

test('engine rejection does not retry the underlying tool', async ($, on) => {
  environment(on)
  let calls = 0
  on('tool.call', () => { calls++; throw new Error('underlying failure') })
  await $.command.run({ command: 'loop-reset', args: '' } as never)
  // The runner skips throwing mock hooks, then rejects with its own HooksError.
  await expect($.tool.call({ tool: 'Bash', command: 'npm test' })).rejects.toThrow('no implementation for tool.call')
  expect(calls).toBe(1)
})

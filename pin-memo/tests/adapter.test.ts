import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 9 }, view: {} }
const START = { cwd: '/repo', surface: 'terminal' as const, isInteractive: true }
function environment(on: On, options: { id?: () => string | Promise<string>; failWrite?: () => boolean; failInvalidate?: boolean; other?: boolean } = {}) {
  const data = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: data.get(e.key) }))
  on('store.set', (_$, e) => {
    if (options.failWrite?.()) throw new Error('disk full')
    data.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('session.id', async () => ({ value: await (options.id?.() ?? 's') }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.invalidate', () => { if (options.failInvalidate) throw new Error('no UI'); return { value: undefined } })
  on('session.start', () => ({ cwd: '/repo' }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return options.other ? Box({ key: 'other', children: Text({ children: 'other mod' }) }) : Box({})
  })
}

test('registers pin and renders clickable todos on terminal and desktop', async ($, on) => {
  environment(on)
  const commands: string[] = []
  on('command.register', (_$, e) => { commands.push(e.name); return { value: { command: e.name } } })
  await $.session.start(START)
  expect(commands).toContain('pin')
  expect((await $.command.run({ command: 'pin', args: '[ ] 배포 확인' } as never)).text).toContain('고정')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pin-memo', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'pin-title' }))?.text).toContain('핀 1')
    expect((await ui.find({ key: 'pin-check-1' }))?.text).toBe('[ ]')
    await ui.press({ key: 'pin-check-1' })
    expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('[x]')
    await ui.redraw()
    expect((await ui.find({ key: 'pin-check-1' }))?.text).toBe('[x]')
    await ui.unmount()
    await $.command.run({ command: 'pin', args: 'uncheck 1' } as never)
  }
})

test('preserves downstream tree and yields band to surveys', async ($, on) => {
  environment(on, { other: true })
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: 'memo' } as never)
  const ui = await $.ui.mount({ plugin: 'pin-memo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'other' }))?.text).toBe('other mod')
  expect(await ui.find({ key: 'pin-title' })).toBeDefined()
  await ui.redraw({ ...BAND, hasSurvey: true })
  expect(await ui.find({ key: 'pin-title' })).toBeUndefined()
  expect((await ui.find({ key: 'other' }))?.text).toBe('other mod')
})

test('reload and resume restore saved state while clear/new IDs isolate notes', async ($, on) => {
  let id = 'old'
  environment(on, { id: () => id })
  on('session.end', () => { id = 'new'; return { sessionId: 'old' } })
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: 'saved' } as never)
  await $.session.start(START)
  expect((await $.command.run({ command: 'pin', args: '' } as never)).text).toContain('saved')
  expect(await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never)).toEqual({ sessionId: 'old' })
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).not.toContain('saved')
  id = 'old'
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('saved')
})

test('failed write keeps previous checkbox and returns error; invalidation failure does not lose notes', async ($, on) => {
  let fail = false
  environment(on, { failWrite: () => fail, failInvalidate: true })
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: '[ ] safe' } as never)
  fail = true
  expect((await $.command.run({ command: 'pin', args: 'check 1' } as never)).text).toContain('저장하지 못')
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('[ ]')
  fail = false
  expect((await $.command.run({ command: 'pin', args: 'check 1' } as never)).text).toContain('변경')
})

test('unavailable identity never leaks old notes and recovers on next command', async ($, on) => {
  let fail = false
  environment(on, { id: () => { if (fail) throw new Error('unavailable'); return 's' } })
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: 'secret' } as never)
  fail = true
  expect((await $.command.run({ command: 'pin', args: 'new' } as never)).text).toContain('확인')
  const ui = await $.ui.mount({ plugin: 'pin-memo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ text: /secret/ })).toBeUndefined()
  fail = false
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('secret')
})

test('rapid concurrent pin commands all persist instead of cancelling each other', async ($, on) => {
  environment(on)
  await $.session.start(START)
  const results = await Promise.all(['first', 'second', 'third'].map(args => $.command.run({ command: 'pin', args } as never)))
  for (const result of results) expect(result.text).toContain('고정')
  const list = (await $.command.run({ command: 'pin', args: 'list' } as never)).text
  expect(list).toContain('first')
  expect(list).toContain('second')
  expect(list).toContain('third')
})

test('an old checkbox drawing cannot change a different current session', async ($, on) => {
  let id = 'old'
  environment(on, { id: () => id })
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: '[ ] old todo' } as never)
  const ui = await $.ui.mount({ plugin: 'pin-memo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  id = 'new'
  // No redraw occurs before the press: this is the previous identity's handle.
  await ui.press({ key: 'pin-check-1' })
  expect(toasts.join('\n')).toContain('세션')
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).not.toContain('old todo')
  id = 'old'
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('[ ]')
})

test('a damaged saved document is shown as an error and cleared only explicitly', async ($, on) => {
  let value: unknown = { version: 2 }
  on('store.get', () => ({ value }))
  on('store.set', (_$, e) => { value = e.value; return { value: undefined } })
  on('session.id', () => ({ value: 's' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => $.ui.resolve(e).Box({}))
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'pin-memo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'pin-error' }))?.text).toContain('불러오지 못')
  expect((await $.command.run({ command: 'pin', args: 'accidental overwrite' } as never)).text).toContain('불러오지 못')
  expect(value).toEqual({ version: 2 })
  await $.command.run({ command: 'pin', args: 'clear' } as never)
  expect(value).toEqual({ version: 1, nextId: 1, items: [] })
  await ui.redraw()
  expect(await ui.find({ key: 'pin-memo' })).toBeUndefined()
})

test('a newer failed identity query invalidates an older delayed successful query', async ($, on) => {
  let mode: 'normal' | 'slow' | 'fail' = 'normal'
  let finish!: (id: string) => void
  let began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const slow = new Promise<string>(resolve => { finish = resolve })
  environment(on, { id: () => {
    if (mode === 'fail') throw new Error('identity unavailable')
    if (mode === 'slow') { began(); return slow }
    return 's'
  } })
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: 'private old note' } as never)
  mode = 'slow'
  const older = $.command.run({ command: 'pin', args: 'list' } as never)
  await started
  mode = 'fail'
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('확인')
  finish('s')
  expect((await older).text).not.toContain('private old note')
  const ui = await $.ui.mount({ plugin: 'pin-memo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ text: /private old note/ })).toBeUndefined()
})

test('expired checkbox handles stay invalid after returning to their original identity', async ($, on) => {
  let id = 'old'
  environment(on, { id: () => id })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start(START)
  await $.command.run({ command: 'pin', args: '[ ] task' } as never)
  const ui = await $.ui.mount({ plugin: 'pin-memo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  id = 'new'
  await $.command.run({ command: 'pin', args: 'list' } as never)
  id = 'old'
  await $.command.run({ command: 'pin', args: 'list' } as never)
  await ui.press({ key: 'pin-check-1' })
  expect((await $.command.run({ command: 'pin', args: 'list' } as never)).text).toContain('[ ]')
})

test('turn lifecycle observations preserve downstream inputs and answers', async ($, on) => {
  environment(on)
  let calls = 0
  on('turn.start', (_$, e) => { calls++; expect(e.text).toBe('unchanged prompt'); return { turnId: e.turnId } })
  await $.session.start(START)
  expect(await $.turn.start({ text: 'unchanged prompt', turnId: 't1' })).toEqual({ turnId: 't1' })
  expect(calls).toBe(1)
})

test('downstream lifecycle errors propagate without a second execution', async ($, on) => {
  environment(on)
  let turns = 0, ends = 0
  on('turn.start', () => { turns++; throw new Error('downstream failed') })
  on('session.end', () => { ends++; throw new Error('downstream failed') })
  await $.session.start(START)
  await expect($.turn.start({ text: 'test', turnId: 't1' })).rejects.toThrow()
  await expect($.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never)).rejects.toThrow()
  expect(turns).toBe(1)
  expect(ends).toBe(1)
})

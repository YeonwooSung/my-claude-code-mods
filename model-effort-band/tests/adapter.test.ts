import type { On, RenderInputOf, RenderElement, TurnStepResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const OTHER: RenderElement = { type: 'Text', props: {}, children: ['other-mod'] }
function renderInput(columns = 95, rows = 10, survey = false, surface: 'terminal' | 'desktop' = 'terminal'): RenderInputOf<'AbovePrompt', 'terminal' | 'desktop'> {
  return {
    component: 'AbovePrompt', surface, requestId: 'band', viewport: { columns: columns + 5, rows: 40 },
    props: { hasSurvey: survey, isWorking: false, maxRows: rows, bodyColumns: columns,
      scroll: { offset: 0, bodyRows: rows }, view: {} },
  }
}
function setup(on: On, model = 'claude-opus-4-6') {
  on('session.model', () => ({ value: model }))
  on('ui.render', { component: 'AbovePrompt' }, () => OTHER)
}
const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-4-6' }
const RESULT: TurnStepResult = { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
function stream(on: On) {
  on('turn.step', async function* (_$, e) {
    yield { kind: 'thinking', index: 0, text: 'hm' }
    yield { kind: 'text', index: 1, text: 'hi' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { ...RESULT, turnId: e.turnId, index: e.index }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`preserves other mods and draws the model band on ${surface}`, async ($, on) => {
    setup(on)
    const tree = await $.ui.render(renderInput(95, 10, false, surface))
    const content = JSON.stringify(tree)
    expect(content).toContain('other-mod')
    expect(content).toContain('Opus 4.6')
    expect(content).toContain('unknown')
    expect(content).toContain('#B99CE5')
    expect(content).toContain('round')
  })
}

test('yields the entire render site to surveys and empty sites', async ($, on) => {
  setup(on)
  for (const input of [renderInput(95, 10, true), renderInput(0, 10), renderInput(95, 0)]) {
    const tree = await $.ui.render(input)
    // Newer engines stamp ownership metadata; the mod must preserve the actual node.
    expect(tree.type).toBe('Text')
    expect('props' in tree ? tree.props : undefined).toEqual({})
    expect('children' in tree ? tree.children : undefined).toEqual(['other-mod'])
  }
})

test('compacts narrow sites and uses one unbordered line when rows are limited', async ($, on) => {
  setup(on)
  const compact = JSON.stringify(await $.ui.render(renderInput(40, 3)))
  expect(compact).toContain('Opus 4.6')
  expect(compact).toContain('round')
  expect(compact).not.toContain('확인 전')
  const inline = JSON.stringify(await $.ui.render(renderInput(29, 3)))
  expect(inline).toContain('effort unknown')
  expect(inline).not.toContain('round')
  const short = JSON.stringify(await $.ui.render(renderInput(95, 2)))
  expect(short).not.toContain('round')
})

test('preserves each streamed chunk and the generator final result', async ($, on) => {
  setup(on)
  stream(on)
  const iterator = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })
  expect(await iterator.next()).toEqual({ done: false, value: { kind: 'thinking', index: 0, text: 'hm' } })
  expect(await iterator.next()).toEqual({ done: false, value: { kind: 'text', index: 1, text: 'hi' } })
  expect(await iterator.next()).toEqual({ done: false, value: { kind: 'stop', stopReason: 'end_turn', usage } })
  expect(await iterator.next()).toEqual({ done: true, value: RESULT })
  const content = JSON.stringify(await $.ui.render(renderInput()))
  expect(content).toContain('high')
  expect(content).toContain('깊게')
})

test('subagent steps and omitted main effort preserve the last effort', async ($, on) => {
  setup(on)
  stream(on)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'low', messageCount: 1 })) {}
  for await (const _ of $.turn.step({ turnId: 'a1', index: 0, model: 'haiku', effort: 'max', agentId: 'agent1', messageCount: 1 })) {}
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('빠르게')
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-4-6', messageCount: 1 })) {}
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('빠르게')
})

test('reads the selected model on every paint and hides mismatched request effort', async ($, on) => {
  let model = 'claude-opus-4-6'
  on('session.model', () => ({ value: model }))
  on('ui.render', { component: 'AbovePrompt' }, () => OTHER)
  stream(on)
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model, effort: 'high', messageCount: 1 })) {}
  model = 'claude-sonnet-4-6'
  const content = JSON.stringify(await $.ui.render(renderInput()))
  expect(content).toContain('Sonnet 4.6')
  expect(content).toContain('unknown')
  expect(content).not.toContain('깊게')
})

test('a failed model lookup displays unknown instead of an old observed model', async ($, on) => {
  on('session.model', () => { throw new Error('unavailable') })
  on('ui.render', { component: 'AbovePrompt' }, () => OTHER)
  const content = JSON.stringify(await $.ui.render(renderInput()))
  expect(content).toContain('Unknown model')
  expect(content).toContain('unknown')
  expect(content).toContain('other-mod')
})

test('invalidate failure does not repeat downstream execution', async ($, on) => {
  setup(on)
  on('ui.invalidate', () => { throw new Error('no redraw') })
  let calls = 0
  on('turn.step', async function* () { calls++; yield { kind: 'text', index: 0, text: 'once' }; return RESULT })
  const chunks = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) chunks.push(chunk)
  expect(chunks).toEqual([{ kind: 'text', index: 0, text: 'once' }])
  expect(calls).toBe(1)
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('깊게')
})

test('propagates downstream streaming failure without retry', async ($, on) => {
  let calls = 0
  on('turn.step', async function* () { calls++; throw new Error('request failed'); yield { kind: 'text', index: 0, text: 'unreachable' } })
  let error = ''
  try { for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 1 })) {} }
  catch (failure) { error = String(failure) }
  expect(error).toContain('no implementation for turn.step')
  expect(calls).toBe(1)
})

test('retains the last effort during tools, idle renders and the next turn', async ($, on) => {
  setup(on)
  stream(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let release!: () => void
  let entered!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  on('tool.call', async () => { entered(); await pending; return { result: 'ok' } })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
  const tool = $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'tool1' })
  await started
  try {
    const input = renderInput()
    const content = JSON.stringify(await $.ui.render({ ...input, props: { ...input.props, isWorking: true } }))
    expect(content).toContain('깊게')
    expect(content).not.toContain('unknown')
  } finally {
    release()
    await tool
  }
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('깊게')
  await $.turn.start({ text: 'next', turnId: 't2' })
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('깊게')
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-4-6', messageCount: 1 })) {}
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('깊게')
  for await (const _ of $.turn.step({ turnId: 't2', index: 1, model: 'claude-opus-4-6', effort: 'low', messageCount: 1 })) {}
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('빠르게')
})

test('ending the session clears the retained effort before a missing-effort request', async ($, on) => {
  setup(on)
  stream(on)
  on('session.end', () => ({ sessionId: 's1' }))
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-4-6', messageCount: 1 })) {}
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('unknown')
})

test('settings commands clear observation and preserve downstream output', async ($, on) => {
  setup(on)
  stream(on)
  on('command.run', () => ({ text: 'settings result' }))
  for (const command of ['model', 'effort', 'config']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
    const result = await $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(result.text).toBe('settings result')
    expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('unknown')
  }
})

test('settings commands clear before execution and retain effort observed while a picker runs', async ($, on) => {
  setup(on)
  stream(on)
  let during = ''
  on('command.run', async () => {
    during = JSON.stringify(await $.ui.render(renderInput()))
    for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-4-6', effort: 'low', messageCount: 1 })) {}
    return { text: 'picker closed' }
  })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
  expect(await $.command.run({ command: 'effort', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).toEqual({ text: 'picker closed' })
  expect(during).toContain('unknown')
  expect(during).not.toContain('깊게')
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('빠르게')
})

test('settings clear effort before the downstream writer runs', async ($, on) => {
  setup(on)
  stream(on)
  let during = ''
  on('config.set', async () => {
    during = JSON.stringify(await $.ui.render(renderInput()))
    return { value: true }
  })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
  expect(await $.config.set({ key: 'verbose', value: true, previous: false, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })).toEqual({ value: true })
  expect(during).toContain('unknown')
  expect(during).not.toContain('깊게')
})

test('settings attempts clear observation while preserving denial and success results', async ($, on) => {
  setup(on)
  stream(on)
  let denied = true
  let calls = 0
  on('config.set', () => { calls++; return denied ? { deny: 'locked' } : { value: true } })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
  expect(await $.config.set({ key: 'verbose', value: true, previous: false, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })).toEqual({ deny: 'locked' })
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('unknown')
  for await (const _ of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
  expect(calls).toBe(1)
  denied = false
  expect(await $.config.set({ key: 'verbose', value: true, previous: false, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })).toEqual({ value: true })
  expect(calls).toBe(2)
  expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('unknown')
})

for (const event of ['config.set', 'command.run'] as const) {
  test(`${event} failure clears effort and never repeats downstream execution`, async ($, on) => {
    setup(on)
    stream(on)
    on('ui.invalidate', () => { throw new Error('no redraw') })
    let calls = 0
    if (event === 'config.set') {
      on('config.set', () => { calls++; throw new Error('writer failed') })
    } else {
      on('command.run', () => { calls++; throw new Error('picker failed') })
    }
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
    let error = ''
    try {
      if (event === 'config.set') {
        await $.config.set({ key: 'verbose', value: true, previous: false, provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
      } else {
        await $.command.run({ command: 'effort', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
      }
    } catch (failure) { error = String(failure) }
    expect(error).toContain(`no implementation for ${event}`)
    expect(calls).toBe(1)
    expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('unknown')
  })
}

test('reload and picker model switches clear effort even when the selected model returns', async ($, on) => {
  setup(on)
  stream(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.PostModelSwitch', () => ({}))
  for (const boundary of ['reload', 'picker']) {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-6', effort: 'high', messageCount: 1 })) {}
    if (boundary === 'reload') {
      await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
    } else {
      await $.classic.PostModelSwitch({
        session_id: 's1', transcript_path: '/transcript', cwd: '/project',
        from_model: 'claude-sonnet-4-6', to_model: 'claude-opus-4-6', requested_model: 'opus', source: 'picker',
        context_tokens: 0, prompt_cache_warm: false, cache_ttl: '5m', estimated_cache_write_usd: 0, pricing: 'catalog',
      })
    }
    expect(JSON.stringify(await $.ui.render(renderInput()))).toContain('unknown')
  }
})

for (const [model, effort, color, description] of [
  ['claude-haiku-4-5', 'low', '#8ACFA7', '빠르게'],
  ['claude-sonnet-4-6', 'medium', '#8BBEF4', '보통'],
  ['claude-opus-4-6', 'high', '#B99CE5', '깊게'],
]) {
  test(`renders the ${model} theme and observed ${effort} gauge`, async ($, on) => {
    setup(on, model)
    stream(on)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: model!, effort: effort as 'low' | 'medium' | 'high', messageCount: 1 })) {}
    const tree = await $.ui.render(renderInput(60, 3))
    const content = JSON.stringify(tree)
    expect(content).toContain(color)
    expect(content).toContain(description)
    expect(content).toContain('truncate-end')
    expect(content).toContain('other-mod')
  })
}

test('keeps model and effort adjacent, reserving flexible space before the badge', async ($, on) => {
  setup(on)
  const tree = await $.ui.render(renderInput(95, 3))
  const children = 'children' in tree ? tree.children : []
  const row = children?.find(node => typeof node !== 'string' && node.type === 'Box' && node.props?.borderStyle === 'round')
  const name = row && typeof row !== 'string' && 'children' in row ? row.children?.[0] : undefined
  expect(name && typeof name !== 'string' && name.type === 'Box' ? name.props?.width : undefined).toBe(8)
  const spacer = row && typeof row !== 'string' && 'children' in row ? row.children?.at(-2) : undefined
  expect(spacer && typeof spacer !== 'string' && spacer.type === 'Box' ? spacer.props?.flexGrow : undefined).toBe(1)
})

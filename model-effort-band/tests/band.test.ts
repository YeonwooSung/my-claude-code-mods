import { expect, test } from 'claude-code/testing'
import { BandState, bandView, effortView, modelView } from '../hooks/core/band.ts'

for (const [input, name, family] of [
  ['claude-sonnet-4-6', 'Sonnet 4.6', 'sonnet'],
  ['claude-opus-4-6', 'Opus 4.6', 'opus'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5', 'haiku'],
  ['claude-3-5-sonnet-20241022', 'Sonnet 3.5', 'sonnet'],
  ['claude-3-opus-20240229', 'Opus 3', 'opus'],
  ['us.anthropic.claude-opus-4-6-v1:0', 'Opus 4.6', 'opus'],
  ['eu.anthropic.claude-3-5-sonnet-20241022-v2:0', 'Sonnet 3.5', 'sonnet'],
  ['anthropic.claude-haiku-4-5-20251001: v1', 'anthropic.claude-haiku-4-5-20251001: v1', 'unknown'],
  ['opus', 'Opus', 'opus'], ['SONNET', 'Sonnet', 'sonnet'], ['haiku', 'Haiku', 'haiku'],
  ['my-opus-proxy', 'my-opus-proxy', 'unknown'],
  ['claude-opus-4-6-unrecognized', 'claude-opus-4-6-unrecognized', 'unknown'],
]) {
  test(`displays ${input} without inventing a model version`, () => {
    const model = modelView(input)
    expect(model.name).toBe(name)
    expect(model.family).toBe(family)
  })
}

test('sanitizes unknown model names and limits Unicode code points', () => {
  expect(modelView('\u001b[31mcustom\u001b[0m\nmodel\u0000').name).toBe('custom model')
  expect(modelView('  ').name).toBe('Unknown model')
  expect(modelView({ name: 'opus' }).name).toBe('Unknown model')
  expect(Array.from(modelView('😀'.repeat(100)).name).length).toBe(80)
})

for (const [value, meter, description] of [
  ['low', '▰▱▱▱▱', '빠르게'], ['medium', '▰▰▱▱▱', '보통'],
  ['high', '▰▰▰▱▱', '깊게'], ['xhigh', '▰▰▰▰▱', '더 깊게'],
  ['max', '▰▰▰▰▰', '최대로'],
]) {
  test(`displays ${value} effort independently of model family`, () => {
    for (const model of ['haiku', 'sonnet', 'opus']) {
      const view = bandView(model, value, 80, 3)
      expect(view.effort.value).toBe(value)
      expect(view.effort.meter).toBe(meter)
      expect(view.effort.description).toBe(description)
    }
  })
}

test('does not infer a level for numeric and future effort values', () => {
  for (const value of [0, 42, 0.5]) {
    expect(effortView(value).value).toBe(String(value))
    expect(effortView(value).meter).toBe('')
    expect(effortView(value).description).toBe('')
  }
  expect(effortView('future\u001b[31m\nlevel').value).toBe('future level')
  expect(effortView('future').meter).toBe('')
})

test('reports invalid or missing effort as unknown instead of a model default', () => {
  for (const value of [undefined, null, '', ' ', {}, false, -1, NaN, Infinity]) {
    expect(effortView(value).value).toBe('unknown')
    expect(effortView(value).meter).toBe('')
    expect(effortView(value).description).toBe('확인 전')
  }
})

test('ignores subagents and retains omitted effort for the same model', () => {
  const state = new BandState()
  state.observeStep({ model: 'opus', effort: 'low' })
  state.observeStep({ model: 'haiku', effort: 'max', agentId: 'a1' })
  expect(state.snapshot('opus').effort).toBe('low')
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBe('low')
})

test('only shows observed effort for exactly the selected model and clears on reset', () => {
  const state = new BandState()
  state.observeStep({ model: 'claude-opus-4-6', effort: 'high' })
  expect(state.snapshot('opus')).toEqual({ model: 'opus', effort: undefined })
  expect(state.snapshot('claude-opus-4-6').effort).toBe('high')
  state.reset()
  expect(state.snapshot('claude-opus-4-6').effort).toBeUndefined()
})

for (const [columns, rows, layout] of [
  [60, 3, 'full'], [59, 3, 'compact'], [30, 3, 'compact'], [29, 3, 'inline'],
  [1, 1, 'inline'], [80, 2, 'inline'], [80, 1, 'inline'],
  [0, 3, 'hidden'], [-1, 3, 'hidden'], [80, 0, 'hidden'], [80, -1, 'hidden'],
  [NaN, 3, 'hidden'], [Infinity, 3, 'hidden'], [80, NaN, 'hidden'], [80, Infinity, 'hidden'],
]) {
  test(`fits a ${columns} column by ${rows} row site`, () => {
    expect(bandView('opus', 'high', columns as number, rows as number).layout).toBe(layout)
  })
}

test('a new main effort replaces the retained value, including numeric zero', () => {
  const state = new BandState()
  state.observeStep({ model: 'opus', effort: 'high' })
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBe('high')
  state.observeStep({ model: 'opus', effort: 'low' })
  expect(state.snapshot('opus').effort).toBe('low')
  state.observeStep({ model: 'opus', effort: 0 })
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBe(0)
})

test('a different main model never inherits effort or resurrects an older value', () => {
  const state = new BandState()
  state.observeStep({ model: 'opus', effort: 'high' })
  state.observeStep({ model: 'sonnet' })
  expect(state.snapshot('sonnet').effort).toBeUndefined()
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBeUndefined()
  state.observeStep({ model: 'opus', effort: 'low' })
  state.reset()
  state.observeStep({ model: 'opus' })
  expect(state.snapshot('opus').effort).toBeUndefined()
})

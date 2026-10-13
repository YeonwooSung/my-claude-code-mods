import { test, expect } from 'claude-code/testing'
import { newGame, act, step, type Game } from '../hooks/core/game.ts'

function advance(game: Game, ticks: number): Game {
  for (let n = 0; n < ticks; n++) game = step(game)
  return game
}

test('ready games do not run until jumping; airborne jumps cannot extend flight', () => {
  const initial = newGame(7)
  expect(step(initial)).toEqual(initial)
  const start = act(initial, 'jump')
  const flying = step(start)
  expect(flying.y).toBeGreaterThan(0)
  expect(flying.phase).toBe('running')
  expect(act(flying, 'jump')).toEqual(flying)
  expect(initial.phase).toBe('ready')
  const landed = advance(start, 15)
  expect(landed.y).toBe(0)
  expect(landed.vy).toBe(0)
  expect(step(act(landed, 'jump')).y).toBeGreaterThan(0)
})

test('pause freezes physics and resume continues; restart resets the course', () => {
  const moving = advance(act(newGame(19), 'jump'), 10)
  const paused = act(moving, 'pause')
  expect(paused.phase).toBe('paused')
  expect(advance(paused, 100)).toEqual(paused)
  expect(step(act(paused, 'pause')).ticks).toBe(moving.ticks + 1)
  const reset = act(moving, 'restart')
  expect(reset.ticks).toBe(0)
  expect(reset.obstacles).toEqual([])
  expect(reset.y).toBe(0)
  expect(reset.phase).toBe('ready')
})

test('ground collision freezes game and score; jumping clears the same obstacle', () => {
  const approaching: Game = { ...newGame(2), phase: 'running', obstacles: [{ x: 6.5, width: 1, height: 1, label: 'BUG' }] }
  const crashed = step(approaching)
  expect(crashed.phase).toBe('over')
  expect(advance(crashed, 40)).toEqual(crashed)
  expect(act(crashed, 'jump')).toEqual(crashed)
  expect(step({ ...approaching, y: 2, vy: 0 }).phase).toBe('running')
  expect(approaching.obstacles[0]?.x).toBe(6.5)
})

test('swept collision catches a narrow obstacle crossing the runner at capped speed', () => {
  const game: Game = { ...newGame(), phase: 'running', ticks: 9000, obstacles: [{ x: 6.1, width: 0.1, height: 1, label: '429' }] }
  expect(step(game).phase).toBe('over')
})

test('offscreen obstacles are removed and survived ticks drive bounded speed', () => {
  const game: Game = { ...newGame(), phase: 'running', ticks: 10000, obstacles: [{ x: 40, width: 1, height: 1, label: 'BUG' }, { x: -2, width: 1, height: 1, label: 'BUG' }] }
  const next = step(game)
  expect(next.obstacles).toHaveLength(1)
  expect(Math.abs(next.obstacles[0]!.x - 38.8)).toBeLessThan(0.000001)
  expect(next.ticks).toBe(10001)
})

test('seeded generation is repeatable, spaced and bounded over long sessions', () => {
  let a = act(newGame(123), 'jump'), b = act(newGame(123), 'jump')
  const seen = new Set<string>()
  for (let tick = 0; tick < 6000; tick++) {
    // Keep the runner above the course so spawning can be observed independently of death.
    a = step({ ...a, y: 4, vy: 0 }); b = step({ ...b, y: 4, vy: 0 })
    expect(a).toEqual(b)
    expect(a.obstacles.length).toBeLessThanOrEqual(3)
    const xs = a.obstacles.map(o => o.x).sort((x, y) => x - y)
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(34)
    for (const obstacle of a.obstacles) seen.add(obstacle.label)
  }
  expect([...seen].sort()).toEqual(['429', 'BUG', 'TIMEOUT'])
  expect(newGame(NaN)).toEqual(newGame(1))
})

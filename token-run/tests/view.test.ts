import { test, expect } from 'claude-code/testing'
import { newGame, act, step, type Game } from '../hooks/core/game.ts'
import { gameView } from '../hooks/core/view.ts'

test('playable tracks fit eight rows and bounded columns including small terminals', () => {
  for (const columns of [24, 32, 64, 200, 1000000]) {
    const view = gameView(newGame(), columns, 8)
    expect(view.playable).toBe(true)
    expect(view.lines).toHaveLength(8)
    expect(view.lines.every(line => line.length <= Math.min(columns, 80))).toBe(true)
    expect(view.lines.join('\n')).toContain('@')
    expect(view.lines.join('\n')).toContain('SPACE')
  }
})

test('undersized and invalid regions return a bounded hint instead of a running track', () => {
  for (const [columns, rows] of [[23,8],[24,7],[0,0],[-1,8],[NaN,8],[24,NaN],[Infinity,8],[24,Infinity]]) {
    const view = gameView(newGame(), columns!, rows!)
    expect(view.playable).toBe(false)
    expect(view.lines.length).toBeLessThanOrEqual(Number.isFinite(rows) ? Math.max(0, Math.floor(rows!)) : 0)
    for (const line of view.lines) expect(line.length).toBeLessThanOrEqual(Number.isFinite(columns) ? Math.max(0, Math.floor(columns!)) : 0)
  }
})

test('jump height moves the runner above the ground without changing simulation', () => {
  const ground = { ...newGame(), phase: 'running' as const }
  const flying = step(act(ground, 'jump'))
  const groundView = gameView(ground,64,8).lines
  const flyingView = gameView(flying,64,8).lines
  expect(groundView[5]).toContain('@')
  expect(flyingView[4]).toContain('@')
  expect(flyingView[5]).not.toContain('@')
  expect(flying.y).toBeCloseTo(0.8)
})

test('obstacles clip at both edges and visible labels are placed on the track', () => {
  const game: Game = { ...newGame(), obstacles: [
    { x: -1, width: 2, height: 1, label: 'TIMEOUT' },
    { x: 30, width: 1, height: 1, label: 'BUG' },
    { x: 64, width: 2, height: 1, label: '429' },
  ] }
  const view = gameView(game,64,8)
  expect(view.lines[5]?.[0]).toBe('#')
  expect(view.lines[5]?.[30]).toBe('#')
  expect(view.lines[5]?.[63]).toBe(' ')
  expect(view.lines[4]).toContain('BUG')
  expect(view.lines.join('\n')).not.toMatch(/[\x00-\x08\x1b]/)
  expect(game.obstacles[0]?.x).toBe(-1)
})

test('game-over and paused tracks make their state and elapsed score visible', () => {
  expect(gameView({...newGame(),phase:'over',ticks:60},64,8).lines.join('\n')).toContain('GAME OVER')
  expect(gameView({...newGame(),phase:'paused',ticks:60},64,8).lines.join('\n')).toContain('PAUSED')
  expect(gameView({...newGame(),ticks:60},64,8).lines[1]).toContain('3')
})

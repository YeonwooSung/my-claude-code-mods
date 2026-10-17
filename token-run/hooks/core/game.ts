export type Obstacle = { x: number; width: number; height: number; label: 'BUG' | '429' | 'TIMEOUT' }
export type Game = {
  phase: 'ready' | 'running' | 'paused' | 'over'
  ticks: number
  y: number
  vy: number
  distance: number
  nextSpawn: number
  seed: number
  initialSeed: number
  obstacles: Obstacle[]
}
export type Action = 'jump' | 'restart' | 'pause'
export const WORLD = 64
export const PLAYER_X = 6
export const FRAME_MS = 50
export function score(game: Game): number { return Math.min(999999, Math.floor(game.ticks / 20)) }

export function newGame(seed = 1): Game {
  const normalized = Number.isFinite(seed) ? (Math.trunc(seed) >>> 0) || 1 : 1
  return { phase: 'ready', ticks: 0, y: 0, vy: 0, distance: 0, nextSpawn: 12, seed: normalized, initialSeed: normalized, obstacles: [] }
}
export function act(game: Game, action: Action): Game {
  if (action === 'restart') return newGame(game.initialSeed)
  if (action === 'pause') {
    if (game.phase === 'running') return { ...game, phase: 'paused' }
    if (game.phase === 'paused') return { ...game, phase: 'running' }
    return game
  }
  if ((game.phase === 'ready' || game.phase === 'running') && game.y === 0 && game.vy === 0) {
    return { ...game, phase: 'running', vy: 0.8 }
  }
  return game
}
export function step(game: Game): Game {
  if (game.phase !== 'running') return game
  const speed = Math.min(1.2, 0.6 + game.ticks / 10000)
  const y = Math.max(0, game.y + game.vy)
  const vy = y === 0 ? 0 : game.vy - 0.12
  let seed = game.seed
  let nextSpawn = game.nextSpawn
  const distance = game.distance + speed
  // Swept horizontal overlap tests the entire movement, including skipped cells.
  const hit = game.obstacles.some(o => o.x + o.width > PLAYER_X && o.x - speed < PLAYER_X + 1 && y < o.height)
  const obstacles = game.obstacles.map(o => ({ ...o, x: o.x - speed })).filter(o => o.x + o.width > 0)
  if (distance >= nextSpawn) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const labels = ['BUG', '429', 'TIMEOUT'] as const
    const kind = seed % 3
    obstacles.push({ x: WORLD, width: kind === 2 ? 2 : 1, height: 1, label: labels[kind]! })
    nextSpawn = distance + 36 + ((seed >>> 8) % 19)
  }
  return { ...game, phase: hit ? 'over' : 'running', ticks: game.ticks + (hit ? 0 : 1), y, vy, distance, nextSpawn, seed, obstacles }
}

/** Validate in-memory Client checkpoints at the host boundary; never trust posted data. */
export function decodeGame(value: unknown): Game | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const g = value as Record<string, unknown>
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  const uint = (n: unknown): n is number => finite(n) && Number.isSafeInteger(n) && n >= 0
  if (typeof g.phase !== 'string' || !['ready', 'running', 'paused', 'over'].includes(g.phase)
    || !uint(g.ticks) || !uint(g.seed) || g.seed > 0xffffffff
    || !uint(g.initialSeed) || g.initialSeed < 1 || g.initialSeed > 0xffffffff
    || !finite(g.y) || g.y < 0 || g.y > 4 || !finite(g.vy) || Math.abs(g.vy) > 1
    || !finite(g.distance) || g.distance < 0 || g.distance > g.ticks * 1.2 + 1
    || !finite(g.nextSpawn) || g.nextSpawn < g.distance || g.nextSpawn > g.distance + 56
    || !Array.isArray(g.obstacles) || g.obstacles.length > 3) return undefined
  const obstacles: Obstacle[] = []
  for (const item of g.obstacles) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const o = item as Record<string, unknown>
    if (!finite(o.x) || o.x < -2 || o.x > WORLD || typeof o.label !== 'string' || !['BUG', '429', 'TIMEOUT'].includes(o.label)
      || o.width !== (o.label === 'TIMEOUT' ? 2 : 1) || o.height !== 1) return undefined
    obstacles.push({ x: o.x, width: o.label === 'TIMEOUT' ? 2 : 1, height: 1, label: o.label as Obstacle['label'] })
  }
  return { phase: g.phase as Game['phase'], ticks: g.ticks, y: g.y, vy: g.vy,
    distance: g.distance, nextSpawn: g.nextSpawn, seed: g.seed, initialSeed: g.initialSeed, obstacles }
}

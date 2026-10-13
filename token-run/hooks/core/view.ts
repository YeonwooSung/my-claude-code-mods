import { PLAYER_X, WORLD, score, type Game } from './game.ts'
export type GameView = { playable: boolean; lines: string[] }
export function gameView(game: Game, columns: number, rows: number): GameView {
  const width = Number.isFinite(columns) ? Math.max(0, Math.min(80, Math.floor(columns))) : 0
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0
  if (width < 24 || height < 8) {
    return { playable: false, lines: width > 0 && height > 0 ? ['Resize to 24 cols x 8 rows'.slice(0, width)] : [] }
  }
  const trackWidth = Math.min(width, WORLD)
  const scale = trackWidth < WORLD ? (trackWidth - 1) / (WORLD - 1) : 1
  const track = Array.from({ length: 4 }, () => Array.from({ length: trackWidth }, () => ' '))
  for (const o of game.obstacles) {
    if (o.x >= WORLD || o.x + o.width <= 0) continue
    const x = Math.floor(o.x * scale)
    const end = Math.ceil((o.x + o.width) * scale)
    for (let col = Math.max(0, x); col < Math.min(trackWidth, Math.max(x + 1, end)); col++) track[3]![col] = '#'
    for (let i = 0; i < o.label.length; i++) {
      const col = x + i
      if (col >= 0 && col < trackWidth) track[2]![col] = o.label[i]!
    }
  }
  const runnerRow = 3 - Math.min(3, Math.ceil(game.y))
  track[runnerRow]![Math.floor(PLAYER_X * scale)] = '@'
  const phase = { ready: 'SPACE to start', running: 'RUNNING', paused: 'PAUSED', over: 'GAME OVER - R to retry' }[game.phase]
  return { playable: true, lines: [
    `TOKEN RUN | ${phase}`, `SCORE ${score(game)}`,
    ...track.map(row => row.join('')), '-'.repeat(trackWidth), 'SPACE/UP R P Q ESC',
  ].map(line => line.slice(0, width)) }
}

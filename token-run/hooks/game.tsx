import type { ClientModule } from 'claude-code'
import { newGame, act, step, score, decodeGame, FRAME_MS, type Game, type Action } from './core/game.ts'
import { gameView } from './core/view.ts'

export type GameProps = { runId: number; columns: number; rows: number; checkpoint: Game | null; best: number; error: string; status: string; recovered: boolean }
type Local = { game: Game; props: GameProps; lastScore: number; best: number }

const Runner: ClientModule<GameProps, Local> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const playable = () => !!surface.state && gameView(surface.state.game, Math.min(surface.columns, surface.state.props.columns), Math.min(surface.rows, surface.state.props.rows)).playable
  const send = (type: 'score' | 'exit', game: Game) => {
    const current = surface.state
    if (current) surface.post({ type, runId: current.props.runId, score: Math.max(current.best, score(game)), game })
  }
  const apply = (action: Action | 'exit') => {
    const current = surface.state
    if (!current) return
    if (action === 'exit') { send('exit', current.game); return }
    if (!playable()) return
    const game = act(current.game, action)
    if (game === current.game) return
    surface.setState({ ...current, game, best: Math.max(current.best, score(current.game)), lastScore: score(game) })
    // Interaction checkpoints preserve pause/restart across a dock/inline remount.
    send('score', game)
  }
  if (!surface.state) {
    surface.setState({ game: decodeGame(props.checkpoint) ?? newGame(props.runId), props, lastScore: props.checkpoint ? score(props.checkpoint) : 0, best: props.best })
    // The engine delivers these only while Client itself owns the keys.
    // Pane.isFocused describes a different focus ring and becomes false on Client focus.
    surface.onKey(event => {
      if (event.ctrl || event.meta || event.shift) return
      const key = event.key.toLowerCase()
      if (key === ' ' || key === 'up') apply('jump')
      else if (key === 'r') apply('restart')
      else if (key === 'p') apply('pause')
      else if (key === 'q') apply('exit')
    })
    // Subscribe to the track's pointer region as well as its child Buttons.
    // This also lets the real terminal hand keyboard focus to the Client.
    surface.onPointer(event => {
      if (event.type === 'down' && event.button === 'left' && !event.ctrl && !event.alt && !event.shift
        && event.y >= 2 && event.y < 7 && event.x >= 0 && event.x < surface.columns) apply('jump')
    })
    surface.every(FRAME_MS, () => {
      const current = surface.state
      if (!current || !playable() || current.game.phase !== 'running') return
      const game = step(current.game)
      const value = score(game)
      const checkpoint = value > current.lastScore || game.phase === 'over'
      surface.setState({ ...current, game, best: Math.max(current.best, value), lastScore: checkpoint ? value : current.lastScore })
      if (checkpoint) send('score', game)
    })
  } else if (surface.state.props.runId !== props.runId) {
    surface.setState({ game: decodeGame(props.checkpoint) ?? newGame(props.runId), props, lastScore: props.checkpoint ? score(props.checkpoint) : 0, best: props.best })
  } else if (JSON.stringify(surface.state.props) !== JSON.stringify(props)) {
    surface.setState({ ...surface.state, props, best: Math.max(surface.state.best, props.best) })
  }
  const game = surface.state?.game ?? decodeGame(props.checkpoint) ?? newGame(props.runId)
  const view = gameView(game, Math.min(surface.columns, props.columns), Math.min(surface.rows, props.rows))
  if (!view.playable) return <Box key="run-resize"><Text wrap="truncate-end">{view.lines[0] ?? ''}</Text></Box>
  const status = props.error || (props.recovered ? '응답이 돌아왔어요 · Esc로 작업 복귀' : props.status === 'failed' ? '요청 실패 · 게임은 로컬에서 실행 중' : '트랙 클릭/Space: 점프 · P: 정지 · Q: 닫기')
  const phase = { ready: 'CLICK + SPACE', running: 'TOKEN RUN', paused: 'PAUSED P', over: 'GAME OVER R' }[game.phase]
  const detail = Math.min(surface.columns, props.columns) < 48
    ? props.error ? 'SAVE!' : props.recovered ? 'BACK:Esc' : props.status === 'failed' ? 'LOCAL' : 'Q:exit'
    : status
  return <Box flexDirection="column" overflow="hidden">
    <Box key="run-phase"><Box key="run-status"><Text bold color={game.phase === 'over' ? '#E9A09A' : '#62B8AD'} wrap="truncate-end">{`${phase} | ${detail}`}</Text></Box></Box>
    <Box key="run-score"><Text wrap="truncate-end">{`SCORE ${score(game)}  BEST ${Math.max(surface.state?.best ?? 0, props.best, score(game))}`}</Text></Box>
    {view.lines.slice(2, 7).map((line, index) => <Box key={`track-${index + 2}`}><Text wrap="truncate-end">{line}</Text></Box>)}
    <Box flexDirection="row">
      <Button key="run-jump" plain label="Jump " onPress={() => apply('jump')} />
      <Button key="run-restart" plain label="R " onPress={() => apply('restart')} />
      <Button key="run-pause" plain label="P " onPress={() => apply('pause')} />
      <Button key="run-close" plain label="Q " onPress={() => apply('exit')} />
    </Box>
  </Box>
}
export default Runner

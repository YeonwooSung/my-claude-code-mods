import type { ClientModule } from 'claude-code'
import { newGame, act, step, score, FRAME_MS, type Game, type Action } from './core/game.ts'
import { gameView } from './core/view.ts'

export type GameProps = { runId: number; columns: number; rows: number; focused: boolean; best: number; error: string; status: string; recovered: boolean }
type Local = { game: Game; props: GameProps; lastScore: number; best: number }

const Runner: ClientModule<GameProps, Local> = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  const playable = () => !!surface.state && gameView(surface.state.game, Math.min(surface.columns, surface.state.props.columns), Math.min(surface.rows, surface.state.props.rows)).playable
  const send = (type: 'score' | 'exit', game: Game) => {
    const current = surface.state
    if (current) surface.post({ type, runId: current.props.runId, score: score(game) })
  }
  const apply = (action: Action | 'exit', keyboard = false) => {
    const current = surface.state
    if (!current || (keyboard && !current.props.focused)) return
    if (action === 'exit') { send('exit', current.game); return }
    if (!playable()) return
    // Save the just-finished run even when restart is faster than a frame checkpoint.
    if (action === 'restart' && score(current.game) > current.lastScore) send('score', current.game)
    surface.setState({ ...current, game: act(current.game, action), best: Math.max(current.best, score(current.game)), lastScore: action === 'restart' ? 0 : current.lastScore })
  }
  if (!surface.state) {
    surface.setState({ game: newGame(props.runId), props, lastScore: 0, best: props.best })
    surface.onKey(event => {
      if (event.ctrl || event.meta || event.shift) return
      const key = event.key.toLowerCase()
      if (key === ' ' || key === 'up') apply('jump', true)
      else if (key === 'r') apply('restart', true)
      else if (key === 'p') apply('pause', true)
      else if (key === 'q') apply('exit', true)
    })
    surface.every(FRAME_MS, () => {
      const current = surface.state
      if (!current || !current.props.focused || !playable() || current.game.phase !== 'running') return
      const game = step(current.game)
      const value = score(game)
      const checkpoint = value > current.lastScore || game.phase === 'over'
      surface.setState({ ...current, game, best: Math.max(current.best, value), lastScore: checkpoint ? value : current.lastScore })
      if (checkpoint) send('score', game)
    })
  } else if (surface.state.props.runId !== props.runId) {
    surface.setState({ game: newGame(props.runId), props, lastScore: 0, best: props.best })
  } else if (JSON.stringify(surface.state.props) !== JSON.stringify(props)) {
    surface.setState({ ...surface.state, props, best: Math.max(surface.state.best, props.best) })
  }
  const game = surface.state?.game ?? newGame(props.runId)
  const view = gameView(game, Math.min(surface.columns, props.columns), Math.min(surface.rows, props.rows))
  if (!view.playable) return <Box key="run-resize"><Text wrap="truncate-end">{view.lines[0] ?? ''}</Text></Box>
  const status = props.error || (props.recovered ? '응답이 돌아왔어요 · Esc로 작업 복귀' : props.status === 'failed' ? '요청 실패 · 게임은 로컬에서 실행 중' : '클릭 / ctrl+x tab: 조작 · Esc: 복귀')
  const phase = { ready: 'SPACE:start', running: 'TOKEN RUN', paused: 'PAUSED P', over: 'GAME OVER R' }[game.phase]
  const detail = Math.min(surface.columns, props.columns) < 48
    ? props.error ? 'SAVE!' : props.recovered ? 'BACK:Esc' : props.status === 'failed' ? 'LOCAL' : 'Esc:exit'
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

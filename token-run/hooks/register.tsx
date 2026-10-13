import type { EngineInterface, Register } from 'claude-code'
import { RequestState, Scores, validScore } from './core/state.ts'

const PANE = 'token-run'
const HELP = 'Token Run: /token-run | /token-run close | /token-run help\nSpace/Up: start or jump · R: restart · P: pause · Q/Esc: return\nClick the game or use ctrl+x tab to focus. Fully local; no model calls.'
function paint($: EngineInterface): void { try { $.ui.invalidate('ui.render') } catch { /* A failed redraw must not affect a turn. */ } }

type AdapterState = { requests: RequestState; scores?: Scores; supported: boolean; open: boolean; runId: number }
function records($: EngineInterface, state: AdapterState): Scores {
  return state.scores ??= new Scores({ get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) })
}
function detach(state: AdapterState): void { state.open = false; state.runId++ }
async function close($: EngineInterface, state: AdapterState): Promise<void> {
  detach(state); await $.ui.close({ id: PANE }); paint($)
}
async function start($: EngineInterface, state: AdapterState): Promise<string> {
  const opening = state.runId
  await records($, state).load()
  if (opening !== state.runId || !state.supported) return 'Token Run · 열기 요청이 취소되었습니다.'
  if (!state.open) { state.runId++; state.open = true }
  try {
    const result = await $.ui.open({ id: PANE, title: 'Token Run', focus: true, closeOnEscape: true, rows: 8, columns: 64 })
    paint($)
    return result.isPlaced ? 'Token Run · Space로 시작하세요. Esc로 작업 복귀.' : 'Token Run · 패널을 표시할 공간이 필요해요.'
  } catch { detach(state); return 'Token Run 패널을 열지 못했어요. /token-run으로 다시 시도하세요.' }
}
export const register: Register = on => {
  const state: AdapterState = { requests: new RequestState(), supported: false, open: false, runId: 0 }
  on('session.start', async ($, e, next) => {
    detach(state); state.requests.reset(); state.supported = e.isInteractive && (e.surface === 'terminal' || e.surface === 'desktop')
    try { await $.ui.close({ id: PANE }) } catch { /* No old game should hold session startup. */ }
    try { await $.command.register({ name: 'token-run', description: 'Play a local runner: [help|close]' }) } catch { /* Session startup still proceeds. */ }
    await records($, state).load(); paint($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    detach(state); state.requests.reset()
    try { await $.ui.close({ id: PANE }) } catch { /* Lifecycle must proceed. */ }
    paint($)
    return next(e)
  })
  on('turn.start', async ($, e, next) => { state.requests.begin(e.turnId); paint($); return next(e) })
  on('turn.complete', async ($, e, next) => {
    state.requests.complete(e.turnId, e.reason, e.agentId); paint($)
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    const generation = state.requests.snapshot().generation
    const iterator = next(e)
    let finished = false
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) { finished = true; return result.value }
        const before = state.requests.snapshot().status
        state.requests.observe(e.turnId, result.value.kind, e.agentId, generation)
        if (before !== state.requests.snapshot().status) paint($)
        yield result.value
      }
    } finally {
      if (!finished) await iterator.return?.(undefined as never)
    }
  })
  on('command.run', { command: 'token-run' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (args === 'help') return { text: HELP }
    if (args === 'close') { try { await close($, state) } catch { /* Can retry close via engine controls. */ }; return { text: 'Token Run · 작업으로 돌아갑니다.' } }
    if (args !== '') return { text: 'Usage: /token-run [help|close]' }
    if (!state.supported) return { text: 'Token Run requires an interactive terminal or desktop session. /token-run help' }
    return { text: await start($, state) }
  })
  on('ui.close', { id: PANE }, async ($, e, next) => { detach(state); paint($); return next(e) })
  on('ui.message', { element: 'runner' }, async ($, e) => {
    const data = e.data
    if (e.component !== 'Pane' || e.requestId !== PANE || !state.open || !data || typeof data !== 'object' || Array.isArray(data)) return {}
    const message = data as Record<string, unknown>
    if (message.runId !== state.runId || !validScore(message.score) || (message.type !== 'score' && message.type !== 'exit')) return {}
    const current = state.runId
    const saving = records($, state).save(message.score)
    if (message.type === 'exit' && state.open && current === state.runId) {
      try { await close($, state) } catch { /* Engine close controls remain available. */ }
    }
    await saving
    paint($)
    return {}
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const existing = await next(e)
    if (e.props.hasSurvey || e.props.bodyColumns < 24 || e.props.maxRows < 1 || !state.supported || state.requests.snapshot().status !== 'failed' || state.open) return existing
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return existing
    const { Box, Button } = $.ui.resolve(e)
    return <Box flexDirection="column">{existing}<Button key="run-invite" plain label="요청 실패 · 잠깐 달려볼까요?" onPress={async () => { await start($, state) }} /></Box>
  })
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const existing = await next(e)
    if (e.requestId !== PANE || !state.open || (e.surface !== 'terminal' && e.surface !== 'desktop')) return existing
    const { Box, Client } = $.ui.resolve(e)
    const record = records($, state).snapshot()
    const request = state.requests.snapshot()
    const columns = Number.isFinite(e.props.bodyColumns) ? Math.max(0, Math.min(80, Math.floor(e.props.bodyColumns))) : 0
    const rows = Number.isFinite(e.props.scroll.bodyRows) ? Math.max(0, Math.min(8, Math.floor(e.props.scroll.bodyRows))) : 0
    return <Box flexDirection="column">{existing}<Client key="runner" module="./game.tsx"
      width={Math.max(1, columns)} height={Math.max(1, rows)}
      props={{ runId: state.runId, columns, rows, focused: e.props.isFocused, best: record.best, error: record.error ?? '', status: request.status, recovered: request.recovered }} /></Box>
  })
}

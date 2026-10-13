import type { EngineInterface, Register } from 'claude-code'
import { MemoController, storeKey } from './core/controller.ts'
import { cleanText } from './core/memo.ts'
import { buildView, cellWidth } from './core/view.ts'

type AdapterState = { controller?: MemoController; identityError?: string; identityRequest: number; appliedRequest: number }
function paint($: EngineInterface): void { try { $.ui.invalidate('ui.render') } catch { /* The next render still reads saved state. */ } }
function notify($: EngineInterface, error: unknown): void {
  try { $.ui.toast(cleanText(error instanceof Error ? error.message : String(error))) } catch { /* Feedback must not affect persistence. */ }
}
async function refresh($: EngineInterface, state: AdapterState): Promise<{ controller: MemoController; key: string }> {
  const request = ++state.identityRequest
  try {
    const [cwd, id] = await Promise.all([$.session.cwd(), $.session.id()])
    const key = storeKey(cwd, id)
    if (request < state.appliedRequest && state.controller?.snapshot().key !== key) throw new Error('세션 확인 요청이 변경되었습니다.')
    state.appliedRequest = Math.max(request, state.appliedRequest)
    state.controller ??= new MemoController({ get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) })
    state.identityError = undefined
    await state.controller.activate(cwd, id)
    if (state.controller.snapshot().key !== key) throw new Error('세션이 바뀌었습니다.')
    return { controller: state.controller, key }
  } catch (error) {
    if (request >= state.appliedRequest) {
      state.appliedRequest = request
      state.controller?.detach()
      state.identityError = '세션 폴더와 ID를 확인할 수 없습니다.'
    }
    throw error
  }
}
async function observe($: EngineInterface, state: AdapterState): Promise<void> {
  try { await refresh($, state) } catch { /* Session startup and turns still proceed. */ }
  paint($)
}

export const register: Register = on => {
  const state: AdapterState = { identityRequest: 0, appliedRequest: 0 }
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: 'pin', description: 'Pin a memo or todo: <memo> | - [ ] <todo> | list | toggle <id> | help' }) } catch { /* Do not prevent session startup. */ }
    // Reload the store even when a test or host starts this identity again.
    state.appliedRequest = ++state.identityRequest
    state.controller?.detach()
    await observe($, state)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') { state.appliedRequest = ++state.identityRequest; state.controller?.detach(); paint($) }
    const result = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') await observe($, state)
    return result
  })
  on('turn.start', async ($, e, next) => {
    await observe($, state)
    return next(e)
  })
  on('command.run', { command: 'pin' }, async ($, e) => {
    try {
      const current = await refresh($, state)
      const result = await current.controller.run(e.args ?? '', current.key)
      paint($)
      return { text: result.text }
    } catch (error) {
      paint($)
      return { text: cleanText(state.identityError ?? (error instanceof Error ? error.message : String(error))) }
    }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const existing = await next(e)
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return existing
    try {
      const snapshot = state.controller?.snapshot()
      const view = buildView(snapshot?.document, state.identityError ?? snapshot?.error, e.props.bodyColumns, e.props.maxRows)
      if (!view) return existing
      const { Box, Text, Button } = $.ui.resolve(e)
      const check = async (id: number) => {
        try {
          const current = await refresh($, state)
          await current.controller.run(`toggle ${id}`, snapshot?.key, snapshot?.generation)
        } catch (error) { notify($, error) }
        paint($)
      }
      return <Box flexDirection="column">
        {existing}
        <Box key="pin-memo" flexDirection="column" width={e.props.bodyColumns}
          borderStyle={view.border ? 'round' : undefined} borderColor="#62B8AD"
          paddingX={view.border ? 1 : 0} backgroundColor="#1D2029">
          <Box key="pin-title"><Text bold color="#D5C57A" wrap="truncate-end">{view.title}</Text></Box>
          {view.error ? <Box key="pin-error"><Text color="#E9A09A" wrap="truncate-end">{view.error}</Text></Box> : null}
          {view.rows.map(row => <Box key={`pin-row-${row.id}`} flexDirection="row">
            {row.checked !== null && cellWidth(`[ ] ${row.id} `) <= view.innerWidth
              ? <><Button key={`pin-check-${row.id}`} plain dimColor={row.checked} onPress={async () => { await check(row.id) }}>{row.checked ? '[x]' : '[ ]'}</Button>
                <Text color="#D6D9E0" dimColor={row.checked} strikethrough={row.checked} wrap="truncate-end">{` ${row.id} ${row.text}`}</Text></>
              : <Text color="#D6D9E0" dimColor={row.checked === true} strikethrough={row.checked === true} wrap="truncate-end">{row.prefix + row.text}</Text>}
          </Box>)}
        </Box>
      </Box>
    } catch { return existing }
  })
}

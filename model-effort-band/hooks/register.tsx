import type { EngineInterface, Register } from 'claude-code'
import { BandState, bandView } from './core/band.ts'

function repaint($: EngineInterface): void {
  try { $.ui.invalidate('ui.render') } catch { /* Drawing must not interrupt a request. */ }
}

// Known model labels are ASCII; Korean descriptions take two terminal cells each.
function cells(text: string): number {
  return Array.from(text).reduce((total, char) => total + (/[^\u0000-\u007f\u25b0\u25b1]/u.test(char) ? 2 : 1), 0)
}

export const register: Register = on => {
  const state = new BandState()

  on('session.start', async ($, e, next) => { state.reset(); repaint($); return next(e) })
  on('session.end', async ($, e, next) => { state.reset(); repaint($); return next(e) })
  on('turn.start', async ($, e, next) => {
    repaint($)
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) { state.observeStep(e); repaint($) }
    return yield* next(e)
  })
  on('classic.PostModelSwitch', async ($, e, next) => {
    state.reset(); repaint($)
    return next(e)
  })
  on('config.set', async ($, e, next) => {
    // Clear conservatively on an attempt: direct delegation cannot inspect a later deny.
    state.reset(); repaint($)
    return next(e)
  })
  on('command.run', { command: /^(model|effort|config)$/ }, async ($, e, next) => {
    state.reset(); repaint($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const existing = await next(e)
    if (e.props.hasSurvey) return existing
    try {
      let selected = ''
      try { selected = await $.session.model() } catch { /* Render an honest unknown. */ }
      const observed = state.snapshot(selected)
      const view = bandView(observed.model, observed.effort, e.props.bodyColumns, e.props.maxRows)
      if (view.layout === 'hidden') return existing
      const { Box, Text } = $.ui.resolve(e)
      const { model, effort } = view
      const columns = Math.floor(e.props.bodyColumns)
      if (view.layout === 'inline') {
        return <Box flexDirection="column">
          {existing}
          <Box width={columns} flexShrink={0} overflow="hidden">
            <Text color={model.color} wrap="truncate-end">{`${model.name} | effort ${effort.value}`}</Text>
          </Box>
        </Box>
      }
      const inner = columns - 4 // two borders and one padding cell at each edge
      const full = view.layout === 'full'
      const detail = full
        ? `${effort.meter ? effort.meter + ' ' : ''}${effort.value}${effort.description ? ' · ' + effort.description : ''}`
        : effort.value
      const badgeWidth = full ? model.badge.length + 2 : 0
      const effortWidth = Math.min(cells('effort ' + detail), Math.floor((inner - 3 - badgeWidth) * 0.7))
      const nameWidth = Math.min(cells(model.name), inner - 3 - badgeWidth - effortWidth)
      return <Box flexDirection="column">
        {existing}
        <Box width={columns} borderStyle="round" borderColor={model.color} backgroundColor={model.background}
          paddingX={1} flexDirection="row" alignItems="center" overflow="hidden">
          <Box width={nameWidth} flexShrink={0}>
            <Text bold color={model.color} wrap="truncate-end">{model.name}</Text>
          </Box>
          <Text dimColor> │ </Text>
          <Box width={effortWidth} flexShrink={0}>
            <Text wrap="truncate-end"><Text dimColor>effort </Text><Text bold color={effort.color}>{detail}</Text></Text>
          </Box>
          {full ? <Box flexGrow={1} /> : null}
          {full ? <Box width={badgeWidth} flexShrink={0} justifyContent="flex-end">
            <Text bold color={model.color} backgroundColor={model.background}>{` ${model.badge} `}</Text>
          </Box> : null}
        </Box>
      </Box>
    } catch {
      // next has already run: return its tree, never run it a second time.
      return existing
    }
  })
}

import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import { chartNotes, chartRows, CHART_COLORS, rasterBars, SECTION_LABEL, svgBars, type ChartModel } from './core/chart.ts'
import { fmtMs } from './core/format.ts'

/** A small pane uses the existing text report. Drawing never performs I/O. */
export function renderCharts($: EngineInterface, e: RenderInput<'Pane'>, model: ChartModel): RenderElement | undefined {
  const columns = e.props.bodyColumns, rows = e.props.scroll.bodyRows
  if (!Number.isFinite(columns) || columns < 40 || !Number.isFinite(rows) || rows < 8) return
  const maxTurns = Math.max(1, Math.min(12, Math.floor(rows / 2) - 3))
  if (e.surface === 'desktop' || e.surface === 'vscode') {
    const { Box, Svg } = $.ui.resolve(e)
    if (!Svg) return
    const image = svgBars(model, maxTurns)
    if (image.source.length > 131072) return
    return <Box key="profile-charts" flexDirection="column"><Svg source={image.source} alt={image.alt} /></Box>
  }
  if (e.surface !== 'terminal') return
  const { Box, Text, Raster } = $.ui.resolve(e)
  if (!Raster) return
  const chartColumns = Math.min(512, Math.floor(columns))
  const bars = chartRows(model, maxTurns), raster = rasterBars(model, chartColumns, maxTurns)
  // A base64 row occupies exactly columns * 12 bytes, divisible by three: slicing is aligned.
  const charsPerRow = chartColumns * 16
  const children: RenderElement[] = []
  let previous = ''
  for (const [i, row] of bars.entries()) {
    if (row.kind !== previous) {
      children.push(<Text bold>{SECTION_LABEL[row.kind]}</Text>)
      previous = row.kind
    }
    children.push(
      <Text wrap="truncate-end">{`${row.label} · ${fmtMs(row.ms)}${row.running ? ' · running' : ''}`}</Text>,
      <Raster key={`profile-bar-${i}`} columns={chartColumns} rows={1} cells={raster.cells.slice(i * charsPerRow, (i + 1) * charsPerRow)} />,
    )
  }
  for (const [i, d] of model.categories.entries()) children.push(
    <Text color={`#${CHART_COLORS[d.category!].toString(16).padStart(6, '0')}`}>{`${['M', 'T', 'A', 'E'][i]} ${d.label}: ${fmtMs(d.ms)}`}</Text>,
  )
  for (const note of chartNotes(model)) children.push(<Text dimColor>{note}</Text>)
  return <Box key="profile-charts" flexDirection="column">{children}</Box>
}

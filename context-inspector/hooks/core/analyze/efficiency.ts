import { MAIN, type EditRec, type Sample } from '../types.ts'

export type TurnEff = { turn: number; growth?: number; lines: number; perLine?: number }
export type Efficiency = { turns: TurnEff[]; growth: number; lines: number; exploration: number; medianPerLine?: number }

// Per main turn: measured input growth (last request of the turn against the last request of the turn
// before, same epoch only) next to the lines edits changed in the turn, subagents' included.
export function efficiency(samples: readonly Sample[], edits: readonly EditRec[]): Efficiency {
  const last = new Map<number, Sample>()
  for (const s of samples) if (s.ctx === MAIN) last.set(s.turn, s)
  const lines = new Map<number, number>()
  for (const e of edits) lines.set(e.turn, (lines.get(e.turn) ?? 0) + e.lines)
  const order = [...new Set([...last.keys(), ...lines.keys()])].sort((a, b) => a - b)
  const turns: TurnEff[] = []
  let prev: Sample | undefined
  for (const turn of order) {
    const s = last.get(turn)
    const growth = s && prev && s.epoch === prev.epoch ? s.input - prev.input : undefined
    if (s) prev = s
    const changed = lines.get(turn) ?? 0
    turns.push({ turn, growth, lines: changed, perLine: growth !== undefined && changed > 0 ? Math.round(growth / changed) : undefined })
  }
  const per = turns.flatMap(t => (t.perLine !== undefined ? [t.perLine] : [])).sort((a, b) => a - b)
  return {
    turns,
    growth: turns.reduce((s, t) => s + Math.max(0, t.growth ?? 0), 0),
    lines: turns.reduce((s, t) => s + t.lines, 0),
    exploration: turns.filter(t => (t.growth ?? 0) > 0 && t.lines === 0).length,
    medianPerLine: per.length > 0 ? per[Math.floor((per.length - 1) / 2)] : undefined,
  }
}

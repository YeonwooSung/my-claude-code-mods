export type Family = 'haiku' | 'sonnet' | 'opus' | 'unknown'
export type ModelView = { name: string; family: Family; badge: string; color: string; background: string }
export type EffortView = { value: string; meter: string; description: string; color: string }
export type BandView = { model: ModelView; effort: EffortView; layout: 'full' | 'compact' | 'inline' | 'hidden' }

const THEMES: Record<Family, { badge: string; color: string; background: string }> = {
  haiku: { badge: 'Haiku', color: '#8ACFA7', background: '#17251F' },
  sonnet: { badge: 'Sonnet', color: '#8BBEF4', background: '#192333' },
  opus: { badge: 'Opus', color: '#B99CE5', background: '#241C32' },
  unknown: { badge: 'Model', color: '#B5BAC4', background: '#202329' },
}

// Strip escape sequences before controls so their payload never becomes visible UI text.
function clean(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, 80).join('')
}

export function modelView(model: unknown): ModelView {
  const raw = clean(model)
  const id = raw.toLowerCase().replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '')
  const alias = /^(haiku|sonnet|opus)$/.exec(id)
  const suffix = '(?:-\\d{8})?(?:-v\\d+(?::\\d+)?|:v\\d+)?'
  const modern = new RegExp(`^claude-(haiku|sonnet|opus)-(\\d{1,2})(?:-(\\d{1,2}))?${suffix}$`).exec(id)
  const legacy = new RegExp(`^claude-(\\d{1,2})(?:-(\\d{1,2}))?-(haiku|sonnet|opus)${suffix}$`).exec(id)
  const family = (alias?.[1] ?? modern?.[1] ?? legacy?.[3] ?? 'unknown') as Family
  const major = modern?.[2] ?? legacy?.[1]
  const minor = modern?.[3] ?? legacy?.[2]
  const theme = THEMES[family]
  const version = major ? ` ${major}${minor ? `.${minor}` : ''}` : ''
  return { name: family === 'unknown' ? raw || 'Unknown model' : theme.badge + version, family, ...theme }
}

export function effortView(effort: unknown): EffortView {
  const levels: Record<string, [string, string, string]> = {
    low: ['▰▱▱▱▱', '빠르게', THEMES.haiku.color],
    medium: ['▰▰▱▱▱', '보통', THEMES.sonnet.color],
    high: ['▰▰▰▱▱', '깊게', '#E4CC75'],
    xhigh: ['▰▰▰▰▱', '더 깊게', '#E4CC75'],
    max: ['▰▰▰▰▰', '최대로', '#E4CC75'],
  }
  const value = typeof effort === 'number'
    ? Number.isFinite(effort) && effort >= 0 ? String(effort) : ''
    : clean(effort)
  // Own-property lookup keeps arbitrary future strings such as "constructor" harmless.
  const level = Object.hasOwn(levels, value) ? levels[value] : undefined
  return {
    value: value || 'unknown', meter: level?.[0] ?? '',
    description: level?.[1] ?? (value ? '' : '확인 전'), color: level?.[2] ?? THEMES.unknown.color,
  }
}

export function bandView(model: unknown, effort: unknown, columns: number, rows: number): BandView {
  const width = Number.isFinite(columns) ? Math.floor(columns) : 0
  const height = Number.isFinite(rows) ? Math.floor(rows) : 0
  const layout = width <= 0 || height <= 0 ? 'hidden'
    : width < 30 || height < 3 ? 'inline' : width < 60 ? 'compact' : 'full'
  return { model: modelView(model), effort: effortView(effort), layout }
}

export class BandState {
  private model: string | undefined
  private effort: unknown

  observeStep(step: { model: string; effort?: unknown; agentId?: string }): void {
    if (step.agentId !== undefined) return
    // An omitted value is not an effort change; only reuse it for this model.
    if (step.model !== this.model || step.effort !== undefined) this.effort = step.effort
    this.model = step.model
  }

  reset(): void {
    this.model = undefined
    this.effort = undefined
  }

  snapshot(selectedModel: string): { model: string; effort: unknown } {
    return { model: selectedModel, effort: selectedModel === this.model ? this.effort : undefined }
  }
}

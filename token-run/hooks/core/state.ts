export type RequestSnapshot = { status: 'unknown' | 'failed' | 'available'; recovered: boolean; generation: number }
export class RequestState {
  private turn: string | undefined
  private value: RequestSnapshot = { status: 'unknown', recovered: false, generation: 0 }
  snapshot(): RequestSnapshot { return { ...this.value } }
  reset(): void {
    this.turn = undefined
    this.value = { status: 'unknown', recovered: false, generation: this.value.generation + 1 }
  }
  begin(turnId: string): void { this.turn = turnId; this.value.generation++ }
  private accepts(turnId: string, agentId: string | undefined, generation: number): boolean {
    if (agentId !== undefined || generation !== this.value.generation) return false
    this.turn ??= turnId
    return this.turn === turnId
  }
  observe(turnId: string, kind: string, agentId?: string, generation = this.value.generation): void {
    if (!this.accepts(turnId, agentId, generation) || !['text', 'thinking', 'tool', 'input', 'stop'].includes(kind)) return
    this.value.recovered ||= this.value.status === 'failed'
    this.value.status = 'available'
  }
  complete(turnId: string, reason: string, agentId?: string, generation = this.value.generation): void {
    if (!this.accepts(turnId, agentId, generation)) return
    if (reason === 'error') { this.value.status = 'failed'; this.value.recovered = false }
    else if (reason === 'answer') this.observe(turnId, 'stop', agentId, generation)
  }
}
export type ScoreDocument = { version: 1; best: number }
type Store = { get(key: string): Promise<unknown>; set(key: string, value: ScoreDocument): Promise<unknown> }
export const SCORE_KEY = 'token-run.best.v1'
export function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 999999
}
function decode(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const doc = value as Record<string, unknown>
  return doc.version === 1 && validScore(doc.best) ? doc.best : 0
}
export class Scores {
  private best = 0
  private error: string | undefined
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly store: Store) {}
  snapshot(): { best: number; error?: string } { return { best: this.best, error: this.error } }
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const operation = this.queue.then(fn)
    this.queue = operation.catch(() => {})
    return operation
  }
  load(): Promise<void> {
    return this.enqueue(async () => {
      try { this.best = Math.max(this.best, decode(await this.store.get(SCORE_KEY))); this.error = undefined }
      catch { this.error = '최고 기록을 불러오지 못했어요. 게임은 계속할 수 있어요.' }
    })
  }
  save(value: number): Promise<void> {
    if (!validScore(value)) return Promise.reject(new Error('Invalid score'))
    return this.enqueue(async () => {
      this.best = Math.max(this.best, value)
      try {
        const stored = decode(await this.store.get(SCORE_KEY))
        this.best = Math.max(this.best, stored)
        if (this.best > stored) await this.store.set(SCORE_KEY, { version: 1, best: this.best })
        this.error = undefined
      } catch { this.error = '최고 기록을 저장하지 못했어요. 이번 실행의 기록은 유지돼요.' }
    })
  }
}

import { decodeDocument, emptyDocument, execute, type MemoDocument, type CommandResult } from './memo.ts'
export type Storage = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
type Context = { key: string; generation: number; ready: Promise<void>; tail: Promise<void>; document?: MemoDocument; error?: string }

export function storeKey(cwd: string, id: string): string {
  if (!cwd || !id || !/^(?:\/|[A-Za-z]:[\\/])/.test(cwd)) throw new Error('세션 폴더와 ID를 확인할 수 없습니다.')
  const folder = cwd.startsWith('/') ? cwd.replace(/\/+$/, '') || '/'
    : /^[A-Za-z]:[\\/]$/.test(cwd) ? cwd : cwd.replace(/[\\/]+$/, '')
  return `pin-memo:v1:${JSON.stringify([folder, id])}`
}

export class MemoController {
  private current?: Context
  private generation = 0
  private pending = new Map<string, Promise<void>>()
  constructor(private readonly store: Storage) {}

  activate(cwd: string, id: string): Promise<void> {
    let key: string
    try { key = storeKey(cwd, id) } catch (error) { this.detach(); return Promise.reject(error) }
    if (this.current?.key === key && this.current.document) return this.current.ready
    if (this.current?.key === key && !this.current.error) return this.current.ready
    const prior = this.pending.get(key) ?? Promise.resolve()
    const ctx: Context = { key, generation: ++this.generation, ready: Promise.resolve(), tail: Promise.resolve() }
    this.current = ctx
    ctx.ready = (async () => {
      await prior
      try { ctx.document = decodeDocument(await this.store.get(key)); ctx.error = undefined }
      catch (error) { ctx.error = `메모를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}` }
    })()
    return ctx.ready
  }

  detach(): void { this.current = undefined }

  snapshot(): { key?: string; generation?: number; document?: MemoDocument; error?: string } {
    const ctx = this.current
    return ctx ? { key: ctx.key, generation: ctx.generation, document: ctx.document ? decodeDocument(ctx.document) : undefined, error: ctx.error } : {}
  }

  async run(args: string, expectedKey?: string, expectedGeneration?: number): Promise<CommandResult> {
    const ctx = this.current
    if (!ctx || (expectedKey !== undefined && ctx.key !== expectedKey) || (expectedGeneration !== undefined && ctx.generation !== expectedGeneration)) throw new Error('세션이 바뀌었습니다. 현재 메모 화면에서 다시 실행하세요.')
    const work = ctx.tail.then(async () => {
      await ctx.ready
      if (this.current !== ctx) throw new Error('세션이 바뀌었습니다. 현재 메모 화면에서 다시 실행하세요.')
      if (!ctx.document && args.trim() !== 'clear') throw new Error(ctx.error ?? '메모를 불러오는 중입니다.')
      const recovering = !ctx.document
      const result = execute(ctx.document ?? emptyDocument(), args)
      if (result.changed || recovering) {
        try { await this.store.set(ctx.key, result.document) }
        catch (error) {
          ctx.error = `메모를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
          throw new Error(ctx.error)
        }
        ctx.document = result.document
        ctx.error = undefined
      }
      return result
    })
    const tail = work.then(() => undefined, () => undefined)
    ctx.tail = tail
    this.pending.set(ctx.key, tail)
    void tail.then(() => { if (this.pending.get(ctx.key) === tail) this.pending.delete(ctx.key) })
    return work
  }
}

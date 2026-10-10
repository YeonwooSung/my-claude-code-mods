import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { why } from './core/causality.ts'
import { classifyCommand } from './core/classify.ts'
import { compare, compareOutputs } from './core/compare.ts'
import { contentHash } from './core/hash.ts'
import {
  circled,
  label,
  renderCompare,
  renderRerun,
  renderRestorePlan,
  renderSessions,
  renderStep,
  renderTimeline,
  renderWhy,
  statusLine,
} from './core/render.ts'
import { ChunkWriter, parseChunks, projectKey } from './core/store.ts'
import { parseTestOutput } from './core/testparse.ts'
import { Recorder } from './core/timeline.ts'
import { callInput, isMutating, resultText, summarizeInput, summarizeResult, targetOf } from './core/tools.ts'
import type { SnapshotRef, Step } from './core/types.ts'
import { isInside, ShadowGit, type Runner } from './git.ts'

const PANE = 'time-machine'
// Names this module load's timeline chunks, so a reload never overwrites an earlier load's.
const LOAD_ID = Date.now().toString(36)
const DAY = 86_400_000
const TOO_SLOW_MS = 5_000
const MAX_LIVE_INPUTS = 500
const USAGE =
  'usage: /tm [timeline [--all] [--branch b] | show <n> | diff <a> [b] | why [n] | restore <n> [--yes] | branch <n> [name] [--yes] | compare <a> <b> | rerun <n> [--write] [--isolated] | sessions]'

type Ctx = {
  rec: Recorder
  root: string
  base: string
  dir: string
  git?: ShadowGit
  ready?: Promise<void>
  off?: string
  head?: string
  writer: ChunkWriter
  writing: Promise<void>
  inflight: number
  snapMs: number[]
  live: Map<number, Record<string, unknown>>
  rerunOf?: number
  ended?: boolean
}

let ctx: Ctx | undefined
let currentOptions: PluginOptions = {}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function runnerOf($: EngineInterface): Runner {
  return async (argv, opts) => {
    const r = await $.process.run(argv, opts)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
}

const refOf = (c: Ctx): string => `refs/tm/${c.rec.session.sessionId}/${c.rec.branch}`

async function storeDir($: EngineInterface, options: PluginOptions): Promise<string> {
  const dir = (String(options.storeDir ?? '').trim() || '~/.claude/time-machine').replace(/\/+$/, '')
  if (!/^~(?=\/|$)/.test(dir)) return dir
  return dir.replace(/^~/, (await $.env.get('HOME')) ?? '.')
}

// Records written in order: every chunk a batch touched gets its final body.
async function persist($: EngineInterface, c: Ctx): Promise<void> {
  const recs = c.rec.drain()
  if (recs.length === 0) return c.writing
  const writes = new Map<string, string>()
  for (const rec of recs) {
    const { name, body } = c.writer.add(rec)
    writes.set(name, body)
  }
  c.writing = c.writing
    .then(async () => {
      for (const [name, body] of writes) await $.fs.write(`${c.dir}/${name}`, body)
    })
    .catch(() => undefined)
  return c.writing
}

function paint($: EngineInterface, c: Ctx): void {
  try {
    $.ui.status(statusLine(c.rec, c.snapMs, c.off))
    $.ui.invalidate('ui.render')
  } catch {
    // no status line here
  }
}

async function startSession($: EngineInterface): Promise<Ctx> {
  const sessionId = await $.session.id()
  const root = await $.session.root()
  const base = `${await storeDir($, currentOptions)}/${projectKey(root)}`
  const dir = `${base}/sessions/${sessionId}`
  let rec: Recorder | undefined
  try {
    const entries = await $.fs.list(dir)
    const files = await Promise.all(
      entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).map(async e => ({ name: e.name, text: String(await $.fs.read(`${dir}/${e.name}`)) })),
    )
    rec = Recorder.fromRecords(parseChunks(files))
  } catch {
    // a new session
  }
  rec ??= new Recorder({ sessionId, root, startedAt: Date.now(), loadId: LOAD_ID })
  const c: Ctx = { rec, root, base, dir, writer: new ChunkWriter(LOAD_ID), writing: Promise.resolve(), inflight: 0, snapMs: [], live: new Map() }
  const last = rec.lastSnapshot()
  if (last?.snapshot) c.head = last.snapshot.commit
  try {
    await $.fs.write(`${dir}/meta.json`, JSON.stringify({ sessionId, root, startedAt: rec.session.startedAt }))
  } catch {
    // the timeline still lives in memory
  }
  await persist($, c)
  return c
}

// The context for this session, started again after a /clear or a resume.
async function live($: EngineInterface): Promise<Ctx | undefined> {
  if (ctx && !ctx.ended) return ctx
  try {
    ctx = await startSession($)
  } catch {
    ctx = undefined
  }
  return ctx
}

// Git, ready to use from this hook, or undefined with `c.off` saying why.
async function ensureGit($: EngineInterface, c: Ctx): Promise<ShadowGit | undefined> {
  if (c.off) return undefined
  if (c.git) {
    c.git.runner = runnerOf($)
    await c.ready
    return c.off ? undefined : c.git
  }
  const home = await $.env.get('HOME').catch(() => undefined)
  if (c.root === '/' || (home !== undefined && c.root.replace(/\/+$/, '') === home.replace(/\/+$/, ''))) {
    c.off = 'the session root is the home or the root directory'
  }
  const git = new ShadowGit(runnerOf($), `${c.base}/shadow.git`, c.root, `${c.base}/index/${c.rec.session.sessionId}`)
  c.git = git
  c.ready = (async () => {
    if (c.off) return
    try {
      await git.runner(['mkdir', '-p', `${c.base}/index`])
      await git.init()
      if (c.head === undefined) {
        const t0 = Date.now()
        const snap = await git.snapshot(undefined, `baseline ${c.rec.session.sessionId}`, refOf(c))
        const ms = Date.now() - t0
        c.head = snap.commit
        if (!c.rec.get(0)) c.rec.baseline(Date.now(), { ...snap, ms })
        if (ms > TOO_SLOW_MS) c.off = `the baseline snapshot took ${ms}ms; per-step snapshots would slow every tool`
      }
      await prune($, c, git)
    } catch (error) {
      c.off = `git unavailable: ${message(error)}`
    }
  })()
  await c.ready
  if (!c.rec.get(0)) c.rec.baseline(Date.now())
  await persist($, c)
  return c.off ? undefined : git
}

async function takeSnapshot($: EngineInterface, c: Ctx, label: string): Promise<SnapshotRef | undefined> {
  const git = await ensureGit($, c)
  if (!git) return undefined
  const concurrent = c.inflight > 0
  const t0 = Date.now()
  try {
    const s = await git.snapshot(c.head, label, refOf(c))
    const ms = Date.now() - t0
    c.head = s.commit
    c.snapMs.push(ms)
    if (c.snapMs.length > 1_000) c.snapMs.shift()
    return { ...s, ms, ...(concurrent ? { concurrent: true } : {}) }
  } catch (error) {
    c.off = `snapshot failed: ${message(error)}`
    return undefined
  }
}

// Changes made outside the agent since the last snapshot become an `external` step of their own.
async function checkExternal($: EngineInterface, c: Ctx): Promise<void> {
  if (c.inflight > 0) return
  const snap = await takeSnapshot($, c, 'external')
  if (!snap?.changed) return
  const step = c.rec.begin({ id: `external-${Date.now()}`, tool: 'external', kind: 'external', at: Date.now() })
  c.rec.finish(step, Date.now(), { snapshot: snap })
}

async function prune($: EngineInterface, c: Ctx, git: ShadowGit): Promise<void> {
  const key = `lastPrune:${projectKey(c.root)}`
  const last = Number((await $.store.get(key)) ?? 0)
  if (Date.now() - last < DAY) return
  await $.store.set(key, Date.now())
  const days = Number(currentOptions.retentionDays ?? 14)
  if (!(days > 0)) return
  const sessions = `${c.base}/sessions`
  for (const entry of await $.fs.list(sessions).catch(() => [])) {
    if (entry.kind !== 'dir' || entry.name === c.rec.session.sessionId) continue
    const target = `${sessions}/${entry.name}`
    try {
      const meta = JSON.parse(String(await $.fs.read(`${target}/meta.json`))) as { startedAt?: number }
      if (Date.now() - Number(meta.startedAt ?? Date.now()) < days * DAY || !isInside(target, sessions)) continue
      await git.runner(['rm', '-rf', target])
      await git.deleteRefs(`refs/tm/${entry.name}/`)
    } catch {
      // leave it for next time
    }
  }
  await git.gc().catch(() => undefined)
}

// Finishes a begun step on every path: a recording error still ends it, with what it gathered.
async function settle($: EngineInterface, c: Ctx, step: Step | undefined, counted: boolean, mutating: boolean, answer: unknown): Promise<void> {
  if (counted) c.inflight = Math.max(0, c.inflight - 1)
  if (!step) return
  try {
    const result = summarizeResult(answer)
    const snapshot = mutating ? await takeSnapshot($, c, `step ${step.n} ${step.tool}`) : undefined
    const command = String(c.live.get(step.n)?.command ?? step.input.command ?? '')
    const test = step.tool === 'Bash' && classifyCommand(command) === 'test' ? parseTestOutput(resultText(answer), result.isError) : undefined
    c.rec.finish(step, Date.now(), { result, ...(snapshot ? { snapshot } : {}), ...(test ? { test } : {}) })
    await persist($, c)
    paint($, c)
  } catch {
    // recording never breaks the call; the step is still finished
    try {
      if (step.endedAt === undefined) c.rec.finish(step, Date.now())
      await persist($, c)
    } catch {
      // dropped
    }
  }
}

const num = (word: string | undefined): number | undefined => (word !== undefined && /^\d+$/.test(word) ? Number(word) : undefined)

async function restore($: EngineInterface, c: Ctx, n: number, yes: boolean, branch?: string): Promise<string> {
  if (!c.rec.get(n)) return `time-machine: no step ${n}`
  const git = await ensureGit($, c)
  if (!git) return `time-machine: snapshots are off (${c.off ?? 'not ready'}); there is nothing to restore`
  const target = c.rec.snapshotAt(n)
  if (!target?.snapshot) return `time-machine: no snapshot at or before step ${n}`
  await checkExternal($, c)
  const from = c.head!
  const files = await git.nameStatus(from, target.snapshot.commit)
  const name = branch === undefined ? undefined : branch || c.rec.nextBranchName()
  const asked = c.rec.get(n)!
  if (!yes) return renderRestorePlan(asked, target, files, false, name)
  if (name !== undefined && c.rec.branches.has(name)) return `time-machine: branch '${name}' already exists`
  // Applied first: a refused restore (the work tree moved since `from`) leaves no fork and no restore step.
  await git.restore(target.snapshot.commit, refOf(c), from)
  c.head = target.snapshot.commit
  if (name !== undefined) c.rec.fork(name, n, Date.now())
  const snapshot: SnapshotRef = { commit: target.snapshot.commit, changed: files.length > 0, files: files.slice(0, 200), filesTotal: files.length, ms: 0 }
  const step = c.rec.begin({ id: `restore-${Date.now()}`, tool: 'restore', kind: 'restore', input: { to: n, from }, target: `step ${n}`, at: Date.now() })
  c.rec.finish(step, Date.now(), { snapshot })
  await persist($, c)
  paint($, c)
  const list = files.slice(0, 20).map(f => `${f.status} ${f.path}`).join(', ')
  const note =
    `[time-machine] The user restored the working tree to step ${n} (${label(c.rec.get(n)!)}). ${files.length} file(s) changed${list ? `: ${list}` : ''}. ` +
    'Earlier tool results about these files are out of date; re-read files before editing them.' +
    (name !== undefined ? ` Work continues on branch '${name}'; the conversation itself was not rewound.` : '')
  let told = true
  try {
    const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
    if (typeof appended?.deny === 'string') told = false
  } catch {
    // the restore stands; the model was not told
    told = false
  }
  return renderRestorePlan(asked, target, files, true, name, told)
}

// A branch name, or `session:<id>[/<branch>]` for another recorded session of this project.
async function pathOf($: EngineInterface, c: Ctx, spec: string): Promise<{ steps: Step[]; head?: string } | string> {
  let rec: Recorder | undefined = c.rec
  let branch = spec
  if (spec.startsWith('session:')) {
    const [id, b] = spec.slice('session:'.length).split('/')
    const dir = `${c.base}/sessions/${id}`
    try {
      const entries = await $.fs.list(dir)
      const files = await Promise.all(
        entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).map(async e => ({ name: e.name, text: String(await $.fs.read(`${dir}/${e.name}`)) })),
      )
      rec = Recorder.fromRecords(parseChunks(files))
    } catch {
      rec = undefined
    }
    if (!rec) return `time-machine: no recorded session ${id}`
    branch = b ?? 'main'
  }
  if (!rec.branches.has(branch)) return `time-machine: no branch '${branch}'`
  const steps = rec.path(branch)
  const head = rec.lastSnapshot(branch)?.snapshot?.commit
  return head !== undefined ? { steps, head } : { steps }
}

async function rerun($: EngineInterface, c: Ctx, n: number, write: boolean, isolated: boolean): Promise<string> {
  const step = c.rec.get(n)
  if (!step || step.kind !== 'tool') return `time-machine: no tool step ${n}`
  const input = c.live.get(n) ?? (step.inputLossy ? undefined : step.input)
  if (!input) return `time-machine: step ${n}'s input was cut or redacted when stored and this load did not record it live, so it cannot be replayed`
  if (isolated) {
    if (step.tool !== 'Bash') return 'time-machine: --isolated replays Bash steps only'
    const git = await ensureGit($, c)
    if (!git) return `time-machine: snapshots are off (${c.off ?? 'not ready'})`
    const before = c.rec.snapshotAt(step.parent)
    if (!before?.snapshot) return `time-machine: no snapshot before step ${n}`
    const command = String(input.command ?? '')
    const tmpRoot = `${c.base}/tmp`
    const tmp = `${tmpRoot}/${LOAD_ID}-${n}-${Date.now().toString(36)}`
    const run = runnerOf($)
    try {
      await run(['mkdir', '-p', tmp])
      await git.exportTo(before.snapshot.commit, tmp)
      const r = await run(['sh', '-lc', command], { cwd: tmp, timeoutMs: 600_000 })
      const text = [r.stdout, r.stderr].filter(s => s !== '').join('\n')
      const now = step.test ? parseTestOutput(text, r.exitCode !== 0) : undefined
      const where = `isolated, in a copy of ${circled(before.n)}'s snapshot; ignored files such as dependencies are not in the copy`
      return [`$ ${command}`, renderRerun(step, compareOutputs(step.result, text, step.test, now), where)].join('\n')
    } finally {
      if (isInside(tmp, tmpRoot)) await run(['rm', '-rf', tmp, `${tmp}.index`]).catch(() => undefined)
    }
  }
  if (isMutating(step.tool, input, currentOptions.skipSearchBash === true) && !write)
    return `time-machine: step ${n} (${step.tool}) can change files; add --write to run it again here (a snapshot is taken after it)`
  c.rerunOf = n
  const answer = await $.tool.call({ tool: step.tool, ...input } as never)
  const text = resultText(answer)
  const now = step.test ? parseTestOutput(text, summarizeResult(answer).isError) : undefined
  return renderRerun(step, compareOutputs(step.result, text, step.test, now), 'here, against the current files')
}

async function runTm($: EngineInterface, c: Ctx, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const flags = new Set(words.filter(w => w.startsWith('--')))
  const rest = words.filter(w => !w.startsWith('--'))
  const sub = rest[0] ?? 'timeline'
  switch (sub) {
    case 'timeline': {
      const branchAt = words.indexOf('--branch')
      const branch = branchAt >= 0 ? words[branchAt + 1] : undefined
      if (branch !== undefined && !c.rec.branches.has(branch)) return `time-machine: no branch '${branch}'`
      return renderTimeline(c.rec, { all: flags.has('--all'), ...(branch ? { branch } : {}), ...(c.off ? { off: c.off } : {}), snapMs: c.snapMs })
    }
    case 'show': {
      const n = num(rest[1])
      const step = n === undefined ? undefined : c.rec.get(n)
      return step ? renderStep(step) : `time-machine: no step ${rest[1] ?? ''}`.trim()
    }
    case 'diff': {
      const a = num(rest[1])
      if (a === undefined) return USAGE
      const git = await ensureGit($, c)
      if (!git) return `time-machine: snapshots are off (${c.off ?? 'not ready'})`
      const from = c.rec.snapshotAt(a)?.snapshot?.commit
      let to: string | undefined
      const b = num(rest[2])
      if (b !== undefined) to = c.rec.snapshotAt(b)?.snapshot?.commit
      else {
        await checkExternal($, c)
        to = c.head
      }
      if (from === undefined || to === undefined) return 'time-machine: no snapshot for that step'
      const { stat, patch } = await git.diffText(from, to)
      const lines = patch.split('\n')
      const cut = lines.length > 400 ? [...lines.slice(0, 400), `… (${lines.length - 400} more lines)`] : lines
      return [stat.trimEnd() || '(no difference)', '', ...cut].join('\n')
    }
    case 'why': {
      const w = why(c.rec.path(), num(rest[1]))
      if (!w) return rest[1] ? `time-machine: step ${rest[1]} is not a test run on this branch` : 'time-machine: no failing test run on this branch'
      return renderWhy(w, n => {
        const s = c.rec.get(n)
        return s ? `${circled(n)} ${label(s)}` : undefined
      })
    }
    case 'restore':
    case 'branch': {
      const n = num(rest[1])
      if (n === undefined) return USAGE
      return restore($, c, n, flags.has('--yes'), sub === 'branch' ? (rest[2] ?? '') : undefined)
    }
    case 'compare': {
      if (rest.length < 3) return USAGE
      const a = await pathOf($, c, rest[1]!)
      const b = await pathOf($, c, rest[2]!)
      if (typeof a === 'string') return a
      if (typeof b === 'string') return b
      let stat: string | undefined
      if (a.head && b.head) {
        const git = await ensureGit($, c)
        if (git) stat = (await git.diffText(a.head, b.head).catch(() => ({ stat: '(snapshots no longer available)', patch: '' }))).stat
      }
      return renderCompare(rest[1]!, rest[2]!, compare(a.steps, b.steps), stat)
    }
    case 'rerun': {
      const n = num(rest[1])
      if (n === undefined) return USAGE
      return rerun($, c, n, flags.has('--write'), flags.has('--isolated'))
    }
    case 'sessions': {
      const sessions = `${c.base}/sessions`
      const rows: { id: string; startedAt: number; current: boolean }[] = []
      for (const entry of await $.fs.list(sessions).catch(() => [])) {
        if (entry.kind !== 'dir') continue
        let startedAt = 0
        try {
          startedAt = Number((JSON.parse(String(await $.fs.read(`${sessions}/${entry.name}/meta.json`))) as { startedAt?: number }).startedAt ?? 0)
        } catch {
          // unknown start
        }
        rows.push({ id: entry.name, startedAt, current: entry.name === c.rec.session.sessionId })
      }
      return renderSessions(rows)
    }
    default:
      return USAGE
  }
}

export const register: Register = (on, options) => {
  currentOptions = options

  on('session.start', async ($, e, next) => {
    try {
      ctx = await startSession($)
      for (const command of [
        { name: 'tm', description: 'Agent Time Machine: timeline, show, diff, why, restore, branch, compare, rerun, sessions', argumentHint: '[timeline|show n|diff a [b]|why [n]|restore n|branch n|compare a b|rerun n|sessions]' },
        { name: 'tm-pane', description: 'Open the live Time Machine timeline pane' },
      ]) {
        try {
          await $.command.register(command)
        } catch {
          // the command stays unavailable
        }
      }
      paint($, ctx)
    } catch {
      ctx = undefined
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if ((e.reason === 'clear' || e.reason === 'resume') && ctx) ctx.ended = true
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      const c = await live($)
      if (c) {
        c.rec.startTurn(Date.now(), e.text, currentOptions.recordModelOutput === true)
        await persist($, c)
      }
    } catch {
      // not recorded
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const c = await live($).catch(() => undefined)
    if (!c) return next(e)
    const raw = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    let step: Step | undefined
    let mutating = false
    let counted = false
    try {
      mutating = isMutating(tool, raw, currentOptions.skipSearchBash === true)
      if (mutating) await checkExternal($, c)
      if (mutating) {
        c.inflight += 1
        counted = true
      }
      const { input, lossy } = summarizeInput(raw)
      const target = targetOf(tool, raw, c.root)
      step = c.rec.begin({
        id: e.tool_use_id ?? `call-${Date.now()}`,
        tool,
        input,
        inputLossy: lossy,
        at: Date.now(),
        ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(c.rerunOf !== undefined ? { rerunOf: c.rerunOf } : {}),
      })
      c.rerunOf = undefined
      c.live.set(step.n, callInput(raw))
      if (c.live.size > MAX_LIVE_INPUTS) c.live.delete(c.live.keys().next().value!)
    } catch {
      // recording never blocks the tool
    }
    try {
      const answer = await next(e)
      await settle($, c, step, counted, mutating, answer)
      return answer
    } catch (error) {
      await settle($, c, step, counted, mutating, { isError: true, text: message(error) })
      throw error
    }
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    let text = ''
    const tools: { id: string; tool: string }[] = []
    for await (const chunk of next(e)) {
      try {
        if (chunk.kind === 'text') text += chunk.text
        else if (chunk.kind === 'tool') tools.push({ id: chunk.id, tool: chunk.name })
        else if (chunk.kind === 'stop' && ctx && !ctx.ended)
          ctx.rec.addModel({
            turn: ctx.rec.turn,
            index: e.index,
            ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
            model: e.model,
            stopReason: chunk.stopReason,
            usage: chunk.usage,
            text: { chars: text.length, hash: contentHash(text), ...(currentOptions.recordModelOutput === true ? { body: text } : {}) },
            toolUses: tools,
          })
      } catch {
        // not recorded
      }
      yield chunk
    }
    if (ctx) await persist($, ctx).catch(() => undefined)
  })

  on('command.run', { command: 'tm' }, async ($, e) => {
    try {
      const c = await live($)
      if (!c) return { text: 'time-machine: not recording (the session could not be read)' }
      return { text: await runTm($, c, e.args ?? '') }
    } catch (error) {
      return { text: `time-machine: ${message(error)}` }
    }
  })

  on('command.run', { command: 'tm-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Time Machine' })
    return { text: 'Time Machine pane opened (shown in the terminal and the desktop app).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    let lines: string[]
    try {
      lines = ctx ? renderTimeline(ctx.rec, { ...(ctx.off ? { off: ctx.off } : {}), snapMs: ctx.snapMs }).split('\n') : ['Time Machine: not recording']
    } catch (error) {
      lines = [`time-machine: ${message(error)}`]
    }
    const width = e.props.bodyColumns ?? 80
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text>{(line.length > width ? `${line.slice(0, width - 1)}…` : line) || ' '}</Text>
        ))}
      </Box>
    )
  })
}

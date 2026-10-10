import { contentHash } from './hash.ts'
import { type BranchRec, type FileChange, MAX_FILES, type ModelRec, type Rec, type SessionRec, type SnapshotRef, type Step, type StepKind, type StepResult, type TestRun, type TurnRec } from './types.ts'

export type BeginArgs = {
  id: string
  tool: string
  kind?: StepKind
  agentId?: string
  input?: Record<string, unknown>
  inputLossy?: boolean
  target?: string
  at: number
  rerunOf?: number
}

// The session's steps as a tree: each step points at its parent, each branch at the step it grew from.
export class Recorder {
  version = 0
  branch = 'main'
  turn = 0
  readonly turns: TurnRec[] = []
  readonly models: ModelRec[] = []
  readonly branches = new Map<string, BranchRec>([['main', { name: 'main', fromStep: 0, at: 0 }]])
  private steps = new Map<number, Step>()
  private order: number[] = []
  private nextN = 1
  private out: Rec[] = []

  constructor(readonly session: SessionRec) {
    this.out.push({ type: 'session', ...session })
  }

  // Records not yet written out, oldest first; each is handed out once.
  drain(): Rec[] {
    const out = this.out
    this.out = []
    return out
  }

  get size(): number {
    return this.order.length
  }

  get(n: number): Step | undefined {
    return this.steps.get(n)
  }

  // By number: the baseline, taken when git is first needed, comes first.
  all(): Step[] {
    return [...this.order].sort((a, b) => a - b).map(n => this.steps.get(n)!)
  }

  baseline(at: number, snapshot?: SnapshotRef): Step {
    const step: Step = { n: 0, id: 'baseline', turn: this.turn, branch: 'main', parent: 0, tool: 'baseline', kind: 'baseline', input: {}, startedAt: at, endedAt: at }
    if (snapshot) step.snapshot = snapshot
    this.put(step)
    this.emit(step)
    return step
  }

  startTurn(at: number, text: string, keepHead = false): TurnRec {
    this.turn += 1
    const rec: TurnRec = { n: this.turn, at, prompt: { chars: text.length, hash: contentHash(text) } }
    if (keepHead) rec.prompt.head = text.slice(0, 200)
    this.turns.push(rec)
    this.out.push({ type: 'turn', ...rec })
    this.version += 1
    return rec
  }

  begin(a: BeginArgs): Step {
    const step: Step = {
      n: this.nextN,
      id: a.id,
      turn: this.turn,
      branch: this.branch,
      parent: this.head(this.branch),
      tool: a.tool,
      kind: a.kind ?? 'tool',
      input: a.input ?? {},
      startedAt: a.at,
    }
    this.nextN += 1
    if (a.agentId !== undefined) step.agentId = a.agentId
    if (a.inputLossy) step.inputLossy = true
    if (a.target !== undefined) step.target = a.target
    if (a.rerunOf !== undefined) step.rerunOf = a.rerunOf
    this.put(step)
    return step
  }

  // The step is complete: written out once, with whatever it gathered.
  finish(step: Step, at: number, extra: { result?: StepResult; snapshot?: SnapshotRef; test?: TestRun } = {}): void {
    step.endedAt = at
    if (extra.result) step.result = extra.result
    if (extra.snapshot) step.snapshot = extra.snapshot
    if (extra.test) step.test = extra.test
    this.emit(step)
  }

  // A restore applied as a step: `commit` has step `to`'s tree, `files` is how the work tree changed
  // (from `from`). On a new branch the step grows from `to`, so its tree equals `to`'s and it changed
  // nothing along the branch's path: the work-tree list is kept in its input, for display only, and the
  // abandoned branch's files never reach causality. On the same branch the files are its changes.
  restoreStep(a: { at: number; to: number; from: string; commit: string; files: readonly FileChange[]; branch?: string }): Step {
    if (a.branch !== undefined) this.fork(a.branch, a.to, a.at)
    const shown = a.files.slice(0, MAX_FILES)
    const onBranch = a.branch !== undefined
    const step = this.begin({ id: `restore-${a.at}`, tool: 'restore', kind: 'restore', input: { to: a.to, from: a.from, ...(onBranch ? { workTree: shown } : {}) }, target: `step ${a.to}`, at: a.at })
    this.finish(step, a.at, { snapshot: { commit: a.commit, changed: a.files.length > 0, files: onBranch ? [] : shown, filesTotal: onBranch ? 0 : a.files.length, ms: 0 } })
    return step
  }

  addModel(rec: ModelRec): void {
    this.models.push(rec)
    this.out.push({ type: 'model', ...rec })
    this.version += 1
  }

  // The newest step on `branch`, else the step the branch grew from.
  head(branch: string): number {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const step = this.steps.get(this.order[i]!)!
      if (step.branch === branch && step.kind !== 'baseline') return step.n
    }
    return this.branches.get(branch)?.fromStep ?? 0
  }

  fork(name: string, fromStep: number, at: number): BranchRec {
    if (this.branches.has(name)) throw new Error(`branch '${name}' already exists`)
    if (!this.steps.has(fromStep)) throw new Error(`no step ${fromStep}`)
    const rec: BranchRec = { name, fromStep, at }
    this.branches.set(name, rec)
    this.branch = name
    this.out.push({ type: 'branch', ...rec })
    this.version += 1
    return rec
  }

  nextBranchName(): string {
    let k = 1
    while (this.branches.has(`b${k}`)) k += 1
    return `b${k}`
  }

  // From the start to the head of `branch` along parents: a branch includes the history it grew from.
  path(branch = this.branch): Step[] {
    const out: Step[] = []
    const seen = new Set<number>()
    let n: number | undefined = this.head(branch)
    while (n !== undefined && !seen.has(n)) {
      seen.add(n)
      const step = this.steps.get(n)
      if (!step) break
      out.push(step)
      n = step.kind === 'baseline' || step.n === step.parent ? undefined : step.parent
    }
    return out.reverse()
  }

  // The nearest step at or before `n`, along its own ancestry, that holds a snapshot.
  snapshotAt(n: number): Step | undefined {
    const seen = new Set<number>()
    let step = this.steps.get(n)
    while (step && !seen.has(step.n)) {
      seen.add(step.n)
      if (step.snapshot) return step
      if (step.kind === 'baseline') return undefined
      step = this.steps.get(step.parent)
    }
    return undefined
  }

  lastSnapshot(branch = this.branch): Step | undefined {
    return this.snapshotAt(this.head(branch))
  }

  // A recorder rebuilt from its own records (a reload); later records of a step replace earlier ones.
  static fromRecords(recs: readonly Rec[]): Recorder | undefined {
    const first = recs.find(r => r.type === 'session')
    if (!first || first.type !== 'session') return undefined
    const { type: _type, ...session } = first
    const r = new Recorder(session)
    r.out = []
    for (const rec of recs) {
      if (rec.type === 'step') {
        const { type: _t, ...step } = rec
        r.put(step)
        r.nextN = Math.max(r.nextN, step.n + 1)
      } else if (rec.type === 'turn') {
        const { type: _t, ...turn } = rec
        r.turns.push(turn)
        r.turn = Math.max(r.turn, turn.n)
      } else if (rec.type === 'model') {
        const { type: _t, ...model } = rec
        r.models.push(model)
      } else if (rec.type === 'branch') {
        const { type: _t, ...branch } = rec
        r.branches.set(branch.name, branch)
        r.branch = branch.name
      }
    }
    r.order.sort((a, b) => a - b)
    return r
  }

  private put(step: Step): void {
    if (!this.steps.has(step.n)) this.order.push(step.n)
    this.steps.set(step.n, step)
    this.version += 1
  }

  private emit(step: Step): void {
    this.out.push({ type: 'step', ...step })
    this.version += 1
  }
}

// Branch refs are files: on a case-insensitive disk `Main` and `main` are one ref.
export function branchTaken(rec: Pick<Recorder, 'branches'>, name: string): boolean {
  const lower = name.toLowerCase()
  return [...rec.branches.keys()].some(b => b.toLowerCase() === lower)
}

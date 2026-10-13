export type FileChange = { status: string; path: string }

// Changed-file lists keep this many entries, plus a total.
export const MAX_FILES = 200

export type SnapshotRef = {
  commit: string
  // False when the tree matched the previous snapshot: `commit` is that snapshot.
  changed: boolean
  // The first 200 changed files; `filesTotal` counts all of them.
  files: FileChange[]
  filesTotal: number
  ms: number
  // Another mutating tool was still running when this snapshot was taken.
  concurrent?: boolean
}

export type TestFailure = { name: string; file?: string; line?: number }

export type TestRun = {
  framework: string
  // Missing in legacy logs or when the full invocation was not observed.
  identity?: { commandHash: string; cwd: string }
  ok: boolean
  passed?: number
  failed?: number
  errors?: number
  skipped?: number
  failures: TestFailure[]
  locations: { file: string; line: number }[]
  // Path-like tokens anywhere in the whole output, for causality.
  paths: string[]
}

export type StepKind = 'baseline' | 'tool' | 'external' | 'restore'

export type StepResult = { isError: boolean; denied: boolean; chars: number; hash: string; head: string }

export type Step = {
  n: number
  id: string
  turn: number
  agentId?: string
  branch: string
  parent: number
  tool: string
  kind: StepKind
  input: Record<string, unknown>
  // The stored input was cut or redacted, so it cannot be replayed from the log alone.
  inputLossy?: boolean
  target?: string
  startedAt: number
  endedAt?: number
  result?: StepResult
  snapshot?: SnapshotRef
  test?: TestRun
  rerunOf?: number
}

export type TurnRec = { n: number; at: number; prompt: { chars: number; hash: string; head?: string } }

export type ModelRec = {
  turn: number
  index: number
  agentId?: string
  model: string
  stopReason: string | null
  usage: unknown
  text: { chars: number; hash: string; body?: string }
  toolUses: { id: string; tool: string }[]
}

export type BranchRec = { name: string; fromStep: number; at: number }

export type SessionRec = { sessionId: string; root: string; startedAt: number; loadId: string }

export type Rec =
  | ({ type: 'session' } & SessionRec)
  | ({ type: 'turn' } & TurnRec)
  | ({ type: 'step' } & Step)
  | ({ type: 'model' } & ModelRec)
  | ({ type: 'branch' } & BranchRec)

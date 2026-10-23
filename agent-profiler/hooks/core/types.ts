export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

export type ToolInputSummary = {
  command?: string
  description?: string
  path?: string
  range?: string
  pattern?: string
  subagentType?: string
}

export type TurnRec = { id: string; ctx: string; start: number; end?: number; reason?: string; prompt: string }

export type StepRec = {
  id: string
  ctx: string
  turnId: string
  index: number
  model: string
  effort?: string
  start: number
  firstContent?: number
  thinkFirst?: number
  thinkLast?: number
  outFirst?: number
  end?: number
  usage?: Usage
  stopReason?: string
}

export type PermissionObservation = {
  decision: 'accept' | 'reject'
  source: 'config' | 'hook' | 'user_permanent' | 'user_temporary' | 'user_abort' | 'user_reject' | 'unknown'
  at: number
  classifier?: 'allow' | 'block' | 'no_verdict' | 'unavailable'
}

export type ToolRec = {
  id: string
  ctx: string
  turnId?: string
  tool: string
  input: ToolInputSummary
  start: number
  end?: number
  execMs?: number
  permission?: PermissionObservation
  isError?: boolean
  denied?: boolean
  launchedAgentId?: string
  launchedAsync?: boolean
}

export type AgentRec = { id: string; agentType: string; start: number; end?: number; parentToolId?: string }

export type Snapshot = {
  sessionId: string
  now: number
  turns: TurnRec[]
  steps: StepRec[]
  tools: ToolRec[]
  agents: AgentRec[]
  // Earliest start ever recorded, including spans dropped since.
  started?: number
  // Whole main turns dropped past the span cap, and the requests, tools and agents that went with them.
  droppedTurns: number
  droppedSpans: number
}

export type Outcome = { denied: boolean; isError: boolean; launchedAgentId?: string; launchedAsync?: boolean }

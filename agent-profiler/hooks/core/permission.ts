import type { PermissionObservation, ToolRec } from './types.ts'

const SOURCES = ['config', 'hook', 'user_permanent', 'user_temporary', 'user_abort', 'user_reject'] as const
const CLASSIFIERS = ['allow', 'block', 'no_verdict', 'unavailable'] as const

// Collector rows are observations, not instructions. Keep only fixed enum values and identity.
export function permissionObservation(event: string, attrs: Readonly<Record<string, unknown>>, loggedAt: string): { id: string; permission: PermissionObservation } | undefined {
  if (event !== 'tool_decision') return undefined
  const id = attrs.tool_use_id
  const decision = attrs.decision
  const at = Date.parse(loggedAt)
  if (typeof id !== 'string' || !id || id.length > 256 || (decision !== 'accept' && decision !== 'reject') || !Number.isFinite(at)) return undefined
  const source = SOURCES.find(value => value === attrs.source) ?? 'unknown'
  const classifier = CLASSIFIERS.find(value => value === attrs.classifier_verdict)
  return { id, permission: { decision, source, at, ...(classifier ? { classifier } : {}) } }
}

// A decision timestamp is not a prompt-open timestamp: this prefix also includes earlier checks/hooks.
// Missing execution evidence leaves approval timing unknown, rather than inventing zero milliseconds.
export function toolTiming(tool: ToolRec, now: number) {
  const wall = Math.max(0, (tool.end ?? now) - tool.start)
  const rejected = tool.permission?.decision === 'reject'
  const execKnown = rejected || tool.execMs !== undefined
  const exec = rejected ? 0 : tool.execMs !== undefined ? Math.max(0, Math.min(tool.execMs, wall)) : wall
  const wait = wall - exec
  const permission = tool.permission
  const kind = permission?.source.startsWith('user_') ? 'user' : permission?.source === 'config' && permission.classifier ? 'auto' : undefined
  const approval = permission && kind && execKnown && tool.end !== undefined
    ? Math.max(0, Math.min(wait, permission.at - tool.start)) : undefined
  return { wall, exec, wait, execKnown, approval, kind: approval !== undefined ? kind : undefined, otherWait: wait - (approval ?? 0) }
}

/**
 * Pure badge/derived-state helpers, ported from the legacy
 * src/dashboard/ui/badges.js. No React/DOM — importable under Vitest without
 * a DOM environment. `now` is injectable everywhere time matters so tests
 * stay deterministic.
 */
import type { DerivedState, AgentRow, Job, BreakerStateT, OverrideT } from "./types"
import type { Tone } from "./tone"

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/** 'agent:model' key used by config.overrides and breaker lookups. */
export function agentKey(agent: string, model: string): string {
  return `${agent}:${model}`
}

/** config.overrides is a union (object map, or [] from a hand-edited file) — normalize to a plain map. */
function overridesRecord(state: DerivedState): Record<string, OverrideT> {
  const overrides = state.config?.overrides
  if (!overrides || Array.isArray(overrides)) return {}
  return overrides as Record<string, OverrideT>
}

export function overrideFor(
  state: DerivedState,
  agent: string,
  model: string
): OverrideT | null {
  return overridesRecord(state)[agentKey(agent, model)] ?? null
}

export function breakerFor(
  state: DerivedState,
  agent: string,
  model: string
): BreakerStateT | null {
  const list = state.config?.breakerState ?? []
  return list.find((b) => b.agent === agent && b.model === model) ?? null
}

/** degraded | unavailable | held | breaker open. */
export function isUnhealthy(state: DerivedState, row: AgentRow): boolean {
  if (row.status === "degraded" || row.status === "unavailable") return true
  const override = overrideFor(state, row.agent, row.model)
  if (override && override.hold) return true
  const breaker = breakerFor(state, row.agent, row.model)
  if (breaker && breaker.open) return true
  return false
}

export function unhealthyAgents(state: DerivedState): AgentRow[] {
  return state.agents.filter((row) => isUnhealthy(state, row))
}

export function unhealthyAgentCount(state: DerivedState): number {
  return unhealthyAgents(state).length
}

/** Override keys ('agent:model') with hold === true. */
export function heldPairs(state: DerivedState): string[] {
  const overrides = overridesRecord(state)
  return Object.keys(overrides).filter((key) => overrides[key]?.hold === true)
}

export function openBreakers(state: DerivedState): BreakerStateT[] {
  const list = state.config?.breakerState ?? []
  return list.filter((b) => b.open)
}

export function openBreakerCount(state: DerivedState): number {
  return openBreakers(state).length
}

/** Agents this dashboard process cannot find on its own PATH. */
export function unresolvedAgents(state: DerivedState): string[] {
  const bins = state.config?.process?.resolvedBins ?? {}
  return Object.keys(bins).filter((agent) => bins[agent] === null)
}

export function runningJobs(state: DerivedState): Job[] {
  return state.jobs.filter((j) => j.status === "queued" || j.status === "running")
}

export function runningJobCount(state: DerivedState): number {
  return runningJobs(state).length
}

/** Failed jobs whose updatedAt falls within the last `sinceMs` from `now`. */
export function failedJobsSince(
  state: DerivedState,
  sinceMs: number,
  now: number = Date.now()
): Job[] {
  return state.jobs.filter((j) => {
    if (j.status !== "failed" || !j.updatedAt) return false
    const updatedAtMs = new Date(j.updatedAt).getTime()
    if (Number.isNaN(updatedAtMs)) return false
    const age = now - updatedAtMs
    return age >= 0 && age <= sinceMs
  })
}

export function failedLast24hCount(state: DerivedState, now: number = Date.now()): number {
  return failedJobsSince(state, TWENTY_FOUR_HOURS_MS, now).length
}

/** Events not yet seen in #/timeline (state.lastSeenTimelineTs is the newest seen ts). */
export function unseenTimelineCount(state: DerivedState): number {
  if (!state.lastSeenTimelineTs) return state.events.length
  return state.events.filter((e) => e.ts > state.lastSeenTimelineTs!).length
}

/** Pending proposals + pending learnings — the /approvals nav badge count. */
export function pendingApprovalsCount(state: DerivedState): number {
  const proposals = state.proposals ?? []
  const learnings = state.learnings ?? []
  return (
    proposals.filter((p) => p.status === "pending").length +
    learnings.filter((l) => l.status === "pending").length
  )
}

export type NavBadgeKey =
  | "agents"
  | "jobs"
  | "history"
  | "timeline"
  | "approvals"
  | "config"

export type NavBadgeEntry = { count: number; tone: Tone } | null

/** Sidebar badge counts, keyed by route name. null when count is 0. */
export function navBadges(
  state: DerivedState,
  now: number = Date.now()
): Record<NavBadgeKey, NavBadgeEntry> {
  const counts: Record<NavBadgeKey, { count: number; tone: Tone }> = {
    agents: { count: unhealthyAgentCount(state), tone: "warning" },
    jobs: { count: runningJobCount(state), tone: "running" },
    history: { count: failedLast24hCount(state, now), tone: "destructive" },
    timeline: { count: unseenTimelineCount(state), tone: "muted" },
    approvals: { count: pendingApprovalsCount(state), tone: "warning" },
    config: { count: unresolvedAgents(state).length, tone: "warning" },
  }
  const result = {} as Record<NavBadgeKey, NavBadgeEntry>
  for (const key of Object.keys(counts) as NavBadgeKey[]) {
    result[key] = counts[key].count > 0 ? counts[key] : null
  }
  return result
}

type StatusBadgeSpec = { label: string; tone: Tone; icon: string }

const STATUS_BADGES: Record<string, StatusBadgeSpec> = {
  ready: { label: "Ready", tone: "ready", icon: "check" },
  degraded: { label: "Degraded", tone: "warning", icon: "warn" },
  unavailable: { label: "Unavailable", tone: "destructive", icon: "error" },
  skipped: { label: "Skipped", tone: "muted", icon: "clock" },
  queued: { label: "Queued", tone: "muted", icon: "clock" },
  running: { label: "Running", tone: "running", icon: "play" },
  succeeded: { label: "Succeeded", tone: "ready", icon: "check" },
  failed: { label: "Failed", tone: "destructive", icon: "error" },
  canceled: { label: "Canceled", tone: "muted", icon: "pause" },
  // opencode model policy (Agents view): a user choice, not a failure.
  allowed: { label: "Allowed", tone: "ready", icon: "check" },
  blocked: { label: "Blocked", tone: "muted", icon: "pause" },
}

/** Status badge spec for an AgentStatus or JobStatus value. */
export function statusBadge(status: string | null | undefined): StatusBadgeSpec {
  const known = status ? STATUS_BADGES[status] : undefined
  if (known) return known
  const label = status ? String(status) : "unknown"
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: "muted", icon: "clock" }
}

/** Existing severity mapping from the legacy dashboard (contracts.js), kept 1:1 in meaning. */
export const ERROR_KIND_SEVERITY: Record<string, Tone> = {
  billing: "destructive",
  auth: "destructive",
  model_unavailable: "destructive",
  crash: "destructive",
  worktree_denied: "destructive",
  locked: "destructive",
  unsupported: "destructive",
  quota: "warning",
  canceled: "warning",
  canceled_by_user: "warning",
  timeout: "warning",
  empty: "warning",
  orphaned: "muted",
  not_terminal: "muted",
  no_session: "muted",
}

/** Severity tone for a job errorKind, from ERROR_KIND_SEVERITY. Unknown kinds -> 'warning'. */
export function errorKindSeverity(errorKind: string | null | undefined): Tone {
  if (!errorKind) return "muted"
  return ERROR_KIND_SEVERITY[errorKind] ?? "warning"
}

/** errorKind badge; tone from errorKindSeverity(). */
export function errorBadge(errorKind: string | null | undefined): { label: string; tone: Tone } {
  if (!errorKind) return { label: "—", tone: "muted" }
  return { label: errorKind, tone: errorKindSeverity(errorKind) }
}

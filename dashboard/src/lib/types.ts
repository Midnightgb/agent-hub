/**
 * Types inferred from the shared server contracts (src/schemas.mjs, aliased
 * as @shared). This is the ONLY place that imports zod's `z.infer` over
 * those schemas — everything else in the dashboard imports these type names.
 */
import type { z } from "zod"
import type {
  AgentStatusRow,
  JobRecord,
  HubEvent,
  StateResponse,
  ConfigResponse,
  MetricsResponse,
  MetricsRow,
  QuotaWindow,
  QuotaInfo,
  AgentQuotaRow,
  AgentsQuotaResponse,
  BreakerState,
  Override,
  Proposal,
  ProposalsResponse,
  UnmappedModel,
  CatalogDriftItem,
  Learning,
  LearningInput,
  CloudAccountsResponse,
  CloudAccountRow,
  CloudSourcesResponse,
  CloudSchedulesResponse,
  CloudScheduleRow,
  CloudSessionsResponse,
  CloudSessionRow,
  CloudActivitiesResponse,
  CloudSourceCacheEntry,
  McpToolInfo,
  McpToolsResponse,
  WorkGraphResponse,
  WorkGraphRepo,
  WorkGraphWorktree,
  WorkGraphNode,
  WorkGraphEdge,
  AgysSnapshotResponse,
  AgysProfile,
  AgysBucket,
  DiffStats,
  DiffFileEntry,
  ChangedFilesMismatch,
  DiffStatsResponse,
} from "@shared"

export type AgentRow = z.infer<typeof AgentStatusRow>
export type Job = z.infer<typeof JobRecord>
export type HubEventT = z.infer<typeof HubEvent>
export type StateResponseT = z.infer<typeof StateResponse>
export type ConfigResponseT = z.infer<typeof ConfigResponse>
export type MetricsResponseT = z.infer<typeof MetricsResponse>
export type MetricsRowT = z.infer<typeof MetricsRow>
export type BreakerStateT = z.infer<typeof BreakerState>
export type QuotaWindowT = z.infer<typeof QuotaWindow>
export type QuotaInfoT = z.infer<typeof QuotaInfo>
export type AgentQuotaRowT = z.infer<typeof AgentQuotaRow>
export type AgentsQuotaResponseT = z.infer<typeof AgentsQuotaResponse>
export type OverrideT = z.infer<typeof Override>
export type ProposalT = z.infer<typeof Proposal>
export type ProposalsResponseT = z.infer<typeof ProposalsResponse>
export type UnmappedModelT = z.infer<typeof UnmappedModel>
export type CatalogDriftItemT = z.infer<typeof CatalogDriftItem>
export type LearningT = z.infer<typeof Learning>
export type LearningInputT = z.infer<typeof LearningInput>
export type AgysSnapshotResponseT = z.infer<typeof AgysSnapshotResponse>
export type AgysProfileT = z.infer<typeof AgysProfile>
export type AgysBucketT = z.infer<typeof AgysBucket>
export type AgysModeInput = { mode: "off" | "profile" | "auto"; profile?: string | null }

/** Diff stats (src/diffstats.mjs's output shape) — live for a running write job, persisted for a terminal one. */
export type DiffStatsT = z.infer<typeof DiffStats>
export type DiffFileEntryT = z.infer<typeof DiffFileEntry>
export type ChangedFilesMismatchT = z.infer<typeof ChangedFilesMismatch>
export type DiffStatsResponseT = z.infer<typeof DiffStatsResponse>

/**
 * Cloud view types, inferred from the shared server contracts (@shared ==
 * ../src/schemas.mjs) — the real /api/accounts, /api/sources, /api/schedules
 * and /api/cloud/* response shapes, never hand-redeclared.
 */
export type AccountPolicy = "round_robin" | "least_used" | "priority"

export type CloudAccountsResponseT = z.infer<typeof CloudAccountsResponse>
export type CloudAccount = z.infer<typeof CloudAccountRow>
/** Fields the create/edit forms may send; `id` and server-computed fields are never client-writable. */
export type CloudAccountInput = { label?: string | null; apiKey?: string; dailyLimit?: number; concurrentLimit?: number }
export type CloudAccountPatch = Partial<Pick<CloudAccount, "label" | "enabled" | "priority" | "dailyLimit" | "concurrentLimit">> & {
  apiKey?: string
}
export type CloudSourceCacheEntryT = z.infer<typeof CloudSourceCacheEntry>

export type CloudSourcesResponseT = z.infer<typeof CloudSourcesResponse>
export type CloudSource = CloudSourcesResponseT["sources"][number]
export type CloudSourceAccountSummary = CloudSourcesResponseT["accounts"][number]

/**
 * `schedule` on the wire is a permissive passthrough object (src/schemas.mjs)
 * because the server owns validation (src/schedules.mjs); this narrower
 * union is only for building the create/edit form, and every value of it is
 * still a valid `schedule` on the wire.
 */
export type CloudScheduleSpec = { kind: "interval"; everyMinutes: number } | { kind: "daily"; at: string; weekdays: number[] }

export type CloudSchedulesResponseT = z.infer<typeof CloudSchedulesResponse>
export type CloudSchedule = z.infer<typeof CloudScheduleRow>
export type CloudScheduleInput = {
  label?: string | null
  schedule: CloudScheduleSpec
  prompt: string
  source: string
  startingBranch?: string | null
  automationMode?: string | null
  requirePlanApproval?: boolean
  accountId?: string | null
  enabled?: boolean
}
export type CloudSchedulePatch = Partial<Omit<CloudScheduleInput, "schedule">> & { schedule?: CloudScheduleSpec }

export type CloudSessionsResponseT = z.infer<typeof CloudSessionsResponse>
export type CloudSession = z.infer<typeof CloudSessionRow>

export type CloudActivitiesResponseT = z.infer<typeof CloudActivitiesResponse>

/** MCP tools (GET /api/tools, src/index.mjs listMcpTools) — name/title/description per registered tool. */
export type McpToolT = z.infer<typeof McpToolInfo>
export type McpToolsResponseT = z.infer<typeof McpToolsResponse>

/** Minimal shape badges.ts needs — a subset of the live query caches. */
export type DerivedState = {
  agents: AgentRow[]
  jobs: Job[]
  events: HubEventT[]
  config: ConfigResponseT | null | undefined
  proposals?: ProposalT[]
  learnings?: LearningT[]
  lastSeenTimelineTs?: string | null
  quota?: AgentQuotaRowT[]
}

export type Connection = "connecting" | "live" | "reconnecting" | "offline"

/**
 * Work graph (GET /api/work-graph, src/workGraph.mjs). The wire types are
 * permissive passthrough objects (one `kind` union, extra fields vary per
 * kind) — these narrower per-kind shapes are what the view/layout code
 * actually reads, and are safe to assume because the server always emits
 * them (see workGraph.mjs's jobPayload/node builders), not re-validated here.
 */
export type WorkGraphResponseT = z.infer<typeof WorkGraphResponse>
export type WorkGraphRepoT = z.infer<typeof WorkGraphRepo>
export type WorkGraphWorktreeT = z.infer<typeof WorkGraphWorktree>
export type WorkGraphNodeT = z.infer<typeof WorkGraphNode>
export type WorkGraphEdgeT = z.infer<typeof WorkGraphEdge>

export type WorkGraphRepoNode = { id: string; kind: "repo"; root: string; mainBranch: string | null }
export type WorkGraphWorktreeNode = {
  id: string
  kind: "worktree"
  repoRoot: string
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  /** True for a job cwd that no longer matches any live worktree (removed after merge) — synthesized, not read from git. */
  removed?: boolean
  /** Display name for a removed worktree (its cwd's basename) — git can no longer tell us a branch for it. */
  label?: string | null
}
export type WorkGraphJobNode = {
  id: string
  kind: "job"
  jobId: string
  agent: string
  model: string
  title: string | null
  status: string
  mode: string
  taskType: string | null
  createdAt: string
  updatedAt: string
  durationS: number | null
  prUrl: string | null
}
export type WorkGraphRemoteBranchNode = {
  id: string
  kind: "remoteBranch"
  source: string | null
  /** Null until the Jules session has actually produced a branch (see `pending`). */
  branch: string | null
  startingBranch: string | null
  prUrl: string | null
  /** True for a placeholder node (no confirmed branch yet): either `from <startingBranch>` or, with `unstarted`, no remote info at all. */
  pending?: boolean
  unstarted?: boolean
  /** Display label for a pending/unstarted node (e.g. "from main", "Unstarted") — branch is null so laneLabel can't derive it. */
  label?: string | null
}
export type WorkGraphOutsideNode = { id: string; kind: "outside" }
export type WorkGraphAnyNode =
  | WorkGraphRepoNode
  | WorkGraphWorktreeNode
  | WorkGraphJobNode
  | WorkGraphRemoteBranchNode
  | WorkGraphOutsideNode

export type ExecutionGraphNodeT = {
  id: string
  jobId: string | null
  agent: string | null
  model: string | null
  status: string | null
  workflow_id: string | null
  step_id: string | null
  attempt: number | null
  parent: string | null
  root: string | null
  relation: string
}


export type ExecutionGraphEdgeT = {
  from: string
  to: string
  relation: string
}

export type ExecutionGraphResponseT = {
  roots: string[]
  nodes: Record<string, ExecutionGraphNodeT>
  edges: ExecutionGraphEdgeT[]
}


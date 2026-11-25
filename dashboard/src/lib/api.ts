/**
 * Typed fetch layer over the dashboard server's JSON API. Every response is
 * parsed with a zod schema from @shared, so a shape drift between server and
 * client fails loudly (as a thrown ApiError) instead of silently rendering
 * `undefined`. Every write sends `Content-Type: application/json` — the
 * server's CSRF guard (dashboard.mjs) requires it on every non-GET request.
 */
import { z } from "zod"
import {
  StateResponse,
  ConfigResponse,
  MetricsResponse,
  Proposal,
  ProposalsResponse,
  Learning,
  LearningInput,
  AgentStatusRow,
  CloudAccountsResponse,
  CloudAccountRow,
  CloudSourcesResponse,
  CloudSchedulesResponse,
  CloudScheduleRow,
  CloudSessionsResponse,
  CloudActivitiesResponse,
  CloudSourceCacheEntry,
  JulesCheckResponse,
  AgentsQuotaResponse,
  WorkGraphResponse,
  McpToolsResponse,
  AgysSnapshotResponse,
  ModelPolicyResponse,
  DiffStatsResponse,
} from "@shared"
import type {
  StateResponseT,
  ConfigResponseT,
  MetricsResponseT,
  AgentsQuotaResponseT,
  AgysSnapshotResponseT,
  ModelPolicyResponseT,
  ProposalT,
  ProposalsResponseT,
  LearningT,
  LearningInputT,
  AgentRow,
  CloudAccount,
  CloudAccountInput,
  CloudAccountPatch,
  CloudAccountsResponseT,
  CloudSourcesResponseT,
  AccountPolicy,
  CloudSchedule,
  CloudScheduleInput,
  CloudSchedulePatch,
  CloudSchedulesResponseT,
  CloudSessionsResponseT,
  CloudActivitiesResponseT,
  CloudSourceCacheEntryT,
  WorkGraphResponseT,
  McpToolsResponseT,
  ExecutionGraphResponseT,
  DiffStatsResponseT,
} from "./types"


export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** GET/POST/DELETE and parse the JSON body with `schema`. Throws ApiError on any non-2xx status. */
export async function fetchJson<S extends z.ZodTypeAny>(
  schema: S,
  url: string,
  init?: RequestInit
): Promise<z.infer<S>> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `request to ${url} failed with status ${response.status}`
    throw new ApiError(message, response.status)
  }

  return schema.parse(body)
}

function writeInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export function getState(): Promise<StateResponseT> {
  return fetchJson(StateResponse, "/api/state")
}

export function getConfig(): Promise<ConfigResponseT> {
  return fetchJson(ConfigResponse, "/api/config")
}

export function getMetrics(): Promise<MetricsResponseT> {
  return fetchJson(MetricsResponse, "/api/metrics")
}

export function getQuota(): Promise<AgentsQuotaResponseT> {
  return fetchJson(AgentsQuotaResponse, "/api/quota")
}

export function getProviders(): Promise<AgysSnapshotResponseT> {
  return fetchJson(AgysSnapshotResponse, "/api/providers")
}

export function setProvidersMode(params: { mode: "off" | "profile" | "auto"; profile?: string | null }): Promise<AgysSnapshotResponseT> {
  return fetchJson(AgysSnapshotResponse, "/api/providers/mode", writeInit("POST", params))
}

export function getProposals(): Promise<ProposalsResponseT> {
  return fetchJson(ProposalsResponse, "/api/proposals")
}

export function refreshProposals(): Promise<ProposalsResponseT> {
  return fetchJson(ProposalsResponse, "/api/proposals/refresh", writeInit("POST"))
}

export function decideProposal(id: string, decision: "accept" | "reject"): Promise<ProposalT> {
  return fetchJson(Proposal, `/api/proposals/${encodeURIComponent(id)}/${decision}`, writeInit("POST"))
}

const LearningsPayload = z.object({ learnings: z.array(Learning) })
export function getLearnings(): Promise<{ learnings: LearningT[] }> {
  return fetchJson(LearningsPayload, "/api/learnings")
}

export function decideLearning(id: string, decision: "approve" | "reject"): Promise<LearningT> {
  return fetchJson(Learning, `/api/learnings/${encodeURIComponent(id)}/${decision}`, writeInit("POST"))
}

export function deleteLearning(id: string): Promise<{ deleted: true }> {
  return fetchJson(
    z.object({ deleted: z.literal(true) }),
    `/api/learnings/${encodeURIComponent(id)}`,
    writeInit("DELETE")
  )
}

export function createLearning(input: LearningInputT): Promise<LearningT> {
  const parsed = LearningInput.parse(input)
  return fetchJson(Learning, "/api/learnings", writeInit("POST", parsed))
}

const RefreshAgentsPayload = z.object({ results: z.array(AgentStatusRow) })
export function refreshAgents(params: { agent?: string; model?: string; ping?: boolean }): Promise<{
  results: AgentRow[]
}> {
  return fetchJson(RefreshAgentsPayload, "/api/agents/refresh", writeInit("POST", params))
}

export function refreshDiscovery(): Promise<Record<string, unknown>> {
  return fetchJson(z.record(z.string(), z.unknown()), "/api/discovery/refresh", writeInit("POST"))
}

export function setOverride(params: {
  agent: string
  model: string
  hold?: boolean
  breakerReset?: boolean
  reason?: string
}): Promise<unknown> {
  return fetchJson(z.unknown(), "/api/overrides", writeInit("POST", params))
}

export function getModelPolicy(agent = "opencode"): Promise<ModelPolicyResponseT> {
  return fetchJson(ModelPolicyResponse, `/api/model-policy?agent=${encodeURIComponent(agent)}`)
}

export function setModelDecision(params: { agent: string; model: string; allowed: boolean }): Promise<unknown> {
  return fetchJson(z.unknown(), "/api/model-policy", writeInit("POST", params))
}

export function setModelOrder(params: { agent: string; order: string[] }): Promise<unknown> {
  return fetchJson(z.unknown(), "/api/model-policy/order", writeInit("PUT", params))
}

export function clearOverride(agent: string, model: string): Promise<unknown> {
  return fetchJson(
    z.unknown(),
    `/api/overrides/${encodeURIComponent(agent)}/${encodeURIComponent(model)}`,
    writeInit("DELETE")
  )
}

export function cancelJob(jobId: string): Promise<unknown> {
  return fetchJson(z.unknown(), `/api/jobs/${encodeURIComponent(jobId)}/cancel`, writeInit("POST"))
}

export function getJobDiffStats(jobId: string): Promise<DiffStatsResponseT> {
  return fetchJson(DiffStatsResponse, `/api/jobs/${encodeURIComponent(jobId)}/diff-stats`)
}

export function getAccounts(): Promise<CloudAccountsResponseT> {
  return fetchJson(CloudAccountsResponse, "/api/accounts")
}

export function createAccount(data: CloudAccountInput): Promise<CloudAccount> {
  return fetchJson(CloudAccountRow, "/api/accounts", writeInit("POST", data))
}

export function updateAccount(id: string, data: CloudAccountPatch): Promise<CloudAccount> {
  return fetchJson(CloudAccountRow, `/api/accounts/${encodeURIComponent(id)}`, writeInit("PATCH", data))
}

export function deleteAccount(id: string): Promise<{ deleted: true }> {
  return fetchJson(z.object({ deleted: z.literal(true) }), `/api/accounts/${encodeURIComponent(id)}`, writeInit("DELETE"))
}

export function setAccountPolicy(policy: AccountPolicy): Promise<{ policy: AccountPolicy }> {
  return fetchJson(z.object({ policy: z.enum(["round_robin", "least_used", "priority"]) }), "/api/accounts/policy", writeInit("PUT", { policy }))
}

export function refreshAccountSources(id: string): Promise<CloudSourceCacheEntryT> {
  return fetchJson(CloudSourceCacheEntry, `/api/accounts/${encodeURIComponent(id)}/refresh-sources`, writeInit("POST"))
}

export function getSources(): Promise<CloudSourcesResponseT> {
  return fetchJson(CloudSourcesResponse, "/api/sources")
}

export function getSchedules(): Promise<CloudSchedulesResponseT> {
  return fetchJson(CloudSchedulesResponse, "/api/schedules")
}

export function createSchedule(data: CloudScheduleInput): Promise<CloudSchedule> {
  return fetchJson(CloudScheduleRow, "/api/schedules", writeInit("POST", data))
}

export function updateSchedule(id: string, data: CloudSchedulePatch): Promise<CloudSchedule> {
  return fetchJson(CloudScheduleRow, `/api/schedules/${encodeURIComponent(id)}`, writeInit("PATCH", data))
}

export function deleteSchedule(id: string): Promise<{ deleted: true }> {
  return fetchJson(z.object({ deleted: z.literal(true) }), `/api/schedules/${encodeURIComponent(id)}`, writeInit("DELETE"))
}

export function runScheduleNow(id: string): Promise<CloudSchedule> {
  return fetchJson(CloudScheduleRow, `/api/schedules/${encodeURIComponent(id)}/run-now`, writeInit("POST"))
}

export function getCloudSessions(): Promise<CloudSessionsResponseT> {
  return fetchJson(CloudSessionsResponse, "/api/cloud/sessions")
}

export function checkCloudJob(id: string) {
  return fetchJson(JulesCheckResponse, `/api/cloud/jobs/${encodeURIComponent(id)}/check`, writeInit("POST"))
}

export function getCloudJobActivities(id: string): Promise<CloudActivitiesResponseT> {
  return fetchJson(CloudActivitiesResponse, `/api/cloud/jobs/${encodeURIComponent(id)}/activities`)
}

export function fetchWorkGraph(): Promise<WorkGraphResponseT> {
  return fetchJson(WorkGraphResponse, "/api/work-graph")
}

export function getTools(): Promise<McpToolsResponseT> {
  return fetchJson(McpToolsResponse, "/api/tools")
}

export const ExecutionGraphNode = z
  .object({
    id: z.string(),
    jobId: z.string().nullable().default(null),
    agent: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
    workflow_id: z.string().nullable().default(null),
    step_id: z.string().nullable().default(null),
    attempt: z.number().nullable().default(null),
    parent: z.string().nullable().default(null),
    root: z.string().nullable().default(null),
    relation: z.string().default('delegate'),
  })
  .passthrough()

export const ExecutionGraphEdge = z
  .object({
    from: z.string(),
    to: z.string(),
    relation: z.string().default('delegate'),
  })
  .passthrough()


export const ExecutionGraphResponse = z
  .object({
    roots: z.array(z.string()),
    nodes: z.record(z.string(), ExecutionGraphNode),
    edges: z.array(ExecutionGraphEdge),
  })
  .passthrough()

export function getExecutionGraph(root?: string | null): Promise<ExecutionGraphResponseT> {
  const query = root ? `?root=${encodeURIComponent(root)}` : ''
  return fetchJson(ExecutionGraphResponse, `/api/execution-graph${query}`)
}


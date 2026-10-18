import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { paths } from './config.mjs'
import { initDb } from './storage/index.mjs'
import { reconcileOrphans, listJobs, readResult, responsePath } from './jobstore.mjs'
import { agentsStatusTool, routeTool, knownTaskTypes } from './tools/agents.mjs'
import { delegateTool, jobWaitTool, jobStatusTool, jobResultTool, jobCancelTool, jobReplyTool } from './tools/jobs.mjs'
import { taskAssignTool, taskContinueTool, taskStatusTool, taskCloseTool } from './tools/assignments.mjs'
import { julesDelegateTool, julesSourcesTool, julesCheckTool, julesSessionsTool, julesAccountsTool, julesSchedulesTool, julesInteractTool, julesWait, julesSuperviseTool } from './tools/jules.mjs'
import { computeAttention } from './cloud/check.mjs'
import { agentsQuotaTool } from './tools/agents.mjs'
import { resumeRemoteJobs } from './cloud/runner.mjs'
import { metricsTool, executionGraphTool } from './tools/insights.mjs'
import { planTaskTool, executePlanTool } from './tools/planner.mjs'
import { learningProposeTool } from './tools/learnings.mjs'
import { agentSendMessageTool, agentInboxTool, agentAckTool, agentPeersTool } from './tools/messaging.mjs'
import { scheduleStartupDiscovery, scheduleQuotaWarmup } from './startup.mjs'
import { dispatch } from './dispatch.mjs'
import { recordDispatchOrigin } from './harness/origin.mjs'
import { clientHintForName, getClientHint, setClientHint } from './harness/registry.mjs'
import {
  TASK_TYPES,
  LEARNING_TEXT_MAX,
  AgentStatusRow,
  RouteResult,
  DelegateResponse,
  DispatchResponse,
  JobRecord,
  JobResultResponse,
  VerifyCheckInput,
  MetricsResponse,
  Learning,
  JulesCheckResponse,
  JulesInteractResponse,
  JulesWaitResponse,
  AgentQuotaRow,
  JulesSessionsResponse,
  JulesSourcesResponse,
  JulesAccountsResponse,
  JulesSchedulesResponse,
  JulesSuperviseResponse,
  TaskTurnResponse,
  TaskStatusResponse,
  TaskCloseResponse,
} from './schemas.mjs'

const VERSION = '2.1.0'
const TESTED_VERSIONS = { agy: '1.2.1', opencode: '2.0.18', copilot: '1.0.31', codex: '0.154.0' }

const log = (...args) => console.error('[agent-hub]', ...args)

// structuredContent must always be a plain object (the MCP outputSchema
// contract requires an object at the top level), so a tool whose "natural"
// payload is a bare array (agents_status) or a subset of shared fields
// (job_reply) gets its own small wrapper schema/shape below instead of
// changing the shared schemas.mjs contracts other consumers (the dashboard)
// rely on.
const AgentsStatusResponse = z.object({ agents: z.array(AgentStatusRow) }).passthrough()
const AgentsQuotaResponseWrapper = z.object({ agents: z.array(AgentQuotaRow) }).passthrough()
const LearningProposeResponse = z.object({ learning: Learning, note: z.string() }).passthrough()

const AgentSendMessageResponse = z.object({
  ok: z.boolean(),
  messageId: z.number().optional(),
  status: z.string().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough()

const AgentInboxMessage = z.object({
  id: z.number(),
  from: z.string(),
  kind: z.string(),
  text: z.string(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable().optional(),
  ackAt: z.string().nullable().optional(),
})

const AgentInboxResponse = z.object({
  ok: z.boolean(),
  messages: z.array(AgentInboxMessage).optional(),
  error: z.string().optional(),
}).passthrough()

const AgentAckResponse = z.object({
  ok: z.boolean(),
  acked: z.boolean().optional(),
  ackAt: z.string().optional(),
  error: z.string().optional(),
}).passthrough()

const AgentPeerRow = z.object({
  jobId: z.string(),
  agent: z.string(),
  model: z.string(),
  status: z.string(),
  stepId: z.string().nullable().optional(),
  messagingTurnBoundary: z.boolean(),
  messagingMidRun: z.boolean(),
})

const AgentPeersResponse = z.object({
  ok: z.boolean(),
  peers: z.array(AgentPeerRow).optional(),
  error: z.string().optional(),
}).passthrough()

const ok = (payload, structuredContent) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  ...(structuredContent !== undefined ? { structuredContent } : {}),
})
const fail = (error) => ({
  content: [{ type: 'text', text: `agent-hub error: ${error?.message ?? String(error)}` }],
  isError: true,
})

// `wrap` lets a handler's text payload (kept byte-for-byte backward
// compatible) differ from its structuredContent shape — only agents_status
// (bare array -> {agents}) and learning_propose (already an object) need it;
// every other tool's payload already matches its outputSchema, so `wrap`
// defaults to identity.
// guard() forwards the transport's extra argument (2nd SDK parameter,
// carrying e.g. _meta/sessionId) to handlers that declare it —
// handler(args, extra). Handlers that ignore it keep working unchanged:
// extra JS arguments are simply dropped.
const guard = (handler, wrap = (payload) => payload) => async (args, extra) => {
  try {
    const payload = await handler(args ?? {}, extra)
    return ok(payload, wrap(payload))
  } catch (error) {
    return fail(error)
  }
}

const agentEnum = z.enum(['agy', 'opencode', 'copilot', 'codex'])
const modeEnum = z.enum(['read', 'write'])
const waitModeEnum = z.enum(['none', 'attention', 'terminal'])
const harnessEnum = z.enum(['generic', 'claude-code', 'opencode'])
const jobIdArg = z.string().min(1).describe('A jobId returned by delegate().')
const taskTypeArg = z
  .enum(TASK_TYPES)
  .optional()
  .describe('Pass the same taskType used for route() — it feeds metrics, adaptive timeouts and learnings.')

// Registry mirror of every tool registered in buildServer(): register()
// appends {name, ...def} here, so listMcpTools() returns [{name, title,
// description}] with zero drift and zero MCP connection. Populated as a
// side effect of buildServer() only — importing this module never connects.
const TOOLS = []

/** Pure, side-effect-free snapshot of the registered MCP tools. */
export function listMcpTools() {
  // TOOLS fills as a side effect of buildServer(), which only registers
  // (never connects — connect happens in main()). Lazy-build once so this
  // stays pure to import and connect-free to call; dedupe by name so a
  // process that also boots the real server never reports doubles.
  if (TOOLS.length === 0) buildServer()
  const seen = new Map()
  for (const { name, title, description } of TOOLS) {
    if (!seen.has(name)) seen.set(name, { name, title, description })
  }
  return [...seen.values()]
}

// Latest MCP server built by buildServer(). Stored so getMcpClientHint()
// can read the LIVE handshake (clientInfo.name via getClientVersion())
// once the client connects — the handshake completes after buildServer()
// returns, so reading it there would always see null.
let mcpServerRef = null

/**
 * Harness hint for the connected MCP client ('claude-code' | 'opencode' |
 * null). Prefers the live handshake over the stored value; both are
 * default-only hints for dispatch()'s waitMode — they never override an
 * explicit harness/env/waitMode and never decide anything
 * security-sensitive (see src/harness/registry.mjs).
 */
export function getMcpClientHint() {
  try {
    const info = mcpServerRef?.server?.getClientVersion?.() ?? mcpServerRef?.getClientVersion?.()
    const live = clientHintForName(info?.name)
    if (live) return live
  } catch {
    // fall through to the stored hint
  }
  return getClientHint()
}

/**
 * Capture clientInfo.name from the handshake into the stored hint.
 * Best-effort: unknown clients map to null (generic), never a guess.
 */
export function captureClientHintFromServer(server = mcpServerRef) {
  try {
    const info = server?.server?.getClientVersion?.() ?? server?.getClientVersion?.()
    return setClientHint(clientHintForName(info?.name))
  } catch {
    return null
  }
}

export function buildServer() {
  const server = new McpServer({ name: 'agent-hub', version: VERSION })
  // Remember the server so getMcpClientHint() can read the live handshake
  // (clientInfo.name) once the client connects — see below.
  mcpServerRef = server

  // Single source of truth for the registered MCP tools: every
  // server.registerTool call below goes through this helper, which keeps a
  // parallel {name, ...def} entry so GET /api/tools (and any future
  // consumer) can list {name, title, description} with zero drift and zero
  // MCP connection. Pure data — importing this module must never connect.
  const register = (name, def, handler) => {
    TOOLS.push({ name, ...def })
    return server.registerTool(name, def, handler)
  }

  register(
    'agent_send_message',
    {
      title: 'Send a message to a peer agent',
      description:
        'Send an inter-agent message to a peer mailbox, scoped to a root execution. ' +
        'ACK SEMANTICS: an ACK means the message was deposited into the peer context envelope; ' +
        'it NEVER means the peer read, understood, agreed, or acted on it.',
      inputSchema: {
        to: z.string().min(1).describe('Recipient peer: an agent name or jobId. Wildcards are not supported.'),
        text: z.string().min(1).describe('Message text (truncated to 4000 characters).'),
        kind: z.enum(['notice', 'query', 'response']).optional().describe('Message kind (notice, query, response; default notice).'),
        rootExecutionId: z.string().optional().describe('Root execution ID scoping this conversation. Inferred from recipient jobId if omitted.'),
        from: z.string().optional().describe('Sender identifier (default: orchestrator).'),
        workflowId: z.string().optional().describe('Optional workflow ID scoping the message.'),
      },
      outputSchema: AgentSendMessageResponse,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    guard(({ to, text, kind, rootExecutionId, from, workflowId }) =>
      agentSendMessageTool({ to, text, kind, rootExecutionId, from, workflowId, env: process.env })
    )
  )

  register(
    'agent_inbox',
    {
      title: 'Read agent inbox messages',
      description:
        'Read messages from the agent mailbox, oldest first, and mark returned messages delivered. ' +
        'ACK SEMANTICS: an ACK means the message was deposited into the peer context envelope; ' +
        'it NEVER means the peer read, understood, agreed, or acted on it.',
      inputSchema: {
        to: z.string().optional().describe('Filter messages by recipient agent name or jobId.'),
        rootExecutionId: z.string().optional().describe('Filter messages by root execution ID.'),
        unreadOnly: z.boolean().optional().describe('When true, return only undelivered messages and mark them delivered (default true).'),
      },
      outputSchema: AgentInboxResponse,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    guard(({ to, rootExecutionId, unreadOnly }) =>
      agentInboxTool({ to, rootExecutionId, unreadOnly, env: process.env })
    )
  )

  register(
    'agent_ack',
    {
      title: 'Acknowledge an agent message',
      description:
        'Acknowledge receipt of a message into the context envelope. ' +
        'ACK SEMANTICS: an ACK means the message was deposited into the peer context envelope; ' +
        'it NEVER means the peer read, understood, agreed, or acted on it.',
      inputSchema: {
        messageId: z.number().describe('Message ID to acknowledge.'),
      },
      outputSchema: AgentAckResponse,
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    guard(({ messageId }) =>
      agentAckTool({ messageId, env: process.env })
    )
  )

  register(
    'agent_peers',
    {
      title: 'List peers participating in root execution',
      description:
        'List active peers participating in a root execution, including their messaging capabilities ' +
        '(messagingTurnBoundary, messagingMidRun). ' +
        'ACK SEMANTICS: an ACK means the message was deposited into the peer context envelope; ' +
        'it NEVER means the peer read, understood, agreed, or acted on it.',
      inputSchema: {
        rootExecutionId: z.string().describe('Root execution ID to find peers for.'),
      },
      outputSchema: AgentPeersResponse,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    guard(({ rootExecutionId }) =>
      agentPeersTool({ rootExecutionId, env: process.env })
    )
  )

  register(
    'agents_quota',
    {
      title: 'Agent quota usage',
      description:
        'Quota state of each delegation pair, read from a local CodexBar server: every window that limits it, with used percent ' +
        'and reset time, and exhausted:true when one is used up. This tool waits for a live reading (up to 45s on a cold CodexBar ' +
        'probe) so its data is always fresh; route() and agents_status instead show whatever is already cached (stale:true/cachedAt ' +
        'when it is), and never wait on the network. INFORMATION ONLY for every agent except codex: quota never chooses, skips or ' +
        'reorders any other agent, and route() is unaffected by it for them. codex is the one deliberate exception (triage/' +
        'mechanical-edit only, where it is always a last-resort fallback): route() drops it entirely below 20% remaining and ' +
        'promotes it to position 2 at/above 50% remaining and on pace — see docs/routing.md. Check it before delegating and tell ' +
        'the user when a chosen agent is exhausted, with its reset time; the human decides whether to use it anyway. A null quota ' +
        'carries a reason (CodexBar unreachable, not metered).',
      inputSchema: { refresh: z.boolean().optional().describe('Bypass the 5-minute cache and fetch live.') },
      outputSchema: AgentsQuotaResponseWrapper,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(
      ({ refresh }) => agentsQuotaTool({ refresh: !!refresh, env: process.env }),
      (agents) => ({ agents })
    )
  )

  register(
    'agents_status',
    {
      title: 'Agent CLI health',
      description:
        `Preflight (L0-L2, no ping) every agy/opencode/copilot/codex model in the delegation map. ` +
        `Returns ready|degraded|unavailable with reason, latency, an advisory quota/dataPolicy badge.`,
      inputSchema: { refresh: z.boolean().optional().describe('Bypass the 15-minute cache and re-run the ladder.') },
      outputSchema: AgentsStatusResponse,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(
      ({ refresh }) => agentsStatusTool({ refresh: !!refresh, cwd: process.cwd() }),
      (agents) => ({ agents })
    )
  )

  register(
    'route',
    {
      title: 'Pick an agent+model for a task type',
      description:
        `Look up the delegation map for one task type and return {primary, fallbacks, reason, ranking}, skipping any ` +
        `pair whose cached preflight is unavailable or whose circuit breaker is open. The result includes a ranking ` +
        `array (per candidate: agent, model, score, reasons per dimension); adaptive reorders only when asked. ` +
        `Known task types: ` +
        knownTaskTypes().join(', '),
      inputSchema: {
        taskType: z.enum(knownTaskTypes()),
        mode: modeEnum.optional(),
        includeCatalog: z
          .boolean()
          .optional()
          .describe('Return the full discovered model catalog per CLI instead of a {binPath, version, modelCount, checkedAt, error} summary.'),
        requirements: z
          .array(z.string())
          .optional()
          .describe(
            'Capability keys a candidate must satisfy: read, write, git, github, web, sessionResume, largeContext. A candidate missing one is skipped with a missing_capabilities reason.'
          ),
        preferences: z
          .object({
            quality: z.number().nonnegative().optional(),
            cost: z.number().nonnegative().optional(),
            latency: z.number().nonnegative().optional(),
          })
          .optional()
          .describe(
            'Weights for the ranking; higher means more important. Omitted/zero weights fall back to the defaults (quality .5, cost .2, latency .3).'
          ),
        adaptive: z
          .boolean()
          .optional()
          .describe(
            'When true, reorder primary/fallbacks by the computed ranking. Default false keeps the static chain order; ranking is always returned for transparency.'
          ),
      },
      outputSchema: RouteResult,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ taskType, mode, includeCatalog, requirements, preferences, adaptive }) =>
      routeTool({ taskType, mode, includeCatalog: !!includeCatalog, requirements, preferences, adaptive })
    )
  )

  register(
    'delegate',
    {
      title: 'Delegate a task to an agent CLI (raw escape hatch)',
      description:
        'RAW ESCAPE HATCH: runs exactly the agent and model you name, with no routing, no policy recovery, no circuit ' +
        'breakers, no dispatch-key idempotency and no execution lineage. Most callers want dispatch(), which adds all of ' +
        'those around the same task. Use delegate() only when you must pin one exact pair and handle failures yourself. ' +
        'Returns {jobId, status:"queued"} immediately and never waits; ' +
        'poll with job_wait or job_status, read with job_result. Write mode requires cwd to be a secondary ' +
        '`git worktree add` checkout. Codex (model "default") has a limited plan quota and is only a LAST fallback, never a primary.',
      inputSchema: {
        agent: agentEnum,
        model: z.string().min(1),
        task: z.string().min(1).describe('The prompt/task text.'),
        cwd: z.string().min(1),
        mode: modeEnum.optional().default('read'),
        timeoutS: z.number().int().positive().optional(),
        title: z.string().optional(),
        variant: z.string().optional().describe('opencode reasoning effort (minimal/low/medium/high/max); ignored by agy/copilot.'),
        taskType: taskTypeArg,
        profile: z.string().optional().describe(
          'agys account to run an agy job on; omit for automatic quota/load-balanced selection. Only meaningful for agent "agy"; rejected for any other agent.'
        ),
        verify: z.array(VerifyCheckInput).optional().describe(
          'Optional hub-run verification checks (argv kind at minimum), run in the foreground in the job cwd once it succeeds — never ask the agent to run tests/builds itself. See docs/verification.md.'
        ),
      },
      outputSchema: DelegateResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    // delegateTool is SYNCHRONOUS (it returns the job record, it does not wait
    // for the job) -- do not reach for .then() here. guard() awaits whatever
    // the handler returns, so a plain object is correct. dispatch() below can
    // use .then() only because it really is async.
    guard(({ agent, model, task, cwd, mode, timeoutS, title, variant, taskType, profile, verify }, extra) => {
      const res = delegateTool({ agent, model, task, cwd, mode, timeoutS, title, variant, taskType, profile, verify })
      // C1.2 origin mapping (best-effort, mapping-only): remember which
      // harness session this job came from for a future wake-up bridge.
      recordDispatchOrigin({ jobId: res?.jobId, extra, harness: null, env: process.env })
      return res
    })
  )

  register(
    'dispatch',
    {
      title: 'Dispatch a task through routing, policy, and reservation',
      description:
        'Route, reserve write lock, and execute a task with automatic policy recovery (retry, fallback). ' +
        'Deduplicates concurrent or recent dispatches with the same dispatchKey. ' +
        'waitMode: "none" returns at create/start (generic default); "attention" also returns on waiting/attention ' +
        '(AWAITING_*/PAUSED, claude-code/opencode default); "terminal" waits for a terminal status only. ' +
        'An explicit waitMode always beats the harness default; the MCP client hint only supplies that default. ' +
        'waiting≠failure — act via jules_interact/job_reply, then observe again.',
      inputSchema: {
        task: z.string().min(1).describe('The prompt/task text.'),
        cwd: z.string().min(1),
        taskType: taskTypeArg.optional(),
        mode: modeEnum.optional().default('read'),
        workflowStep: z.string().optional().describe('Workflow step identifier used in key derivation.'),
        dispatchKey: z.string().optional().describe('Explicit idempotency key. Defaults to sha256(task+cwd+taskType+workflowStep).'),
        attempt: z.number().int().positive().optional().default(1),
        parentExecutionId: z.string().optional(),
        rootExecutionId: z.string().optional(),
        timeoutS: z.number().int().positive().optional(),
        waitMode: waitModeEnum.optional().describe('none: return at create/start; attention: also return on waiting/attention; terminal: terminal status only. Defaults to the harness profile.'),
        harness: harnessEnum.optional().describe('Explicit harness profile; beats AGENT_HUB_HARNESS env and the MCP client hint.'),
        profile: z.string().optional().describe(
          'agys account to run an agy job on; omit for automatic quota/load-balanced selection. Only meaningful when the routed candidate is agent "agy"; rejected otherwise.'
        ),
        verify: z.array(VerifyCheckInput).optional().describe(
          'Optional hub-run verification checks (argv kind at minimum), run in the foreground in the job cwd once it succeeds — never ask the agent to run tests/builds itself. See docs/verification.md.'
        ),
      },
      outputSchema: DispatchResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ task, taskType, cwd, mode, workflowStep, dispatchKey, attempt, parentExecutionId, rootExecutionId, timeoutS, waitMode, harness, profile, verify }, extra) =>
      dispatch({ task, taskType, cwd, mode, workflowStep, dispatchKey, attempt, parentExecutionId, rootExecutionId, timeoutS, waitMode, harness, profile, verify, clientHint: getMcpClientHint() }).then((res) => {
        // C1.2 origin mapping (best-effort, mapping-only): remember which
        // harness session this dispatch came from for a future wake-up bridge.
        recordDispatchOrigin({ jobId: res?.job?.jobId ?? res?.jobId, extra, harness: harness ?? null, env: process.env })
        return res
      })
    )
  )

  register(
    'job_wait',
    {
      title: 'Wait for a job to finish',
      description:
        'Poll a job until it reaches a terminal state or timeoutS (max 60s) elapses. ' +
        'A remote (Jules) session waiting for interaction (AWAITING_*/PAUSED) also ends the wait immediately: ' +
        'done+waiting:true with attentionRequired, attentionReason and recommendedAction — then act via jules_interact. ' +
        'waiting≠failure. done+timedOut:true means only the local budget elapsed; the job/session keeps running.',
      inputSchema: { jobId: jobIdArg, timeoutS: z.number().int().positive().max(60).optional().default(30) },
      outputSchema: JobRecord,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ jobId, timeoutS }) => jobWaitTool({ jobId, timeoutS }))
  )

  register(
    'job_status',
    {
      title: 'Read a job status',
      description: 'Current status of one job, without waiting.',
      inputSchema: { jobId: jobIdArg },
      outputSchema: JobRecord,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ jobId }) => jobStatusTool({ jobId }))
  )

  register(
    'job_result',
    {
      title: 'Read a job result (head only)',
      description: 'The first maxLines of a finished job\'s response, plus fullPath for the complete text.',
      inputSchema: {
        jobId: jobIdArg,
        maxLines: z.number().int().positive().max(500).optional().default(20),
        tailLines: z.number().int().min(0).max(200).optional().default(10).describe('Extra lines from the end of the response to include alongside the head.'),
      },
      outputSchema: JobResultResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ jobId, maxLines, tailLines }) => jobResultTool({ jobId, maxLines, tailLines }))
  )

  register(
    'job_cancel',
    {
      title: 'Cancel a running job',
      description: 'Kill a running job\'s whole process group and mark it canceled.',
      inputSchema: { jobId: jobIdArg },
      outputSchema: JobRecord,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard(({ jobId }) => jobCancelTool({ jobId }))
  )

  register(
    'job_reply',
    {
      title: 'Reply to a finished agy/opencode job, resuming its session',
      description:
        'Start a new turn in a terminal job\'s conversation, using its recorded sessionId. agy (--conversation), opencode (-s) ' +
        'and jules (its remote session) support this; copilot returns {status:"failed", errorKind:"unsupported"} without spawning ' +
        'anything. For a jules job this never starts a new local job: it relays message/action to the existing remote session ' +
        '(a RUNNING jules parent is accepted, not just a terminal one). mode defaults to the parent job\'s mode; switching ' +
        'read -> write goes through the same worktree gate + lock as delegate() (not applicable to jules). ' +
        'A parent that is not yet terminal/running (errorKind:"not_terminal") or has no sessionId (errorKind:"no_session") is also rejected.',
      inputSchema: {
        jobId: jobIdArg,
        message: z.string().min(1).optional().describe('The reply/follow-up prompt text. Required for every agent except a jules approve_plan.'),
        mode: modeEnum.optional(),
        timeoutS: z.number().int().positive().optional(),
        title: z.string().optional(),
        taskType: taskTypeArg,
        action: z
          .enum(['message', 'approve_plan'])
          .optional()
          .describe(
            'jules only: which remote call to make. Defaults to approve_plan when the session is AWAITING_PLAN_APPROVAL and no message was given, otherwise message.'
          ),
      },
      outputSchema: DelegateResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ jobId, message, mode, timeoutS, title, taskType, action }) => jobReplyTool({ jobId, message, mode, timeoutS, title, taskType, action }))
  )

  // Task assignments: one plan task kept in one agent's native session across
  // many turns until a human closes it (src/tools/assignments.mjs).
  const assignmentIdArg = z.string().min(1).describe('An assignmentId returned by task_assign().')

  register(
    'task_assign',
    {
      title: 'Assign a plan task to one agent, keeping its session across turns',
      description:
        'Assign ONE plan task to ONE agent and start its first turn. Use this instead of delegate() when the work will ' +
        'need rework or follow-up turns: the agent keeps its native CLI session (agy --conversation, opencode -s, codex ' +
        'exec resume), so later turns do not re-read the codebase. Workflow: assign once; for every follow-up (review ' +
        'findings, corrections, "now execute the plan") call task_continue with the SAME assignmentId — never a new ' +
        'task_assign or delegate — until the human says the task is done; then call task_close. Returns ' +
        '{assignmentId, jobId, status} immediately and never waits; poll with job_wait/job_status on jobId or with ' +
        'task_status. Only agy, opencode and codex (errorKind:"unsupported_agent" otherwise); for Jules use ' +
        'jules_delegate + jules_interact. Write mode requires cwd to be a secondary `git worktree add` checkout.',
      inputSchema: {
        agent: z.enum(['agy', 'opencode', 'codex']),
        model: z.string().min(1),
        title: z.string().min(1).describe('Short human-readable name of the task.'),
        task: z.string().min(1).describe('The task brief; also stored as the assignment brief.'),
        planRef: z.string().optional().describe('Optional pointer to the plan item, e.g. "odd/tasks/x.md#T2".'),
        cwd: z.string().min(1),
        mode: modeEnum.optional().default('read'),
        timeoutS: z.number().int().positive().optional(),
        variant: z.string().optional().describe('opencode reasoning effort (minimal/low/medium/high/max); ignored by agy.'),
        taskType: taskTypeArg,
      },
      outputSchema: TaskTurnResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ agent, model, title, task, planRef, cwd, mode, timeoutS, variant, taskType }, extra) =>
      taskAssignTool({ agent, model, title, task, planRef, cwd, mode, timeoutS, variant, taskType }).then((res) => {
        recordDispatchOrigin({ jobId: res?.jobId, extra, harness: null, env: process.env })
        return res
      })
    )
  )

  register(
    'task_continue',
    {
      title: 'Continue an assigned task in the same agent session',
      description:
        'Send the next message to an assigned task: resumes the native session of the assignment\'s latest turn ' +
        '(no jobId needed) and starts a new turn. Use it for every follow-up until the human closes the task. Refused ' +
        'with errorKind "busy" while the previous turn is still running (wait for it first), "closed" after task_close ' +
        'and "not_found" for an unknown id. When the session cannot be resumed (the last turn recorded no session, or ' +
        'the CLI cannot resume it) the turn is rehydrated instead: a fresh session with the same agent/model/cwd/mode, ' +
        'seeded with the original brief, the tail of the last response and this message; the result then carries ' +
        'rehydrated: true and rehydrationReason ("no_session" | "session_unusable" | "requested"). Returns ' +
        '{jobId, status} immediately; poll with job_wait or task_status. Also returns contextBudget (last observed ' +
        'session occupancy vs the model context window); its warning means the session is getting large: consider ' +
        'rehydrate: true for a compact fresh session, task_close and a fresh assignment, or continue knowing quality ' +
        'may degrade. It never blocks.',
      inputSchema: {
        assignmentId: assignmentIdArg,
        message: z.string().min(1).describe('The follow-up instruction for the agent.'),
        timeoutS: z.number().int().positive().optional(),
        rehydrate: z
          .boolean()
          .optional()
          .describe('Start a compact fresh session (brief + last response + message) instead of resuming the current one.'),
      },
      outputSchema: TaskTurnResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ assignmentId, message, timeoutS, rehydrate }, extra) =>
      taskContinueTool({ assignmentId, message, timeoutS, rehydrate }).then((res) => {
        recordDispatchOrigin({ jobId: res?.jobId, extra, harness: null, env: process.env })
        return res
      })
    )
  )

  register(
    'task_status',
    {
      title: 'Read one assigned task, or list them',
      description:
        'With assignmentId: the assignment (status, turns, headJobId, sessionId, tokensUsed, contextTokens, ' +
        'inFlightJobId) plus summaries of its latest finished turn (headJob) and running turn (inFlightJob), and its ' +
        'contextBudget. Without it: assignments newest ' +
        'first, filtered by status/agent/limit. A finished turn is folded into the assignment whenever this runs.',
      inputSchema: {
        assignmentId: assignmentIdArg.optional(),
        status: z.enum(['active', 'closed']).optional(),
        agent: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      outputSchema: TaskStatusResponse,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    guard(({ assignmentId, status, agent, limit }) => taskStatusTool({ assignmentId, status, agent, limit }))
  )

  register(
    'task_close',
    {
      title: 'Close an assigned task',
      description:
        'Close an assignment ONLY when the human says the task is done: verdict "accepted" (work kept) or "abandoned". ' +
        'Further task_continue calls are refused with "closed". Refused with "busy" while a turn is still running.',
      inputSchema: {
        assignmentId: assignmentIdArg,
        verdict: z.enum(['accepted', 'abandoned']),
        note: z.string().optional(),
      },
      outputSchema: TaskCloseResponse,
      annotations: { readOnlyHint: false },
    },
    guard(({ assignmentId, verdict, note }) => taskCloseTool({ assignmentId, verdict, note }))
  )

  register(
    'jules_delegate',
    {
      title: 'Delegate a task to Jules (Google\'s remote coding agent)',
      description:
        'Start a Jules session. The work runs on GOOGLE\'S OWN SERVERS, not locally — Jules clones the named GitHub source, ' +
        'works in its own sandbox, and the result is a GITHUB PULL REQUEST (or a pushed branch), never a change to this cwd. ' +
        'The Jules API is ALPHA and its shapes may change. Requires JULES_API_KEY in the environment and either cwd (to infer ' +
        'the source/branch from the git remote) or an explicit source. Returns {jobId, status:"queued"} immediately; poll with ' +
        'job_wait/job_status, read with job_result, and use job_reply to send a message or approve a plan. job_cancel on a jules ' +
        'job ONLY stops this server\'s own polling — Jules exposes no cancel endpoint, so the remote session keeps running. ' +
        'The session keeps running even when THIS machine is off, so polling is never the only way to learn the outcome: pick the ' +
        'session up later with jules_check (which reads the Jules API live and finalizes the local job), or jules_sessions first to ' +
        'find a session this machine has no record of.',
      inputSchema: {
        task: z.string().min(1).describe('The prompt/task text.'),
        cwd: z.string().min(1).optional().describe('Local checkout used to infer source/startingBranch from the git remote. Optional if source is given.'),
        source: z.string().min(1).optional().describe('An explicit Jules source name, e.g. "sources/github/acme/widgets" (see jules_sources). Wins over cwd inference.'),
        startingBranch: z.string().min(1).optional().describe('Branch Jules starts from. Defaults to the branch inferred from cwd, if any.'),
        title: z.string().optional(),
        requirePlanApproval: z.boolean().optional().default(false).describe('If true, Jules pauses for approval (job_reply action:"approve_plan") before coding.'),
        automationMode: z.string().optional().default('AUTO_CREATE_PR').describe('Jules automationMode, e.g. AUTO_CREATE_PR.'),
        timeoutS: z.number().int().positive().optional(),
        taskType: taskTypeArg,
        account: z.string().min(1).optional().describe('Jules account id to use (see jules_accounts). Defaults to the configured selection policy; falls back to the JULES_API_KEY environment variable when no accounts exist.'),
      },
      outputSchema: DelegateResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ task, cwd, source, startingBranch, title, requirePlanApproval, automationMode, timeoutS, taskType, account }) =>
      julesDelegateTool({ task, cwd, source, startingBranch, title, requirePlanApproval, automationMode, timeoutS, taskType, account })
    )
  )

  register(
    'jules_sources',
    {
      title: 'List GitHub repos connected to the Jules account',
      description:
        'List the GitHub repositories connected to a Jules account. Repos are connected in the Jules web UI (jules.google.com) and ' +
        'cannot be added through this API — use the returned source name with jules_delegate. Pass account to choose a configured ' +
        'account (see jules_accounts); with none configured this reads the JULES_API_KEY environment variable. An account whose /sources call is refused ' +
        'reports noSourceAccess (it has no source access), which is NOT a rejected key.',
      inputSchema: {
        account: z.string().min(1).optional().describe('Jules account id to read (see jules_accounts). Defaults to the highest-priority enabled account, or the JULES_API_KEY environment variable when none are configured.'),
      },
      outputSchema: JulesSourcesResponse,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(({ account }) => julesSourcesTool({ account }))
  )

  register(
    'jules_accounts',
    {
      title: 'List configured Jules accounts',
      description:
        'Read-only view of the configured Jules accounts: masked keys (keyPresent/keyLast4, never the raw key), their rolling-24h and ' +
        'concurrent usage, and the last /sources cache status per account. Accounts are created and edited in the dashboard. Use an id ' +
        'from here as jules_delegate/jules_sources account.',
      inputSchema: {},
      outputSchema: JulesAccountsResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(() => julesAccountsTool({}))
  )

  register(
    'jules_schedules',
    {
      title: 'List recurring Jules tasks',
      description:
        'Read-only view of the recurring Jules tasks owned by the dashboard service: each schedule with its next run and the ' +
        'outcome of the job it started last time. The Jules API has no scheduling, so agent-hub owns recurrence; schedules are ' +
        'created and edited in the dashboard, never here. A schedule whose previous job is still running is skipped (recorded as ' +
        'lastStatus "skipped") rather than piling up a duplicate session against the same repo.',
      inputSchema: {},
      outputSchema: JulesSchedulesResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(() => julesSchedulesTool({}))
  )

  register(
    'jules_check',
    {
      title: 'Check a Jules session live',
      description:
        'Ask the Jules API RIGHT NOW what a session did — one getSession plus one activities read, with NO local poller involved. ' +
        'This is the way to learn the outcome after a reboot or days later, when the MCP server and dashboard that started the ' +
        'session are long gone. Pass jobId to read its remote.sessionId, persist the fresh state/PR url/branch and, when the session ' +
        'is terminal while the job is still "running", finalize that job so job_result returns the real answer and the PR link. ' +
        'Pass sessionId alone to inspect a session this machine has no record of. Recovery path for a Jules job whose session ' +
        'finished while the machine was off: jules_sessions to find the session, then jules_check to finalize it locally.',
      inputSchema: {
        jobId: z.string().min(1).optional().describe('Local jobId whose remote.sessionId should be checked and, if terminal, finalized.'),
        sessionId: z.string().min(1).optional().describe('A bare Jules session id, for a session this machine has no local job for.'),
      },
      outputSchema: JulesCheckResponse,
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(async ({ jobId, sessionId }) => {
      const check = await julesCheckTool({ jobId, sessionId, enrich: true })
      if (check.attentionRequired !== undefined) return check
      return {
        ...check,
        ...computeAttention({ state: check.state, record: check }),
      }
    })
  )

  register(
    'jules_interact',
    {
      title: 'Interact with a Jules session',
      description:
        'Send a message or approve a plan for an active Jules session. Only action "reply" (requires message) and "approve_plan" ' +
        'are supported. Jules runs remotely on Google infrastructure and does NOT support remote pause, resume, or cancel. ' +
        'Model A: interacting never restarts polling — after this call nothing observes the session until you do ' +
        '(jules_wait/jules_check) or the supervisor owns it. job_wait alone will NOT see post-interaction completion.',
      inputSchema: {
        jobId: z.string().min(1).optional().describe('Local jobId whose remote.sessionId should receive the interaction.'),
        sessionId: z.string().min(1).optional().describe('A bare Jules session id.'),
        action: z.enum(['reply', 'approve_plan']).describe('Interaction action: reply (requires message) or approve_plan.'),
        message: z.string().min(1).optional().describe('The reply message text. Required when action is reply.'),
      },
      outputSchema: JulesInteractResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ jobId, sessionId, action, message }) => julesInteractTool({ jobId, sessionId, action, message }))
  )

  register(
    'jules_wait',
    {
      title: 'Wait locally for a Jules session to need you or finish',
      description:
        'Local orchestration only — the Jules API has no wait endpoint. Polls with a local budget until the session reaches ' +
        'a terminal state (done+terminal) or a waiting state AWAITING_*/PAUSED (done+waiting, with attentionRequired, ' +
        'attentionReason and recommendedAction — then act via jules_interact). Returns done+timedOut:false only when the ' +
        'local budget elapsed while the session keeps working; the remote session is unaffected. ' +
        'jules_interact never restarts observation — after interacting, nothing observes the session until you ' +
        'wait/check again or jules_supervise owns it. jules_supervise holds the watcher lease; a concurrent ' +
        'jules_wait then observes read-only. waiting≠failure. ' +
        'Never a watch daemon: one bounded wait per call; continuous supervision is the future jules_supervise.',
      inputSchema: {
        jobId: z.string().min(1).optional().describe('Local jobId whose remote.sessionId should be watched.'),
        sessionId: z.string().min(1).optional().describe('A bare Jules session id.'),
        timeoutS: z.number().int().positive().max(600).optional().default(30),
        pollIntervalS: z.number().int().positive().max(60).optional(),
      },
      outputSchema: JulesWaitResponse,
      // Observation with local side effects: checkRemoteSession persists the
      // fresh state and may finalize the local job — readOnlyHint:false.
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
    },
    guard(({ jobId, sessionId, timeoutS, pollIntervalS }) =>
      julesWait({ jobId, sessionId, timeoutS, intervalMs: pollIntervalS != null ? pollIntervalS * 1000 : undefined })
    )
  )

  register(
    'jules_sessions',
    {
      title: 'List Jules sessions live from the API',
      description:
        'List the account\'s Jules sessions straight from the Jules API, newest first, WITHOUT any local polling or job history — this is ' +
        'how you find out what a session did while the machine was off or after a reboot. Each row carries the session state, PR ' +
        'url and working branch, plus jobId: the local job that started it, or null when this machine has no record (a reinstall, ' +
        'or a session started elsewhere). Sessions belong to one account, so with several configured this queries every enabled ' +
        'account in parallel and merges the rows (each tagged accountId); pass account to read just one, and accountErrors reports ' +
        'any account whose query failed without failing the call. Recovery path: find the session here, then jules_check to finalize ' +
        'its local job.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().default(20).describe('Maximum number of sessions to return, newest first.'),
        state: z.string().min(1).optional().describe('Only return sessions in this state, e.g. COMPLETED.'),
        account: z.string().min(1).optional().describe('Jules account id to read (see jules_accounts). Defaults to every enabled account that has a key, or the JULES_API_KEY environment variable when none are configured.'),
      },
      outputSchema: JulesSessionsResponse,
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    },
    guard(({ limit, state, account }) => julesSessionsTool({ limit, state, account }))
  )

  register(
    'jules_supervise',
    {
      title: 'Supervise a Jules session with autonomous watch and interaction',
      description:
        'Autonomous watch-and-interact loop for a Jules session. Acquires the watch lease so concurrent ' +
        'watchers observe read-only. Continuously observes the session, auto-approving plans (if enabled) ' +
        'and classifying user feedback through hard gates across 3 levels with evidence (AUTO_REPLY: strict mechanical allowlist; ' +
        'SAFE_CONTINUE: conditional operational blockers; REQUEST_USER: 10 escalation classes), on separate ' +
        'budgets (maxAutoReplies/maxSafeContinues). A PAUSED session is never auto-resumed. ' +
        'Returns with outcome: terminal (completed/failed), attention (needs human decision), paused, ' +
        'timeout, or budget_exhausted (a budget reached).',
      inputSchema: {
        jobId: z.string().min(1).optional().describe('Local jobId whose remote.sessionId should be supervised.'),
        sessionId: z.string().min(1).optional().describe('A bare Jules session id.'),
        autoApprovePlan: z.boolean().optional().default(true).describe('Automatically approve plans when AWAITING_PLAN_APPROVAL.'),
        autoResolveFeedback: z.boolean().optional().default(true).describe('Automatically reply to unambiguous questions when AWAITING_USER_FEEDBACK.'),
        maxAutoReplies: z.number().int().nonnegative().optional().default(2).describe('Maximum number of auto-replies across the session.'),
        maxSafeContinues: z.number().int().nonnegative().optional().default(3).describe('Maximum number of safe continues across the session.'),
        pauseAfterAmbiguity: z.boolean().optional().default(true).describe('Pause and request user attention if feedback cannot be safely auto-resolved.'),
        timeoutS: z.number().int().positive().max(600).optional().default(300).describe('Supervision timeout in seconds.'),
        pollIntervalS: z.number().int().positive().max(60).optional().describe('Poll interval in seconds between checks.'),
      },
      outputSchema: JulesSuperviseResponse,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(({ jobId, sessionId, autoApprovePlan, autoResolveFeedback, maxAutoReplies, maxSafeContinues, pauseAfterAmbiguity, timeoutS, pollIntervalS }) =>
      julesSuperviseTool({
        jobId,
        sessionId,
        autoApprovePlan,
        autoResolveFeedback,
        maxAutoReplies,
        maxSafeContinues,
        pauseAfterAmbiguity,
        timeoutS,
        pollIntervalS,
      })
    )
  )

  register(
    'agents_metrics',
    {
      title: 'Delegation metrics',
      description:
        'Success rate, p50/p95 latency, error kinds, tokens, costUsd, verified, quality, revisions and retries per agent/model/mode/taskType from job history.',
      inputSchema: {
        groupBy: z
          .array(z.enum(['agent', 'model', 'mode', 'taskType']))
          .optional()
          .describe('Dimensions to group by. Default: agent, model, mode, taskType.'),
      },
      outputSchema: MetricsResponse,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ groupBy }) => metricsTool({ groupBy }))
  )

  register(
    'execution_graph',
    {
      title: 'Execution graph',
      description:
        'Read-only lineage of agent executions: roots, nodes (id, agent, model, status, workflow_id, step_id, attempt, parent, root) ' +
        'and parent->child edges derived from rootExecutionId/parentExecutionId/executionId. The relation label is best-effort ' +
        '(retry when attempt > 1, resume when the session matches the parent, else delegate). Pass rootExecutionId to get one subtree.',
      inputSchema: {
        rootExecutionId: z.string().min(1).optional().describe('Return only the subtree rooted at this execution id.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ rootExecutionId }) => executionGraphTool({ rootExecutionId: rootExecutionId ?? null }))
  )

  register(
    'plan_task',
    {
      title: 'Plan a task',
      description:
        'Validate a WorkflowPlan (goal + steps with roles) and materialize it into a runnable workflow WITHOUT executing anything. ' +
        'Pass the plan object you wrote (the calling orchestrator plans); pass intent only when a planner is configured. ' +
        'Returns { ok, plan, workflow } or the validation errors.',
      inputSchema: {
        plan: z.any().optional().describe('The WorkflowPlan to validate: { goal, steps: [{ id, role, dependsOn?, task?, taskType? }] }.'),
        intent: z.string().min(1).optional().describe('A goal to decompose when a planner is configured.'),
        maxSteps: z.number().int().min(1).max(50).optional().describe('Reject a plan with more steps than this (default 12).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    guard(({ plan, intent, maxSteps }) => planTaskTool({ plan: plan ?? null, intent, maxSteps }))
  )

  register(
    'execute_plan',
    {
      title: 'Execute a plan',
      description:
        'Validate a WorkflowPlan, materialize it and run it. REQUIRES approve:true — review the plan first (plan_task). ' +
        'Never executes an invalid plan and never partially executes.',
      inputSchema: {
        plan: z.any().describe('The WorkflowPlan to execute.'),
        approve: z.boolean().describe('Must be true; confirms the plan was reviewed.'),
      },
    },
    guard(({ plan, approve }) => executePlanTool({ plan, approve }))
  )

  register(
    'learning_propose',
    {
      title: 'Propose a learning',
      description:
        'Record a gotcha about an agent/model/task type (e.g. "X hangs on long prompts"). Stored as pending until a human ' +
        'approves it in the dashboard; approved learnings are prepended to future prompts for a matching agent/model/taskType.',
      inputSchema: {
        text: z.string().trim().min(1).max(LEARNING_TEXT_MAX).describe('The gotcha, short and specific.'),
        agent: z.string().min(1).optional().describe("The CLI or Claude subagent tier this learning is about, e.g. 'agy', 'opencode', 'copilot', 'claude'."),
        model: z.string().min(1).optional(),
        taskType: taskTypeArg,
        sourceJobId: jobIdArg.optional(),
      },
      outputSchema: LearningProposeResponse,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    guard(({ text, agent, model, taskType, sourceJobId }) => learningProposeTool({ text, agent, model, taskType, sourceJobId }))
  )

  server.registerResource(
    'agent-hub-job',
    new ResourceTemplate('agent-hub://jobs/{jobId}', {
      list: async () => ({
        resources: listJobs(process.env)
          .slice(0, 20)
          .map((job) => ({
            uri: `agent-hub://jobs/${job.jobId}`,
            name: job.title || job.jobId,
            mimeType: 'application/json',
          })),
      }),
    }),
    { title: 'Job record', description: 'The full job record (result.json) for one job.', mimeType: 'application/json' },
    async (uri, { jobId }) => {
      let record
      try {
        record = readResult(jobId)
      } catch {
        throw new Error('job not found')
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(record, null, 2) }] }
    }
  )

  server.registerResource(
    'agent-hub-job-response',
    new ResourceTemplate('agent-hub://jobs/{jobId}/response', { list: undefined }),
    { title: 'Job response text', description: 'response.txt for one job, or empty string if it has none yet.', mimeType: 'text/plain' },
    async (uri, { jobId }) => {
      try {
        readResult(jobId) // throws when the job does not exist
      } catch {
        throw new Error('job not found')
      }
      let text = ''
      try {
        text = fs.readFileSync(responsePath(jobId), 'utf8')
      } catch {
        // queued/running job, or a job whose CLI never produced response text
      }
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] }
    }
  )

  const promptArgsSchema = {
    goal: z.string().describe('What the orchestrator is trying to accomplish.'),
    cwd: z.string().describe('Absolute working directory / worktree path for the delegated work.'),
    files: z.string().optional().describe('Relevant file(s)/path(s), if already known.'),
  }

  server.registerPrompt(
    'recon',
    {
      title: 'Recon via agent-hub',
      description: 'Delegate a bounded, read-only recon task off Claude quota.',
      argsSchema: promptArgsSchema,
    },
    ({ goal, cwd, files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\nWorking directory: ${cwd}\n${files ? `Relevant files: ${files}\n` : ''}\n` +
              `Run this recon through agent-hub instead of reading everything yourself:\n` +
              `1) route({taskType:'recon'}) to pick an agent+model.\n` +
              `2) delegate({agent, model, cwd:'${cwd}', mode:'read', taskType:'recon', task:'<bounded question>'}) — ` +
              `pass the SAME taskType ('recon') you gave route(), it feeds metrics, adaptive timeouts and learnings. ` +
              `Shape the task with an explicit output format and a hard line budget, e.g. "List files under src/ ` +
              `that define X. One relative path per line. Max 15 lines."\n` +
              `3) job_wait or job_status({jobId}) until terminal, then job_result({jobId}) for the head of the response.\n` +
              `4) Synthesize what was found; do not restate the raw output.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'adversarial-review',
    {
      title: 'Adversarial review via agent-hub',
      description: 'Get a second, independently-hosted opinion in parallel with a third CLI.',
      argsSchema: promptArgsSchema,
    },
    ({ goal, cwd, files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\nWorking directory: ${cwd}\n${files ? `Relevant files: ${files}\n` : ''}\n` +
              `Run an adversarial review through agent-hub:\n` +
              `1) route({taskType:'adversarial-review'}) — the delegation map's primary for this taskType is agy ` +
              `claude-sonnet-4-6 run in parallel with copilot auto (see the returned chain's parallelWith pair), ` +
              `fallback agy claude-opus-4-6-thinking.\n` +
              `2) delegate({agent, model, cwd:'${cwd}', mode:'read', taskType:'adversarial-review', task:'<the change ` +
              `to review, plus what to check>'}) for BOTH the primary and its parallelWith pair — pass the same ` +
              `taskType ('adversarial-review') to each so metrics/learnings track the pair together. Name the exact ` +
              `output format (numbered findings, file:line evidence) and a line budget in the task text.\n` +
              `3) job_wait/job_status + job_result for each jobId.\n` +
              `4) Synthesize both: flag disagreements explicitly, do not just merge lists silently.`,
          },
        },
      ],
    })
  )

  server.registerPrompt(
    'guided-write',
    {
      title: 'Guided write via agent-hub',
      description: 'Plan -> review -> execute -> delivery-review a non-trivial write, using job_reply to stay in one session.',
      argsSchema: promptArgsSchema,
    },
    ({ goal, cwd, files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Goal: ${goal}\nWorking directory: ${cwd}\n${files ? `Relevant files: ${files}\n` : ''}\n` +
              `Do NOT go straight to a write-mode delegate. Use the guided workflow instead:\n` +
              `1) Plan (read mode): route({taskType:'mechanical-edit'}) then delegate({..., cwd:'${cwd}', mode:'read', ` +
              `taskType:'mechanical-edit', task:'propose a plan for <goal>, do not edit anything'}).\n` +
              `2) Review the plan against the real tree yourself (not just internal consistency). If it needs ` +
              `changes, job_reply({jobId, message:'<numbered feedback>', mode:'read'}) and repeat until it is right.\n` +
              `3) Execute: job_reply({jobId:<last reply's jobId>, message:'execute the approved plan', mode:'write', ` +
              `taskType:'mechanical-edit'}) — the one call allowed to touch the filesystem.\n` +
              `4) Run this project's own required verification commands yourself and read the diff.\n` +
              `5) Delivery review: if anything is off, job_reply({jobId:<execute job's id>, message:'<numbered ` +
              `corrections>', mode:'write'}) in the same conversation, without committing yet. Only stop once it is clean.`,
          },
        },
      ],
    })
  )

  return server
}

function checkCliVersion(name, cmd) {
  try {
    const out = execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
    const tested = TESTED_VERSIONS[name]
    const match = out.includes(tested)
    console.log(`${name.padEnd(10)}: ${out}${match ? '' : `  (WARN: tested against ${tested})`}`)
  } catch (error) {
    console.log(`${name.padEnd(10)}: NOT FOUND (${error.message?.split('\n')[0] ?? error})`)
  }
}

async function selftest() {
  console.log(`agent-hub      : ${VERSION}`)
  console.log(`node           : ${process.version}`)

  const p = paths()
  console.log(`state dir      : ${p.home}`)
  fs.mkdirSync(p.home, { recursive: true })
  const probe = `${p.home}/.selftest-write-probe`
  fs.writeFileSync(probe, 'ok')
  fs.rmSync(probe)
  console.log('state dir write: OK')

  checkCliVersion('agy', 'agy')
  checkCliVersion('opencode', 'opencode')
  checkCliVersion('copilot', 'copilot')
  checkCliVersion('codex', 'codex')

  console.log('\nSelftest passed.')
}

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('agent-hub — MCP server delegating tasks to agy/opencode/copilot.\n\n  --selftest   verify environment and CLI versions\n  --version    print version')
    return
  }
  if (args.includes('--version')) {
    console.log(VERSION)
    return
  }
  if (args.includes('--selftest')) {
    await selftest()
    return
  }

  try {
    initDb()
  } catch (error) {
    log('initDb failed on startup:', error?.message ?? error)
  }

  const changed = reconcileOrphans()
  if (changed.length > 0) log(`reconciled ${changed.length} orphaned job(s) on startup: ${changed.join(', ')}`)

  // Fire-and-forget: resumeRemoteJobs returns synchronously and never throws,
  // so a slow/unreachable Jules API can never block or crash the handshake.
  try {
    const { resumed, failed, unkeyed = [] } = resumeRemoteJobs()
    if (resumed.length > 0 || failed.length > 0) {
      log(`resumed ${resumed.length} remote job(s) on startup; ${failed.length} could not be resumed`)
    }
    // Not an error: those sessions keep running remotely. Say how to pick them
    // up rather than leaving them silently unpolled.
    if (unkeyed.length > 0) {
      log(`${unkeyed.length} remote job(s) still running but no Jules key is configured here — add an account, then jules_check to pick them up`)
    }
  } catch (error) {
    log('resumeRemoteJobs failed:', error?.message ?? error)
  }

  // Fire-and-forget: never awaited, so a slow/missing CLI never delays the
  // stdio handshake below. See src/startup.mjs for the non-blocking wiring.
  scheduleStartupDiscovery()

  // Fire-and-forget, same reasoning: warms the quota cache live so the first
  // cached-mode route()/agents_status of this session isn't stuck reporting
  // every provider `pending`. A cold/unreachable CodexBar can never delay or
  // crash the stdio handshake below.
  scheduleQuotaWarmup()

  // Deliberately NOT startScheduler(): this MCP server is a per-session stdio
  // process, and the dashboard already runs the scheduler as the one
  // long-lived process. Two schedulers would double-fire every schedule.
  const server = buildServer()
  await server.connect(new StdioServerTransport())
  // Best-effort: the handshake may complete after connect() resolves, but
  // getMcpClientHint() also reads it live on every dispatch, so a miss here
  // is harmless — this is just the earliest capture point.
  captureClientHintFromServer(server)
  log(`ready — state dir ${paths().home}`)
}

// Importing this module (e.g. listMcpTools() for GET /api/tools) must be
// side-effect-free: main() runs only when node executes src/index.mjs
// directly (dev convenience) or when the bin/agent-hub dispatcher calls the
// exported main() explicitly (it must — a bare import.meta.url comparison
// never fires through the dispatcher, since argv[1] is bin/agent-hub).
export { main }
const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    log('fatal:', error?.message ?? error)
    process.exitCode = 1
  })
}

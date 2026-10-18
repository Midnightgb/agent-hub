/**
 * task_* MCP tools: one plan task assigned to one agent, continued turn by
 * turn in the same native CLI session until a human closes it.
 *
 * Thin layer over the assignment store (src/assignments.mjs) and the existing
 * job plumbing: the first turn goes through delegateTool, every later turn
 * through jobReplyTool with the assignment's head job as parent. No job
 * lifecycle is forked here.
 *
 * Turn completion is reconciled lazily (reconcileAssignment) from the
 * in-flight job's record whenever status/continue/close runs, so it survives
 * a server restart without a background watcher.
 *
 * task_continue and task_status also report a `contextBudget` (contextBudget):
 * the native session's last observed occupancy against the model's context
 * window, with an advisory warning past a configurable fraction. It replaces
 * job_reply's turn-depth nudge inside an assignment and never blocks a turn.
 *
 * When the native session cannot be resumed (no head job or no sessionId,
 * a reply refused as session-unusable) or the caller asks for it with
 * `rehydrate: true`, task_continue rehydrates: it starts a fresh session
 * through the same delegate path as task_assign, seeded with the brief, the
 * tail of the last response and the new message (buildRehydrationPrompt).
 *
 * Every tool returns `errorKind: null` on success. Refusals return a typed
 * errorKind ('unsupported_agent' | 'not_found' | 'closed' | 'busy' |
 * 'invalid' | 'spawn_failed', or the job's own errorKind)
 * instead of throwing; invalid schema-level input (e.g. an unknown taskType)
 * still throws, like delegate.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { startJob as defaultStartJob } from '../jobrunner.mjs'
import { readResult as defaultReadResult, responsePath } from '../jobstore.mjs'
import { readDiscovery as defaultReadDiscovery } from '../discovery.mjs'
import { assignmentDefaultContextTokens, assignmentContextWarnFraction } from '../config.mjs'
import { readSessionOccupancy } from '../adapters/opencode.mjs'
import { TASK_TYPES } from '../schemas.mjs'
import { delegateTool, jobReplyTool } from './jobs.mjs'
import {
  createAssignment,
  getAssignment,
  listAssignments,
  beginTurn,
  rebindTurn,
  completeTurn,
  abortTurn,
  closeAssignment,
  markRehydrated,
} from '../assignments.mjs'

// Local agents whose CLI can resume a native session (see REPLYABLE_AGENTS in
// ./jobs.mjs). Jules is replyable too, but its remote session already gives
// multi-turn through jules_interact, so it is not assignable here.
export const ASSIGNABLE_AGENTS = Object.freeze(['agy', 'opencode', 'codex'])

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

// jobIds are allocated inside startJob, so a turn is locked with a reservation
// token first and rebound to the real jobId the moment startJob returns.
// startJob returns synchronously, so a reservation older than this can only
// be left over from a crash between beginTurn and the rebind.
const RESERVATION_PREFIX = 'reserve-'
const STALE_RESERVATION_MS = 60_000

function newReservation(now) {
  return `${RESERVATION_PREFIX}${now}-${crypto.randomBytes(4).toString('hex')}`
}

function reservationAgeMs(lock, now) {
  const createdAt = Number(lock.slice(RESERVATION_PREFIX.length).split('-')[0])
  return Number.isFinite(createdAt) ? now - createdAt : Infinity
}

/**
 * Normalize a job record's `tokens` field to one number. agy/opencode report
 * a plain total; codex reports {input, cachedInput, output, reasoning} where
 * cachedInput is part of input and reasoning is part of output.
 */
export function tokenCount(tokens) {
  if (typeof tokens === 'number') return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0
  if (tokens && typeof tokens === 'object') {
    if (Number.isFinite(tokens.total)) return Math.max(0, Math.floor(tokens.total))
    const sum = (Number(tokens.input) || 0) + (Number(tokens.output) || 0)
    return sum > 0 ? Math.floor(sum) : 0
  }
  return 0
}

/**
 * Context occupancy of the native session after one turn, from a job
 * record's `tokens` field, or null when the record has none.
 *
 * A resumed session reprocesses the whole transcript on every turn, so
 * summing per-turn tokens overstates occupancy; the best proxy is the LAST
 * turn's input side. codex reports {input, cachedInput, output, reasoning}
 * where cachedInput is already part of input, so input alone is used.
 * agy (usage.total_tokens) and opencode (input + output + reasoning + cache
 * read/write of the final step) only expose one total, which is used as the
 * occupancy proxy as is. If a CLI sums usage over several model calls inside
 * one turn this overstates occupancy; the budget is advisory and never blocks.
 */
export function contextTokenCount(tokens) {
  const valid = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null)
  if (typeof tokens === 'number') return valid(tokens)
  if (tokens && typeof tokens === 'object') {
    if (tokens.input != null) return valid(Number(tokens.input))
    if (tokens.total != null) return valid(Number(tokens.total))
  }
  return null
}

/** The model's context window from the live CLI catalog (discovery.json), else null. */
function catalogContextWindow(discovery, agent, model) {
  const models = discovery?.[agent]?.models
  const entry = Array.isArray(models) ? models.find((m) => m?.id === model) : null
  const window = Number(entry?.limit?.context)
  return Number.isFinite(window) && window > 0 ? Math.floor(window) : null
}

/**
 * Advisory context budget of an assignment's native session:
 * {contextTokens, contextWindow, fraction, source: 'catalog'|'default', warning?}.
 * The window comes from the live catalog when it lists the model (opencode's
 * `limit.context`), otherwise from the configured default. `warning` is set
 * once `fraction` reaches the configured warn fraction; nothing is blocked
 * or closed automatically.
 */
export function contextBudget(assignment, { env = process.env, readDiscoveryFn = defaultReadDiscovery } = {}) {
  let discovery = {}
  try {
    discovery = readDiscoveryFn(env) ?? {}
  } catch {
    discovery = {}
  }
  const catalogWindow = catalogContextWindow(discovery, assignment.agent, assignment.model)
  const contextWindow = catalogWindow ?? assignmentDefaultContextTokens(env)
  const source = catalogWindow ? 'catalog' : 'default'
  const contextTokens = assignment.contextTokens ?? null
  if (contextTokens == null) return { contextTokens: null, contextWindow, fraction: null, source }

  const raw = contextTokens / contextWindow
  const budget = { contextTokens, contextWindow, fraction: Math.round(raw * 10_000) / 10_000, source }
  if (raw >= assignmentContextWarnFraction(env)) {
    const windowNote = source === 'catalog' ? 'from the live model catalog' : 'a default estimate; the model window is unknown'
    budget.warning =
      `This assignment's session last held about ${contextTokens} tokens, ${Math.round(raw * 100)}% of the ` +
      `${contextWindow}-token context window (${windowNote}). The session is getting large and answer quality may ` +
      'degrade: consider task_continue with rehydrate: true to carry on in a compact fresh session seeded with the ' +
      'brief and the last response, closing it with task_close and assigning a fresh task, or continuing knowing ' +
      'quality may degrade.'
  }
  return budget
}

function readJobOrNull(jobId, readResultFn, env) {
  if (!jobId) return null
  try {
    return readResultFn(jobId, env)
  } catch {
    return null
  }
}

/** A job's final response text (jobstore response.txt), or null when absent. */
function defaultReadResponse(jobId, env) {
  return fs.readFileSync(responsePath(jobId, env), 'utf8')
}

function readResponseOrNull(jobId, readResponseFn, env) {
  if (!jobId) return null
  try {
    return readResponseFn(jobId, env)
  } catch {
    return null
  }
}

/** Upper bound on the previous response carried into a rehydrated session. */
export const REHYDRATION_RESPONSE_MAX_CHARS = 8000

// jobReplyTool refusals meaning the head session itself cannot be resumed.
// Refusals about the request or the turn (invalid, not_terminal) are not.
const SESSION_UNUSABLE_ERROR_KINDS = new Set(['no_session', 'unsupported'])

/**
 * Prompt that starts a fresh session for an assignment whose native session
 * cannot be resumed: the original brief, the tail of the last turn's final
 * response (bounded to `maxChars`, with an explicit marker when cut) and the
 * new message, each in a clearly delimited section. The summary section is
 * omitted when there is no usable previous response. Pure.
 */
export function buildRehydrationPrompt({ assignment, lastResponse, message, maxChars = REHYDRATION_RESPONSE_MAX_CHARS }) {
  const sections = [
    'This task continues in a fresh session: the previous agent session could not be resumed or was replaced to ' +
      'keep the context compact. The original task brief and the final response of the previous session follow; ' +
      'treat them as context, then act on the new message.',
    `=== ORIGINAL TASK BRIEF ===\n${assignment.brief}\n=== END ORIGINAL TASK BRIEF ===`,
  ]
  const previous = typeof lastResponse === 'string' ? lastResponse.trim() : ''
  if (previous) {
    const cut = previous.length > maxChars
    const body = cut ? `[truncated: showing the last ${maxChars} of ${previous.length} characters]\n${previous.slice(-maxChars)}` : previous
    sections.push(`=== PREVIOUS SESSION SUMMARY (final response of the last turn) ===\n${body}\n=== END PREVIOUS SESSION SUMMARY ===`)
  }
  sections.push(`=== NEW MESSAGE ===\n${message}\n=== END NEW MESSAGE ===`)
  return sections.join('\n\n')
}

function jobSummary(job) {
  if (!job) return null
  return {
    jobId: job.jobId,
    status: job.status,
    errorKind: job.errorKind ?? null,
    sessionId: job.sessionId ?? null,
    tokens: tokenCount(job.tokens),
    updatedAt: job.updatedAt ?? null,
  }
}

/**
 * Bring an assignment up to date with its in-flight job. A terminal job
 * completes the turn whatever its outcome (a failed or canceled turn still
 * advances the head, so the human sees the failure and can reply to it); a
 * running job leaves the lock in place; a lock whose job record is missing,
 * or a stale reservation, is released without advancing.
 * Returns the current record, or null when the id is unknown.
 */
export function reconcileAssignment(
  id,
  { env = process.env, readResultFn = defaultReadResult, now = Date.now, readSessionOccupancyFn = readSessionOccupancy } = {},
) {
  const assignment = getAssignment(id, env)
  if (!assignment || assignment.status !== 'active' || !assignment.inFlightJobId) return assignment

  const lock = assignment.inFlightJobId
  if (lock.startsWith(RESERVATION_PREFIX)) {
    if (reservationAgeMs(lock, now()) > STALE_RESERVATION_MS) abortTurn(id, lock, env)
    return getAssignment(id, env)
  }

  const job = readJobOrNull(lock, readResultFn, env)
  if (!job) {
    abortTurn(id, lock, env)
  } else if (TERMINAL_STATUSES.has(job.status)) {
    let contextTokens = contextTokenCount(job.tokens)
    // A resumed opencode turn can finish without a step_finish event, hence
    // without tokens; the session export still knows the real occupancy.
    if (contextTokens == null && assignment.agent === 'opencode' && job.sessionId) {
      try {
        contextTokens = readSessionOccupancyFn(job.sessionId, { env }) ?? null
      } catch {
        contextTokens = null
      }
    }
    completeTurn(id, {
      jobId: lock,
      sessionId: job.sessionId ?? null,
      tokens: tokenCount(job.tokens),
      contextTokens,
    }, env)
  }
  return getAssignment(id, env)
}

function refusal(assignmentId, errorKind, extra = {}) {
  return { assignmentId, jobId: null, status: 'failed', errorKind, ...extra }
}

/** Refusal for a reconciled record that cannot take a new turn, else null. */
function refuseUnlessIdle(assignmentId, assignment) {
  if (!assignment) return refusal(assignmentId, 'not_found')
  if (assignment.status !== 'active') return refusal(assignmentId, 'closed')
  if (assignment.inFlightJobId) return refusal(assignmentId, 'busy', { inFlightJobId: assignment.inFlightJobId })
  return null
}

/**
 * Take the turn lock with a reservation, then run `start(startJobFn)` with a
 * startJobFn that rebinds the lock to the real jobId as soon as it exists.
 * Any failure (throw, or a failed-fast/failed reply) releases the lock.
 * Returns { lockRefusal } | { error } | { result }.
 */
async function runLockedTurn({ assignmentId, startJobFn, env, now, start }) {
  const reservation = newReservation(now())
  const locked = beginTurn(assignmentId, reservation, env)
  if (!locked.ok) return { lockRefusal: locked }

  let holder = reservation
  const startAndRebind = (args) => {
    const out = startJobFn(args)
    const jobId = out?.job?.jobId
    if (jobId && rebindTurn(assignmentId, reservation, jobId, env).ok) holder = jobId
    return out
  }

  try {
    const result = await start(startAndRebind)
    if (result.status === 'failed') abortTurn(assignmentId, holder, env)
    return { result }
  } catch (error) {
    abortTurn(assignmentId, holder, env)
    return { error }
  }
}

/**
 * task_assign: create the assignment and start its first turn through the
 * same path as delegate(). Returns immediately; observe with job_wait on
 * jobId or with task_status.
 */
export async function taskAssignTool({
  agent,
  model,
  title,
  task,
  planRef = null,
  cwd,
  mode = 'read',
  timeoutS,
  variant,
  taskType,
  startJobFn = defaultStartJob,
  env = process.env,
  now = Date.now,
}) {
  if (!ASSIGNABLE_AGENTS.includes(agent)) {
    return refusal(null, 'unsupported_agent', {
      error: `task_assign supports ${ASSIGNABLE_AGENTS.join(', ')} (got "${agent}"); for Jules use jules_delegate and continue the session with jules_interact`,
    })
  }
  if (taskType != null && !TASK_TYPES.includes(taskType)) {
    throw new Error(`unknown taskType: ${taskType}`)
  }

  const assignment = createAssignment({ agent, model, title, brief: task, planRef, cwd, mode }, env)
  const outcome = await runLockedTurn({
    assignmentId: assignment.id,
    startJobFn,
    env,
    now,
    start: (fn) => delegateTool({ agent, model, task, cwd, mode, timeoutS, title, variant, taskType, startJobFn: fn, env }),
  })

  if (outcome.error) {
    return refusal(assignment.id, 'spawn_failed', { error: String(outcome.error?.message ?? outcome.error) })
  }
  const { result } = outcome
  return {
    assignmentId: assignment.id,
    jobId: result.jobId,
    status: result.status,
    errorKind: result.status === 'failed' ? result.errorKind ?? 'spawn_failed' : null,
  }
}

/**
 * task_continue: send the next message into the assignment's native session
 * (the head job's sessionId) through job_reply's core. The caller never
 * passes a jobId. The turn-depth "consider a fresh delegate" warning is not
 * surfaced here: an assignment is meant to stay in one session. Instead the
 * result carries the contextBudget of the session being resumed.
 *
 * Rehydration: when the head has no resumable sessionId ('no_session'),
 * job_reply refuses the session as unusable ('session_unusable'), or the
 * caller passes `rehydrate: true` ('requested'), the turn instead starts a
 * fresh session through delegate with buildRehydrationPrompt, under the same
 * turn lock. Once that job has started the assignment is marked rehydrated
 * (old session and its occupancy dropped); the new job's sessionId becomes
 * the assignment's on reconcile. The result then carries `rehydrated: true`
 * and `rehydrationReason`.
 */
export async function taskContinueTool({
  assignmentId,
  message,
  timeoutS,
  rehydrate = false,
  startJobFn = defaultStartJob,
  readResultFn = defaultReadResult,
  readResponseFn = defaultReadResponse,
  readDiscoveryFn = defaultReadDiscovery,
  jobReplyFn = jobReplyTool,
  env = process.env,
  now = Date.now,
}) {
  if (typeof message !== 'string' || message.trim() === '') {
    return refusal(assignmentId, 'invalid', { error: 'task_continue requires message text' })
  }

  const assignment = reconcileAssignment(assignmentId, { env, readResultFn, now })
  const notIdle = refuseUnlessIdle(assignmentId, assignment)
  if (notIdle) return notIdle

  const head = readJobOrNull(assignment.headJobId, readResultFn, env)
  const upfrontReason = rehydrate === true ? 'requested' : head?.sessionId ? null : 'no_session'

  // A fresh session with the same agent/model/cwd/mode as the assignment;
  // variant and taskType are not stored on the assignment, so they come from
  // the head job record when there is one.
  const rehydrateTurn = async (fn, rehydrationReason) => {
    const task = buildRehydrationPrompt({
      assignment,
      lastResponse: readResponseOrNull(head?.jobId, readResponseFn, env),
      message,
    })
    const started = await delegateTool({
      agent: assignment.agent,
      model: assignment.model,
      task,
      cwd: assignment.cwd,
      mode: assignment.mode ?? 'read',
      timeoutS,
      title: `${assignment.title || assignment.id} (rehydrated)`,
      variant: head?.variant ?? undefined,
      taskType: head?.taskType ?? undefined,
      startJobFn: fn,
      env,
    })
    if (started.status !== 'failed') markRehydrated(assignmentId, {}, env)
    return { ...started, parentJobId: null, turnDepth: 0, rehydrationReason }
  }

  const outcome = await runLockedTurn({
    assignmentId,
    startJobFn,
    env,
    now,
    start: async (fn) => {
      if (upfrontReason) return rehydrateTurn(fn, upfrontReason)
      const reply = await jobReplyFn({ jobId: head.jobId, message, timeoutS, startJobFn: fn, env })
      // Only a refusal that spawned nothing can fall back under the same lock.
      if (reply.status === 'failed' && !reply.jobId && SESSION_UNUSABLE_ERROR_KINDS.has(reply.errorKind)) {
        return rehydrateTurn(fn, 'session_unusable')
      }
      return reply
    },
  })

  if (outcome.lockRefusal) {
    return refusal(assignmentId, outcome.lockRefusal.reason, { inFlightJobId: outcome.lockRefusal.inFlightJobId ?? null })
  }
  if (outcome.error) {
    return refusal(assignmentId, 'spawn_failed', { parentJobId: head?.jobId ?? null, error: String(outcome.error?.message ?? outcome.error) })
  }
  const { result } = outcome
  // A fresh session that failed to start is reported with its reason but
  // rehydrated: false — nothing was recorded on the assignment.
  const rehydration = result.rehydrationReason
    ? { rehydrated: result.status !== 'failed', rehydrationReason: result.rehydrationReason }
    : {}
  const budgetOf = result.rehydrationReason ? getAssignment(assignmentId, env) ?? assignment : assignment
  return {
    assignmentId,
    jobId: result.jobId,
    status: result.status,
    parentJobId: result.rehydrationReason ? result.parentJobId : result.parentJobId ?? head.jobId,
    turnDepth: result.turnDepth,
    errorKind: result.status === 'failed' ? result.errorKind ?? 'spawn_failed' : null,
    contextBudget: contextBudget(budgetOf, { env, readDiscoveryFn }),
    ...rehydration,
    ...(result.error ? { error: result.error } : {}),
  }
}

/**
 * task_status: with assignmentId, the reconciled record plus head and
 * in-flight job summaries and its contextBudget; without it, a newest-first
 * list filtered by status/agent/limit, each active entry reconciled.
 */
export function taskStatusTool({
  assignmentId,
  status,
  agent,
  limit,
  readResultFn = defaultReadResult,
  readDiscoveryFn = defaultReadDiscovery,
  env = process.env,
  now = Date.now,
} = {}) {
  if (assignmentId) {
    const assignment = reconcileAssignment(assignmentId, { env, readResultFn, now })
    if (!assignment) return { assignmentId, errorKind: 'not_found', assignment: null, headJob: null, inFlightJob: null }
    const inFlight = assignment.inFlightJobId?.startsWith(RESERVATION_PREFIX) ? null : assignment.inFlightJobId
    return {
      assignmentId,
      errorKind: null,
      assignment,
      headJob: jobSummary(readJobOrNull(assignment.headJobId, readResultFn, env)),
      inFlightJob: jobSummary(readJobOrNull(inFlight, readResultFn, env)),
      contextBudget: contextBudget(assignment, { env, readDiscoveryFn }),
    }
  }

  const listed = listAssignments({ status, agent, limit }, env)
  const assignments = listed.map((a) =>
    a.status === 'active' && a.inFlightJobId ? reconcileAssignment(a.id, { env, readResultFn, now }) ?? a : a
  )
  return { assignments }
}

/** task_close: human-owned terminal transition, after reconciling the last turn. */
export async function taskCloseTool({
  assignmentId,
  verdict,
  note = null,
  readResultFn = defaultReadResult,
  env = process.env,
  now = Date.now,
}) {
  const assignment = reconcileAssignment(assignmentId, { env, readResultFn, now })
  const notIdle = refuseUnlessIdle(assignmentId, assignment)
  if (notIdle) return { assignmentId, errorKind: notIdle.errorKind, assignment, ...(notIdle.inFlightJobId ? { inFlightJobId: notIdle.inFlightJobId } : {}) }

  const closed = closeAssignment(assignmentId, { verdict, note }, env)
  if (!closed.ok) {
    return { assignmentId, errorKind: closed.reason, assignment: getAssignment(assignmentId, env), ...(closed.inFlightJobId ? { inFlightJobId: closed.inFlightJobId } : {}) }
  }
  return { assignmentId, errorKind: null, assignment: closed.assignment }
}

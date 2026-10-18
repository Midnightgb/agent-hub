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
 * Every tool returns `errorKind: null` on success. Refusals return a typed
 * errorKind ('unsupported_agent' | 'not_found' | 'closed' | 'busy' |
 * 'no_session' | 'invalid' | 'spawn_failed', or the job's own errorKind)
 * instead of throwing; invalid schema-level input (e.g. an unknown taskType)
 * still throws, like delegate.
 */
import crypto from 'node:crypto'
import { startJob as defaultStartJob } from '../jobrunner.mjs'
import { readResult as defaultReadResult } from '../jobstore.mjs'
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

function readJobOrNull(jobId, readResultFn, env) {
  if (!jobId) return null
  try {
    return readResultFn(jobId, env)
  } catch {
    return null
  }
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
export function reconcileAssignment(id, { env = process.env, readResultFn = defaultReadResult, now = Date.now } = {}) {
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
    completeTurn(id, { jobId: lock, sessionId: job.sessionId ?? null, tokens: tokenCount(job.tokens) }, env)
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
 * surfaced here: an assignment is meant to stay in one session.
 */
export async function taskContinueTool({
  assignmentId,
  message,
  timeoutS,
  startJobFn = defaultStartJob,
  readResultFn = defaultReadResult,
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
  if (!head?.sessionId) {
    return refusal(assignmentId, 'no_session', { error: 'the assignment has no head job with a resumable sessionId' })
  }

  const outcome = await runLockedTurn({
    assignmentId,
    startJobFn,
    env,
    now,
    start: (fn) => jobReplyTool({ jobId: head.jobId, message, timeoutS, startJobFn: fn, env }),
  })

  if (outcome.lockRefusal) {
    return refusal(assignmentId, outcome.lockRefusal.reason, { inFlightJobId: outcome.lockRefusal.inFlightJobId ?? null })
  }
  if (outcome.error) {
    return refusal(assignmentId, 'spawn_failed', { parentJobId: head.jobId, error: String(outcome.error?.message ?? outcome.error) })
  }
  const { result } = outcome
  return {
    assignmentId,
    jobId: result.jobId,
    status: result.status,
    parentJobId: result.parentJobId ?? head.jobId,
    turnDepth: result.turnDepth,
    errorKind: result.status === 'failed' ? result.errorKind ?? 'spawn_failed' : null,
    ...(result.error ? { error: result.error } : {}),
  }
}

/**
 * task_status: with assignmentId, the reconciled record plus head and
 * in-flight job summaries; without it, a newest-first list filtered by
 * status/agent/limit, each active entry reconciled.
 */
export function taskStatusTool({
  assignmentId,
  status,
  agent,
  limit,
  readResultFn = defaultReadResult,
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

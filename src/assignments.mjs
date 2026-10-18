/**
 * Assignment store: one plan task assigned to one agent, kept alive across
 * many turns of the same native CLI session until a human closes it.
 *
 * Pure data layer — no job spawning. Callers (the task_* MCP tools) take the
 * turn lock with beginTurn before starting a job and release it with
 * completeTurn or abortTurn when that job ends.
 *
 * Refusals are returned, not thrown: `{ ok: false, reason }` with reason one of
 * 'not_found' | 'closed' | 'busy' | 'lock_mismatch'. Invalid input throws.
 */
import crypto from 'node:crypto'
import {
  getDb,
  insertAssignment,
  getAssignmentRow,
  listAssignmentRows,
  updateAssignmentAtomic,
} from './storage/sqlite.mjs'

export const ASSIGNMENT_STATUSES = Object.freeze(['active', 'closed'])
export const CLOSE_VERDICTS = Object.freeze(['accepted', 'abandoned'])

function newAssignmentId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `asg-${ts}-${crypto.randomBytes(4).toString('hex')}`
}

function nonNegativeInt(value) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`)
  }
  return value
}

function formatAssignment(row) {
  if (!row) return null
  return {
    id: row.id,
    agent: row.agent,
    model: row.model,
    title: row.title,
    brief: row.brief,
    planRef: row.plan_ref,
    cwd: row.cwd,
    mode: row.mode,
    status: row.status,
    headJobId: row.head_job_id,
    sessionId: row.session_id,
    turns: row.turns,
    tokensUsed: row.tokens_used,
    inFlightJobId: row.in_flight_job_id,
    rehydratedAt: row.rehydrated_at,
    closeVerdict: row.close_verdict,
    closeNote: row.close_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  }
}

function toResult(outcome) {
  if (!outcome.ok) return outcome
  return { ok: true, assignment: formatAssignment(outcome.row) }
}

function refuseUnlessActive(row) {
  return row.status === 'active' ? null : { ok: false, reason: 'closed' }
}

function refuseUnlessLockHeldBy(row, jobId) {
  if (row.in_flight_job_id && row.in_flight_job_id === jobId) return null
  return { ok: false, reason: 'lock_mismatch', inFlightJobId: row.in_flight_job_id }
}

export function createAssignment({
  agent,
  model = null,
  title = null,
  brief,
  planRef = null,
  cwd = null,
  mode = null,
  headJobId = null,
  sessionId = null,
} = {}, env = process.env) {
  requireText(agent, 'agent')
  requireText(brief, 'brief')
  const now = new Date().toISOString()
  const row = insertAssignment(getDb(env), {
    id: newAssignmentId(),
    agent,
    model,
    title,
    brief,
    plan_ref: planRef,
    cwd,
    mode,
    status: 'active',
    head_job_id: headJobId,
    session_id: sessionId,
    turns: 0,
    tokens_used: 0,
    in_flight_job_id: null,
    rehydrated_at: null,
    close_verdict: null,
    close_note: null,
    created_at: now,
    updated_at: now,
    closed_at: null,
  })
  return formatAssignment(row)
}

export function getAssignment(id, env = process.env) {
  return formatAssignment(getAssignmentRow(getDb(env), id))
}

/** Newest first. `limit` is ignored unless it is a positive integer. */
export function listAssignments({ status, agent, limit } = {}, env = process.env) {
  if (status && !ASSIGNMENT_STATUSES.includes(status)) {
    throw new Error(`invalid status: ${status}; must be one of ${ASSIGNMENT_STATUSES.join(', ')}`)
  }
  return listAssignmentRows(getDb(env), { status, agent, limit }).map(formatAssignment)
}

/** Take the turn lock for `jobId`. Only one turn may be in flight. */
export function beginTurn(id, jobId, env = process.env) {
  requireText(jobId, 'jobId')
  const now = new Date().toISOString()
  return toResult(updateAssignmentAtomic(getDb(env), id, (row) => {
    const refusal = refuseUnlessActive(row)
    if (refusal) return refusal
    if (row.in_flight_job_id) return { ok: false, reason: 'busy', inFlightJobId: row.in_flight_job_id }
    return { ok: true, patch: { in_flight_job_id: jobId, updated_at: now } }
  }))
}

/**
 * Finish the in-flight turn: release the lock and advance the head job.
 * Only the job holding the lock may complete; anything else is refused
 * with `lock_mismatch` and nothing changes.
 */
export function completeTurn(id, { jobId, sessionId, tokens } = {}, env = process.env) {
  requireText(jobId, 'jobId')
  const now = new Date().toISOString()
  return toResult(updateAssignmentAtomic(getDb(env), id, (row) => {
    const refusal = refuseUnlessLockHeldBy(row, jobId)
    if (refusal) return refusal
    const patch = {
      in_flight_job_id: null,
      head_job_id: jobId,
      turns: row.turns + 1,
      tokens_used: row.tokens_used + nonNegativeInt(tokens),
      updated_at: now,
    }
    if (sessionId) patch.session_id = sessionId
    return { ok: true, patch }
  }))
}

/** Release the turn lock without advancing the assignment (failed/cancelled turn). */
export function abortTurn(id, jobId, env = process.env) {
  requireText(jobId, 'jobId')
  const now = new Date().toISOString()
  return toResult(updateAssignmentAtomic(getDb(env), id, (row) => {
    const refusal = refuseUnlessLockHeldBy(row, jobId)
    if (refusal) return refusal
    return { ok: true, patch: { in_flight_job_id: null, updated_at: now } }
  }))
}

/** Human-owned terminal transition. Refused while a turn is in flight. */
export function closeAssignment(id, { verdict, note = null } = {}, env = process.env) {
  if (!CLOSE_VERDICTS.includes(verdict)) {
    throw new Error(`invalid verdict: ${verdict}; must be one of ${CLOSE_VERDICTS.join(', ')}`)
  }
  const now = new Date().toISOString()
  return toResult(updateAssignmentAtomic(getDb(env), id, (row) => {
    const refusal = refuseUnlessActive(row)
    if (refusal) return refusal
    if (row.in_flight_job_id) return { ok: false, reason: 'busy', inFlightJobId: row.in_flight_job_id }
    return {
      ok: true,
      patch: {
        status: 'closed',
        close_verdict: verdict,
        close_note: note ?? null,
        closed_at: now,
        updated_at: now,
      },
    }
  }))
}

/** Record that the native session was replaced by a rehydrated one. */
export function markRehydrated(id, { sessionId = null } = {}, env = process.env) {
  const now = new Date().toISOString()
  return toResult(updateAssignmentAtomic(getDb(env), id, () => {
    const patch = { rehydrated_at: now, updated_at: now }
    if (sessionId) patch.session_id = sessionId
    return { ok: true, patch }
  }))
}

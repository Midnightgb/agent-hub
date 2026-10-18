import fs from 'node:fs'
import path from 'node:path'
import { stateHome as resolveStateHome, paths } from '../config.mjs'
import { updateJsonLocked, writeJsonAtomic, withJsonLock } from '../fsutil.mjs'

/**
 * Dual-mode storage: better-sqlite3 when available, JSON file fallback.
 *
 * Tables (C0 — workflow tracking + job mirror):
 *   workflows(id TEXT PK, name TEXT, created_at TEXT)
 *   workflow_nodes(workflow_id TEXT, step_id TEXT, PRIMARY KEY(workflow_id,step_id))
 *   jobs(job_id TEXT PK, workflow_id TEXT, step_id TEXT, parent_execution_id TEXT,
 *        root_execution_id TEXT, attempt INTEGER, remote_state TEXT,
 *        quality_score REAL, verified INTEGER, judge_verdict TEXT, result_json TEXT)
 *   leases(job_id TEXT PK, owner TEXT, expires_at TEXT)
 *   assignments(id TEXT PK, agent, brief, status, head_job_id, in_flight_job_id, ...)
 *     — persistent multi-turn task sessions; see src/assignments.mjs
 *
 * The JSON fallback stores everything in a single `storage.json` file under
 * the same stateHome() directory. It's meant for development/testing only —
 * real deployments should install better-sqlite3.
 */

let SqliteDB = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SqliteDB = (await import('better-sqlite3')).default
} catch {
  // better-sqlite3 not installed — fall back to JSON
}

export function _setSqliteDB(val) {
  SqliteDB = val
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function normalizeHome(stateHomeArg) {
  if (typeof stateHomeArg === 'string' && stateHomeArg.length > 0) return stateHomeArg
  return resolveStateHome()
}

/* ------------------------------------------------------------------ */
/*  JSON fallback                                                      */
/* ------------------------------------------------------------------ */

function jsonStoragePath(stateHome) {
  return path.join(stateHome, 'storage.json')
}

function defaultJsonStore() {
  return { workflows: {}, workflow_nodes: {}, jobs: {}, leases: {}, harness_origins: {}, task_handoffs: {}, task_context: [], agent_messages: [], dispatch_reservations: {}, assignments: {} }
}

function readJsonStore(stateHome) {
  const p = jsonStoragePath(stateHome)
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return defaultJsonStore()
  }
}

function writeJsonStore(stateHome, store) {
  // Atomic rename, never a plain write: a concurrent reader must not observe a
  // half-written store. readJsonStore falls back to the EMPTY default on a parse
  // error, so a torn read silently degrades to data loss on the next write.
  writeJsonAtomic(jsonStoragePath(stateHome), store)
}

/**
 * One critical section for a JSON mutation.
 *
 * Every json* mutator below reads, changes and writes the WHOLE store, so
 * without this two concurrent writers (the MCP server and the dashboard, or two
 * CLI processes) each clobber whatever the other just wrote. Never nest with
 * updateJsonLocked on the same file.
 */
function mutateJsonStore(stateHome, fn) {
  return withJsonLock(jsonStoragePath(stateHome), fn)
}

function jsonInitDb(stateHome) {
  ensureDir(stateHome)
  const p = jsonStoragePath(stateHome)
  if (!fs.existsSync(p)) {
    writeJsonStore(stateHome, defaultJsonStore())
  }
}

function normalizeJobRow(row) {
  return {
    job_id: row.job_id,
    workflow_id: row.workflow_id ?? null,
    step_id: row.step_id ?? null,
    parent_execution_id: row.parent_execution_id ?? null,
    root_execution_id: row.root_execution_id ?? null,
    attempt: row.attempt ?? null,
    remote_state: row.remote_state ?? null,
    quality_score: row.quality_score ?? null,
    verified: row.verified === true ? 1 : (row.verified === false ? 0 : (row.verified ?? null)),
    judge_verdict: row.judge_verdict ?? null,
    result_json: typeof row.result_json === 'string' ? row.result_json : JSON.stringify(row.result_json ?? null),
  }
}

function normalizeLeaseRow(row) {
  return {
    job_id: row.job_id,
    owner: row.owner ?? null,
    expires_at: row.expires_at ?? null,
  }
}

function normalizeWorkflowRow(row) {
  const updatedAt = row.updated_at ?? row.updatedAt ?? new Date().toISOString()
  const createdAt = row.created_at ?? row.createdAt ?? new Date().toISOString()
  return {
    id: row.id,
    name: row.name ?? '',
    created_at: createdAt,
    createdAt,
    definition_json: typeof row.definition_json === 'string'
      ? row.definition_json
      : (row.definition ? JSON.stringify(row.definition) : null),
    status: row.status ?? 'pending',
    updated_at: updatedAt,
    updatedAt,
  }
}

function normalizeWorkflowNodeRow(row) {
  const updatedAt = row.updated_at ?? row.updatedAt ?? new Date().toISOString()
  return {
    workflow_id: row.workflow_id,
    step_id: row.step_id,
    status: row.status ?? 'pending',
    attempt: row.attempt ?? 0,
    updated_at: updatedAt,
    updatedAt,
    claimed_by: row.claimed_by ?? row.claimedBy ?? null,
    result_json: typeof row.result_json === 'string'
      ? row.result_json
      : JSON.stringify(row.result_json ?? row.result ?? null),
  }
}

function jsonUpsertJob(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.jobs = store.jobs || {}
  store.jobs[row.job_id] = normalizeJobRow(row)
  writeJsonStore(stateHome, store)
}

function jsonGetJob(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.jobs?.[jobId] ?? null
}

function jsonListJobIds(stateHome) {
  const store = readJsonStore(stateHome)
  return Object.keys(store.jobs || {})
}

function jsonUpsertLease(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.leases = store.leases || {}
  store.leases[row.job_id] = normalizeLeaseRow(row)
  writeJsonStore(stateHome, store)
}

function jsonDeleteLease(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  if (store.leases && store.leases[jobId]) {
    delete store.leases[jobId]
    writeJsonStore(stateHome, store)
  }
}

function jsonGetLease(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.leases?.[jobId] ?? null
}

function jsonUpsertWorkflow(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.workflows = store.workflows || {}
  store.workflows[row.id] = normalizeWorkflowRow(row)
  writeJsonStore(stateHome, store)
}

function jsonGetWorkflow(stateHome, id) {
  const store = readJsonStore(stateHome)
  return store.workflows?.[id] ?? null
}

function jsonUpsertWorkflowNode(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${row.workflow_id}:${row.step_id}`
  store.workflow_nodes[key] = normalizeWorkflowNodeRow(row)
  writeJsonStore(stateHome, store)
}

function jsonGetWorkflowNode(stateHome, workflowId, stepId) {
  const store = readJsonStore(stateHome)
  return store.workflow_nodes?.[`${workflowId}:${stepId}`] ?? null
}

function jsonListWorkflowNodes(stateHome, workflowId) {
  const store = readJsonStore(stateHome)
  const prefix = `${workflowId}:`
  const result = []
  for (const [k, v] of Object.entries(store.workflow_nodes || {})) {
    if (k.startsWith(prefix) || v.workflow_id === workflowId) {
      result.push(v)
    }
  }
  return result
}

function jsonPublishWorkflowNodeReady(stateHome, { workflowId, stepId }) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${workflowId}:${stepId}`
  const existing = store.workflow_nodes[key]
  if (!existing || existing.status !== 'pending') return false
  existing.status = 'ready'
  existing.updated_at = new Date().toISOString()
  existing.updatedAt = existing.updated_at
  writeJsonStore(stateHome, store)
  return true
}
function jsonClaimWorkflowNode(stateHome, { workflowId, stepId, claimedBy, attempt }) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${workflowId}:${stepId}`
  const existing = store.workflow_nodes[key]
  if (!existing) return false
  if (
    (existing.status === 'pending' || existing.status === 'ready') &&
    (!existing.claimed_by || existing.claimed_by === claimedBy)
  ) {
    existing.claimed_by = claimedBy
    existing.status = 'running'
    existing.attempt = attempt ?? (existing.attempt + 1)
    existing.updated_at = new Date().toISOString()
    existing.updatedAt = existing.updated_at
    writeJsonStore(stateHome, store)
    return true
  }
  return false
}

/**
 * C1.2: atomic CAS resume waiting -> running. Only flips a node that is
 * STILL waiting; preserves claimed_by/attempt/result_json so the scheduler
 * that holds the claim keeps it — a resume never steals ownership.
 */
function jsonResumeWorkflowNode(stateHome, { workflowId, stepId }) {
  const store = readJsonStore(stateHome)
  store.workflow_nodes = store.workflow_nodes || {}
  const key = `${workflowId}:${stepId}`
  const existing = store.workflow_nodes[key]
  if (!existing || existing.status !== 'waiting') return false
  existing.status = 'running'
  existing.updated_at = new Date().toISOString()
  existing.updatedAt = existing.updated_at
  writeJsonStore(stateHome, store)
  return true
}

function normalizeHarnessOriginRow(row) {
  return {
    job_id: row.job_id,
    harness_session_id: row.harness_session_id ?? null,
    harness: row.harness ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
  }
}

function jsonUpsertHarnessOrigin(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.harness_origins = store.harness_origins || {}
  const norm = normalizeHarnessOriginRow(row)
  store.harness_origins[norm.job_id] = norm
  writeJsonStore(stateHome, store)
  return norm
}

function jsonGetHarnessOrigin(stateHome, jobId) {
  const store = readJsonStore(stateHome)
  return store.harness_origins?.[jobId] ?? null
}

function normalizeHandoffRow(row) {
  return {
    workflow_id: row.workflow_id,
    step_id: row.step_id,
    handoff_json: typeof row.handoff_json === 'string'
      ? row.handoff_json
      : JSON.stringify(row.handoff_json ?? {}),
    updated_at: row.updated_at ?? new Date().toISOString(),
  }
}

function jsonUpsertHandoff(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.task_handoffs = store.task_handoffs || {}
  const norm = normalizeHandoffRow(row)
  const key = `${norm.workflow_id}:${norm.step_id}`
  store.task_handoffs[key] = norm
  writeJsonStore(stateHome, store)
  return norm
}

function jsonGetHandoff(stateHome, workflowId, stepId) {
  const store = readJsonStore(stateHome)
  return store.task_handoffs?.[`${workflowId}:${stepId}`] ?? null
}

function jsonListHandoffs(stateHome, workflowId) {
  const store = readJsonStore(stateHome)
  const prefix = `${workflowId}:`
  const result = []
  for (const [k, v] of Object.entries(store.task_handoffs || {})) {
    if (k.startsWith(prefix) || v.workflow_id === workflowId) {
      result.push(v)
    }
  }
  return result.sort((a, b) => a.step_id.localeCompare(b.step_id))
}

function normalizeContextRow(row) {
  return {
    workflow_id: row.workflow_id,
    step_id: row.step_id ?? null,
    kind: row.kind,
    text: row.text,
    created_at: row.created_at ?? new Date().toISOString(),
  }
}

function jsonAddContextEntry(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.task_context = store.task_context || []
  const norm = normalizeContextRow(row)
  const maxId = store.task_context.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0)
  const entry = { id: maxId + 1, ...norm }
  store.task_context.push(entry)
  writeJsonStore(stateHome, store)
  return entry
}

/** Statuses a heartbeat must never re-stamp (a terminal row is final). */
const TERMINAL_NODE_STATUSES = Object.freeze(['succeeded', 'failed', 'skipped', 'canceled'])

/**
 * Refresh only the lease timestamp of a node that is still in flight.
 *
 * This is the claim heartbeat: `updated_at` is otherwise written once at claim
 * time, so a job that legitimately runs longer than the lease looks like a dead
 * owner to another scheduler. Only `updated_at` moves — never the status — and
 * never a terminal row, so a heartbeat can never resurrect a node an external
 * actor already finalized.
 */
function jsonTouchWorkflowNode(stateHome, { workflowId, stepId, at }) {
  const key = `${workflowId}:${stepId}`
  let touched = false
  updateJsonLocked(
    jsonStoragePath(stateHome),
    (store) => {
      store.workflow_nodes = store.workflow_nodes || {}
      const existing = store.workflow_nodes[key]
      if (!existing || TERMINAL_NODE_STATUSES.includes(existing.status)) return store
      existing.updated_at = at ?? new Date().toISOString()
      existing.updatedAt = existing.updated_at
      touched = true
      return store
    },
    { defaultValue: defaultJsonStore() }
  )
  return touched
}

/**
 * T1: orphan reclaim as compare-and-set (JSON backend). Same semantics as
 * RECLAIM_ORPHANED_WORKFLOW_NODE_SQL: release to READY only inside one
 * critical section, and only if the row still matches the observed
 * status/owner/updated_at. Uses updateJsonLocked directly (like
 * touchWorkflowNode/reserveDispatchKey) — never nest with mutateJsonStore.
 */
function jsonReclaimOrphanedWorkflowNode(stateHome, { workflowId, stepId, expectedStatus, expectedClaimedBy, expectedUpdatedAt }) {
  const key = `${workflowId}:${stepId}`
  let released = false
  updateJsonLocked(
    jsonStoragePath(stateHome),
    (store) => {
      store.workflow_nodes = store.workflow_nodes || {}
      const existing = store.workflow_nodes[key]
      if (
        !existing ||
        existing.status !== expectedStatus ||
        existing.claimed_by !== expectedClaimedBy ||
        existing.updated_at !== expectedUpdatedAt
      ) {
        return store
      }
      existing.status = 'ready'
      existing.claimed_by = null
      existing.updated_at = new Date().toISOString()
      existing.updatedAt = existing.updated_at
      released = true
      return store
    },
    { defaultValue: defaultJsonStore() }
  )
  return released
}

function jsonListContextEntries(stateHome, workflowId, stepId = null) {
  const store = readJsonStore(stateHome)
  const entries = store.task_context || []
  const filtered = entries.filter((e) => {
    if (e.workflow_id !== workflowId) return false
    if (stepId !== null && stepId !== undefined) {
      return e.step_id === stepId
    }
    return true
  })
  return [...filtered].sort((a, b) => (a.id || 0) - (b.id || 0))
}

function normalizeAgentMessageRow(row) {
  return {
    root_execution_id: row.root_execution_id ?? row.rootExecutionId,
    workflow_id: row.workflow_id ?? row.workflowId ?? null,
    from_agent: row.from_agent ?? row.fromAgent ?? row.from,
    to_agent: row.to_agent ?? row.toAgent ?? row.to,
    kind: row.kind,
    text: row.text,
    created_at: row.created_at ?? row.createdAt ?? new Date().toISOString(),
    delivered_at: row.delivered_at ?? row.deliveredAt ?? null,
    ack_at: row.ack_at ?? row.ackAt ?? null,
  }
}

function jsonInsertAgentMessage(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.agent_messages = store.agent_messages || []
  const norm = normalizeAgentMessageRow(row)
  const maxId = store.agent_messages.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0)
  const entry = { id: row.id != null ? Number(row.id) : maxId + 1, ...norm }
  store.agent_messages.push(entry)
  writeJsonStore(stateHome, store)
  return entry
}

function jsonListAgentMessages(stateHome, { to, rootExecutionId, unreadOnly } = {}) {
  const store = readJsonStore(stateHome)
  const messages = store.agent_messages || []
  const filtered = messages.filter((m) => {
    if (to) {
      if (Array.isArray(to)) {
        if (!to.includes(m.to_agent)) return false
      } else if (m.to_agent !== to) {
        return false
      }
    }
    if (rootExecutionId && m.root_execution_id !== rootExecutionId) return false
    if (unreadOnly && m.delivered_at != null) return false
    return true
  })
  return [...filtered].sort((a, b) => (a.id || 0) - (b.id || 0))
}

function jsonMarkAgentMessageDelivered(stateHome, id, at) {
  const store = readJsonStore(stateHome)
  store.agent_messages = store.agent_messages || []
  const msg = store.agent_messages.find((m) => m.id === Number(id))
  if (!msg) return false
  msg.delivered_at = at ?? new Date().toISOString()
  writeJsonStore(stateHome, store)
  return true
}

function jsonMarkAgentMessageAck(stateHome, id, at) {
  const store = readJsonStore(stateHome)
  store.agent_messages = store.agent_messages || []
  const msg = store.agent_messages.find((m) => m.id === Number(id))
  if (!msg) return false
  msg.ack_at = at ?? new Date().toISOString()
  writeJsonStore(stateHome, store)
  return true
}

function jsonGetAgentMessage(stateHome, id) {
  const store = readJsonStore(stateHome)
  return (store.agent_messages || []).find((m) => m.id === Number(id)) ?? null
}

function normalizeDispatchReservationRow(row) {
  return {
    dispatch_key: row.dispatch_key ?? row.dispatchKey,
    job_id: row.job_id ?? row.jobId ?? null,
    created_at: row.created_at ?? row.createdAt ?? new Date().toISOString(),
  }
}

function jsonReserveDispatchKey(stateHome, { dispatchKey, jobId = null, createdAt = null } = {}) {
  // The lock is what makes this atomic ACROSS processes: a bare
  // read-check-write let every concurrent process observe the key absent and
  // all of them win. The JSON backend is the default, so this is the path that
  // actually matters at runtime.
  let outcome = null
  updateJsonLocked(
    jsonStoragePath(stateHome),
    (store) => {
      store.dispatch_reservations = store.dispatch_reservations || {}
      const existing = store.dispatch_reservations[dispatchKey]
      if (existing) {
        outcome = {
          reserved: false,
          existingJobId: existing.job_id ?? null,
          existingCreatedAt: existing.created_at ?? null,
        }
        return store
      }
      store.dispatch_reservations[dispatchKey] = normalizeDispatchReservationRow({ dispatchKey, jobId, createdAt })
      outcome = { reserved: true, existingJobId: null, existingCreatedAt: null }
      return store
    },
    { defaultValue: defaultJsonStore() }
  )
  return outcome
}

function jsonGetDispatchReservation(stateHome, dispatchKey) {
  const store = readJsonStore(stateHome)
  return store.dispatch_reservations?.[dispatchKey] ?? null
}

function jsonReleaseDispatchReservation(stateHome, dispatchKey, expectedJobId) {
  let removed = false
  updateJsonLocked(
    jsonStoragePath(stateHome),
    (store) => {
      const existing = store.dispatch_reservations?.[dispatchKey]
      if (!existing) return store
      // T2: conditional takeover — only delete a reservation that still
      // belongs to the exact holder we observed. `expectedJobId === undefined`
      // preserves the old unconditional-release callers/tests.
      if (expectedJobId !== undefined && (existing.job_id ?? null) !== (expectedJobId ?? null)) return store
      delete store.dispatch_reservations[dispatchKey]
      removed = true
      return store
    },
    { defaultValue: defaultJsonStore() }
  )
  return removed
}

const ASSIGNMENT_COLUMNS = [
  'id', 'agent', 'model', 'title', 'brief', 'plan_ref', 'cwd', 'mode', 'status',
  'head_job_id', 'session_id', 'turns', 'tokens_used', 'in_flight_job_id',
  'rehydrated_at', 'close_verdict', 'close_note', 'created_at', 'updated_at', 'closed_at',
]

function normalizeAssignmentRow(row) {
  const out = {}
  for (const col of ASSIGNMENT_COLUMNS) out[col] = row[col] ?? null
  out.status = out.status ?? 'active'
  out.turns = Number(out.turns) || 0
  out.tokens_used = Number(out.tokens_used) || 0
  return out
}

/**
 * Newest first. `_seq` breaks created_at ties by insertion order so both
 * backends return the same order for rows created in the same millisecond.
 */
function filterAssignmentRows(rows, { status, agent, limit } = {}) {
  const filtered = rows.filter((r) => (!status || r.status === status) && (!agent || r.agent === agent))
  const ordered = [...filtered].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return (b._seq ?? 0) - (a._seq ?? 0)
  })
  const sliced = Number.isInteger(limit) && limit > 0 ? ordered.slice(0, limit) : ordered
  return sliced.map(normalizeAssignmentRow)
}

function jsonInsertAssignment(stateHome, row) {
  const store = readJsonStore(stateHome)
  store.assignments = store.assignments || {}
  const norm = normalizeAssignmentRow(row)
  if (store.assignments[norm.id]) throw new Error(`assignment already exists: ${norm.id}`)
  const seq = Object.keys(store.assignments).length + 1
  store.assignments[norm.id] = { ...norm, _seq: seq }
  writeJsonStore(stateHome, store)
  return norm
}

function jsonGetAssignment(stateHome, id) {
  const store = readJsonStore(stateHome)
  const row = store.assignments?.[id]
  return row ? normalizeAssignmentRow(row) : null
}

function jsonListAssignments(stateHome, options) {
  const store = readJsonStore(stateHome)
  return filterAssignmentRows(Object.values(store.assignments || {}), options)
}

function jsonUpdateAssignmentAtomic(stateHome, id, mutator) {
  const store = readJsonStore(stateHome)
  const existing = store.assignments?.[id]
  if (!existing) return { ok: false, reason: 'not_found' }
  const current = normalizeAssignmentRow(existing)
  const outcome = mutator(current)
  if (!outcome?.ok) return outcome
  const next = normalizeAssignmentRow({ ...current, ...outcome.patch, id })
  store.assignments[id] = { ...next, _seq: existing._seq }
  writeJsonStore(stateHome, store)
  return { ok: true, row: next }
}

/* ------------------------------------------------------------------ */
/*  better-sqlite3                                                     */
/* ------------------------------------------------------------------ */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT,
  definition_json TEXT,
  status TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  workflow_id TEXT,
  step_id TEXT,
  status TEXT DEFAULT 'pending',
  attempt INTEGER DEFAULT 0,
  updated_at TEXT,
  claimed_by TEXT,
  result_json TEXT,
  PRIMARY KEY(workflow_id, step_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  step_id TEXT,
  parent_execution_id TEXT,
  root_execution_id TEXT,
  attempt INTEGER,
  remote_state TEXT,
  quality_score REAL,
  verified INTEGER,
  judge_verdict TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  job_id TEXT PRIMARY KEY,
  owner TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS harness_origins (
  job_id TEXT PRIMARY KEY,
  harness_session_id TEXT,
  harness TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS task_handoffs (
  workflow_id TEXT,
  step_id TEXT,
  handoff_json TEXT,
  updated_at TEXT,
  PRIMARY KEY(workflow_id, step_id)
);

CREATE TABLE IF NOT EXISTS task_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT,
  step_id TEXT,
  kind TEXT,
  text TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_execution_id TEXT NOT NULL,
  workflow_id TEXT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  ack_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_delivery ON agent_messages (to_agent, root_execution_id, delivered_at);

CREATE TABLE IF NOT EXISTS dispatch_reservations (
  dispatch_key TEXT PRIMARY KEY,
  job_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  model TEXT,
  title TEXT,
  brief TEXT NOT NULL,
  plan_ref TEXT,
  cwd TEXT,
  mode TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  head_job_id TEXT,
  session_id TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  in_flight_job_id TEXT,
  rehydrated_at TEXT,
  close_verdict TEXT,
  close_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignments_status_agent ON assignments (status, agent);
`

const UPSERT_JOB_SQL = `
INSERT INTO jobs (job_id, workflow_id, step_id, parent_execution_id, root_execution_id,
                  attempt, remote_state, quality_score, verified, judge_verdict, result_json)
VALUES (@job_id, @workflow_id, @step_id, @parent_execution_id, @root_execution_id,
        @attempt, @remote_state, @quality_score, @verified, @judge_verdict, @result_json)
ON CONFLICT(job_id) DO UPDATE SET
  workflow_id = @workflow_id,
  step_id = @step_id,
  parent_execution_id = @parent_execution_id,
  root_execution_id = @root_execution_id,
  attempt = @attempt,
  remote_state = @remote_state,
  quality_score = @quality_score,
  verified = @verified,
  judge_verdict = @judge_verdict,
  result_json = @result_json
`

const GET_JOB_SQL = `SELECT * FROM jobs WHERE job_id = ?`
const LIST_JOB_IDS_SQL = `SELECT job_id FROM jobs`

const UPSERT_LEASE_SQL = `
INSERT INTO leases (job_id, owner, expires_at)
VALUES (@job_id, @owner, @expires_at)
ON CONFLICT(job_id) DO UPDATE SET
  owner = @owner,
  expires_at = @expires_at
`

const DELETE_LEASE_SQL = `DELETE FROM leases WHERE job_id = ?`

const GET_LEASE_SQL = `SELECT * FROM leases WHERE job_id = ?`

const UPSERT_WORKFLOW_SQL = `
INSERT INTO workflows (id, name, created_at, definition_json, status, updated_at)
VALUES (@id, @name, @created_at, @definition_json, @status, @updated_at)
ON CONFLICT(id) DO UPDATE SET
  name = @name,
  definition_json = COALESCE(@definition_json, workflows.definition_json),
  status = @status,
  updated_at = @updated_at
`

const GET_WORKFLOW_SQL = `SELECT * FROM workflows WHERE id = ?`

const UPSERT_WORKFLOW_NODE_SQL = `
INSERT INTO workflow_nodes (workflow_id, step_id, status, attempt, updated_at, claimed_by, result_json)
VALUES (@workflow_id, @step_id, @status, @attempt, @updated_at, @claimed_by, @result_json)
ON CONFLICT(workflow_id, step_id) DO UPDATE SET
  status = @status,
  attempt = @attempt,
  updated_at = @updated_at,
  claimed_by = @claimed_by,
  result_json = @result_json
`

const GET_WORKFLOW_NODE_SQL = `SELECT * FROM workflow_nodes WHERE workflow_id = ? AND step_id = ?`

const LIST_WORKFLOW_NODES_SQL = `SELECT * FROM workflow_nodes WHERE workflow_id = ?`

const TOUCH_WORKFLOW_NODE_SQL = `
UPDATE workflow_nodes
SET updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status NOT IN ('succeeded', 'failed', 'skipped', 'canceled')
`

const CLAIM_WORKFLOW_NODE_SQL = `
UPDATE workflow_nodes
SET claimed_by = @claimed_by,
    status = 'running',
    attempt = CASE WHEN @attempt IS NOT NULL THEN @attempt ELSE attempt + 1 END,
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status IN ('pending', 'ready')
  AND (claimed_by IS NULL OR claimed_by = '' OR claimed_by = @claimed_by)
`

/**
 * T1: orphan reclaim as compare-and-set. Releases a node back to READY only
 * if the row still has the exact status/owner/updated_at that justified the
 * reclaim decision. A peer that reclaimed AND re-claimed the node between our
 * read and this write leaves a row that no longer matches, so this is a
 * no-op (changes = 0) instead of clobbering the fresh claim.
 */
const RECLAIM_ORPHANED_WORKFLOW_NODE_SQL = `
UPDATE workflow_nodes
SET status = 'ready',
    claimed_by = NULL,
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status = @expected_status
  AND claimed_by = @expected_claimed_by
  AND updated_at = @expected_updated_at
`

const PUBLISH_READY_SQL = `
UPDATE workflow_nodes
SET status = 'ready',
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status = 'pending'
`

const RESUME_WORKFLOW_NODE_SQL = `
UPDATE workflow_nodes
SET status = 'running',
    updated_at = @updated_at
WHERE workflow_id = @workflow_id
  AND step_id = @step_id
  AND status = 'waiting'
`

const UPSERT_HARNESS_ORIGIN_SQL = `
INSERT INTO harness_origins (job_id, harness_session_id, harness, created_at)
VALUES (@job_id, @harness_session_id, @harness, @created_at)
ON CONFLICT(job_id) DO UPDATE SET
  harness_session_id = @harness_session_id,
  harness = @harness,
  created_at = @created_at
`

const GET_HARNESS_ORIGIN_SQL = `SELECT * FROM harness_origins WHERE job_id = ?`

const UPSERT_HANDOFF_SQL = `
INSERT INTO task_handoffs (workflow_id, step_id, handoff_json, updated_at)
VALUES (@workflow_id, @step_id, @handoff_json, @updated_at)
ON CONFLICT(workflow_id, step_id) DO UPDATE SET
  handoff_json = @handoff_json,
  updated_at = @updated_at
`

const GET_HANDOFF_SQL = `SELECT * FROM task_handoffs WHERE workflow_id = ? AND step_id = ?`

const LIST_HANDOFFS_SQL = `SELECT * FROM task_handoffs WHERE workflow_id = ? ORDER BY step_id ASC`

const ADD_CONTEXT_ENTRY_SQL = `
INSERT INTO task_context (workflow_id, step_id, kind, text, created_at)
VALUES (@workflow_id, @step_id, @kind, @text, @created_at)
`

const LIST_CONTEXT_ENTRIES_SQL = `SELECT * FROM task_context WHERE workflow_id = ? ORDER BY id ASC`

const LIST_CONTEXT_ENTRIES_BY_STEP_SQL = `SELECT * FROM task_context WHERE workflow_id = ? AND step_id = ? ORDER BY id ASC`

const INSERT_AGENT_MESSAGE_SQL = `
INSERT INTO agent_messages (root_execution_id, workflow_id, from_agent, to_agent, kind, text, created_at, delivered_at, ack_at)
VALUES (@root_execution_id, @workflow_id, @from_agent, @to_agent, @kind, @text, @created_at, @delivered_at, @ack_at)
`

const RESERVE_DISPATCH_KEY_SQL = `
INSERT INTO dispatch_reservations (dispatch_key, job_id, created_at)
VALUES (@dispatch_key, @job_id, @created_at)
ON CONFLICT(dispatch_key) DO NOTHING
`

const GET_DISPATCH_RESERVATION_SQL = `SELECT * FROM dispatch_reservations WHERE dispatch_key = ?`

const DELETE_DISPATCH_RESERVATION_SQL = `DELETE FROM dispatch_reservations WHERE dispatch_key = ?`

/**
 * T2: conditional takeover release. `IS` (not `=`) so a reservation held
 * with a NULL job_id can still be matched by an explicit `expectedJobId` of
 * null, the same way `=` would fail to.
 */
const DELETE_DISPATCH_RESERVATION_IF_OWNER_SQL = `DELETE FROM dispatch_reservations WHERE dispatch_key = ? AND job_id IS ?`

const INSERT_ASSIGNMENT_SQL = `
INSERT INTO assignments (${ASSIGNMENT_COLUMNS.join(', ')})
VALUES (${ASSIGNMENT_COLUMNS.map((c) => `@${c}`).join(', ')})
`

const GET_ASSIGNMENT_SQL = `SELECT * FROM assignments WHERE id = ?`

const UPDATE_ASSIGNMENT_SQL = `
UPDATE assignments SET
${ASSIGNMENT_COLUMNS.filter((c) => c !== 'id').map((c) => `  ${c} = @${c}`).join(',\n')}
WHERE id = @id
`

function sqliteInitDb(stateHome) {
  const dbPath = paths({ AGENT_HUB_HOME: stateHome }).dbFile
  ensureDir(stateHome)
  // C1.1: dos schedulers (incluso en procesos distintos) pueden crear el DB
  // a la vez. El `timeout` del constructor no siempre cubre el DDL inicial,
  // así que se reintenta con backoff ante SQLITE_BUSY.
  const attempts = Number(process.env.AGENT_HUB_DB_INIT_RETRIES ?? 10)
  let lastError = null
  for (let i = 0; i < Math.max(1, attempts); i++) {
    let db = null
    try {
      // C1.1: timeout de busy desde el constructor para que TAMBIÉN cubra los
      // pragmas/DDL iniciales cuando dos procesos crean el DB a la vez.
      db = new SqliteDB(dbPath, { timeout: 5000 })
      db.pragma('journal_mode = WAL')
  // C1.1: dos schedulers (incluso en procesos distintos) escriben sobre el
  // mismo DB. Sin busy_timeout, better-sqlite3 falla de inmediato con
  // SQLITE_BUSY ante cualquier solape de escritura.
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA_SQL)
  try { db.exec("ALTER TABLE workflows ADD COLUMN definition_json TEXT") } catch {}
  try { db.exec("ALTER TABLE workflows ADD COLUMN status TEXT") } catch {}
  try { db.exec("ALTER TABLE workflows ADD COLUMN updated_at TEXT") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN status TEXT DEFAULT 'pending'") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN attempt INTEGER DEFAULT 0") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN updated_at TEXT") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN claimed_by TEXT") } catch {}
  try { db.exec("ALTER TABLE workflow_nodes ADD COLUMN result_json TEXT") } catch {}
  return db
    } catch (error) {
      lastError = error
      try { db?.close() } catch {}
      const busy = error?.code === 'SQLITE_BUSY' || /database is locked/i.test(String(error?.message ?? ''))
      if (!busy || i === Math.max(1, attempts) - 1) throw error
      const delayMs = Math.min(1000, 25 * 2 ** i)
      const start = Date.now()
      while (Date.now() - start < delayMs) { /* backoff síncrono: initDb es síncrono */ }
    }
  }
  throw lastError
}

function sqliteUpsertJob(db, row) {
  db.prepare(UPSERT_JOB_SQL).run(normalizeJobRow(row))
}

function sqliteGetJob(db, jobId) {
  return db.prepare(GET_JOB_SQL).get(jobId) ?? null
}

function sqliteListJobIds(db) {
  const rows = db.prepare(LIST_JOB_IDS_SQL).all()
  return rows.map((r) => r.job_id)
}

function sqliteUpsertLease(db, row) {
  db.prepare(UPSERT_LEASE_SQL).run(normalizeLeaseRow(row))
}

function sqliteDeleteLease(db, jobId) {
  db.prepare(DELETE_LEASE_SQL).run(jobId)
}

function sqliteGetLease(db, jobId) {
  return db.prepare(GET_LEASE_SQL).get(jobId) ?? null
}

function sqliteUpsertWorkflow(db, row) {
  const norm = normalizeWorkflowRow(row)
  db.prepare(UPSERT_WORKFLOW_SQL).run({
    id: norm.id,
    name: norm.name,
    created_at: norm.created_at,
    definition_json: norm.definition_json,
    status: norm.status,
    updated_at: norm.updated_at,
  })
}

function sqliteGetWorkflow(db, id) {
  const row = db.prepare(GET_WORKFLOW_SQL).get(id)
  if (!row) return null
  return {
    ...row,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function sqliteUpsertWorkflowNode(db, row) {
  const norm = normalizeWorkflowNodeRow(row)
  db.prepare(UPSERT_WORKFLOW_NODE_SQL).run({
    workflow_id: norm.workflow_id,
    step_id: norm.step_id,
    status: norm.status,
    attempt: norm.attempt,
    updated_at: norm.updated_at,
    claimed_by: norm.claimed_by,
    result_json: norm.result_json,
  })
}

function sqliteGetWorkflowNode(db, workflowId, stepId) {
  const row = db.prepare(GET_WORKFLOW_NODE_SQL).get(workflowId, stepId)
  if (!row) return null
  return {
    ...row,
    updatedAt: row.updated_at,
  }
}

function sqliteListWorkflowNodes(db, workflowId) {
  const rows = db.prepare(LIST_WORKFLOW_NODES_SQL).all(workflowId)
  return rows.map((r) => ({
    ...r,
    updatedAt: r.updated_at,
  }))
}

function sqlitePublishWorkflowNodeReady(db, { workflowId, stepId }) {
  const now = new Date().toISOString()
  const info = db.prepare(PUBLISH_READY_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    updated_at: now,
  })
  return info.changes > 0
}

function sqliteClaimWorkflowNode(db, { workflowId, stepId, claimedBy, attempt }) {  const now = new Date().toISOString()
  const info = db.prepare(CLAIM_WORKFLOW_NODE_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    claimed_by: claimedBy,
    attempt: attempt ?? null,
    updated_at: now,
  })
  return info.changes > 0
}

function sqliteTouchWorkflowNode(db, { workflowId, stepId, at }) {
  const info = db.prepare(TOUCH_WORKFLOW_NODE_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    updated_at: at ?? new Date().toISOString(),
  })
  return info.changes > 0
}

function sqliteReclaimOrphanedWorkflowNode(db, { workflowId, stepId, expectedStatus, expectedClaimedBy, expectedUpdatedAt }) {
  const info = db.prepare(RECLAIM_ORPHANED_WORKFLOW_NODE_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    expected_status: expectedStatus,
    expected_claimed_by: expectedClaimedBy,
    expected_updated_at: expectedUpdatedAt,
    updated_at: new Date().toISOString(),
  })
  return info.changes > 0
}

function sqliteResumeWorkflowNode(db, { workflowId, stepId }) {
  const now = new Date().toISOString()
  const info = db.prepare(RESUME_WORKFLOW_NODE_SQL).run({
    workflow_id: workflowId,
    step_id: stepId,
    updated_at: now,
  })
  return info.changes > 0
}

function sqliteUpsertHarnessOrigin(db, row) {
  const norm = normalizeHarnessOriginRow(row)
  db.prepare(UPSERT_HARNESS_ORIGIN_SQL).run({
    job_id: norm.job_id,
    harness_session_id: norm.harness_session_id,
    harness: norm.harness,
    created_at: norm.created_at,
  })
  return norm
}

function sqliteGetHarnessOrigin(db, jobId) {
  return db.prepare(GET_HARNESS_ORIGIN_SQL).get(jobId) ?? null
}

function sqliteUpsertHandoff(db, row) {
  const norm = normalizeHandoffRow(row)
  db.prepare(UPSERT_HANDOFF_SQL).run(norm)
  return norm
}

function sqliteGetHandoff(db, workflowId, stepId) {
  return db.prepare(GET_HANDOFF_SQL).get(workflowId, stepId) ?? null
}

function sqliteListHandoffs(db, workflowId) {
  return db.prepare(LIST_HANDOFFS_SQL).all(workflowId)
}

function sqliteAddContextEntry(db, row) {
  const norm = normalizeContextRow(row)
  const info = db.prepare(ADD_CONTEXT_ENTRY_SQL).run(norm)
  return {
    id: Number(info.lastInsertRowid),
    ...norm,
  }
}

function sqliteListContextEntries(db, workflowId, stepId = null) {
  if (stepId !== null && stepId !== undefined) {
    return db.prepare(LIST_CONTEXT_ENTRIES_BY_STEP_SQL).all(workflowId, stepId)
  }
  return db.prepare(LIST_CONTEXT_ENTRIES_SQL).all(workflowId)
}

function sqliteInsertAgentMessage(db, row) {
  const norm = normalizeAgentMessageRow(row)
  const info = db.prepare(INSERT_AGENT_MESSAGE_SQL).run(norm)
  return {
    id: Number(info.lastInsertRowid),
    ...norm,
  }
}

function sqliteListAgentMessages(db, { to, rootExecutionId, unreadOnly } = {}) {
  let sql = 'SELECT * FROM agent_messages WHERE 1=1'
  const params = []
  if (to) {
    if (Array.isArray(to)) {
      if (to.length === 0) return []
      const placeholders = to.map(() => '?').join(', ')
      sql += ` AND to_agent IN (${placeholders})`
      params.push(...to)
    } else {
      sql += ' AND to_agent = ?'
      params.push(to)
    }
  }
  if (rootExecutionId) {
    sql += ' AND root_execution_id = ?'
    params.push(rootExecutionId)
  }
  if (unreadOnly) {
    sql += ' AND delivered_at IS NULL'
  }
  sql += ' ORDER BY id ASC'
  return db.prepare(sql).all(...params)
}

function sqliteMarkAgentMessageDelivered(db, id, at) {
  const atVal = at ?? new Date().toISOString()
  const info = db.prepare('UPDATE agent_messages SET delivered_at = ? WHERE id = ?').run(atVal, id)
  return info.changes > 0
}

function sqliteMarkAgentMessageAck(db, id, at) {
  const atVal = at ?? new Date().toISOString()
  const info = db.prepare('UPDATE agent_messages SET ack_at = ? WHERE id = ?').run(atVal, id)
  return info.changes > 0
}

function sqliteGetAgentMessage(db, id) {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) ?? null
}

function sqliteReserveDispatchKey(db, { dispatchKey, jobId = null, createdAt = null } = {}) {
  const norm = normalizeDispatchReservationRow({ dispatchKey, jobId, createdAt })
  const info = db.prepare(RESERVE_DISPATCH_KEY_SQL).run(norm)
  if (info.changes === 1) {
    return { reserved: true, existingJobId: null, existingCreatedAt: null }
  }
  const existing = db.prepare(GET_DISPATCH_RESERVATION_SQL).get(dispatchKey) ?? null
  return {
    reserved: false,
    existingJobId: existing?.job_id ?? null,
    existingCreatedAt: existing?.created_at ?? null,
  }
}

function sqliteGetDispatchReservation(db, dispatchKey) {
  return db.prepare(GET_DISPATCH_RESERVATION_SQL).get(dispatchKey) ?? null
}

function sqliteReleaseDispatchReservation(db, dispatchKey, expectedJobId) {
  if (expectedJobId === undefined) {
    const info = db.prepare(DELETE_DISPATCH_RESERVATION_SQL).run(dispatchKey)
    return info.changes > 0
  }
  const info = db.prepare(DELETE_DISPATCH_RESERVATION_IF_OWNER_SQL).run(dispatchKey, expectedJobId)
  return info.changes > 0
}

function sqliteInsertAssignment(db, row) {
  const norm = normalizeAssignmentRow(row)
  db.prepare(INSERT_ASSIGNMENT_SQL).run(norm)
  return norm
}

function sqliteGetAssignment(db, id) {
  const row = db.prepare(GET_ASSIGNMENT_SQL).get(id)
  return row ? normalizeAssignmentRow(row) : null
}

function sqliteListAssignments(db, { status, agent, limit } = {}) {
  const where = []
  const params = []
  if (status) { where.push('status = ?'); params.push(status) }
  if (agent) { where.push('agent = ?'); params.push(agent) }
  let sql = 'SELECT * FROM assignments'
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`
  sql += ' ORDER BY created_at DESC, rowid DESC'
  if (Number.isInteger(limit) && limit > 0) { sql += ' LIMIT ?'; params.push(limit) }
  return db.prepare(sql).all(...params).map(normalizeAssignmentRow)
}

function sqliteUpdateAssignmentAtomic(db, id, mutator) {
  // IMMEDIATE takes the write lock before the read, so the guard the mutator
  // evaluates cannot be invalidated by another process before the write.
  const run = db.transaction(() => {
    const existing = db.prepare(GET_ASSIGNMENT_SQL).get(id)
    if (!existing) return { ok: false, reason: 'not_found' }
    const current = normalizeAssignmentRow(existing)
    const outcome = mutator(current)
    if (!outcome?.ok) return outcome
    const next = normalizeAssignmentRow({ ...current, ...outcome.patch, id })
    db.prepare(UPDATE_ASSIGNMENT_SQL).run(next)
    return { ok: true, row: next }
  })
  return run.immediate()
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {string} [stateHome] - Root state directory (defaults to stateHome() in config.mjs)
 * @returns {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome: string }}
 */
export function initDb(stateHome) {
  const home = normalizeHome(stateHome)
  if (SqliteDB) {
    const db = sqliteInitDb(home)
    return { db, backend: 'sqlite', stateHome: home }
  }
  mutateJsonStore(home, () => jsonInitDb(home))
  return { db: null, backend: 'json', stateHome: home }
}

/**
 * Insert or update a job row. `result_json` is the full job record as a string.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {object} row - Must include job_id; all other columns are nullable.
 */
export function upsertJob(ctx, row) {
  if (!ctx) return
  if (ctx.backend === 'sqlite') {
    sqliteUpsertJob(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    mutateJsonStore(home, () => jsonUpsertJob(home, row))
  }
}

/**
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} jobId
 * @returns {object | null}
 */
export function getJob(ctx, jobId) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteGetJob(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetJob(home, jobId)
}

/**
 * List all job IDs.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @returns {string[]}
 */
export function listJobIds(ctx) {
  if (!ctx) return []
  if (ctx.backend === 'sqlite') {
    return sqliteListJobIds(ctx.db)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListJobIds(home)
}

/**
 * Insert or update a lease row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {{ job_id: string, owner: string, expires_at: string }} row
 */
export function upsertLease(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertLease(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    mutateJsonStore(home, () => jsonUpsertLease(home, row))
  }
}

/**
 * Delete a lease row by job_id.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} jobId
 */
export function deleteLease(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    sqliteDeleteLease(ctx.db, jobId)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    mutateJsonStore(home, () => jsonDeleteLease(home, jobId))
  }
}

/**
 * Get a lease row by job_id.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} jobId
 * @returns {object | null}
 */
export function getLease(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetLease(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetLease(home, jobId)
}

/**
 * Insert or update a workflow row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {object} row
 */
export function upsertWorkflow(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertWorkflow(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    mutateJsonStore(home, () => jsonUpsertWorkflow(home, row))
  }
}

/**
 * Get a workflow row by id.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} id
 * @returns {object | null}
 */
export function getWorkflow(ctx, id) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetWorkflow(ctx.db, id)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetWorkflow(home, id)
}

/**
 * Insert or update a workflow node row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {object} row
 */
export function upsertWorkflowNode(ctx, row) {
  if (ctx.backend === 'sqlite') {
    sqliteUpsertWorkflowNode(ctx.db, row)
  } else {
    const home = normalizeHome(ctx?.stateHome)
    mutateJsonStore(home, () => jsonUpsertWorkflowNode(home, row))
  }
}

/**
 * Get a workflow node row.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} workflowId
 * @param {string} stepId
 * @returns {object | null}
 */
export function getWorkflowNode(ctx, workflowId, stepId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetWorkflowNode(ctx.db, workflowId, stepId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetWorkflowNode(home, workflowId, stepId)
}

/**
 * List all workflow nodes for a given workflow.
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {string} workflowId
 * @returns {Array<object>}
 */
export function listWorkflowNodes(ctx, workflowId) {
  if (ctx.backend === 'sqlite') {
    return sqliteListWorkflowNodes(ctx.db, workflowId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListWorkflowNodes(home, workflowId)
}

/**
 * Atomically claim a workflow node for execution (CAS).
 * @param {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome?: string }} ctx
 * @param {{ workflowId: string, stepId: string, claimedBy: string, attempt?: number }} params
 * @returns {boolean} true if claimed successfully, false if already claimed or executed
 */
export function claimWorkflowNode(ctx, { workflowId, stepId, claimedBy, attempt }) {
  if (ctx.backend === 'sqlite') {
    return sqliteClaimWorkflowNode(ctx.db, { workflowId, stepId, claimedBy, attempt })
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonClaimWorkflowNode(home, { workflowId, stepId, claimedBy, attempt }))
}

export function touchWorkflowNode(ctx, { workflowId, stepId, at }) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteTouchWorkflowNode(ctx.db, { workflowId, stepId, at })
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonTouchWorkflowNode(home, { workflowId, stepId, at })
}

/**
 * T1: orphan reclaim as compare-and-set. Releases a RUNNING/WAITING node
 * back to READY (claimed_by = null) ONLY IF the row still has the exact
 * status/owner/updated_at that justified the reclaim. Returns false and
 * changes nothing when another process already reclaimed and re-claimed the
 * node — the caller (reclaimOrphanedNode) must not treat that as success.
 * @returns {boolean} true if this call released the node
 */
export function reclaimOrphanedWorkflowNode(ctx, { workflowId, stepId, expectedStatus, expectedClaimedBy, expectedUpdatedAt }) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteReclaimOrphanedWorkflowNode(ctx.db, { workflowId, stepId, expectedStatus, expectedClaimedBy, expectedUpdatedAt })
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonReclaimOrphanedWorkflowNode(home, { workflowId, stepId, expectedStatus, expectedClaimedBy, expectedUpdatedAt })
}

/**
 * Atomically publish a pending node as ready (conditional: only from pending).
 * Never touches claimed/running rows, so it cannot clobber another
 * scheduler's claim — the CAS claim below stays the single winner gate.
 * @returns {boolean} true if the row moved pending -> ready
 */
export function publishWorkflowNodeReady(ctx, { workflowId, stepId }) {
  if (ctx.backend === 'sqlite') {
    return sqlitePublishWorkflowNodeReady(ctx.db, { workflowId, stepId })
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonPublishWorkflowNodeReady(home, { workflowId, stepId }))
}

/**
 * C1.2: atomically resume a waiting node to running (conditional: only from
 * waiting). Preserves claimed_by so the scheduler holding the claim keeps
 * it — a resume never steals ownership.
 * @returns {boolean} true if the row moved waiting -> running
 */
export function resumeWorkflowNode(ctx, { workflowId, stepId }) {
  if (ctx.backend === 'sqlite') {
    return sqliteResumeWorkflowNode(ctx.db, { workflowId, stepId })
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonResumeWorkflowNode(home, { workflowId, stepId }))
}

/**
 * C1.2: persist the jobId -> harness-session mapping (future bridge only;
 * nothing consumes it yet — every profile reports supportsWake=false).
 */
export function upsertHarnessOrigin(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteUpsertHarnessOrigin(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonUpsertHarnessOrigin(home, row))
}

/**
 * C1.2: read the jobId -> harness-session mapping, or null when unknown.
 */
export function getHarnessOrigin(ctx, jobId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetHarnessOrigin(ctx.db, jobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetHarnessOrigin(home, jobId)
}

export function upsertHandoff(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteUpsertHandoff(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonUpsertHandoff(home, row))
}

export function getHandoff(ctx, workflowId, stepId) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetHandoff(ctx.db, workflowId, stepId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetHandoff(home, workflowId, stepId)
}

export function listHandoffs(ctx, workflowId) {
  if (ctx.backend === 'sqlite') {
    return sqliteListHandoffs(ctx.db, workflowId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListHandoffs(home, workflowId)
}

export function addContextEntry(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteAddContextEntry(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonAddContextEntry(home, row))
}

export function listContextEntries(ctx, workflowId, stepId = null) {
  if (ctx.backend === 'sqlite') {
    return sqliteListContextEntries(ctx.db, workflowId, stepId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListContextEntries(home, workflowId, stepId)
}

export function insertAgentMessage(ctx, row) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteInsertAgentMessage(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonInsertAgentMessage(home, row))
}

export function listAgentMessages(ctx, options = {}) {
  if (!ctx) return []
  if (ctx.backend === 'sqlite') {
    return sqliteListAgentMessages(ctx.db, options)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListAgentMessages(home, options)
}

export function markAgentMessageDelivered(ctx, id, at) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteMarkAgentMessageDelivered(ctx.db, id, at)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonMarkAgentMessageDelivered(home, id, at))
}

export function markAgentMessageAck(ctx, id, at) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteMarkAgentMessageAck(ctx.db, id, at)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonMarkAgentMessageAck(home, id, at))
}

/**
 * Cross-process idempotency primitive for dispatches.
 *
 * reserveDispatchKey is atomic per dispatch_key: the first caller wins and
 * every later caller gets { reserved: false } with the winning job, so a
 * dispatch cannot be started twice for the same key. Behaviour is mirrored in
 * the JSON fallback so it is identical without better-sqlite3.
 *
 * Known gap: there is no deleteLeaseByCwd helper. The leases table is keyed by
 * job_id alone (owner is a plain column, not part of the key) and has no cwd
 * column; the worktree cwd only exists as the lock file path. A cwd-keyed
 * delete would need a schema change, so it is intentionally not invented here.
 */
export function reserveDispatchKey(ctx, options = {}) {
  if (!ctx) return { reserved: false, existingJobId: null, existingCreatedAt: null }
  if (ctx.backend === 'sqlite') {
    return sqliteReserveDispatchKey(ctx.db, options)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonReserveDispatchKey(home, options)
}

export function getDispatchReservation(ctx, dispatchKey) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteGetDispatchReservation(ctx.db, dispatchKey)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetDispatchReservation(home, dispatchKey)
}

/**
 * T2: release a dispatch-key reservation. With no `expectedJobId` this is
 * the historical unconditional release. With `expectedJobId` (including
 * `null`, meaning "the reservation had no jobId"), the delete is a
 * compare-and-set: it only removes the row when it still belongs to the
 * exact holder that was observed, so a stale-holder takeover can never
 * delete a reservation someone else already took over.
 * @returns {boolean} true if a row was deleted
 */
export function releaseDispatchReservation(ctx, dispatchKey, expectedJobId) {
  if (!ctx) return false
  if (ctx.backend === 'sqlite') {
    return sqliteReleaseDispatchReservation(ctx.db, dispatchKey, expectedJobId)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonReleaseDispatchReservation(home, dispatchKey, expectedJobId)
}

export function getAgentMessage(ctx, id) {
  if (!ctx) return null
  if (ctx.backend === 'sqlite') {
    return sqliteGetAgentMessage(ctx.db, id)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetAgentMessage(home, id)
}

/**
 * Assignment rows (snake_case). Domain rules live in src/assignments.mjs; this
 * layer only persists rows and provides one atomic read-check-write primitive.
 */
export function insertAssignment(ctx, row) {
  if (ctx.backend === 'sqlite') {
    return sqliteInsertAssignment(ctx.db, row)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonInsertAssignment(home, row))
}

export function getAssignmentRow(ctx, id) {
  if (ctx.backend === 'sqlite') {
    return sqliteGetAssignment(ctx.db, id)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonGetAssignment(home, id)
}

export function listAssignmentRows(ctx, options = {}) {
  if (ctx.backend === 'sqlite') {
    return sqliteListAssignments(ctx.db, options)
  }
  const home = normalizeHome(ctx?.stateHome)
  return jsonListAssignments(home, options)
}

/**
 * Atomic compare-and-set on one assignment row.
 *
 * `mutator(currentRow)` runs inside the backend's critical section (an
 * IMMEDIATE transaction for SQLite, the JSON store lock otherwise) and returns
 * either `{ ok: false, ...details }` to refuse without writing, or
 * `{ ok: true, patch }` to merge `patch` into the row. A missing row yields
 * `{ ok: false, reason: 'not_found' }` without calling the mutator.
 * @returns {{ ok: true, row: object } | { ok: false, reason: string }}
 */
export function updateAssignmentAtomic(ctx, id, mutator) {
  if (ctx.backend === 'sqlite') {
    return sqliteUpdateAssignmentAtomic(ctx.db, id, mutator)
  }
  const home = normalizeHome(ctx?.stateHome)
  return mutateJsonStore(home, () => jsonUpdateAssignmentAtomic(home, id, mutator))
}

export { getDb, closeDb, resetDbInstances } from './db.mjs'

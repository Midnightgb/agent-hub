/**
 * Job store and persistence.
 *
 * Architecture Invariant: SQLite is coordination state, the filesystem is content.
 * In sqlite mode (C0.1.3/C0.1.4), SQLite acts as the index and coordination state.
 * result.json continues to be written on createJob and updateResult as a durability
 * and content artifact, but is no longer the primary index for queries.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { paths } from './config.mjs'
import { appendEvent } from './eventlog.mjs'
import { updateJsonLocked } from './fsutil.mjs'
import { getDb, upsertJob, getJob, listJobIds } from './storage/index.mjs'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * A job id is used directly as a directory name under runs/, so it must be a
 * single safe path segment. Without this a decoded id like `../../x` (reachable
 * via GET /api/jobs/..%2F..%2Fx/result and the MCP job_* tools) would read or
 * write files outside runs/. Every exported function that accepts a jobId
 * funnels through jobDir(), so validating here rejects the whole class before
 * any filesystem call, and reports it the same way a missing job does.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertValidJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId) || jobId.includes('..')) {
    throw new Error(`job not found: ${jobId}`)
  }
}

function jobDir(jobId, env = process.env) {
  assertValidJobId(jobId)
  return path.join(paths(env).runsDir, jobId)
}

export function resultPath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'result.json')
}

export function stdoutPath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'stdout.log')
}

/** The parsed, human-readable response text — distinct from the raw stdout.log. */
export function responsePath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'response.txt')
}

export function promptPath(jobId, env = process.env) {
  return path.join(jobDir(jobId, env), 'prompt.txt')
}

function newJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `${ts}-${crypto.randomBytes(4).toString('hex')}`
}

let sqliteMirrorWarned = false

function mirrorJobToDb(job, env = process.env) {
  try {
    const ctx = getDb(env)
    if (!ctx || ctx.backend !== 'sqlite' || !ctx.db) {
      if (!sqliteMirrorWarned) {
        console.warn('[agent-hub] better-sqlite3 unavailable; skipping SQLite job mirror')
        sqliteMirrorWarned = true
      }
      return
    }
    upsertJob(ctx, {
      job_id: job.jobId ?? job.job_id ?? null,
      workflow_id: job.workflow_id ?? null,
      step_id: job.step_id ?? null,
      parent_execution_id: job.parent_execution_id ?? null,
      root_execution_id: job.root_execution_id ?? null,
      attempt: job.attempt ?? null,
      remote_state: job.remote_state ?? (job.remote?.state ?? null),
      // Column is kept for compatibility and no longer produced (the UPSERT binds @quality_score, so it must still be passed).
      quality_score: null,
      verified: job.verified === true ? 1 : (job.verified === false ? 0 : (job.verified ?? null)),
      judge_verdict: job.judge_verdict ?? null,
      result_json: JSON.stringify(job),
    })
  } catch (error) {
    if (!sqliteMirrorWarned) {
      console.warn('[agent-hub] SQLite job mirror failed:', error?.message ?? error)
      sqliteMirrorWarned = true
    }
  }
}

/**
 * Create a new job: allocates a jobId, writes prompt.txt and an initial
 * result.json in 'queued' state. Does not spawn anything — process.mjs owns that.
 */
export function createJob({
  agent,
  model,
  task,
  cwd,
  title,
  mode = 'read',
  timeoutS,
  timeoutSource = 'default',
  taskType = null,
  turnDepth = 0,
  learningIds = [],
  env = process.env,
  variant,
  sessionId,
  parentJobId,
  // C0 workflow/provenance params
  workflow_id = null,
  step_id = null,
  parent_execution_id = null,
  root_execution_id = null,
  attempt = null,
  remote_state = null,
  verified = null,
  judge_verdict = null,
  revision = null,
  // A1 dispatch params
  executionId = null,
  execution_id = null,
  dispatchKey = null,
  dispatch_key = null,
  // Harness profile id + dispatch waitMode that created this job (nullable
  // so every pre-existing record and caller stays valid).
  harness = null,
  waitMode = null,
  profile = null,
  profileStatus = null,
}) {
  // A job record without an identity is not a job. `JobRecord` (src/schemas.mjs)
  // requires agent/model, and the dashboard validates /api/state as ONE payload,
  // so a record missing either blanks every job-list view. Reject at the source,
  // before a run directory is allocated.
  if (typeof agent !== 'string' || agent.trim() === '') {
    throw new Error('createJob: agent is required')
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('createJob: model is required')
  }

  const jobId = newJobId()
  const dir = jobDir(jobId, env)
  ensureDir(dir)

  fs.writeFileSync(promptPath(jobId, env), task ?? '', 'utf8')

  const resolvedExecutionId = executionId ?? execution_id ?? null
  const resolvedDispatchKey = dispatchKey ?? dispatch_key ?? null

  const result = {
    jobId,
    agent,
    model,
    title: title ?? '',
    cwd,
    mode,
    // timeoutS is the EFFECTIVE timeout (already resolved against metrics by
    // startJob); timeoutSource records which rule produced it. taskType and
    // turnDepth drive metrics grouping and the deep-conversation warning.
    timeoutS: timeoutS ?? null,
    timeoutSource: timeoutSource ?? 'default',
    taskType: taskType ?? null,
    turnDepth: turnDepth ?? 0,
    learningIds: Array.isArray(learningIds) ? learningIds : [],
    variant: variant ?? null,
    // sessionId is the CLI's own conversation/session id, used to resume via
    // job_reply. parentJobId links a reply back to the job it continues.
    sessionId: sessionId ?? null,
    parentJobId: parentJobId ?? null,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // C0 workflow/provenance fields
    workflow_id: workflow_id ?? null,
    step_id: step_id ?? null,
    parent_execution_id: parent_execution_id ?? null,
    root_execution_id: root_execution_id ?? null,
    attempt: attempt ?? null,
    remote_state: remote_state ?? null,
    verified: verified ?? null,
    judge_verdict: judge_verdict ?? null,
    revision: revision ?? null,
    // A1 dispatch provenance fields
    executionId: resolvedExecutionId,
    execution_id: resolvedExecutionId,
    dispatchKey: resolvedDispatchKey,
    dispatch_key: resolvedDispatchKey,
    // Harness profile + waitMode that created this job (informational only:
    // never gates, locks, or routes — see src/harness/registry.mjs).
    harness: harness ?? null,
    waitMode: waitMode ?? null,
    profile: profile ?? null,
    profileStatus: profileStatus ?? null,
  }
  // Dual state: if remote_state is provided, mirror it into remote.state for compat.
  if (remote_state != null) {
    result.remote = { state: remote_state }
  }
  fs.writeFileSync(resultPath(jobId, env), JSON.stringify(result, null, 2), 'utf8')
  mirrorJobToDb(result, env)
  return result
}

const COMPARE_FIELDS = ['jobId', 'status', 'updatedAt', 'verified', 'judge_verdict', 'revision']

export const _warnedDivergentJobIds = new Set()

function readJsonResult(jobId, env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(resultPath(jobId, env), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`job not found: ${jobId}`)
    throw error
  }
}

export function compareJobReadPaths(jobId, env = process.env) {
  let json = null
  try {
    json = JSON.parse(fs.readFileSync(resultPath(jobId, env), 'utf8'))
  } catch {
    json = null
  }

  let sqlite = null
  try {
    const ctx = getDb(env)
    if (ctx) {
      const row = getJob(ctx, jobId)
      if (row?.result_json) {
        sqlite = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json
      }
    }
  } catch {
    sqlite = null
  }

  const divergences = []
  if (!json && !sqlite) {
    return { json: null, sqlite: null, divergences: [] }
  }

  if (json && !sqlite) {
    for (const field of COMPARE_FIELDS) {
      divergences.push({ field, json: json[field] ?? null, sqlite: null })
    }
    return { json, sqlite: null, divergences }
  }

  if (!json && sqlite) {
    for (const field of COMPARE_FIELDS) {
      divergences.push({ field, json: null, sqlite: sqlite[field] ?? null })
    }
    return { json: null, sqlite, divergences }
  }

  for (const field of COMPARE_FIELDS) {
    const jsonVal = json[field] ?? null
    const sqliteVal = sqlite[field] ?? null
    if (jsonVal !== sqliteVal) {
      divergences.push({ field, json: json[field], sqlite: sqlite[field] })
    }
  }

  return { json, sqlite, divergences }
}

function warnIfDivergent(jobId, env = process.env) {
  const comparison = compareJobReadPaths(jobId, env)
  if (comparison.divergences.length > 0 && !_warnedDivergentJobIds.has(jobId)) {
    _warnedDivergentJobIds.add(jobId)
    console.warn(`[agent-hub] job read divergence for ${jobId}:`, comparison.divergences)
  }
  return comparison
}

/**
 * Read a job result.
 *
 * In sqlite mode (C0.1.3/C0.1.4), SQLite is coordination state and primary index:
 * readResult reads the DB row first. When absent, it falls back to result.json
 * and best-effort backfills/mirrors it into SQLite so legacy jobs are indexed.
 *
 * In shadow mode (C0.1.2), reads compare JSON and SQLite, warning once per
 * divergent jobId while JSON always wins (returns JSON record).
 *
 * Default (json) mode preserves legacy filesystem-only behaviour.
 */
export function readResult(jobId, env = process.env) {
  const storeMode = env?.AGENT_HUB_STORE || 'json'

  if (storeMode === 'sqlite') {
    assertValidJobId(jobId)
    const ctx = getDb(env)
    if (ctx) {
      try {
        const row = getJob(ctx, jobId)
        if (row?.result_json) {
          return typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json
        }
      } catch {
        // fall back to JSON file below
      }
    }
    const result = readJsonResult(jobId, env)
    try {
      if (!result.jobId) result.jobId = jobId
      mirrorJobToDb(result, env)
    } catch {
      // best-effort backfill into SQLite
    }
    return result
  }

  if (storeMode === 'shadow') {
    warnIfDivergent(jobId, env)
    return readJsonResult(jobId, env)
  }

  return readJsonResult(jobId, env)
}

/**
 * Merge fields into result.json. Both the job runner and the dashboard's
 * cancel endpoint call this for the same job, so the read-modify-write goes
 * through updateJsonLocked (not a plain writeFileSync) to make the whole
 * sequence atomic across processes, never just the final write.
 */
export function updateResult(jobId, patchOrUpdater, env = process.env) {
  readResult(jobId, env) // throws `job not found: ${jobId}` if result.json does not exist
  const updatedAt = new Date().toISOString()
  return updateJsonLocked(resultPath(jobId, env), (current) => {
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(current) : patchOrUpdater
    const next = { ...current, ...patch, updatedAt }
    // cancelJob (dashboard process) and finishJob (MCP process) race: a finish
    // computed from a record read before the cancel must not resurrect the job
    // as succeeded/failed. Cancellation wins on status; everything else may
    // still merge (tokens, sessionId, costUsd, ...).
    if (current.status === 'canceled' && patch?.status && patch.status !== 'canceled') {
      next.status = 'canceled'
      next.errorKind = current.errorKind
      next.error = current.error
    }
    mirrorJobToDb(next, env)
    return next
  })
}

/**
 * List all jobs, sorted by createdAt descending.
 *
 * In sqlite mode (C0.1.3/C0.1.4), SQLite is coordination state and primary index.
 * result.json is no longer the index; listJobs computes the UNION of DB job IDs
 * and runs/ directory names, reading each DB-first with fallback to result.json
 * (and backfilling legacy jobs into SQLite).
 *
 * In shadow mode (C0.1.2), reads compare JSON and SQLite for every job,
 * warning once per divergent jobId without altering returned JSON data.
 *
 * Default (json) mode preserves byte-for-byte legacy filesystem-scanning behaviour.
 */
export function listJobs(env = process.env) {
  const { runsDir } = paths(env)
  const storeMode = env?.AGENT_HUB_STORE || 'json'

  if (storeMode === 'sqlite') {
    const ctx = getDb(env)
    let dbIds = []
    if (ctx) {
      try {
        dbIds = listJobIds(ctx)
      } catch {
        dbIds = []
      }
    }

    let runIds = []
    try {
      const entries = fs.readdirSync(runsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== '.locks') {
          runIds.push(entry.name)
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const unionIds = new Set([...dbIds, ...runIds])
    const jobs = []
    for (const id of unionIds) {
      try {
        jobs.push(readResult(id, env))
      } catch {
        // skip missing or unreadable jobs
      }
    }
    jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return jobs
  }

  if (storeMode === 'shadow') {
    let entries = []
    try {
      entries = fs.readdirSync(runsDir, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    const ctx = getDb(env)
    let dbIds = []
    if (ctx) {
      try {
        dbIds = listJobIds(ctx)
      } catch {
        dbIds = []
      }
    }

    const runIds = []
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.locks') {
        runIds.push(entry.name)
      }
    }

    const allIds = new Set([...runIds, ...dbIds])
    for (const id of allIds) {
      try {
        warnIfDivergent(id, env)
      } catch {
        // ignore
      }
    }

    const jobs = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.locks') continue
      try {
        jobs.push(readJsonResult(entry.name, env))
      } catch {
        // skip a job directory without a readable result.json
      }
    }
    jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    return jobs
  }

  let entries
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const jobs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.locks') continue
    try {
      jobs.push(readJsonResult(entry.name, env))
    } catch {
      // skip a job directory without a readable result.json
    }
  }
  jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  return jobs
}

export function appendStdout(jobId, chunk, env = process.env) {
  fs.appendFileSync(stdoutPath(jobId, env), chunk, 'utf8')
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM' // exists but owned by someone else
  }
}

/**
 * Reconcile jobs left 'running' whose pid is dead (e.g. the MCP process was
 * killed mid-job). Called on MCP startup. Returns the list of jobIds changed.
 */
export function reconcileOrphans(env = process.env) {
  const changed = []
  for (const job of listJobs(env)) {
    if (job.status !== 'running') continue
    // A remote job (Jules) has no local pid — it runs on the provider's own
    // infrastructure and is tracked by the poller, not by a child of this
    // process. Judging it by a missing/foreign pid would wrongly mark a
    // still-progressing remote session as orphaned on every MCP restart.
    if (job.remote) continue
    if (job.pid && isPidAlive(job.pid)) continue
    updateResult(job.jobId, { status: 'failed', errorKind: 'orphaned', error: 'process not found on startup reconcile' }, env)
    changed.push(job.jobId)
    // Orphans never reach finishJob, so without this a watcher would wait on
    // them forever. Best-effort: an event-log failure must not break startup.
    try {
      appendEvent(
        { kind: 'job.failed', agent: job.agent, model: job.model, cwd: job.cwd, title: job.title, jobId: job.jobId, errorKind: 'orphaned' },
        { env }
      )
    } catch {
      // ignore
    }
  }
  return changed
}

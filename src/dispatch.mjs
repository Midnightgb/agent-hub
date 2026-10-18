import crypto from 'node:crypto'
import { route } from './router.mjs'
import { modelGroupFor } from './providers/profiles.mjs'
import { policyFor } from './policy/registry.mjs'
import { executeWithPolicy } from './policy/executor.mjs'
import { startJob } from './jobrunner.mjs'
import { createJob, listJobs, readResult } from './jobstore.mjs'
import { runPreflight, circuitBreakerOpen } from './preflight.mjs'
import { acquireWriteLock, releaseWriteLock, adoptWriteLock } from './worktree.mjs'
import { resolveEffectiveTimeoutS } from './timeouts.mjs'
import { ADAPTIVE_TIMEOUT } from './config.mjs'
import { classifyError } from './policy/taxonomy.mjs'
import { adapterFor as defaultAdapterFor } from './adapters/index.mjs'
import { normalizeVerifyCheck } from './verify.mjs'
import { cancelJob as defaultCancelJob } from './jobrunner.mjs'
import { resolveHarness, normalizeWaitMode } from './harness/registry.mjs'
import { resolveAgyProfile, listAgysProfiles, isAgysAvailable } from './providers/agys.mjs'
import { getDb, reserveDispatchKey, releaseDispatchReservation } from './storage/index.mjs'


/** Terminal job statuses: only these count as a real terminal outcome. */
export const TERMINAL_JOB_STATUSES = Object.freeze(['succeeded', 'failed', 'canceled'])

/** Remote states that mean "waiting for interaction", never terminal. */
export function isWaitingJobState(state) {
  return (
    typeof state === 'string' &&
    (state.startsWith('AWAITING_') || state === 'PAUSED')
  )
}

export function waitingReasonForState(state) {
  if (state === 'AWAITING_USER_FEEDBACK') return 'user_feedback'
  if (state === 'AWAITING_PLAN_APPROVAL') return 'plan_approval'
  return 'external_event'
}

/**
 * Creates an execution handle for a dispatched job.
 *
 * Local jobs: abort() calls cancelJob and confirms the terminal record.
 * Remote jobs: abort() only stops the local wait — the remote session
 * keeps running (REMOTE NO-GUARANTEE, see docs/execution-contract.md §2).
 */
export function createExecutionHandle({ job, sessionId = null, env = process.env, cancelJobFn = defaultCancelJob, isRemote = false } = {}) {
  const jobId = job?.jobId ?? null
  const resolvedSessionId = sessionId ?? job?.sessionId ?? job?.remote?.sessionId ?? null
  const handle = {
    jobId,
    sessionId: resolvedSessionId,
    profile: job?.profile ?? null,
    job,
    remote: isRemote,
    _aborted: false,
    async abort() {
      if (handle._aborted) return { alreadyAborted: true, jobId }
      handle._aborted = true
      if (isRemote || job?.remote) {
        return { stoppedWaiting: true, remoteContinuing: true, jobId }
      }
      try {
        const record = await cancelJobFn(jobId, { env })
        return { canceled: true, jobId, status: record?.status ?? 'canceled' }
      } catch (error) {
        return { abortError: String(error?.message ?? error), jobId }
      }
    },
  }
  return handle
}

export function isExecutionHandle(value) {
  return Boolean(value && typeof value === 'object' && typeof value?.jobId === 'string' && typeof value?.abort === 'function')
}

/**
 * Waits for an execution handle until the job record reaches a terminal
 * status or a waiting state (AWAITING_* / PAUSED).
 *
 * Returns:
 *   { done:true, status, record } on terminal,
 *   { done:true, waiting:true, status:'waiting', record, reason } on waiting,
 *   { done:true, aborted:true } when handle.abort() was called,
 *   { done:false, timedOut:true, record } on local budget expiry.
 */
export async function waitExecution(handleOrJobId, { timeoutS = 60, pollIntervalMs = 100, onWaiting = null, readResultFn = null, nowFn = Date.now } = {}) {
  const handle = typeof handleOrJobId === 'string' ? { jobId: handleOrJobId, _aborted: false } : (handleOrJobId ?? {})
  const jobId = handle.jobId ?? handle?.job?.jobId
  if (!jobId) throw new Error('waitExecution requires a jobId')
  let readFn = readResultFn
  if (!readFn) {
    const { readResult } = await import('./jobstore.mjs')
    readFn = (id) => readResult(id)
  }
  const deadline = nowFn() + Math.max(1, timeoutS) * 1000
  for (;;) {
    if (handle._aborted) return { done: true, aborted: true, jobId }
    let record = null
    try {
      record = readFn(jobId)
    } catch {
      record = handle.job ?? null
    }
    const status = record?.status
    if (status && TERMINAL_JOB_STATUSES.includes(status)) {
      return { done: true, aborted: false, timedOut: false, waiting: false, status, record }
    }
    const remoteState = record?.remote?.state ?? record?.remote_state ?? null
    if (status === 'running' && isWaitingJobState(remoteState)) {
      const reason = waitingReasonForState(remoteState)
      try {
        await onWaiting?.({ record, reason, remoteState })
      } catch {}
      return { done: true, waiting: true, timedOut: false, aborted: false, status: 'waiting', record, reason, remoteState }
    }
    if (nowFn() >= deadline) {
      return { done: false, timedOut: true, waiting: false, jobId, record }
    }
    await new Promise((r) => setTimeout(r, Math.max(10, pollIntervalMs)))
  }
}

/** Default window for deduplicating recent dispatches: 10 minutes */
export const DISPATCH_WINDOW_MS = 10 * 60 * 1000

/** How long a loser waits for the reservation holder's job to appear (ms) */
export const DISPATCH_RESERVATION_WAIT_MS = 2000

/** Poll interval while waiting for the holder's job (ms) */
const DISPATCH_RESERVATION_POLL_MS = 25

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** In-flight map to deduplicate concurrent dispatches in this process */
const inFlightDispatches = new Map()

/** In-memory cache for recent dispatches (useful when startJob is mocked without disk persistence) */
const recentDispatches = new Map()

/**
 * Computes the deterministic dispatchKey: sha256(task+cwd+taskType+workflowStep[+workflowId]).
 * workflowId scopes the key to one workflow run: two different workflows with
 * an identical step must NOT share a job (live validation showed a re-run
 * reusing another run's terminal record and "succeeding" in 0s). Omitted
 * workflowId keeps the exact legacy hash (backward compatible).
 */
export function computeDispatchKey({ task, cwd, taskType, workflowStep, workflowId = null } = {}) {
  const hash = crypto.createHash('sha256')
  hash.update(`${task ?? ''}${cwd ?? ''}${taskType ?? ''}${workflowStep ?? ''}${workflowId ?? ''}`)
  return hash.digest('hex')
}

/**
 * Computes remote intent fingerprint for Jules reconcilation:
 * sha256(source + branch + taskHash + title + 10min window bucket)
 */
export function fingerprintRemoteIntent({
  source,
  branch,
  startingBranch,
  task,
  title,
  now = Date.now(),
  windowMs = DISPATCH_WINDOW_MS,
} = {}) {
  const resolvedBranch = branch ?? startingBranch ?? null
  const taskHash = crypto.createHash('sha256').update(String(task ?? '')).digest('hex')
  const timeBucket = Math.floor(now / windowMs)
  const hash = crypto
    .createHash('sha256')
    .update(`${source ?? ''}:${resolvedBranch ?? ''}:${taskHash}:${title ?? ''}:${timeBucket}`)
    .digest('hex')

  return {
    source: source ?? null,
    branch: resolvedBranch,
    taskHash,
    title: title ?? null,
    timeBucket,
    windowMs,
    hash,
  }
}

/**
 * Finds a matching recent Jules session in listSessions to avoid duplicate session creation.
 */
export async function findMatchingSession({
  fingerprint,
  source,
  branch,
  startingBranch,
  task,
  title,
  sessions,
  client,
  apiKey,
  env = process.env,
  listJobsFn = listJobs,
  now = Date.now(),
  windowMs = DISPATCH_WINDOW_MS,
} = {}) {
  const fp = fingerprint ?? fingerprintRemoteIntent({ source, branch, startingBranch, task, title, now, windowMs })

  let sessionList = sessions
  if (!sessionList && client?.listSessions) {
    try {
      const resp = await client.listSessions({ apiKey })
      sessionList = Array.isArray(resp?.sessions) ? resp.sessions : Array.isArray(resp) ? resp : []
    } catch {
      sessionList = []
    }
  }

  if (!Array.isArray(sessionList) || sessionList.length === 0) {
    return null
  }

  const matchingSession = sessionList.find((s) => {
    // 1. Time window check
    if (s.createTime) {
      const created = new Date(s.createTime).getTime()
      if (Math.abs(now - created) > (fp.windowMs ?? windowMs)) return false
    }

    // 2. Source check
    const sSource = s.sourceContext?.source ?? s.source
    if (fp.source && sSource && sSource !== fp.source) return false

    // 3. Branch check
    const sBranch = s.sourceContext?.githubRepoContext?.startingBranch ?? s.branch
    if (fp.branch && sBranch && sBranch !== fp.branch) return false

    // 4. Title check
    if (fp.title && s.title && s.title !== fp.title) return false

    // 5. Prompt check
    if (s.prompt && fp.taskHash) {
      const sHash = crypto.createHash('sha256').update(String(s.prompt)).digest('hex')
      if (sHash !== fp.taskHash) return false
    }

    return true
  })

  if (!matchingSession) {
    return null
  }

  const rawId = matchingSession.id ?? matchingSession.sessionId ?? matchingSession.name
  const sessionId = typeof rawId === 'string' && rawId.startsWith('sessions/') ? rawId.slice(9) : rawId

  const jobs = listJobsFn(env)
  const linkedJob = jobs.find((j) => j.remote?.sessionId === sessionId || j.sessionId === sessionId)

  return {
    session: matchingSession,
    sessionId,
    job: linkedJob ?? null,
  }
}

/**
 * Calculates effective dispatch timeout with attempt backoff (1x, 1.5x, 2x).
 */
export function calculateDispatchTimeoutS({
  agent,
  model,
  mode = 'read',
  taskType = null,
  explicit = null,
  attempt = 1,
  env = process.env,
  resolveEffectiveTimeoutSFn = resolveEffectiveTimeoutS,
} = {}) {
  const { timeoutS: baseTimeoutS } = resolveEffectiveTimeoutSFn({
    agent,
    model,
    mode,
    taskType,
    explicit,
    env,
  })

  const attemptNum = Math.max(1, attempt || 1)
  const multiplier = attemptNum === 1 ? 1 : attemptNum === 2 ? 1.5 : 2.0
  const effective = Math.round(baseTimeoutS * multiplier)

  return Math.min(ADAPTIVE_TIMEOUT.capS, effective)
}

/**
 * Searches runs for an existing recent job by dispatchKey.
 */
export function findRecentJobByDispatchKey({
  dispatchKey,
  env = process.env,
  listJobsFn = listJobs,
  windowMs = DISPATCH_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const jobs = listJobsFn(env)
  const found = jobs.find((j) => {
    const key = j.dispatchKey ?? j.dispatch_key
    if (key !== dispatchKey) return false
    if (!j.createdAt) return false
    const created = new Date(j.createdAt).getTime()
    const age = now - created
    if (age < 0 || age >= windowMs) return false
    return j.status !== 'failed' && j.status !== 'canceled'
  })
  if (found) return found

  const cached = recentDispatches.get(dispatchKey)
  if (cached) {
    const age = now - cached.timestamp
    if (age >= 0 && age < windowMs) {
      return cached.job
    }
  }

  return null
}

/**
 * Bounded wait for the job a reservation holder recorded as its executionId.
 *
 * The holder creates the job a few milliseconds after reserving, so a short
 * poll is enough. A holder that died in that gap resolves to null and its key is
 * reclaimed by the caller, which keeps a crashed dispatch from blocking the key
 * for the whole dedup window.
 */
async function waitForJobByExecutionId({ executionId, env, listJobsFn, waitMs, pollMs, nowFn }) {
  if (!executionId) return null
  const deadline = nowFn() + waitMs
  for (;;) {
    const found = listJobsFn(env).find((j) => (j.executionId ?? j.execution_id) === executionId)
    if (found) return found
    if (nowFn() >= deadline) return null
    await sleep(pollMs)
  }
}

async function isCandidateUsable(candidate, { cwd, env, runPreflightFn, circuitBreakerOpenFn }) {
  // 'claude' is host-only (see the filter in dispatch() above, which drops
  // it before this preflight ever runs) and never dispatchable: no adapter
  // exists for it (adapters/index.mjs), so it must never be reported usable.
  if (candidate.agent === 'claude') return false
  if (circuitBreakerOpenFn({ agent: candidate.agent, model: candidate.model, env })) return false
  try {
    const pf = await runPreflightFn({ agent: candidate.agent, model: candidate.model, cwd, env, level: 'L2' })
    if (pf?.status === 'unavailable') return false
  } catch {
    return false
  }
  return true
}

/**
 * Main dispatch entrypoint:
 * route() → primer candidato usable → policyFor() → reserva writeLock →
 * createJob con dispatchKey + executionId → executeWithPolicy → fallback automático →
 * retorna { job, dispatchKey, executionId, candidate, jobId, sessionId, abort }
 * (jobId/sessionId/abort = C1.1 execution handle; compat total con callers viejos).
 */
export async function dispatch({
  task,
  taskType,
  cwd,
  mode = 'read',
  workflowStep = null,
  dispatchKey = null,
  // Workflow scoping for the idempotency key (see computeDispatchKey).
  // The engine passes workflow_id; accept workflowId too for direct callers.
  workflowId = null,
  attempt = 1,
  parentExecutionId = null,
  rootExecutionId = null,
  timeoutS,
  category = null,
  // same-tree-fanout (S2): read-job isolation forwarded to startJob
  // ('auto' | 'in-place' | 'scratch'); undefined keeps startJob's default.
  isolation = undefined,
  env = process.env,
  // Harness wait contract: waitMode 'none' returns at create/start,
  // 'attention' observes until terminal OR waiting/attention, 'terminal'
  // only resolves on terminal (keeps observing past waiting states).
  // Default comes from the harness profile when the caller passes none.
  waitMode = undefined,
  // Explicit harness profile id ('generic'|'claude-code'|'opencode').
  // Priority: explicit > AGENT_HUB_HARNESS env > clientHint > generic.
  harness = undefined,
  // MCP client hint ('claude-code'|'opencode'|null, from clientInfo.name).
  // Default-only: never overrides an explicit harness/env/waitMode and
  // never decides anything security-sensitive.
  clientHint = undefined,
  // Local observation budget (seconds) for attention/terminal modes.
  waitTimeoutS = null,
  waitPollIntervalMs = 250,
  onWaiting = null,
  waitExecutionFn = waitExecution,
  // Injectable dependencies
  routeFn = route,
  policyForFn = policyFor,
  executeWithPolicyFn = executeWithPolicy,
  startJobFn = startJob,
  resolveProfileFn = resolveAgyProfile,
  // Explicit per-call agys profile pin ("nope" -> unknown agys profile).
  // Only meaningful for agent 'agy' — validated against the live profile
  // list once the routed/explicit candidate's agent is known. Overrides
  // BOTH auto selection and a global pin (AGENT_HUB_AGYS_PROFILE / mode
  // file `profile`): it is explicit per call, so it wins even under
  // mode 'off' (see the pinned-profile branch below, which never consults
  // resolveProfileFn/getAgysMode).
  profile: pinnedProfile = null,
  // D2 (agy-hub-verification): optional hub-run verification checks, same
  // shapes as src/verify.mjs's normalizeVerifyCheck. Validated below before
  // any route/breaker/reservation state changes ("fails fast before
  // dispatch"), then forwarded to startJobFn untouched — jobrunner.mjs's
  // startJob does the canonical normalization and persists it on the record.
  verify = null,
  listAgysProfilesFn = listAgysProfiles,
  isAgysAvailableFn = isAgysAvailable,
  createJobFn = createJob,
  listJobsFn = listJobs,
  readResultFn = readResult,
  runPreflightFn = runPreflight,
  circuitBreakerOpenFn = circuitBreakerOpen,
  acquireWriteLockFn = acquireWriteLock,
  releaseWriteLockFn = releaseWriteLock,
  calculateTimeoutFn = calculateDispatchTimeoutS,
  fingerprintRemoteIntentFn = fingerprintRemoteIntent,
  findMatchingSessionFn = findMatchingSession,
  nowFn = Date.now,
  adoptWriteLockFn = adoptWriteLock,
  classifyErrorFn = classifyError,
  adapterForFn = defaultAdapterFor,
  cancelJobFn = defaultCancelJob,
  ...restDeps
} = {}) {
  // D2: reject an invalid verify check before any state (breaker checks,
  // reservation, dedup cache) is touched.
  if (Array.isArray(verify) && verify.length > 0) {
    verify.forEach(normalizeVerifyCheck)
  }

  const profileMemo = new Map()
  const resolvedWorkflowId = workflowId ?? restDeps.workflowId ?? restDeps.workflow_id ?? null
  const key = dispatchKey ?? computeDispatchKey({ task, cwd, taskType, workflowStep, workflowId: resolvedWorkflowId })
  // Harness profile + effective wait contract, resolved once per dispatch.
  // An explicit waitMode always wins over every profile default.
  const harnessProfile = resolveHarness({ explicit: harness, env, clientHint })
  const effectiveWaitMode = normalizeWaitMode(waitMode ?? harnessProfile.delegation.defaultWaitMode) ?? 'none'
  // Observes a dispatch result per the effective waitMode. Single funnel:
  // every return path below goes through here, so harness/waitMode travel
  // on the result and 'none' keeps the historical create/start-and-return
  // behavior byte-for-byte (plus the two additive fields).
  const observeWithMode = async (base) => {
    if (effectiveWaitMode === 'none') return base
    const handle = base.__handle
    if (!handle?.jobId) return { ...base, wait: { done: false, timedOut: true, waiting: false, jobId: base.jobId ?? null } }
    const budgetS = Math.max(0.05, waitTimeoutS ?? 60)
    if (effectiveWaitMode === 'attention') {
      const outcome = await waitExecutionFn(handle, {
        timeoutS: budgetS,
        pollIntervalMs: waitPollIntervalMs,
        readResultFn,
        onWaiting,
      })
      return { ...base, wait: outcome }
    }
    // terminal: keep observing past waiting states until a terminal
    // outcome, an abort, or the local budget expires.
    const deadline = nowFn() + Math.max(1, budgetS) * 1000
    let last = null
    for (;;) {
      const remainingS = Math.max(0.05, (deadline - nowFn()) / 1000)
      const outcome = await waitExecutionFn(handle, {
        timeoutS: remainingS,
        pollIntervalMs: waitPollIntervalMs,
        readResultFn,
        onWaiting,
      })
      if (outcome?.waiting && !outcome?.aborted && nowFn() < deadline) {
        last = outcome
        continue
      }
      last = outcome
      break
    }
    if (last?.waiting && nowFn() >= deadline) last = { ...last, timedOut: true }
    return { ...base, wait: last }
  }
  // Wraps a { job, dispatchKey, executionId, candidate } result with the
  // C1.1 execution handle (compat: old fields untouched) plus the harness
  // wait contract, then observes per waitMode (none = return immediately).
  const withHandle = (result, candidateForRemote) => {
    const remoteFlag = Boolean(
      candidateForRemote?.agent === 'jules' ||
      candidateForRemote?.remote === true ||
      result?.job?.remote
    )
    const handle = createExecutionHandle({
      job: result.job,
      sessionId: result.sessionId ?? result.job?.sessionId ?? result.job?.remote?.sessionId ?? null,
      env,
      cancelJobFn,
      isRemote: remoteFlag,
    })
    const base = {
      ...result,
      jobId: handle.jobId,
      sessionId: handle.sessionId,
      abort: (...args) => handle.abort(...args),
      __handle: handle,
      harness: harnessProfile.id,
      waitMode: effectiveWaitMode,
    }
    return observeWithMode(base)
  }

  // 1. Check recent runs for existing job with same dispatchKey
  const existingJob = findRecentJobByDispatchKey({
    dispatchKey: key,
    env,
    listJobsFn,
    windowMs: DISPATCH_WINDOW_MS,
    now: nowFn(),
  })
  if (existingJob) {
    return withHandle({
      job: existingJob,
      dispatchKey: key,
      executionId: existingJob.executionId ?? existingJob.execution_id ?? null,
      candidate: {
        agent: existingJob.agent,
        model: existingJob.model,
        mode: existingJob.mode,
      },
    }, existingJob)
  }

  // 2. Concurrency control: synchronize concurrent dispatches with the same key
  while (inFlightDispatches.has(key)) {
    await inFlightDispatches.get(key)
    const existing = findRecentJobByDispatchKey({
      dispatchKey: key,
      env,
      listJobsFn,
      windowMs: DISPATCH_WINDOW_MS,
      now: nowFn(),
    })
    if (existing) {
      return withHandle({
        job: existing,
        dispatchKey: key,
        executionId: existing.executionId ?? existing.execution_id ?? null,
        candidate: {
          agent: existing.agent,
          model: existing.model,
          mode: existing.mode,
        },
      }, existing)
    }
  }

  let releaseInFlight
  const inFlightPromise = new Promise((resolve) => {
    releaseInFlight = resolve
  })
  inFlightDispatches.set(key, inFlightPromise)

  let reservationToken = null
  let reservationAdopted = false
  // Store-backed idempotency (see step 0 inside the try). Declared here so the
  // finally below can release the key when this dispatch never produced a job.
  let dispatchReservationOwned = false
  let jobProduced = false

  try {
    const execId = `exec_${crypto.randomBytes(6).toString('hex')}`
    const rootExecId = rootExecutionId ?? execId

    // 0. Store-backed idempotency gate.
    //    Steps 1 and 2 above deduplicate within ONE process and only once a job
    //    exists, so two schedulers (or a restart) scanning at the same instant
    //    both miss and both create a job. The reservation is taken first and is
    //    the only gate that survives across processes: the winner records its
    //    executionId, which is what a loser needs to find the job to share.
    const storeCtx = getDb(env)
    let reservation = reserveDispatchKey(storeCtx, { dispatchKey: key, jobId: execId })
    dispatchReservationOwned = reservation.reserved
    // T2: a stale holder can be taken over by someone else first. Re-evaluate
    // the (possibly new) holder on every iteration instead of ever deleting a
    // reservation we did not ourselves just observe — that is what keeps two
    // waiters that saw the same dead holder from both proceeding as owner.
    while (!reservation.reserved) {
      const holderAgeMs = nowFn() - (Date.parse(reservation.existingCreatedAt ?? '') || 0)
      const holderInWindow = holderAgeMs >= 0 && holderAgeMs < DISPATCH_WINDOW_MS
      const sharedJob = holderInWindow
        ? await waitForJobByExecutionId({
            executionId: reservation.existingJobId,
            env,
            listJobsFn,
            waitMs: DISPATCH_RESERVATION_WAIT_MS,
            pollMs: DISPATCH_RESERVATION_POLL_MS,
            nowFn,
          })
        : null
      if (sharedJob && sharedJob.status !== 'failed' && sharedJob.status !== 'canceled') {
        jobProduced = true
        recentDispatches.set(key, { job: sharedJob, timestamp: nowFn() })
        return withHandle(
          {
            job: sharedJob,
            dispatchKey: key,
            executionId: sharedJob.executionId ?? sharedJob.execution_id ?? null,
            candidate: { agent: sharedJob.agent, model: sharedJob.model, mode: sharedJob.mode },
          },
          sharedJob
        )
      }
      // The holder died between reserving and creating its job, its job failed,
      // or the reservation outlived the dedup window: take the key over so this
      // dispatch can proceed instead of sharing a corpse. The release is
      // conditional on the exact holder we just observed (T2 CAS): if another
      // dispatcher already took over first, this delete is a no-op, the
      // following reserve fails again against the NEW holder, and the loop
      // re-evaluates that holder instead of clobbering it.
      releaseDispatchReservation(storeCtx, key, reservation.existingJobId)
      reservation = reserveDispatchKey(storeCtx, { dispatchKey: key, jobId: execId })
      dispatchReservationOwned = reservation.reserved
    }

    // 3. Candidate discovery & TOCTOU revalidation
    let primaryCandidate = null
    let fallbackCandidates = []

    if (restDeps.candidate) {
      primaryCandidate = restDeps.candidate
      fallbackCandidates = restDeps.fallbacks ? [...restDeps.fallbacks] : []
    } else {
      const routeResult = await routeFn({ taskType, mode, env })
      if (!routeResult || !routeResult.primary) {
        throw new Error(routeResult?.reason || `No available candidate for taskType "${taskType}"`)
      }

      const allCandidates = [routeResult.primary, ...(routeResult.fallbacks || [])]

      // Host-only: `agent: 'claude'` is routed by DELEGATION_MAP for the
      // host's own Agent tool -- there is no 'claude' entry in
      // adapters/index.mjs, so startJobFn would throw deep inside startJob,
      // after the worktree lock and dispatch-key reservation are already
      // held (2026-09-28 incident: combined with the pre-fix fallback bug in
      // executeWithPolicy, this froze the whole MCP process). Drop these
      // candidates from the executable chain up front, before any usability
      // preflight or reservation runs.
      const executableCandidates = allCandidates.filter((c) => c.agent !== 'claude')
      const onlyHostOnlyCandidates = allCandidates.length > 0 && executableCandidates.length === 0

      const usableCandidates = []
      for (const c of executableCandidates) {
        const usable = await isCandidateUsable(c, { cwd, env, runPreflightFn, circuitBreakerOpenFn })
        if (usable) {
          usableCandidates.push(c)
        }
      }

      if (usableCandidates.length === 0) {
        if (onlyHostOnlyCandidates) {
          const routedModel = allCandidates[0]?.model ?? 'unknown'
          const err = new Error(
            `Task "${taskType}" routes to Claude Code itself (model ${routedModel}) and must be run ` +
            `through the host's Agent tool, not dispatched.`
          )
          err.errorKind = 'host_only'
          err.category = 'host_only'
          throw err
        }
        throw new Error(`Every candidate for "${taskType}" is unavailable at execution time`)
      }

      primaryCandidate = usableCandidates[0]
      fallbackCandidates = usableCandidates.slice(1)
    }

    // Explicit profile pin: validate fast, before any job is started. Only
    // meaningful for agent 'agy' — any other agent rejects instead of
    // silently ignoring a pin that would never apply (mirrors delegateTool).
    let normalizedPinnedProfile = null
    if (typeof pinnedProfile === 'string' && pinnedProfile.trim() !== '') {
      normalizedPinnedProfile = pinnedProfile.trim()
      if (primaryCandidate.agent !== 'agy') {
        throw new Error(`profile is only meaningful for agent "agy" (got "${primaryCandidate.agent}")`)
      }
      const available = await isAgysAvailableFn({ env })
      if (!available) {
        throw new Error(`agys is unavailable; cannot validate profile "${normalizedPinnedProfile}"`)
      }
      const profiles = await listAgysProfilesFn({ env })
      const names = (Array.isArray(profiles) ? profiles : []).map((p) => p.name)
      if (!names.includes(normalizedPinnedProfile)) {
        throw new Error(`unknown agys profile "${normalizedPinnedProfile}"; valid profiles: ${names.join(', ') || '(none)'}`)
      }
    }

    // Helper to determine if a candidate is remote
    const isRemoteCandidate = (c) => {
      if (!c) return false
      if (c.agent === 'jules' || c.remote === true) return true
      if (restDeps.adapter?.remote === true) return true
      try {
        return Boolean(adapterForFn(c.agent)?.remote)
      } catch {
        return false
      }
    }

    const isRemote = isRemoteCandidate(primaryCandidate)

    let matchedSessionId = restDeps.sessionId ?? null

    // 4. Remote reconciliation for Jules / remote candidates
    if (primaryCandidate.agent === 'jules' || isRemote) {
      const fingerprint = fingerprintRemoteIntentFn({
        source: restDeps.source,
        branch: restDeps.startingBranch ?? restDeps.branch,
        task,
        title: restDeps.title,
        now: nowFn(),
      })

      const matched = await findMatchingSessionFn({
        fingerprint,
        source: restDeps.source,
        branch: restDeps.startingBranch ?? restDeps.branch,
        task,
        title: restDeps.title,
        now: nowFn(),
        env,
        listJobsFn,
        client: restDeps.client,
        apiKey: restDeps.apiKey,
        sessions: restDeps.sessions,
      })

      if (matched?.sessionId) {
        matchedSessionId = matched.sessionId
      } else if (matched?.session) {
        const rawId = matched.session.id ?? matched.session.sessionId ?? matched.session.name
        matchedSessionId = typeof rawId === 'string' && rawId.startsWith('sessions/') ? rawId.slice(9) : rawId
      }

      if (matched?.job) {
        const jobSessId = matched.job.remote?.sessionId ?? matched.job.sessionId
        if (jobSessId) matchedSessionId = jobSessId
        if (matched.job.status !== 'failed' && matched.job.status !== 'canceled') {
          jobProduced = true
          recentDispatches.set(key, { job: matched.job, timestamp: nowFn() })
          return withHandle({
            job: matched.job,
            dispatchKey: key,
            executionId: matched.job.executionId ?? matched.job.execution_id ?? execId,
            candidate: primaryCandidate,
          }, primaryCandidate)
        }
      } else if (matched?.session && !matched?.job) {
        const adoptedJob = createJobFn({
          agent: primaryCandidate.agent,
          model: primaryCandidate.model ?? 'default',
          task: task ?? matched.session.prompt ?? '',
          cwd: null,
          title: restDeps.title ?? matched.session.title ?? '',
          mode: 'write',
          remote_state: matched.session.state ?? 'IN_PROGRESS',
          sessionId: matchedSessionId,
          dispatchKey: key,
          executionId: execId,
          attempt,
          parent_execution_id: parentExecutionId,
          root_execution_id: rootExecId,
          env,
          harness: harnessProfile.id,
          waitMode: effectiveWaitMode,
        })
        jobProduced = true
        recentDispatches.set(key, { job: adoptedJob, timestamp: nowFn() })
        return withHandle({
          job: adoptedJob,
          dispatchKey: key,
          executionId: execId,
          candidate: primaryCandidate,
        }, primaryCandidate)
      }
    }

    const resolvedSessionId = matchedSessionId ?? restDeps.job?.remote?.sessionId ?? restDeps.job?.sessionId ?? restDeps.sessionId ?? null

    // 5. Worktree reservation (honest reservation token)
    if (mode === 'write' && !isRemote) {
      const lock = acquireWriteLockFn({ cwd, jobId: execId, env })
      if (!lock.acquired) {
        const err = new Error(`Worktree locked: ${lock.reason}`)
        err.errorKind = 'locked'
        err.category = 'write-conflict'
        throw err
      }
      reservationToken = lock.token
    }

    // 6. Policy resolution & recovery execution
    const recoveryOrder = isRemote
      ? ['resume', 'fallback', 'retry', 'escalate']
      : ['retry', 'resume', 'fallback', 'escalate']

    const resolvePolicyForError = (err) => {
      if (category) {
        return policyForFn(category) || {
          retry: 1,
          resume: false,
          fallback: true,
          escalation: 'human',
        }
      }
      const meta = {
        errorKind: err?.errorKind ?? err?.result?.errorKind ?? err?.result?.job?.errorKind,
        status: err?.status ?? err?.statusCode ?? err?.result?.status ?? err?.result?.job?.status,
        category: err?.category ?? err?.result?.category,
      }
      const cat = classifyErrorFn(err, meta)
      const pol = cat ? policyForFn(cat) : null
      return pol || policyForFn('default') || {
        retry: 1,
        resume: false,
        fallback: true,
        escalation: 'human',
      }
    }

    const execCtx = {
      candidate: primaryCandidate,
      fallbacks: [...fallbackCandidates],
      recoveryOrder,
      sessionId: resolvedSessionId,
      policyFor: policyForFn,
      onResume: restDeps.onResume,
      onFallback: async ({ candidate }) => {
        // Ensure the candidate popped from fallbacks is still usable
        if (candidate) {
          const usable = await isCandidateUsable(candidate, { cwd, env, runPreflightFn, circuitBreakerOpenFn })
          if (!usable && execCtx.fallbacks.length > 0) {
            execCtx.candidate = execCtx.fallbacks.shift()
          }
        }
      },
      ...restDeps,
    }

    const execResult = await executeWithPolicyFn(
      async (activeCtx) => {
        const candidate = activeCtx.candidate
        const attemptNum = (activeCtx.attempt ?? 0) + (attempt || 1)

        const effectiveTimeoutS = calculateTimeoutFn({
          agent: candidate.agent,
          model: candidate.model,
          mode: candidate.mode ?? mode,
          taskType,
          explicit: timeoutS,
          attempt: attemptNum,
          env,
        })

        let profile = null
        let profileStatus = null

        if (candidate?.agent === 'agy' && normalizedPinnedProfile) {
          // Pinned wins outright: never consult resolveProfileFn/the memo, so
          // a 429-driven failover (fallback stage) can swap the CANDIDATE
          // (agent/model) but never swaps the pinned account — the job just
          // fails with quota on that account, same as an unpinned exhausted
          // pick would, and recordQuotaExhaustion still runs on that error.
          profile = normalizedPinnedProfile
          profileStatus = 'pinned'
        } else if (candidate?.agent === 'agy') {
          // Quota is per model group (Gemini vs Claude/GPT — see
          // src/providers/profiles.mjs), so the memo is keyed by agent+group,
          // not just agent: a fallback in a DIFFERENT group (e.g. a gemini
          // primary falling back to a claude candidate) must re-resolve
          // instead of reusing the other group's profile.
          const memoKey = `${candidate.agent}:${modelGroupFor(candidate.model) ?? 'unknown'}`
          if (!profileMemo.has(memoKey)) {
            try {
              // reserve:true — this pick is actually about to start a job, so
              // it must reserve a same-tick load slot (T2 burst spreading);
              // see the matching comment in jobrunner.mjs's startJob.
              const res = await resolveProfileFn({ env, model: candidate.model, reserve: true })
              if (res && typeof res === 'object') {
                const p = typeof res.profile === 'string' && res.profile.trim() !== '' ? res.profile.trim() : null
                const s = typeof (res.profileStatus ?? res.status) === 'string' && (res.profileStatus ?? res.status).trim() !== ''
                  ? (res.profileStatus ?? res.status).trim()
                  : null
                profileMemo.set(memoKey, { profile: p, profileStatus: p ? s : null })
              } else {
                profileMemo.set(memoKey, { profile: null, profileStatus: null })
              }
            } catch {
              profileMemo.set(memoKey, { profile: null, profileStatus: null })
            }
          }
          const memoEntry = profileMemo.get(memoKey)
          profile = memoEntry?.profile ?? null
          profileStatus = memoEntry?.profileStatus ?? null
        }

        const startResult = await startJobFn({
          agent: candidate.agent,
          model: candidate.model,
          task,
          cwd,
          mode: candidate.mode ?? mode,
          timeoutS: effectiveTimeoutS,
          taskType,
          dispatchKey: key,
          executionId: execId,
          attempt: attemptNum,
          parentExecutionId,
          rootExecutionId: rootExecId,
          reservationToken,
          adoptWriteLockFn,
          workflow_id: restDeps.workflowId ?? restDeps.workflow_id,
          step_id: workflowStep ?? restDeps.step_id,
          sessionId: activeCtx.sessionId,
          resumed: activeCtx.resumed,
          env,
          ...restDeps,
          verify,
          ...(isolation ? { isolation } : {}),
          profile,
          profileStatus,
          // Resolved contract always wins over caller extras.
          harness: harnessProfile.id,
          waitMode: effectiveWaitMode,
        })

        reservationAdopted = true

        const job = startResult?.job ?? startResult
        const status = job?.status
        const error = job?.error
        const errorKind = job?.errorKind
        const currentSessionId = job?.sessionId ?? job?.remote?.sessionId ?? startResult?.sessionId ?? activeCtx.sessionId

        return {
          job,
          candidate,
          status,
          error,
          errorKind,
          sessionId: currentSessionId,
        }
      },
      resolvePolicyForError,
      execCtx
    )

    const finalJob = execResult?.job ?? execResult
    const finalCandidate = execResult?.candidate ?? primaryCandidate

    jobProduced = true
    recentDispatches.set(key, { job: finalJob, timestamp: nowFn() })

    const finalSessionId =
      execResult?.sessionId ?? finalJob?.sessionId ?? finalJob?.remote?.sessionId ?? resolvedSessionId ?? null
    return withHandle({
      job: finalJob,
      dispatchKey: key,
      executionId: execId,
      candidate: finalCandidate,
      sessionId: finalSessionId,
    }, finalCandidate)
  } finally {
    if (reservationToken && !reservationAdopted) {
      try {
        releaseWriteLockFn({ cwd, token: reservationToken, env })
      } catch {}
    }
    // A dispatch that never produced a job must not keep its key: otherwise the
    // failed attempt would block every retry for the whole dedup window.
    // T2: conditional on execId — this dispatcher may have lost the key to a
    // takeover after `dispatchReservationOwned` was last set true, and an
    // unconditional release here would delete that takeover's own reservation.
    if (dispatchReservationOwned && !jobProduced) {
      try {
        releaseDispatchReservation(getDb(env), key, execId)
      } catch {}
    }
    inFlightDispatches.delete(key)
    releaseInFlight?.()
  }
}

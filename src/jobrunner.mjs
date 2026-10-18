import fs from 'node:fs'
import { spawnDetached, runWithTimeout as defaultRunWithTimeout, killProcessGroup, runCommand as defaultRunCommand } from './process.mjs'
import { createJob, updateResult, appendStdout, stdoutPath, responsePath, readResult } from './jobstore.mjs'
import { appendEvent } from './eventlog.mjs'
import { adapterFor as defaultAdapterFor } from './adapters/index.mjs'
import { checkWriteAllowed, acquireWriteLock, releaseWriteLock, heartbeatWriteLock, LEASE_TTL_MS_DEFAULT, adoptWriteLock } from './worktree.mjs'
import { resolveVariant, KILL_GRACE_S, SANDBOX } from './config.mjs'
import { resolveSandboxProfile, filterEnv, sandboxTelemetry } from './sandbox.mjs'
import { resolveEffectiveTimeoutS as defaultResolveEffectiveTimeoutS } from './timeouts.mjs'
import { selectLearnings as defaultSelectLearnings, augmentTask as defaultAugmentTask } from './learnings.mjs'
import { takeSnapshot as defaultTakeSnapshot, diffSnapshots as defaultDiffSnapshots, formatViolation as defaultFormatViolation } from './readguard.mjs'
import { startRemoteJob as defaultStartRemoteJob } from './cloud/runner.mjs'
import { resolveAgyCommand, profileFromEnv, resolveAgyProfileSync as defaultResolveAgyProfileSync, recordQuotaExhaustion as defaultRecordQuotaExhaustion } from './providers/agys.mjs'
import { modelGroupFor } from './providers/profiles.mjs'
import {
  captureDiffBase as defaultCaptureDiffBase,
  captureRepoInfo as defaultCaptureRepoInfo,
  computeDiffStats as defaultComputeDiffStats,
  computeChangedFilesMismatch as defaultComputeChangedFilesMismatch,
} from './diffstats.mjs'
import { readHandoff as defaultReadHandoff } from './context.mjs'
import { normalizeVerifyCheck, runJobVerification as defaultRunJobVerification } from './verify.mjs'
import { readDiscovery as defaultReadDiscovery } from './discovery.mjs'
import { validateVariant as defaultValidateVariant } from './catalog.mjs'

// jobId -> { pgid, leaseToken, heartbeatTimer, leaseTtlMs } for jobs still
// running in THIS process. Used by cancelJob for an immediate kill; the
// leaseToken lets cancel/finish release ONLY the lease this job acquired —
// never a new holder's lease after a reclaim. reconcileOrphans
// (jobstore.mjs) covers jobs left running by a process that died without
// ever calling cancelJob.
const active = new Map()

// Bound on the best-effort server-side session.interrupt cleanup fired on an
// opencode-style timeout (E19). Short and fixed, not derived from the job's
// own timeoutS/KILL_GRACE_S: this is cleanup after the job has already been
// finalized as failed, so it must never meaningfully delay that finalization
// even if the CLI/server is unresponsive.
const INTERRUPT_TIMEOUT_MS = 5000

/** Lease TTL for a write job's lock: explicit opt wins, then
 * AGENT_HUB_LEASE_TTL_MS, then the worktree default. */
export function resolveLeaseTtlMs(env = process.env, override) {
  const n = Number(override ?? env?.AGENT_HUB_LEASE_TTL_MS)
  return Number.isFinite(n) && n > 0 ? n : LEASE_TTL_MS_DEFAULT
}

function stopHeartbeat(jobId) {
  const entry = active.get(jobId)
  if (entry?.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer)
    entry.heartbeatTimer = null
  }
}

/**
 * While a write job runs, refresh its lease every ttlMs/3 so a long job
 * never loses its lock mid-run. If the lease was reclaimed by someone else
 * (heartbeat returns false — e.g. this process was paused past expiry), the
 * timer stops itself: beating a dead lease is pointless, and the terminal
 * release below (token-guarded) will correctly no-op instead of deleting the
 * new holder's lease.
 */
function startHeartbeat({ jobId, cwd, token, ttlMs, env }) {
  const intervalMs = Math.min(ttlMs, Math.max(50, Math.floor(ttlMs / 3)))
  const timer = setInterval(() => {
    let ok = false
    try {
      ok = heartbeatWriteLock({ cwd, token, env, ttlMs })
    } catch {
      ok = false
    }
    if (!ok) clearInterval(timer)
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  const entry = active.get(jobId)
  if (entry) entry.heartbeatTimer = timer
  else active.set(jobId, { heartbeatTimer: timer })
}
// Emit the compatibility-sandbox warning once per process, not per job.
let _warnedCompatibility = false

function summarize(text, max = 300) {
  if (!text) return ''
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * D2 (agy-hub-verification): a job that reaches a terminal state OTHER than
 * 'succeeded' (incomplete/failed/read_mode_violation/canceled) never runs
 * its `verify` checks — but if the caller asked for verification, that must
 * be recorded, not silently dropped (see docs/verification.md).
 */
function skippedVerification(reason) {
  return { ok: null, checks: [], skipped: true, reason }
}

/**
 * Start a job. Returns immediately with the queued/failed-fast job record;
 * the actual CLI run happens in the background. `done` resolves once the
 * job reaches a terminal state — tests can await it; the MCP layer polls
 * jobstore instead, which also works after a process restart.
 */
export function startJob({
  agent,
  model,
  task,
  cwd,
  mode = 'read',
  title = '',
  maxLines = 20,
  timeoutS,
  taskType = null,
  turnDepth = 0,
  allowlist = [],
  env = process.env,
  spawn = spawnDetached,
  adapterFor = defaultAdapterFor,
  runWithTimeout = defaultRunWithTimeout,
  runCommandFn = defaultRunCommand,
  variant,
  profile = null,
  profileStatus = null,
  resolveAgyProfileSyncFn = defaultResolveAgyProfileSync,
  recordQuotaExhaustionFn = defaultRecordQuotaExhaustion,
  sessionId,
  parentJobId,
  resolveEffectiveTimeoutSFn = defaultResolveEffectiveTimeoutS,
  selectLearningsFn = defaultSelectLearnings,
  augmentTaskFn = defaultAugmentTask,
  takeSnapshotFn = defaultTakeSnapshot,
  diffSnapshotsFn = defaultDiffSnapshots,
  formatViolationFn = defaultFormatViolation,
  // Jules-only fields, forwarded untouched to startRemoteJobFn for a remote
  // adapter; unused (and harmless) for every local agent.
  source,
  startingBranch,
  requirePlanApproval,
  automationMode,
  startRemoteJobFn = defaultStartRemoteJob,
  // Lease TTL for this job's write lock (ms). Defaults to
  // AGENT_HUB_LEASE_TTL_MS / LEASE_TTL_MS_DEFAULT via resolveLeaseTtlMs.
  leaseTtlMs,
  // A1 dispatch / C0 provenance fields
  dispatchKey,
  executionId,
  parentExecutionId,
  rootExecutionId,
  attempt,
  workflow_id,
  step_id,
  reservationToken,
  adoptWriteLockFn = adoptWriteLock,
  acquireWriteLockFn = acquireWriteLock,
  // Harness profile id + dispatch waitMode (informational: persisted on the
  // record and events, never gates/locks/routes — see harness/registry.mjs).
  harness = null,
  waitMode = null,
  // job-diff-stats: injectable so tests never shell out to a real git binary.
  captureDiffBaseFn = defaultCaptureDiffBase,
  // job-project-branch: injectable so tests never shell out to a real git binary.
  captureRepoInfoFn = defaultCaptureRepoInfo,
  // D2 (agy-hub-verification): optional hub-run verification checks (same
  // shapes as src/verify.mjs's normalizeVerifyCheck). Validated synchronously
  // below, before any job record exists — "fails fast before dispatch".
  verify = null,
  runJobVerificationFn = defaultRunJobVerification,
  // T3 (opencode-live-catalog): injectable so tests never read the real
  // discovery.json, and so a future adapter/agent can swap in its own
  // validation without touching startJob's body.
  readDiscoveryFn = defaultReadDiscovery,
  validateVariantFn = defaultValidateVariant,
}) {
  // D2: one bad check must reject the whole call before any side effect
  // (job record, write lock, spawn) — mirrors the adapterFor(agent) throw
  // just below for an unknown agent.
  const normalizedVerify = Array.isArray(verify) && verify.length > 0 ? verify.map(normalizeVerifyCheck) : null

  // Resolved BEFORE anything else — including learnings/timeout/createJob —
  // because a remote adapter (Jules) edits a branch on GitHub via its own
  // infrastructure, never this process's cwd: the "must be a secondary
  // worktree" write-mode gate and the read-mode snapshot must never run for
  // it. One side effect: an unknown agent now throws here, before any job
  // record exists (previously adapterFor ran after createJob/the write gate;
  // no existing test pinned that ordering).
  const adapter = adapterFor(agent)
  if (adapter.remote) {
    return startRemoteJobFn({
      agent,
      model,
      task,
      cwd,
      title,
      source,
      startingBranch,
      requirePlanApproval,
      automationMode,
      timeoutS,
      taskType,
      turnDepth,
      parentJobId,
      env,
      adapter,
      resolveEffectiveTimeoutSFn,
      selectLearningsFn,
      augmentTaskFn,
      dispatchKey,
      executionId,
      parentExecutionId,
      rootExecutionId,
      attempt,
      workflow_id,
      step_id,
    })
  }

  // Only a root turn (no resumed session, depth 0) gets curated learnings
  // prepended — a reply turn continues a conversation that already has them.
  const isRootTurn = !sessionId && (turnDepth ?? 0) === 0
  let effectiveTask = task
  let learningIds = []
  if (isRootTurn) {
    const selected = selectLearningsFn({ agent, model, taskType, env })
    const augmented = augmentTaskFn(task, selected)
    effectiveTask = augmented.task
    learningIds = Array.isArray(augmented.learningIds) ? augmented.learningIds : []
  }

  // Resolve the effective timeout BEFORE createJob so the record persists the
  // value actually used for the adapter and the kill timer, not the raw input.
  const { timeoutS: effectiveTimeoutS, source: timeoutSource } = resolveEffectiveTimeoutSFn({
    agent,
    model,
    mode,
    taskType,
    explicit: timeoutS,
    env,
  })
  // T3 (opencode-live-catalog): drop a variant the live catalog no longer
  // supports (or never did) before it ever reaches the CLI as a
  // provider.no-route failure -- an explicit `model#variant` id is validated
  // the same way (see validateVariant's own precedence rule). A missing/
  // errored/empty catalog, or a model the catalog doesn't list, leaves this
  // completely unchanged (no evidence to second-guess against).
  const requestedVariant = resolveVariant(agent, model, variant)
  const variantCheck = validateVariantFn({ agent, model, variant: requestedVariant, discovery: readDiscoveryFn(env) })
  model = variantCheck.model
  const effectiveVariant = variantCheck.variant
  // agy may run through agys (multi-account profiles). Resolution is env-based
  // and SYNCHRONOUS: startJob is synchronous and delegate()/dispatch()
  // read `.job` immediately.
  let effectiveProfile = null
  let effectiveProfileStatus = null
  if (adapter.cmd === 'agy') {
    if (profile) {
      effectiveProfile = profile
      effectiveProfileStatus = profileStatus ?? 'selected'
    } else {
      // reserve:true — this pick is actually about to start a job, so it must
      // reserve a same-tick load slot (T2 burst spreading); an
      // informational-only caller (e.g. router.mjs's annotation) must not.
      const resolved = resolveAgyProfileSyncFn({ env, model, reserve: true })
      effectiveProfile = resolved?.profile ?? null
      effectiveProfileStatus = effectiveProfile ? (resolved?.status ?? 'selected') : null
    }
  }
  const job = createJob({
    agent,
    model,
    task: effectiveTask,
    cwd,
    title,
    mode,
    timeoutS: effectiveTimeoutS,
    timeoutSource,
    taskType,
    turnDepth,
    learningIds,
    env,
    variant: effectiveVariant,
    sessionId,
    parentJobId,
    dispatchKey,
    executionId,
    parentExecutionId,
    rootExecutionId,
    attempt,
    workflow_id,
    step_id,
    harness,
    waitMode,
    profile: effectiveProfile,
    profileStatus: effectiveProfileStatus,
  })
  appendEvent({ kind: 'job.queued', agent, model, cwd, title, jobId: job.jobId, taskType, harness: harness ?? null, waitMode: waitMode ?? null }, { env })

  // T3 (opencode-live-catalog): record the dropped-variant warning on the
  // job record so a caller (and the dashboard) can see why the run used the
  // model's default instead of the requested reasoning effort.
  if (variantCheck.warning) {
    updateResult(job.jobId, { warnings: [variantCheck.warning] }, env)
  }

  // D2: persisted on the record (not just closed over) so cancelJob -- which
  // only receives a jobId -- can also see it and record a skipped reason.
  if (normalizedVerify) {
    updateResult(job.jobId, { verify: normalizedVerify }, env)
  }

  // Token of the lease THIS job acquired (null for read mode / remote /
  // gate failures). Every later release/heartbeat for this job must use it,
  // so a stale holder can never delete a new holder's lease after a reclaim.
  let leaseToken = null

  if (mode === 'write') {
    const gate = checkWriteAllowed({ cwd, allowlist })
    if (!gate.allowed) {
      updateResult(job.jobId, { status: 'failed', errorKind: 'worktree_denied', error: gate.reason }, env)
      appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'worktree_denied', taskType, summary: gate.reason, harness: harness ?? null, waitMode: waitMode ?? null, profile: effectiveProfile, profileStatus: effectiveProfileStatus }, { env })
      return { job: readResult(job.jobId, env), done: Promise.resolve() }
    }
    leaseTtlMs = resolveLeaseTtlMs(env, leaseTtlMs)
    if (reservationToken) {
      const adoption = adoptWriteLockFn({ cwd, token: reservationToken, jobId: job.jobId, env, ttlMs: leaseTtlMs })
      if (!adoption.adopted) {
        updateResult(job.jobId, { status: 'failed', errorKind: 'locked', error: `Reservation invalid: ${adoption.reason}` }, env)
        appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'locked', taskType, summary: `Reservation invalid: ${adoption.reason}`, harness: harness ?? null, waitMode: waitMode ?? null, profile: effectiveProfile, profileStatus: effectiveProfileStatus }, { env })
        return { job: readResult(job.jobId, env), done: Promise.resolve() }
      }
      leaseToken = adoption.token
    } else {
      const lock = acquireWriteLockFn({ cwd, jobId: job.jobId, env, ttlMs: leaseTtlMs })
      if (!lock.acquired) {
        updateResult(job.jobId, { status: 'failed', errorKind: 'locked', error: lock.reason }, env)
        appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'locked', taskType, summary: lock.reason, harness: harness ?? null, waitMode: waitMode ?? null, profile: effectiveProfile, profileStatus: effectiveProfileStatus }, { env })
        return { job: readResult(job.jobId, env), done: Promise.resolve() }
      }
      leaseToken = lock.token
    }
  }

  // job-diff-stats: baseline HEAD, captured synchronously before the CLI
  // spawns so a later `git diff --numstat <base>` also sees any commit the
  // agent itself makes during the run. Only for write mode, and only when
  // cwd is actually a git work tree with at least one commit — every other
  // case (read mode, non-git cwd, no commits yet) silently stays null, per
  // this feature's "no baseline -> no stats, no error" contract.
  let diffBase = null
  if (mode === 'write') {
    diffBase = captureDiffBaseFn({ cwd, env })
    if (diffBase) updateResult(job.jobId, { diffBase }, env)
  }

  // job-project-branch: which repo/branch a job's cwd lives in, for the
  // dashboard's "Project" column. Unlike diffBase this is captured for
  // every local-cwd mode (read AND write) -- it's purely informational, not
  // a diff baseline -- and silently stays null for a non-git cwd. A remote
  // (Jules) job has already returned above and never reaches this line.
  if (cwd) {
    const repoInfo = captureRepoInfoFn({ cwd, env })
    if (repoInfo) updateResult(job.jobId, { repo: repoInfo }, env)
  }

  const adapterArgs = { model, prompt: effectiveTask, cwd, mode, title, variant: effectiveVariant, timeoutS: effectiveTimeoutS, sessionId, env }
  const argv = adapter.buildArgv(adapterArgs)
  // Only opencode (v2) provides stdinFor: its prompt travels on stdin
  // instead of argv (E3/E4). Every other adapter is unaffected -- the
  // optional chaining leaves stdin undefined for them, which spawnDetached
  // treats as "no stdin", byte-identical to before.
  const stdin = adapter.stdinFor?.(adapterArgs)

  // Snapshot right before spawning, AFTER the write gate/lock: a gate failure
  // must never be judged by a snapshot it never ran against.
  const snapshot = mode === 'read' || mode === 'write' ? takeSnapshotFn(cwd, { env }) : null

  // The local CLIs are third-party processes outside our control. Secrets
  // are always redacted; HOME isolation depends on the sandbox profile.
  const sandboxProfile = resolveSandboxProfile(env.AGENT_HUB_SANDBOX_PROFILE)
  const childEnv = filterEnv({ ...process.env }, sandboxProfile)
  // opencode v2 resolves its own working directory as
  // `process.env.PWD ?? process.cwd()` before chdir'ing (E14). A stale
  // inherited PWD (agent-hub itself may be running from a different
  // worktree than the one it delegates into) would silently redirect the
  // child into the wrong directory. Set it explicitly for every adapter so
  // it always agrees with the `cwd` passed to spawn below.
  childEnv.PWD = cwd

  if (sandboxProfile === 'compatibility' && !_warnedCompatibility) {
    _warnedCompatibility = true
    console.warn('Agent running in compatibility sandbox: environment secrets filtered, HOME inherited. Use isolated-home for stronger credential isolation.')
  }

  const resolved = resolveAgyCommand({ profile: effectiveProfile, agyCmd: adapter.cmd, agyArgv: argv })

  let child
  try {
    child = spawn(resolved.cmd, resolved.args, { cwd, env: childEnv, stdin })
  } catch (error) {
    updateResult(job.jobId, { status: 'failed', errorKind: 'crash', error: String(error?.message ?? error) }, env)
    appendEvent({ kind: 'job.failed', agent, model, cwd, title, jobId: job.jobId, errorKind: 'crash', taskType, summary: String(error?.message ?? error), harness: harness ?? null, waitMode: waitMode ?? null, profile: effectiveProfile, profileStatus: effectiveProfileStatus }, { env })
    if (mode === 'write') releaseWriteLock({ cwd, token: leaseToken, jobId: job.jobId, env })
    return { job: readResult(job.jobId, env), done: Promise.resolve() }
  }

  updateResult(job.jobId, { status: 'running', pid: child.pid, pgid: child.pid }, env)
  const sandbox = sandboxTelemetry(childEnv, process.env, sandboxProfile)
  appendEvent({ kind: 'job.started', agent, model, cwd, title, jobId: job.jobId, taskType, sandbox, harness: harness ?? null, waitMode: waitMode ?? null, profile: effectiveProfile, profileStatus: effectiveProfileStatus }, { env })
  // adapter/runCommandFn are stashed so cancelJob can reach them: a user
  // cancel kills the same process group a timeout does, and must interrupt
  // the server-side session just as the timeout path does.
  active.set(job.jobId, { pgid: child.pid, leaseToken, adapter, runCommandFn, profile: effectiveProfile })
  if (mode === 'write') startHeartbeat({ jobId: job.jobId, cwd, token: leaseToken, ttlMs: leaseTtlMs, env })

  // Hard-kill at timeoutS + KILL_GRACE_S, not at timeoutS itself: agy is
  // given --print-timeout <timeoutS>s (see buildArgv above) and exits on its
  // own — with a partial/empty result on stdout — when that fires. The extra
  // grace period lets that graceful, partial-output-preserving exit happen
  // before this hub SIGTERM->SIGKILLs the whole process group.
  const { exitPromise } = runWithTimeout(child, {
    timeoutMs: (effectiveTimeoutS + KILL_GRACE_S) * 1000,
    onStdout: (chunk) => appendStdout(job.jobId, chunk, env),
    onStderr: (chunk) => appendStdout(job.jobId, chunk, env),
  })

  const done = exitPromise
    .then(({ code, timedOut }) =>
      finishJob({ jobId: job.jobId, agent, model, cwd, title, adapter, mode, env, timedOut, exitCode: code, taskType, snapshot, takeSnapshotFn, diffSnapshotsFn, formatViolationFn, harness, waitMode, runCommandFn, profile: effectiveProfile, profileStatus: effectiveProfileStatus, recordQuotaExhaustionFn, diffBase, verify: normalizedVerify, runJobVerificationFn })
    )
    .finally(() => {
      stopHeartbeat(job.jobId)
      active.delete(job.jobId)
      // Token-guarded: if this job's lease already expired and was reclaimed
      // by another holder, the stale token no longer matches and this
      // correctly no-ops instead of deleting the new holder's lease.
      if (mode === 'write') releaseWriteLock({ cwd, token: leaseToken, jobId: job.jobId, env })
    })

  return { job: readResult(job.jobId, env), done }
}

/**
 * Best-effort server-side session interrupt, fired when a job finalizes as
 * timed out (E19/E13/T10 — see odd/tasks/opencode-v2-migration.md). Only
 * opencode defines `adapter.interruptArgv`; every other adapter (agy, codex,
 * copilot, jules) is entirely unaffected since this is a no-op without it.
 *
 * This must never throw into the caller's finalization path and must never
 * block it beyond INTERRUPT_TIMEOUT_MS — both are enforced here rather than
 * relied upon from the adapter or runCommandFn.
 */
async function attemptServerInterrupt({ adapter, agent, model, cwd, title, jobId, taskType, sessionId, env, harness, waitMode, runCommandFn, profile = null }) {
  if (!sessionId || typeof adapter.interruptArgv !== 'function') return

  let argv
  try {
    argv = adapter.interruptArgv({ sessionId })
  } catch {
    return // a broken hook must not affect finalization
  }
  if (!Array.isArray(argv) || argv.length === 0) return

  let interrupted = null
  let ranOk = false
  try {
    const resolved = resolveAgyCommand({ profile, agyCmd: adapter.cmd, agyArgv: argv })
    const result = await runCommandFn(resolved.cmd, resolved.args, { env, timeoutMs: INTERRUPT_TIMEOUT_MS })
    ranOk = result?.code === 0 && !result?.timedOut
    if (ranOk) {
      try {
        const parsed = JSON.parse(result.stdout)
        interrupted = typeof parsed?.interrupted === 'boolean' ? parsed.interrupted : null
      } catch {
        interrupted = null // stdout wasn't the expected JSON envelope — still ran, outcome unknown
      }
    }
  } catch {
    ranOk = false // the interrupt command itself failed to run — best-effort, swallow it
  }

  appendEvent(
    {
      kind: 'job.interrupted',
      agent,
      model,
      cwd,
      title,
      jobId,
      taskType,
      sessionId,
      interrupted,
      summary: ranOk ? `server-side session interrupt attempted (interrupted=${interrupted})` : 'server-side session interrupt attempt failed to run',
      harness,
      waitMode,
    },
    { env }
  )
}

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

/**
 * Final diff-stats snapshot for a write-mode job at a terminal transition
 * (finishJob's three branches, and cancelJob): measures `cwd` against its
 * recorded baseline, then flags an informational mismatch against a
 * declared handoff for the same workflow/step, when one exists. Returns
 * null for a read-mode job, a job with no baseline, or on ANY failure along
 * the way — a stats error must never fail the job it was computed for.
 */
async function computeFinalDiffStats({
  mode,
  cwd,
  diffBase,
  workflowId,
  stepId,
  env,
  computeDiffStatsFn = defaultComputeDiffStats,
  readHandoffFn = defaultReadHandoff,
  mismatchFn = defaultComputeChangedFilesMismatch,
}) {
  if (mode !== 'write' || !diffBase) return null
  let stats
  try {
    stats = await computeDiffStatsFn({ cwd, baseCommit: diffBase, env })
  } catch {
    return null
  }
  if (!stats) return null

  if (workflowId && stepId) {
    try {
      const handoff = readHandoffFn({ workflowId, stepId }, env)
      const declared = handoff?.changedFiles
      if (Array.isArray(declared) && declared.length > 0) {
        const measured = stats.files.map((f) => f.path)
        const mismatch = mismatchFn({ declaredFiles: declared, measuredFiles: measured })
        if (mismatch) return { ...stats, changedFilesMismatch: mismatch }
      }
    } catch {
      // Handoff lookup is best-effort; the measured stats above are still valid on their own.
    }
  }
  return stats
}

/**
 * Live/final diff stats for the dashboard's GET /api/jobs/:id/diff-stats:
 * a terminal job returns its persisted snapshot (survives worktree
 * deletion — never recomputed); a still-running write-mode job with a
 * baseline computes on demand, optionally through a short-TTL `cache`
 * (see diffstats.mjs's createDiffStatsCache) so a fast poll loop doesn't
 * re-shell out to git on every render. Everything else (read mode, no
 * baseline) is null — no stats, no error.
 */
export async function getJobDiffStats({
  jobId,
  env = process.env,
  cache = null,
  computeDiffStatsFn = defaultComputeDiffStats,
  readHandoffFn = defaultReadHandoff,
  mismatchFn = defaultComputeChangedFilesMismatch,
}) {
  const record = readResult(jobId, env)
  if (TERMINAL_JOB_STATUSES.has(record.status)) return record.diffStats ?? null
  if (record.mode !== 'write' || !record.diffBase) return null

  if (cache) {
    const cached = cache.get(jobId)
    if (cached !== undefined) return cached
  }

  const diffStats = await computeFinalDiffStats({
    mode: record.mode,
    cwd: record.cwd,
    diffBase: record.diffBase,
    workflowId: record.workflow_id ?? record.workflowId ?? null,
    stepId: record.step_id ?? record.stepId ?? null,
    env,
    computeDiffStatsFn,
    readHandoffFn,
    mismatchFn,
  })

  if (cache) cache.set(jobId, diffStats)
  return diffStats
}

async function finishJob({
  jobId,
  agent,
  model,
  cwd,
  title,
  adapter,
  mode,
  env,
  timedOut,
  exitCode = null,
  taskType = null,
  snapshot = null,
  takeSnapshotFn = defaultTakeSnapshot,
  diffSnapshotsFn = defaultDiffSnapshots,
  formatViolationFn = defaultFormatViolation,
  harness = null,
  waitMode = null,
  runCommandFn = defaultRunCommand,
  profile = null,
  profileStatus = null,
  recordQuotaExhaustionFn = defaultRecordQuotaExhaustion,
  diffBase = null,
  computeDiffStatsFn = defaultComputeDiffStats,
  readHandoffFn = defaultReadHandoff,
  mismatchFn = defaultComputeChangedFilesMismatch,
  // D2 (agy-hub-verification): normalized verify checks (or null). Only the
  // 'succeeded' branch below actually runs them.
  verify = null,
  runJobVerificationFn = defaultRunJobVerification,
}) {
  const current = readResult(jobId, env)
  if (current.status === 'canceled') return // cancelJob already finalized this job
  const eventHarness = harness ?? current.harness ?? null
  const eventWaitMode = waitMode ?? current.waitMode ?? null
  const eventProfile = profile ?? current.profile ?? null
  const eventProfileStatus = profileStatus ?? current.profileStatus ?? null
  const effectiveVerify = verify ?? current.verify ?? null

  // job-diff-stats: computed once here (not inside each branch below) so
  // every terminal outcome — failed, read-mode violation, succeeded — gets
  // the same final snapshot merged into its own updateResult patch. Never
  // throws; a stats failure degrades to null and must never fail the job.
  const effectiveDiffBase = diffBase ?? current.diffBase ?? null
  const diffStats = await computeFinalDiffStats({
    mode,
    cwd,
    diffBase: effectiveDiffBase,
    workflowId: current.workflow_id ?? current.workflowId ?? null,
    stepId: current.step_id ?? current.stepId ?? null,
    env,
    computeDiffStatsFn,
    readHandoffFn,
    mismatchFn,
  })

  let stdout = ''
  try {
    stdout = fs.readFileSync(stdoutPath(jobId, env), 'utf8')
  } catch {
    // no output captured — parse/classify will treat this as empty
  }

  // A read-mode or write-mode job is re-snapshotted at the terminal transition.
  // A non-git cwd produced no baseline, so the diff stays null and nothing changes.
  const diff = snapshot ? diffSnapshotsFn(snapshot, takeSnapshotFn(cwd, { env })) : null
  const violation = mode === 'read' && diff?.changed ? formatViolationFn(diff) : null

  const error = adapter.classifyError(stdout, { timedOut, code: exitCode })
  if (error) {
    // A print-timeout abandons the turn but agy still streamed partial text
    // (see agy.mjs classifyError) — keep it in response.txt like a normal
    // result, and persist sessionId so job_reply can resume that conversation.
    if (error.partialText) {
      try {
        fs.writeFileSync(responsePath(jobId, env), error.partialText, 'utf8')
      } catch {
        // best-effort — a failed job still gets reported even if this write fails
      }
    }
    // The original failure stays the errorKind; a read-mode violation is
    // recorded alongside it rather than replacing the primary cause.
    updateResult(
      jobId,
      {
        status: 'failed',
        errorKind: error.kind,
        error: error.message,
        sessionId: error.sessionId ?? current.sessionId ?? null,
        ...(violation ? { readModeViolation: violation } : {}),
        ...(diffStats ? { diffStats } : {}),
        ...(effectiveVerify ? { verification: skippedVerification(`job ended failed (errorKind=${error.kind}); verification skipped`) } : {}),
      },
      env
    )
    appendEvent(
      { kind: 'job.failed', agent, model, cwd, title, jobId, errorKind: error.kind, taskType, summary: summarize(error.message), harness: eventHarness, waitMode: eventWaitMode, profile: eventProfile, profileStatus: eventProfileStatus },
      { env }
    )
    // T4 failover: a 429 on the profile that just ran means the NEXT
    // resolution (dispatch or startJob) for the same model group should
    // avoid it, even before `agys quota --json` catches up — see
    // recordQuotaExhaustion in providers/agys.mjs.
    if (error.kind === 'quota' && agent === 'agy' && eventProfile) {
      try {
        recordQuotaExhaustionFn({ profile: eventProfile, modelGroup: modelGroupFor(model) ?? 'unknown', message: error.message, env })
      } catch {
        // Best-effort: a broken exhaustion record must never fail job finalization.
      }
    }
    if (error.kind === 'timeout') {
      // Best-effort cleanup only (E19): a timeout means our own SIGINT was
      // at best best-effort (opencode's handler swallows a rejected
      // session.interrupt) and a SIGKILL never reached the server at all, so
      // the session may still be running there. This must never affect the
      // status/errorKind already recorded above, and must never throw or
      // hang finalization — see attemptServerInterrupt.
      await attemptServerInterrupt({
        adapter,
        agent,
        model,
        cwd,
        title,
        jobId,
        taskType,
        sessionId: error.sessionId ?? current.sessionId ?? null,
        env,
        harness: eventHarness,
        waitMode: eventWaitMode,
        runCommandFn,
        profile,
      })
    }
    return
  }

  const result = adapter.parseResult(stdout)
  fs.writeFileSync(responsePath(jobId, env), result.text ?? '', 'utf8')

  if (violation) {
    // A "read" job that modified its worktree is a failure even though the CLI
    // succeeded. response.txt and tokens are still kept so the caller can see
    // the work that was produced.
    updateResult(
      jobId,
      {
        status: 'failed',
        errorKind: 'read_mode_violation',
        error: violation,
        tokens: result.tokens ?? null,
        costUsd: result.costUsd ?? null,
        sessionId: result.sessionId ?? null,
        toolDenials: result.toolDenials ?? [],
        ...(diffStats ? { diffStats } : {}),
        ...(effectiveVerify ? { verification: skippedVerification('job ended failed (errorKind=read_mode_violation); verification skipped') } : {}),
      },
      env
    )
    appendEvent(
      { kind: 'job.failed', agent, model, cwd, title, jobId, errorKind: 'read_mode_violation', taskType, summary: summarize(violation), harness: eventHarness, waitMode: eventWaitMode, profile: eventProfile, profileStatus: eventProfileStatus },
      { env }
    )
    return
  }

  const noChanges = mode === 'write' && Boolean(diff && !diff.unverifiable && !diff.changed)

  // D2: the job just reached 'succeeded' -- run its verify checks here, in
  // the foreground, before this function returns. startJob releases the
  // write lock (and stops the lease heartbeat) only in the .finally() after
  // finishJob's promise settles, so the lock is held for the whole run. A
  // crash inside verification itself must never fail the job it verified.
  let verification = null
  if (effectiveVerify) {
    try {
      verification = await runJobVerificationFn({
        checks: effectiveVerify,
        cwd,
        workflowId: current.workflow_id ?? current.workflowId ?? null,
        stepId: current.step_id ?? current.stepId ?? null,
        env,
        runCommandFn,
      })
    } catch (err) {
      verification = { ok: false, checks: [], reason: `verification crashed: ${String(err?.message ?? err)}` }
    }
  }

  updateResult(
    jobId,
    {
      status: 'succeeded',
      tokens: result.tokens ?? null,
      costUsd: result.costUsd ?? null,
      sessionId: result.sessionId ?? null,
      toolDenials: result.toolDenials ?? [],
      ...(noChanges ? { noChanges: true } : {}),
      ...(diffStats ? { diffStats } : {}),
      ...(verification ? { verification } : {}),
    },
    env
  )
  if (noChanges) {
    appendEvent(
      { kind: 'job.no_changes', agent, model, cwd, title, jobId, taskType, summary: 'write-mode job finished without modifying any file' },
      { env }
    )
  }
  appendEvent(
    { kind: 'job.finished', agent, model, cwd, title, jobId, taskType, tokens: result.tokens ?? null, costUsd: result.costUsd ?? null, summary: summarize(result.text), harness: eventHarness, waitMode: eventWaitMode, profile: eventProfile, profileStatus: eventProfileStatus, verificationOk: verification ? verification.ok : null },
    { env }
  )
}

/** Kill a running job's process group and mark it canceled. */
export async function cancelJob(
  jobId,
  {
    env = process.env,
    computeDiffStatsFn = defaultComputeDiffStats,
    readHandoffFn = defaultReadHandoff,
    mismatchFn = defaultComputeChangedFilesMismatch,
  } = {}
) {
  const result = readResult(jobId, env)
  if (result.status !== 'running') {
    return result
  }

  // Mark 'canceled' BEFORE killing: killProcessGroup makes the child exit,
  // which races finishJob's own completion handler (via the same exitPromise
  // that runs the timeout ladder). finishJob checks for status:'canceled' and
  // no-ops when it sees it, so this ordering is what keeps a cancel from also
  // producing a spurious job.failed(errorKind:'empty') event for the same job.
  let updated = updateResult(jobId, { status: 'canceled', errorKind: 'canceled_by_user' }, env)

  // job-diff-stats: a canceled write-mode job still gets its final snapshot
  // persisted (same "any terminal status" contract as finishJob) — a
  // canceled run may have already produced real, worth-keeping changes.
  const diffStats = await computeFinalDiffStats({
    mode: result.mode,
    cwd: result.cwd,
    diffBase: result.diffBase,
    workflowId: result.workflow_id ?? result.workflowId ?? null,
    stepId: result.step_id ?? result.stepId ?? null,
    env,
    computeDiffStatsFn,
    readHandoffFn,
    mismatchFn,
  })
  if (diffStats) updated = updateResult(jobId, { diffStats }, env)

  // D2: a canceled job with verify checks configured never runs them —
  // record that explicitly instead of silently leaving `verification` unset.
  if (result.verify) {
    updated = updateResult(jobId, { verification: skippedVerification('job was canceled; verification skipped') }, env)
  }

  if (result.remote) {
    // There is no Jules API to cancel a remote session: marking the record
    // canceled above is enough — pollUntilTerminal (src/cloud/poller.mjs)
    // reads the record on its next tick and stops itself there. The session
    // on Jules' own infrastructure keeps running; only OUR polling/reporting
    // of it stops. A remote job also never acquired the local write lock (its
    // mode is 'write' but checkWriteAllowed/acquireWriteLock never ran for
    // it — see startJob's remote branch), so releaseWriteLock must not run
    // either: doing so would release a lock a concurrent LOCAL write-mode
    // job on the same cwd actually holds.
    appendEvent(
      { kind: 'job.canceled', agent: result.agent, model: result.model, cwd: result.cwd, title: result.title, jobId, taskType: result.taskType ?? null, harness: result.harness ?? null, waitMode: result.waitMode ?? null },
      { env }
    )
    active.delete(jobId)
    return updated
  }

  const entry = active.get(jobId)
  const pgid = entry?.pgid ?? result.pgid
  stopHeartbeat(jobId)
  if (pgid) {
    await killProcessGroup(pgid, {})
  }

  // Killing the local client does not stop the run: in opencode v2 the shared
  // background server owns execution (E19), so without this the session keeps
  // spending tokens and editing the worktree after the user cancelled it.
  // Best-effort and bounded, exactly like the timeout path.
  const adapter = entry?.adapter
  if (adapter) {
    let stdout = ''
    try {
      stdout = fs.readFileSync(stdoutPath(jobId, env), 'utf8')
    } catch {
      // nothing captured yet — sessionId simply stays unrecoverable below
    }
    await attemptServerInterrupt({
      adapter,
      agent: result.agent,
      model: result.model,
      cwd: result.cwd,
      title: result.title,
      jobId,
      taskType: result.taskType ?? null,
      sessionId: adapter.sessionIdFrom?.(stdout) ?? result.sessionId ?? null,
      env,
      harness: result.harness ?? null,
      waitMode: result.waitMode ?? null,
      runCommandFn: entry?.runCommandFn ?? defaultRunCommand,
      profile: entry?.profile ?? result.profile ?? null,
    })
  }

  appendEvent(
    { kind: 'job.canceled', agent: result.agent, model: result.model, cwd: result.cwd, title: result.title, jobId, taskType: result.taskType ?? null, harness: result.harness ?? null, waitMode: result.waitMode ?? null },
    { env }
  )
  active.delete(jobId)
  // Token-guarded like the done.finally above; falls back to the
  // jobId+pid legacy check when this process never held the token (e.g. a
  // job started before a restart), which then correctly refuses to release a
  // lease it cannot prove it owns — the lease expires on its own instead.
  if (result.mode === 'write') releaseWriteLock({ cwd: result.cwd, token: entry?.leaseToken, jobId, env })
  return updated
}

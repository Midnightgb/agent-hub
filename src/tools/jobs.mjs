import fs from 'node:fs'
import { startJob as defaultStartJob, cancelJob } from '../jobrunner.mjs'
import { readResult, responsePath } from '../jobstore.mjs'
import { WRITE_ALLOWLIST, TURN_DEPTH_WARNING } from '../config.mjs'
import { TASK_TYPES } from '../schemas.mjs'
import { keyForJob, NO_KEY_MESSAGE } from '../cloud/credentials.mjs'
import { computeAttention } from '../cloud/check.mjs'
import { isWaitingRemoteState } from '../cloud/poller.mjs'
import { interactWithSession } from './jules.mjs'
import * as defaultJulesClient from '../cloud/jules/client.mjs'
import * as defaultJulesAdapter from '../cloud/jules/adapter.mjs'
import { getDb, listAgentMessages, markAgentMessageDelivered } from '../storage/index.mjs'
import { listAgysProfilesSync } from '../providers/agys.mjs'
import { normalizeVerifyCheck } from '../verify.mjs'

/** Reject a caller-supplied taskType that is not one of schemas.mjs TASK_TYPES. */
function assertTaskType(taskType) {
  if (taskType != null && !TASK_TYPES.includes(taskType)) {
    throw new Error(`unknown taskType: ${taskType}`)
  }
}

function jobStatusView(result) {
  return {
    jobId: result.jobId,
    agent: result.agent,
    model: result.model,
    title: result.title,
    cwd: result.cwd,
    mode: result.mode,
    status: result.status,
    errorKind: result.errorKind ?? null,
    error: result.error ?? null,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    // D2 (agy-hub-verification): hub-run verification result, present only
    // when the job was given a `verify` array (docs/verification.md).
    verification: result.verification ?? null,
    ...readIsolationView(result),
  }
}

/**
 * same-tree-fanout (S1, S2): how a read job was isolated and what the read
 * guard saw. Only present on records that carry them, so older records and
 * write jobs keep their exact previous shape.
 */
function readIsolationView(result) {
  return {
    ...(result.isolation ? { isolation: result.isolation } : {}),
    ...(result.readGuard ? { readGuard: result.readGuard } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  }
}

/**
 * Validates an explicit per-call `profile` input against the live agys
 * profile list. Only meaningful for agent 'agy' — any other agent rejects
 * fast instead of silently ignoring a pin that would never apply. Unknown
 * profile / unavailable agys also reject fast: no silent fallback to auto
 * selection, since the caller explicitly asked to pin one account.
 */
function assertPinnedProfile({ agent, profile, listAgysProfilesFn, env }) {
  if (agent !== 'agy') {
    throw new Error(`profile is only meaningful for agent "agy" (got "${agent}")`)
  }
  const { available, profiles, reason } = listAgysProfilesFn({ env })
  if (!available) {
    throw new Error(`agys is unavailable; cannot validate profile "${profile}"${reason ? ` (${reason})` : ''}`)
  }
  const names = (profiles ?? []).map((p) => p.name)
  if (!names.includes(profile)) {
    throw new Error(`unknown agys profile "${profile}"; valid profiles: ${names.join(', ') || '(none)'}`)
  }
}

export function delegateTool({
  agent,
  model,
  task,
  cwd,
  mode = 'read',
  timeoutS,
  title,
  variant,
  taskType,
  profile = null,
  // D2 (agy-hub-verification): optional hub-run verification checks
  // (docs/verification.md). Validated here before startJobFn is ever
  // called ("fails fast before dispatch"); startJob does the canonical
  // normalization and persists it on the job record.
  verify = null,
  // same-tree-fanout (S2): 'auto' | 'in-place' | 'scratch' for read jobs.
  isolation,
  startJobFn = defaultStartJob,
  listAgysProfilesFn = listAgysProfilesSync,
  env = process.env,
}) {
  assertTaskType(taskType)
  if (Array.isArray(verify) && verify.length > 0) {
    verify.forEach(normalizeVerifyCheck)
  }

  // An explicit per-call profile overrides auto selection AND a global pin
  // (AGENT_HUB_AGYS_PROFILE / mode file): it is explicit per call, so it is
  // the most specific signal available. startJob() already honors a truthy
  // `profile` as-is (see src/jobrunner.mjs) — this only validates it and
  // marks it 'pinned' instead of 'selected'.
  let effectiveProfile = null
  let effectiveProfileStatus = null
  if (profile != null && String(profile).trim() !== '') {
    const trimmed = String(profile).trim()
    assertPinnedProfile({ agent, profile: trimmed, listAgysProfilesFn, env })
    effectiveProfile = trimmed
    effectiveProfileStatus = 'pinned'
  }

  const { job } = startJobFn({
    agent,
    model,
    task,
    cwd,
    mode,
    title,
    timeoutS,
    variant,
    taskType,
    turnDepth: 0,
    allowlist: WRITE_ALLOWLIST,
    profile: effectiveProfile,
    profileStatus: effectiveProfileStatus,
    verify,
    ...(isolation ? { isolation } : {}),
  })
  return { jobId: job.jobId, status: job.status, errorKind: job.errorKind ?? null }
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

// job_reply supports resuming a conversation for these agents only: agy has
// --conversation, opencode has -s/--session, codex has `exec resume <thread_id>`,
// jules has sendMessage/approvePlan against its remote session. copilot has none
// of these.
const REPLYABLE_AGENTS = new Set(['agy', 'opencode', 'codex', 'jules'])

/**
 * job_reply for a jules parent: unlike agy/opencode, this never spawns a new
 * local job — it talks directly to the existing remote session through the
 * shared interactWithSession() implementation (same as jules_interact: one
 * place for reply/approve_plan semantics, counters and accounting), using
 * the SAME jobId. Model A: like jules_interact, this never restarts a
 * poller — observe afterwards with jules_wait/jules_check.
 */
async function julesReply({ jobId, parent, message, action, client, env, turnDepth, warning }) {
  const sessionId = parent.remote?.sessionId
  if (!sessionId) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'no_session', turnDepth, warning }
  }

  // No action given: approve the plan only when the session is actually
  // waiting on one and the caller did not also send free text (a message
  // always means "say this", regardless of the session's current state).
  const resolvedAction = action ?? (parent.remote?.state === 'AWAITING_PLAN_APPROVAL' && !message ? 'approve_plan' : 'message')

  if (resolvedAction === 'message' && (!message || String(message).trim().length === 0)) {
    return {
      jobId: null,
      status: 'failed',
      parentJobId: jobId,
      errorKind: 'invalid',
      error: 'job_reply on a jules job needs either message text or action:"approve_plan"',
      turnDepth,
      warning,
    }
  }

  // The session belongs to the account that STARTED the job: fail fast here
  // with 'auth' when no key exists anywhere (same NO_KEY_MESSAGE contract as
  // before), so a missing key never reaches the shared implementation.
  const apiKey = keyForJob(parent, { env })
  if (!apiKey) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'auth', error: NO_KEY_MESSAGE, turnDepth, warning }
  }

  try {
    await interactWithSession({
      jobId,
      action: resolvedAction === 'approve_plan' ? 'approve_plan' : 'reply',
      message,
      client,
      env,
    })
  } catch (error) {
    // Mirrors the createSession error mapping in src/cloud/runner.mjs: 429 is
    // quota exhaustion, 401/403 is a rejected/missing key, anything else is an
    // unclassified remote failure. The message is carried through so a caller
    // can tell a rejected key apart from a genuine bug instead of seeing an
    // opaque 'crash' for all three.
    const status = error?.status
    const errorKind = status === 429 ? 'quota' : status === 401 || status === 403 ? 'auth' : 'crash'
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind, error: String(error?.message ?? error), turnDepth, warning }
  }

  // The reply lands on the SAME job/session — there is no new jobId to hand
  // back, so callers keep polling job_status/job_wait on the original one.
  return { jobId, status: parent.status, parentJobId: jobId, errorKind: null, turnDepth, warning }
}

/**
 * job_reply: start a new turn in a terminal job's conversation, using its
 * recorded sessionId. Mirrors delegate()'s shape but resumes instead of
 * starting fresh — the guided agy workflow is plan (read) -> feedback
 * (read, same session) -> "execute the approved plan" (write, same session).
 *
 * For a jules parent this instead relays `message`/`action` to the existing
 * remote session (see julesReply above) rather than spawning a new job.
 */
export async function jobReplyTool({
  jobId,
  message,
  mode,
  timeoutS,
  title,
  taskType,
  action,
  startJobFn = defaultStartJob,
  client = defaultJulesClient,
  env = process.env,
}) {
  assertTaskType(taskType)
  const parent = readResult(jobId, env)

  // Each reply deepens the conversation by one turn; a resumed conversation
  // carries the parent's depth forward (root = 0).
  const turnDepth = (parent.turnDepth ?? 0) + 1
  const warning =
    turnDepth >= TURN_DEPTH_WARNING
      ? `conversation is ${turnDepth} turns deep; consider a fresh delegate with a short summary`
      : null

  const isJules = parent.agent === 'jules'
  // A running Jules session is exactly when a reply is useful — it is a live
  // remote conversation, not a finished local process — so 'running' is
  // accepted in addition to a terminal status. Every other agent still
  // requires the parent to have finished first.
  const parentReady = isJules ? parent.status === 'running' || TERMINAL_STATUSES.has(parent.status) : TERMINAL_STATUSES.has(parent.status)
  if (!parentReady) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'not_terminal', turnDepth, warning }
  }

  if (isJules) {
    return julesReply({ jobId, parent, message, action, client, env, turnDepth, warning })
  }

  // Only a jules approve_plan may omit message text. For every other agent the
  // reply IS the message: without this check a schema-legal job_reply({jobId})
  // would reach startJobFn with task: undefined and spawn the CLI with the
  // literal prompt "undefined".
  if (!message || String(message).trim().length === 0) {
    return {
      jobId: null,
      status: 'failed',
      parentJobId: jobId,
      errorKind: 'invalid',
      error: 'job_reply requires message text',
      turnDepth,
      warning,
    }
  }

  if (!parent.sessionId) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'no_session', turnDepth, warning }
  }
  if (!REPLYABLE_AGENTS.has(parent.agent)) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'unsupported', turnDepth, warning }
  }

  // Inherit the parent's taskType unless the caller overrides it, so metrics
  // and adaptive timeouts keep grouping a conversation's turns together.
  const effectiveTaskType = taskType ?? parent.taskType ?? null
  assertTaskType(effectiveTaskType)
  const effectiveMode = mode ?? parent.mode ?? 'read'
  const effectiveTitle = title ?? `${parent.title || parent.jobId} (reply)`

  let effectiveMessage = message
  try {
    const rootExecutionId = parent.root_execution_id ?? parent.rootExecutionId ?? parent.executionId ?? parent.execution_id ?? null
    if (rootExecutionId) {
      const ctx = getDb(env)
      const targetRecipients = [
        jobId,
        parent.jobId,
        parent.job_id,
        parent.step_id,
        parent.stepId,
        parent.agent,
      ].filter(Boolean)
      const undelivered = listAgentMessages(ctx, {
        to: [...new Set(targetRecipients)],
        rootExecutionId,
        unreadOnly: true,
      })

      if (undelivered && undelivered.length > 0) {
        const MAX_NOTICE_CHARS = 4000
        const noticeBlocks = []
        let totalChars = 0
        const deliveredIds = []
        const now = new Date().toISOString()

        for (const msg of undelivered) {
          const from = msg.from_agent ?? msg.from ?? 'unknown'
          const block = `[Inter-Agent Notice from ${from}]: ${msg.text}`
          if (totalChars + block.length > MAX_NOTICE_CHARS) {
            const remaining = MAX_NOTICE_CHARS - totalChars
            if (remaining > 50) {
              noticeBlocks.push(block.slice(0, remaining) + '...[truncated]')
              deliveredIds.push(msg.id)
            }
            break
          }
          noticeBlocks.push(block)
          deliveredIds.push(msg.id)
          totalChars += block.length
        }

        if (noticeBlocks.length > 0) {
          effectiveMessage = `${noticeBlocks.join('\n\n')}\n\n${message}`
          for (const id of deliveredIds) {
            markAgentMessageDelivered(ctx, id, now)
          }
        }
      }
    }
  } catch {
    // Best-effort: a mailbox failure must never break job_reply
  }

  const { job } = startJobFn({
    agent: parent.agent,
    model: parent.model,
    task: effectiveMessage,
    cwd: parent.cwd,
    mode: effectiveMode,
    title: effectiveTitle,
    timeoutS,
    taskType: effectiveTaskType,
    turnDepth,
    variant: parent.variant ?? undefined,
    sessionId: parent.sessionId,
    parentJobId: jobId,
    allowlist: WRITE_ALLOWLIST,
  })
  return { jobId: job.jobId, status: job.status, parentJobId: jobId, errorKind: job.errorKind ?? null, turnDepth, warning }
}

/**
 * A job_wait stop condition for one record: terminal, or a remote session
 * waiting for interaction (P0.1, see jobWaitTool below).
 */
function isWaitDone(result) {
  return TERMINAL_STATUSES.has(result.status) || (result.status === 'running' && isWaitingRemoteState(defaultJulesAdapter, result.remote?.state))
}

/**
 * same-tree-fanout (S3): wait on a fan-out of jobs. until:'all' (default)
 * returns once every job is done; until:'any' returns as soon as one is, so
 * the caller can read it and wait again on `pending`. `jobs` keeps the
 * caller's order; done/timedOut follow the single-job job_wait meaning.
 */
async function jobWaitManyTool({ jobIds, until = 'all', timeoutS = 30 }) {
  const boundedTimeoutS = Math.min(Math.max(timeoutS, 1), 60)
  const deadline = Date.now() + boundedTimeoutS * 1000
  while (true) {
    const results = jobIds.map((id) => readResult(id))
    const completed = results.filter(isWaitDone).map((r) => r.jobId)
    const pending = results.filter((r) => !isWaitDone(r)).map((r) => r.jobId)
    const satisfied = until === 'any' ? completed.length > 0 : pending.length === 0
    const timedOut = !satisfied && Date.now() >= deadline
    if (satisfied || timedOut) {
      const jobs = results.map((r) => {
        const waiting = r.status === 'running' && isWaitingRemoteState(defaultJulesAdapter, r.remote?.state)
        return { ...jobStatusView(r), done: isWaitDone(r), waiting, ...(waiting ? computeAttention({ state: r.remote.state, record: r }) : {}) }
      })
      return { jobs, completed, pending, done: satisfied, timedOut }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

export async function jobWaitTool({ jobId, jobIds, until, timeoutS = 30 }) {
  const many = Array.isArray(jobIds)
  if ((jobId != null) === many || (many && jobIds.length === 0)) {
    throw new Error('job_wait takes exactly one of jobId or jobIds (a non-empty array)')
  }
  if (many) return jobWaitManyTool({ jobIds, until, timeoutS })
  const boundedTimeoutS = Math.min(Math.max(timeoutS, 1), 60)
  const deadline = Date.now() + boundedTimeoutS * 1000
  let result = readResult(jobId)
  while (true) {
    if (TERMINAL_STATUSES.has(result.status)) {
      return { ...jobStatusView(result), done: true, waiting: false, timedOut: false }
    }
    // P0.1: a remote session waiting for interaction (AWAITING_*/PAUSED) is
    // a result, not a reason to block until timeout. Return immediately with
    // the waiting signal + attention fields so the caller (supervisor/human)
    // can act via jules_interact instead of burning its own timeout. This
    // uses the same isWaitingRemoteState definition as the poller — no drift.
    if (result.status === 'running' && isWaitingRemoteState(defaultJulesAdapter, result.remote?.state)) {
      const attention = computeAttention({ state: result.remote.state, record: result })
      return { ...jobStatusView(result), done: true, waiting: true, timedOut: false, ...attention }
    }
    if (Date.now() >= deadline) {
      return { ...jobStatusView(result), done: false, waiting: false, timedOut: true }
    }
    await new Promise((r) => setTimeout(r, 300))
    result = readResult(jobId)
  }
}

export function jobStatusTool({ jobId }) {
  return jobStatusView(readResult(jobId))
}

export function jobResultTool({ jobId, maxLines = 20, tailLines = 10 }) {
  const result = readResult(jobId)
  let fullText = ''
  try {
    fullText = fs.readFileSync(responsePath(jobId), 'utf8')
  } catch {
    // no response yet (still running, or the job never produced text)
  }

  const lines = fullText.split('\n')
  const totalLines = lines.length
  const truncated = totalLines > maxLines
  // The tail never repeats a line already in the head: it starts after the
  // head when the response is short enough for both to fit without a gap.
  const tailStart = Math.max(maxLines, totalLines - tailLines)
  const tail = lines.slice(tailStart).join('\n')
  const tailTruncated = totalLines > maxLines + tailLines

  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated,
    tail,
    totalLines,
    tailTruncated,
    fullPath: responsePath(jobId),
    tokens: result.tokens ?? null,
    costUsd: result.costUsd ?? null,
    sessionId: result.sessionId ?? null,
    status: result.status,
    errorKind: result.errorKind ?? null,
    verification: result.verification ?? null,
    ...readIsolationView(result),
  }
}

export async function jobCancelTool({ jobId }) {
  const result = await cancelJob(jobId)
  return jobStatusView(result)
}

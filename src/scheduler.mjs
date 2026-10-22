import { startRemoteJob as defaultStartRemoteJob } from './cloud/runner.mjs'
import { readResult as defaultReadResult } from './jobstore.mjs'
import { computeNextRunAt, dueSchedules, listSchedules, updateSchedule } from './schedules.mjs'
import { quotaRefreshMs, quotaRoutingMode, refreshQuota } from './routing/quota-gate.mjs'

/**
 * The recurring-task loop. It belongs to the DASHBOARD process, the only
 * long-lived process in agent-hub (startDashboard calls startScheduler); the
 * MCP server is a per-session stdio process that dies with the Claude session.
 * index.mjs deliberately does NOT start a scheduler: two of them would
 * double-fire every schedule.
 *
 * Every dependency is injectable (startJobFn, nowFn, listSchedulesFn,
 * updateScheduleFn, readResultFn, logFn) so the tests drive `tick` directly
 * with a fake clock and a fake starter — no timers, no network.
 */

const defaultLog = (...args) => console.error(...args)

function message(error) {
  return String(error?.message ?? error)
}

/**
 * True when the job this schedule started last time is still queued or
 * running. A Jules session is slow and asynchronous, so a second fire while
 * the first is in flight would pile up duplicate sessions against the same
 * repo — the one thing recurrence must never do.
 */
function previousRunInFlight(schedule, { env, readResultFn }) {
  if (!schedule.lastJobId) return false
  try {
    const previous = readResultFn(schedule.lastJobId, env)
    return previous?.status === 'queued' || previous?.status === 'running'
  } catch {
    // The record is gone (pruned, unreadable): treat it as finished so a
    // missing file can never block this schedule forever.
    return false
  }
}

/**
 * Fire one schedule once: skip when the previous run is still in flight,
 * otherwise start a Jules job and stamp the outcome. A start failure is
 * recorded, never thrown — one bad schedule must not wedge the loop.
 */
async function runOne(schedule, { env, startJobFn, nowFn, updateScheduleFn, readResultFn, logFn }) {
  const nowMs = nowFn()
  const nextRunAt = computeNextRunAt(schedule.schedule, nowMs)

  if (previousRunInFlight(schedule, { env, readResultFn })) {
    return updateScheduleFn(schedule.id, { lastStatus: 'skipped', nextRunAt }, env)
  }

  let job = null
  let lastStatus = 'queued'
  try {
    const result = await startJobFn({
      agent: 'jules',
      model: 'jules',
      task: schedule.prompt,
      source: schedule.source,
      startingBranch: schedule.startingBranch ?? undefined,
      title: schedule.label ?? undefined,
      requirePlanApproval: schedule.requirePlanApproval === true,
      automationMode: schedule.automationMode ?? undefined,
      account: schedule.accountId ?? undefined,
      turnDepth: 0,
      env,
    })
    job = result?.job ?? null
    lastStatus = job?.status ?? 'queued'
  } catch (error) {
    lastStatus = 'error'
    logFn(`[agent-hub] schedule ${schedule.id} could not start a job: ${message(error)}`)
  }

  const patch = { lastRunAt: new Date(nowMs).toISOString(), lastStatus, nextRunAt }
  // A fail-fast start (e.g. missing JULES_API_KEY) still produced a job record;
  // naming it lets the dashboard show why, and it is already terminal so the
  // in-flight guard will not block the next occurrence on it.
  if (job?.jobId) patch.lastJobId = job.jobId
  return updateScheduleFn(schedule.id, patch, env)
}

/**
 * One pass over the due schedules. Exported so tests drive it directly; the
 * timer below only calls it. Never throws out of itself.
 */
export async function tick({
  env = process.env,
  startJobFn = defaultStartRemoteJob,
  nowFn = Date.now,
  listSchedulesFn = listSchedules,
  updateScheduleFn = updateSchedule,
  readResultFn = defaultReadResult,
  logFn = defaultLog,
} = {}) {
  const nowMs = nowFn()

  let due
  try {
    due = dueSchedules(nowMs, env, { listSchedulesFn })
  } catch (error) {
    logFn(`[agent-hub] scheduler could not read schedules: ${message(error)}`)
    return []
  }

  const results = []
  for (const schedule of due) {
    try {
      results.push(await runOne(schedule, { env, startJobFn, nowFn, updateScheduleFn, readResultFn, logFn }))
    } catch (error) {
      // runOne already absorbs start failures; this catches a broken
      // readResultFn/updateScheduleFn so one schedule can never crash the tick.
      logFn(`[agent-hub] schedule ${schedule.id} failed: ${message(error)}`)
      try {
        results.push(updateScheduleFn(schedule.id, { lastStatus: 'error', nextRunAt: computeNextRunAt(schedule.schedule, nowFn()) }, env))
      } catch {
        // Even the recovery write failed (disk full, lock timeout): move on.
      }
    }
  }
  return results
}

/**
 * Fire one schedule right now, ignoring whether it is enabled or due. Used by
 * the dashboard's "run now". The in-flight guard still applies: a manual run
 * must not create the duplicate session the scheduler exists to prevent.
 * Throws `schedule not found: <id>`.
 */
export async function runScheduleNow(
  id,
  {
    env = process.env,
    startJobFn = defaultStartRemoteJob,
    nowFn = Date.now,
    listSchedulesFn = listSchedules,
    updateScheduleFn = updateSchedule,
    readResultFn = defaultReadResult,
    logFn = defaultLog,
  } = {}
) {
  const schedule = listSchedulesFn(env).find((candidate) => candidate.id === id)
  if (!schedule) throw new Error(`schedule not found: ${id}`)
  return runOne(schedule, { env, startJobFn, nowFn, updateScheduleFn, readResultFn, logFn })
}

/**
 * Start the interval loop. Returns { stop() }. The timer is unref()ed so it
 * can never be the reason the process stays alive on its own. With
 * AGENT_HUB_QUOTA_ROUTING=skip, a second timer refreshes quota and clears
 * exhaustion marks every AGENT_HUB_QUOTA_REFRESH_S (0 disables it).
 */
export function startScheduler({
  env = process.env,
  intervalMs = 30000,
  startJobFn = defaultStartRemoteJob,
  nowFn = Date.now,
  listSchedulesFn = listSchedules,
  updateScheduleFn = updateSchedule,
  readResultFn = defaultReadResult,
  logFn = defaultLog,
  refreshQuotaFn = refreshQuota,
} = {}) {
  const timer = setInterval(() => {
    tick({ env, startJobFn, nowFn, listSchedulesFn, updateScheduleFn, readResultFn, logFn }).catch((error) => {
      logFn(`[agent-hub] scheduler tick failed: ${message(error)}`)
    })
  }, intervalMs)
  timer.unref?.()

  const quotaMs = quotaRoutingMode(env) === 'skip' ? quotaRefreshMs(env) : 0
  const quotaTimer = quotaMs > 0
    ? setInterval(() => {
        refreshQuotaFn({ env }).catch((error) => logFn(`[agent-hub] quota refresh failed: ${message(error)}`))
      }, quotaMs)
    : null
  quotaTimer?.unref?.()

  return {
    stop() {
      clearInterval(timer)
      if (quotaTimer) clearInterval(quotaTimer)
    },
  }
}

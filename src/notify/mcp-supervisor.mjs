/**
 * Job supervisor for the MCP server: follows the jobs a delegate/dispatch call
 * started until they are terminal, so that
 *   - an MCP task (src/notify/mcp-tasks.mjs) can report working/completed/failed,
 *   - the opt-in Claude Code channel can push the terminal state, and
 *   - a dispatch job that fails on quota after it started moves to the next
 *     routed fallback (src/reroute.mjs), bounded by maxReroutes.
 *
 * One tracker per call, keyed by the first job's id (that id is the task id). It
 * lives in this server process only; nothing is written to events.jsonl.
 */
import { watchJobUntilTerminal, buildJobNotice, noticeText, mergeAttempts } from './mcp-jobs.mjs'
import { readResult as defaultReadResult, updateResult } from '../jobstore.mjs'
import { isQuotaFailure, buildRerouteTask, preservePartialWork } from '../reroute.mjs'

const RESTART_LOCK_RETRIES = 6
const RESTART_LOCK_WAIT_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.())

export class JobSupervisor {
  /**
   * @param {object} opts
   * @param {object} [opts.env]
   * @param {Function} [opts.readResultFn]
   * @param {Function} opts.cancelJobFn (jobId, {env}) => record
   * @param {number} [opts.pollMs]
   */
  constructor({ env = process.env, readResultFn = defaultReadResult, cancelJobFn, pollMs = 500 } = {}) {
    this.env = env
    this.readResultFn = readResultFn
    this.cancelJobFn = cancelJobFn
    this.pollMs = pollMs
    this.trackers = new Map()
  }

  /**
   * Start following a call's job.
   * @param {object} spec
   * @param {string} spec.tool 'delegate' | 'dispatch'
   * @param {string} spec.jobId the job the call started (also the task id)
   * @param {object[]} [spec.attempts] start attempts already made, in order
   * @param {object|null} [spec.reroute] {task, mode, remaining[], maxReroutes, restart(args)} to reroute on quota
   * @param {(tracker) => void} [spec.onTerminal] called once with the finished tracker
   */
  start({ tool, jobId, attempts = [], reroute = null, onTerminal = null }) {
    const now = new Date().toISOString()
    const tracker = {
      taskId: jobId,
      tool,
      createdAt: now,
      lastUpdatedAt: now,
      status: 'working',
      statusMessage: null,
      currentJobId: jobId,
      attempts: attempts.map((a) => ({ ...a })),
      reroutes: 0,
      cancelled: false,
      record: null,
      notice: null,
      done: null,
    }
    this.trackers.set(jobId, tracker)
    tracker.done = this.#run(tracker, reroute).then(() => {
      try {
        onTerminal?.(tracker)
      } catch {}
      return tracker
    })
    return tracker
  }

  get(taskId) {
    return this.trackers.get(taskId) ?? null
  }

  /** tasks/cancel: stop following, stop rerouting, cancel the job that is running now. */
  async cancel(taskId) {
    const tracker = this.trackers.get(taskId)
    if (!tracker || tracker.status !== 'working') return tracker
    tracker.cancelled = true
    tracker.status = 'cancelled'
    tracker.statusMessage = 'cancelled by the client'
    tracker.lastUpdatedAt = new Date().toISOString()
    try {
      await this.cancelJobFn?.(tracker.currentJobId, { env: this.env })
    } catch {}
    return tracker
  }

  async #run(tracker, reroute) {
    let remaining = reroute ? [...reroute.remaining] : []
    for (;;) {
      const record = await watchJobUntilTerminal({
        jobId: tracker.currentJobId,
        env: this.env,
        readResultFn: this.readResultFn,
        pollMs: this.pollMs,
        shouldStop: () => tracker.cancelled,
      })
      if (!record || tracker.cancelled) return
      tracker.attempts = mergeAttempts(tracker.attempts, record)
      tracker.lastUpdatedAt = new Date().toISOString()

      const canReroute = reroute && !tracker.cancelled && tracker.reroutes < reroute.maxReroutes && remaining.length > 0 && isQuotaFailure(record)
      if (canReroute) {
        const next = remaining.shift()
        // Read-side views report this job as still going while the next attempt starts.
        this.#mark(record.jobId, { reroutePending: true })
        const started = await this.#restart(reroute, { next, remaining, previous: record }, () => tracker.cancelled)
        if (started.ok) this.#mark(record.jobId, { reroutePending: false, reroutedTo: started.jobId })
        else this.#mark(record.jobId, { reroutePending: false })
        if (tracker.cancelled) {
          // tasks/cancel landed while the successor was starting: it was not running yet
          // when cancel() stopped the old job, so stop it here (and free its write lock).
          if (started.ok) {
            try {
              await this.cancelJobFn?.(started.jobId, { env: this.env })
            } catch {}
          }
          return
        }
        if (started.ok) {
          tracker.reroutes += 1
          tracker.currentJobId = started.jobId
          tracker.attempts.push(...started.attempts)
          remaining = started.remaining
          tracker.statusMessage = `rerouted after ${record.errorKind ?? 'quota'} on ${record.agent}/${record.model}: now ${started.agent}/${started.model} (reroute ${tracker.reroutes}/${reroute.maxReroutes})`
          continue
        }
        // The next candidate could not start: report that as the last attempt and end here.
        tracker.attempts.push(...started.attempts)
        if (started.attempts.length === 0) {
          tracker.attempts.push({ agent: next?.agent ?? null, model: next?.model ?? null, jobId: null, status: 'failed', errorKind: started.errorKind, error: started.error })
        }
      }
      this.#finish(tracker, record)
      return
    }
  }

  async #restart(reroute, { next, remaining, previous }, isCancelled = () => false) {
    const partial = await preservePartialWork(previous, { env: this.env })
    const task = buildRerouteTask({ task: reroute.task, previous, partial })
    let lastError = null
    for (let i = 0; i < RESTART_LOCK_RETRIES; i++) {
      if (isCancelled()) return { ok: false, attempts: [], errorKind: 'canceled', error: 'cancelled before the next attempt started' }
      try {
        const res = await reroute.restart({ candidate: next, remaining, task, previous })
        return { ok: true, ...res }
      } catch (error) {
        lastError = error
        // The failed job's write lock is released just after its record turns terminal.
        if (error?.category !== 'write-conflict' && !/lock/i.test(String(error?.message ?? ''))) break
        await sleep(RESTART_LOCK_WAIT_MS)
      }
    }
    return { ok: false, attempts: lastError?.attempts ?? [], errorKind: lastError?.errorKind ?? 'crash', error: String(lastError?.message ?? lastError) }
  }

  #mark(jobId, patch) {
    try {
      updateResult(jobId, patch, this.env)
    } catch {}
  }

  #finish(tracker, record) {
    tracker.record = record
    tracker.notice = { ...buildJobNotice(record, { attempts: tracker.attempts, tool: tracker.tool }), ...(tracker.reroutes ? { reroutes: tracker.reroutes } : {}) }
    tracker.status = record.status === 'succeeded' ? 'completed' : record.status === 'canceled' ? 'cancelled' : 'failed'
    tracker.statusMessage = noticeText(tracker.notice)
    tracker.lastUpdatedAt = new Date().toISOString()
  }
}

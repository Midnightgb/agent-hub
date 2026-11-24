/**
 * MCP-side job notifications: tell the client that started a job when it
 * reaches a terminal state, without the client polling job_status.
 *
 * Two delivery mechanisms share this module's watcher and notice shape
 * (see mcp-tasks.mjs and mcp-channel.mjs). Neither writes to events.jsonl:
 * the event log keeps its shape, this is a per-session MCP consumer only.
 */
import { readResult as defaultReadResult } from '../jobstore.mjs'

export const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'canceled'])

const DEFAULT_POLL_MS = 500

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status)
}

/** The jobId of whatever a delegate/dispatch handler returned. */
export function jobIdOf(payload) {
  return payload?.job?.jobId ?? payload?.jobId ?? null
}

/**
 * Resolve with the job record once it is terminal. `shouldStop()` is checked on
 * every tick (a cancelled MCP task stops watching); returns null when stopped.
 * A record that cannot be read yet is retried, never thrown: a job that does
 * not exist keeps the watch on until it is stopped or the process exits.
 */
export async function watchJobUntilTerminal({
  jobId,
  env = process.env,
  readResultFn = defaultReadResult,
  pollMs = DEFAULT_POLL_MS,
  shouldStop = () => false,
  onTick = null,
} = {}) {
  for (;;) {
    if (shouldStop()) return null
    let record = null
    try {
      record = readResultFn(jobId, env)
    } catch {
      record = null
    }
    if (record && isTerminalStatus(record.status)) return record
    if (record && onTick) {
      try {
        await onTick(record)
      } catch {}
    }
    // unref: a watcher must never keep the MCP server process alive on exit.
    await new Promise((resolve) => setTimeout(resolve, pollMs).unref?.())
  }
}

/**
 * Merge the start-time attempts a dispatch made (agent/model tried, in order)
 * with the final outcome of the job that is the last of them. dispatch only
 * retries or falls back while a job fails to START, so every attempt but the
 * last already has its outcome; the last one takes the job's terminal result.
 */
export function mergeAttempts(attempts, record) {
  const list = (attempts ?? []).map((a) => ({
    agent: a.agent ?? null,
    model: a.model ?? null,
    jobId: a.jobId ?? null,
    status: a.status ?? null,
    errorKind: a.errorKind ?? null,
    error: a.error ?? null,
  }))
  if (list.length === 0 || !record) return list
  const last = list[list.length - 1]
  if (last.jobId == null || last.jobId === record.jobId) {
    list[list.length - 1] = {
      ...last,
      jobId: record.jobId,
      status: record.status,
      errorKind: record.errorKind ?? null,
      error: record.error ?? null,
    }
  }
  return list
}

/** The notification payload for one terminal job. Plain JSON. */
export function buildJobNotice(record, { attempts = null, tool = null } = {}) {
  return {
    jobId: record.jobId,
    tool,
    status: record.status,
    agent: record.agent ?? null,
    model: record.model ?? null,
    title: record.title ?? null,
    errorKind: record.errorKind ?? null,
    error: record.error ?? null,
    ...(attempts && attempts.length > 0 ? { attempts: mergeAttempts(attempts, record) } : {}),
  }
}

/** One human line (plus an attempts line for dispatch) describing the notice. */
export function noticeText(notice) {
  const who = [notice.agent, notice.model].filter(Boolean).join('/')
  const head = `Job ${notice.jobId}${who ? ` (${who})` : ''} ${notice.status}`
  const parts = [head]
  if (notice.errorKind) parts.push(`errorKind=${notice.errorKind}`)
  if (notice.error) parts.push(`error: ${notice.error}`)
  let text = parts.join(' - ')
  if (notice.attempts?.length) {
    const tried = notice.attempts
      .map((a) => `${[a.agent, a.model].filter(Boolean).join('/')}: ${a.status}${a.errorKind ? ` (${a.errorKind})` : ''}`)
      .join('; ')
    text += `. Attempts: ${tried}`
  }
  return text
}

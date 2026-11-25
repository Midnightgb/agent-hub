import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config.mjs'

/**
 * First-level event router + notification sinks.
 *
 * Architecture: event (events.jsonl) -> watcher (notify/watch.mjs) ->
 * notification adapter (this file). Nothing here is coupled to the dashboard;
 * the watcher runs as its own `bin/agent-hub watch` process, never inside
 * the MCP stdio lifecycle.
 *
 * Routing contract — how each category is detected from an event (or its
 * nested record, for emitters that wrap a job_wait/job_result payload):
 *
 * - job.finished            — event.kind === 'job.finished'
 * - job.failed              — event.kind === 'job.failed'
 * - job.canceled            — event.kind === 'job.canceled'
 * - workflow.completed      — event.kind === 'workflow.completed' (hook only;
 *                             workflows don't exist yet, no emitter writes it)
 * - jules.waiting           — the poller stopped for interaction: derived from
 *                             job_wait's waiting signal, i.e. the event (or its
 *                             record) carries pollingStoppedReason ===
 *                             'awaiting_interaction' (see cloud/poller.mjs),
 *                             waiting === true, or a remote state of
 *                             AWAITING_* / PAUSED (see computeAttention in
 *                             cloud/check.mjs). Checked BEFORE kind, so a
 *                             waiting snapshot never misroutes as finished.
 * - jules.attention_required — attentionRequired === true on the event (or its
 *                             record), i.e. jules_check/job_wait's attention
 *                             fields. Checked FIRST: attention implies waiting
 *                             but is the more specific, actionable signal.
 *
 * Everything else (job.queued/started, preflight, subagent.*,
 * proposal.*, learning.*) routes to null and is ignored by every adapter.
 */

/** Kinds that route by kind alone (no attention/waiting fields needed). */
export const INTERESTING_KINDS = new Set(['job.finished', 'job.failed', 'job.canceled', 'workflow.completed'])

function field(event, name) {
  if (event?.[name] !== undefined) return event[name]
  return event?.record?.[name]
}

function isWaitingState(state) {
  return typeof state === 'string' && (state.startsWith('AWAITING_') || state === 'PAUSED')
}

/**
 * Map an event to its notification category, or null when no adapter cares.
 * Never throws on malformed input (returns null).
 */
export function routeEvent(event) {
  try {
    if (!event || typeof event !== 'object') return null
    if (field(event, 'attentionRequired') === true) return 'jules.attention_required'
    if (
      field(event, 'pollingStoppedReason') === 'awaiting_interaction' ||
      field(event, 'waiting') === true ||
      isWaitingState(field(event, 'state'))
    ) {
      return 'jules.waiting'
    }
    if (typeof event.kind === 'string' && INTERESTING_KINDS.has(event.kind)) return event.kind
    return null
  } catch {
    return null
  }
}

/** Pick only display-safe fields — never the whole object, so no secret (API key, token) can leak into logs. */
export function summarizeEvent(event, category) {
  return {
    category,
    kind: event?.kind ?? null,
    jobId: event?.jobId ?? event?.record?.jobId ?? null,
    agent: event?.agent ?? null,
    model: event?.model ?? null,
    title: event?.title ?? null,
    state: event?.state ?? null,
    attentionReason: event?.attentionReason ?? event?.record?.attentionReason ?? null,
    summary: typeof event?.summary === 'string' ? event.summary.slice(0, 200) : null,
    ts: event?.ts ?? null,
  }
}

export function formatLine(event, category) {
  const s = summarizeEvent(event, category)
  const head = `[${s.category}] ${s.kind ?? 'event'}${s.jobId ? ` ${s.jobId}` : ''}${s.title ? ` — ${s.title}` : ''}`
  const tail = [s.agent && s.model ? `${s.agent}:${s.model}` : null, s.attentionReason ?? s.state, s.summary]
    .filter(Boolean)
    .join(' | ')
  return tail ? `${head} (${tail})` : head
}

/**
 * Log one line per interesting event. Returns true when handled, false when
 * the event was ignored. Never throws (a broken log stream reports once and
 * returns false).
 */
export function consoleAdapter(event, { log = console.log } = {}) {
  try {
    const category = routeEvent(event)
    if (!category) return false
    log(formatLine(event, category))
    return true
  } catch {
    return false
  }
}

/**
 * Append one JSON object per interesting event to `file` (JSONL).
 *
 * No opencode `notifier` plugin file convention was found in this repo, so
 * the line format is documented here instead: one JSON object per line with
 * { ts, category, kind, jobId, agent, model, title, state, attentionReason,
 * summary } — exactly what summarizeEvent() returns. Consumers tail the file
 * the same way watchEvents() tails events.jsonl.
 *
 * Default file: <AGENT_HUB_HOME>/notifications.jsonl. Returns true when
 * handled, false when ignored; never throws (I/O errors report once and
 * return false).
 */
export function createFileAdapter({ file = null, env = process.env } = {}) {
  const dest = file ?? path.join(paths(env).home, 'notifications.jsonl')
  return (event) => {
    try {
      const category = routeEvent(event)
      if (!category) return false
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.appendFileSync(dest, JSON.stringify(summarizeEvent(event, category)) + '\n', { encoding: 'utf8' })
      return true
    } catch (error) {
      console.error('[agent-hub] fileAdapter failed:', error?.message ?? error)
      return false
    }
  }
}

/**
 * POST one JSON body per interesting event to `url` (stub: no retries, no
 * batching). Body shape: { category, event: <summarizeEvent fields> }.
 *
 * - Missing URL: returns a no-op sink resolving { delivered: false, reason:
 *   'no_url' } — constructing or calling it NEVER throws.
 * - Timeout: AbortController at `timeoutMs` (default 5000); a slow endpoint
 *   resolves { delivered: false, reason: 'timeout' } instead of hanging.
 * - Errors (DNS, refused, non-2xx) resolve a reason object — never throw, so
 *   one dead endpoint can't kill the watch loop.
 * - Secrets: the URL itself is never logged; only summarizeEvent() fields go
 *   on the wire.
 */
export function createWebhookAdapter({ url = null, timeoutMs = 5000 } = {}) {
  if (!url) {
    return async () => ({ delivered: false, reason: 'no_url' })
  }
  return async (event) => {
    const category = routeEvent(event)
    if (!category) return { delivered: false, reason: 'ignored' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, event: summarizeEvent(event, category) }),
        signal: controller.signal,
      })
      if (!res.ok) return { delivered: false, reason: `http_${res.status}` }
      return { delivered: true }
    } catch (error) {
      if (error?.name === 'AbortError') return { delivered: false, reason: 'timeout' }
      return { delivered: false, reason: 'error' }
    } finally {
      clearTimeout(timer)
    }
  }
}

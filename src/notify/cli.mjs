import { readTail } from '../eventlog.mjs'
import { watchEvents } from './watch.mjs'
import { routeEvent, consoleAdapter, createFileAdapter, createWebhookAdapter } from './adapters.mjs'
import { deliverCompletion } from '../harness/lifecycle.mjs'
import { listJobs, readResult } from '../jobstore.mjs'

const USAGE =
  'Usage: agent-hub watch [--once|--follow] [--sink console|file|webhook] [--file PATH] [--url URL] [--tail N] ' +
  '[--job ID[,ID...]] [--root ID] [--until-terminal]'
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])
const TERMINAL_KINDS = new Set(['job.finished', 'job.failed', 'job.canceled'])

function rootOf(record) {
  return record?.root_execution_id ?? record?.rootExecutionId ?? null
}

function safeRead(jobId, env) {
  try {
    return readResult(jobId, env)
  } catch {
    return null
  }
}

function usageError(message) {
  console.error(`agent-hub watch: ${message}`)
  console.error(USAGE)
  process.exitCode = 2
  return false
}

/**
 * `bin/agent-hub watch` — the watcher as its own process, so the MCP stdio
 * lifecycle (src/index.mjs) stays scheduler-free on purpose.
 *
 * - --once: route the last --tail N events (default 50) and exit. Exit 0.
 * - --follow (default): route the last --tail N (default: none, only new
 *   appends), then tail events.jsonl until SIGINT/SIGTERM.
 * - --sink: comma-separated/repeatable, subset of console|file|webhook
 *   (default console). --file sets the file sink path, --url the webhook URL.
 * - --job ID[,ID...] / --root ID: only route events of those jobs (repeatable
 *   --job; --root matches every job whose root execution id is ID).
 * - --until-terminal: with --job/--root and --follow, exit 0 once every
 *   targeted job is terminal (succeeded/failed/canceled). Jobs already terminal
 *   when the watcher starts count, so a fast job cannot be missed.
 */
export async function runWatchCli(args, { env = process.env } = {}) {
  let once = false
  let follow = false
  const sinks = []
  let file = null
  let url = null
  let tail = null
  const jobIds = []
  let root = null
  let untilTerminal = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--once') once = true
    else if (a === '--follow') follow = true
    else if (a === '--sink') {
      const v = args[++i]
      if (!v) return usageError('--sink requires a value')
      sinks.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a.startsWith('--sink=')) {
      sinks.push(...a.slice('--sink='.length).split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a === '--file') {
      file = args[++i]
      if (!file) return usageError('--file requires a path')
    } else if (a.startsWith('--file=')) file = a.slice('--file='.length)
    else if (a === '--url') {
      url = args[++i]
      if (!url) return usageError('--url requires a value')
    } else if (a.startsWith('--url=')) url = a.slice('--url='.length)
    else if (a === '--tail') {
      tail = Number(args[++i])
      if (!Number.isInteger(tail) || tail < 0) return usageError('--tail requires a non-negative integer')
    } else if (a.startsWith('--tail=')) {
      tail = Number(a.slice('--tail='.length))
      if (!Number.isInteger(tail) || tail < 0) return usageError('--tail requires a non-negative integer')
    } else if (a === '--job') {
      const v = args[++i]
      if (!v) return usageError('--job requires a value')
      jobIds.push(...v.split(',').map((x) => x.trim()).filter(Boolean))
    } else if (a.startsWith('--job=')) {
      jobIds.push(...a.slice('--job='.length).split(',').map((x) => x.trim()).filter(Boolean))
    } else if (a === '--root') {
      root = args[++i]
      if (!root) return usageError('--root requires a value')
    } else if (a.startsWith('--root=')) {
      root = a.slice('--root='.length)
      if (!root) return usageError('--root requires a value')
    } else if (a === '--until-terminal') untilTerminal = true
    else if (a === '--help' || a === '-h') {
      console.log(USAGE)
      return true
    } else {
      return usageError(`unknown flag "${a}"`)
    }
  }

  if (once && follow) return usageError('--once and --follow are mutually exclusive')
  if (sinks.length === 0) sinks.push('console')
  for (const s of sinks) {
    if (!['console', 'file', 'webhook'].includes(s)) return usageError(`unknown sink "${s}"`)
  }
  if (sinks.includes('webhook') && !url) return usageError('webhook sink requires --url')
  const filtered = jobIds.length > 0 || root != null
  if (untilTerminal && !filtered) return usageError('--until-terminal requires --job or --root')
  if (untilTerminal && once) return usageError('--until-terminal cannot be combined with --once')

  const matches = (event) => {
    if (!filtered) return true
    const id = event?.jobId ?? event?.record?.jobId ?? null
    if (!id) return false
    if (jobIds.includes(id)) return true
    return root != null && rootOf(safeRead(id, env)) === root
  }

  // Truth comes from the job store, events are only the wake-up signal. A job
  // whose record does not exist yet counts as pending.
  const allTerminal = () => {
    const targets = new Set(jobIds)
    if (root != null) {
      for (const job of listJobs(env)) {
        if (rootOf(job) === root && job.jobId) targets.add(job.jobId)
      }
    }
    if (targets.size === 0) return false
    for (const id of targets) {
      if (!TERMINAL_STATUSES.has(safeRead(id, env)?.status)) return false
    }
    return true
  }

  const handlers = []
  if (sinks.includes('console')) handlers.push((e) => consoleAdapter(e))
  if (sinks.includes('file')) handlers.push(createFileAdapter({ file, env }))
  if (sinks.includes('webhook')) handlers.push(createWebhookAdapter({ url }))

  let routed = 0
  let handle = null
  const dispatch = async (event) => {
    if (!matches(event)) return
    if (!routeEvent(event)) return
    routed++
    const kind = event?.kind
    const jobId = event?.jobId ?? event?.record?.jobId ?? null
    if (kind === 'job.finished' || kind === 'job.failed' || (kind === 'workflow.completed' && jobId)) {
      try {
        await deliverCompletion({
          jobId,
          event,
          summary: event?.summary ?? event?.record?.summary ?? null,
          env,
        })
      } catch {
        // Best effort: bridge failure must never affect sink delivery
      }
    }
    await Promise.all(handlers.map((h) => h(event)))
    if (untilTerminal && handle && TERMINAL_KINDS.has(kind) && allTerminal()) handle.close()
  }

  if (once) {
    const n = tail ?? 50
    for (const event of readTail({ n, env })) await dispatch(event)
    console.error(`[agent-hub] watch --once: routed ${routed} event(s)`)
    return true
  }

  // --follow: catch up on --tail N first (default: only new appends), then tail.
  if (tail != null && tail > 0) {
    for (const event of readTail({ n: tail, env })) await dispatch(event)
  }
  handle = watchEvents({ env, onEvent: dispatch })
  console.error('[agent-hub] watch: following events.jsonl (Ctrl-C to stop)')
  // Jobs that finished before we started produce no new event: check the store.
  if (untilTerminal && allTerminal()) handle.close()
  const stop = () => {
    handle.close()
    console.error(`[agent-hub] watch: stopped after routing ${routed} event(s)`)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (handle.closed) {
        clearInterval(t)
        resolve()
      }
    }, 100)
    t.unref?.()
  })
  return true
}

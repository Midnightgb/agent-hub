/**
 * MCP tasks for long-running hub tools: the `io.modelcontextprotocol/tasks`
 * extension of protocol revision 2026-07-28 (https://modelcontextprotocol.io/extensions/tasks/overview),
 * which is what Claude Code speaks.
 *
 * A client that declares the extension in the per-request capabilities
 * (`_meta["io.modelcontextprotocol/clientCapabilities"].extensions`) and calls
 * delegate or dispatch gets a task handle (`resultType: "task"`) at once; the
 * hub follows the job and answers `tasks/get` with working, then completed
 * (result), failed (error with errorKind, error, agent/model, attempts) or
 * cancelled. Every other call (a legacy 2025-era connection, a 2026 client
 * without the extension, any other tool) goes to the SDK's own tools/call
 * handler untouched, so its result is byte-identical.
 *
 * The 2.x SDK ships no task engine (the 1.x experimental one was removed), so the
 * three task methods are served here. tools/call is wrapped through
 * Server._getRequestHandler, which is underscored in the SDK; installTaskSupport()
 * returns false and tasks stay off if it ever disappears (a test fails loudly).
 */
import * as z from 'zod'
import { ProtocolError, ProtocolErrorCode, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server'
import { jobIdOf, buildJobNotice, noticeText, isTerminalStatus } from './mcp-jobs.mjs'

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
export const TASKS_CAPABILITIES = Object.freeze({ extensions: { [TASKS_EXTENSION]: {} } })

const POLL_INTERVAL_MS = 3000
// -32000..-32019 is the implementation-defined range of the 2026-07-28 error code policy.
const JOB_FAILED_CODE = -32000

export function tasksEnabled(env = process.env) {
  const v = String(env?.AGENT_HUB_MCP_TASKS ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** Did this request's client declare the tasks extension (2026-07-28 connections only)? */
export function clientSupportsTasks(ctx) {
  const caps = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY]
  return Boolean(caps?.extensions && TASKS_EXTENSION in caps.extensions)
}

const textResult = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] })

function taskBase(t) {
  return {
    taskId: t.taskId,
    status: t.status,
    ...(t.statusMessage ? { statusMessage: t.statusMessage } : {}),
    createdAt: t.createdAt,
    lastUpdatedAt: t.lastUpdatedAt,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
  }
}

/** The tasks/get body for a tracker (or for a bare job record when this process has no tracker). */
function taskView(tracker, record) {
  if (tracker) {
    const base = taskBase(tracker)
    if (tracker.status === 'completed') return { ...base, result: textResult(tracker.notice) }
    if (tracker.status === 'failed') {
      return { ...base, error: { code: JOB_FAILED_CODE, message: tracker.statusMessage, data: tracker.notice } }
    }
    return base
  }
  // No tracker: the server restarted, or the job was not started as a task. The
  // task id is the job id, so the job record still answers (without attempts).
  const status = record.status === 'succeeded' ? 'completed' : record.status === 'canceled' ? 'cancelled' : isTerminalStatus(record.status) ? 'failed' : 'working'
  const notice = isTerminalStatus(record.status) ? buildJobNotice(record) : null
  const created = record.createdAt ?? new Date().toISOString()
  const base = taskBase({
    taskId: record.jobId,
    status,
    statusMessage: notice ? noticeText(notice) : null,
    createdAt: created,
    lastUpdatedAt: record.updatedAt ?? created,
  })
  if (status === 'completed') return { ...base, result: textResult(notice) }
  if (status === 'failed') return { ...base, error: { code: JOB_FAILED_CODE, message: noticeText(notice), data: notice } }
  return base
}

/**
 * @param {import('@modelcontextprotocol/server').McpServer} mcpServer
 * @param {object} opts
 * @param {Map<string, {schema, handler, track, ok, fail}>} opts.tools task-capable tools:
 *   handler(args, ctx, hooks) -> payload; track(payload, hooks, args, ctx) -> tracker;
 *   ok(payload)/fail(error) -> the plain CallToolResult the SDK path would return
 * @param {import('./mcp-supervisor.mjs').JobSupervisor} opts.supervisor
 * @param {Function} opts.readResultFn (jobId, env) => record, for tasks/get without a tracker
 * @param {object} [opts.env]
 */
export function installTaskSupport(mcpServer, { tools, supervisor, readResultFn, env = process.env }) {
  const low = mcpServer.server
  const originalCall = low?._getRequestHandler?.('tools/call')
  if (typeof originalCall !== 'function') return false

  low.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name
    const entry = tools.get(name)
    if (!entry || !clientSupportsTasks(ctx)) return originalCall(request, ctx)

    const parsed = entry.schema.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.message}`)
    }
    const hooks = { attempts: [], route: null }
    // The point of a task is not to hold the call: dispatch must not wait for the job here.
    const args = { ...parsed.data, ...(name === 'dispatch' && parsed.data.waitMode == null ? { waitMode: 'none' } : {}) }
    let payload
    try {
      payload = await entry.handler(args, ctx, {
        onAttempt: (a) => hooks.attempts.push(a),
        onRoute: (r) => {
          hooks.route = r
        },
      })
    } catch (error) {
      return entry.fail(error)
    }
    if (!jobIdOf(payload)) return entry.ok(payload)
    const tracker = entry.track(payload, hooks, args, ctx)
    return { resultType: 'task', ...taskBase(tracker) }
  })

  const TaskParams = z.object({ taskId: z.string().min(1) }).passthrough()
  const AnyResult = z.object({}).passthrough()

  low.setRequestHandler('tasks/get', { params: TaskParams, result: AnyResult }, async ({ taskId }) => {
    const tracker = supervisor.get(taskId)
    let record = null
    if (!tracker) {
      try {
        record = readResultFn(taskId, env)
      } catch {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to retrieve task: Task not found (${taskId})`)
      }
    }
    return { resultType: 'complete', ...taskView(tracker, record) }
  })

  low.setRequestHandler('tasks/cancel', { params: TaskParams, result: AnyResult }, async ({ taskId }) => {
    const tracker = supervisor.get(taskId)
    if (!tracker) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to retrieve task: Task not found (${taskId})`)
    await supervisor.cancel(taskId)
    return { resultType: 'complete' }
  })

  // The hub never asks a task for input, so there is nothing to answer.
  low.setRequestHandler('tasks/update', { params: TaskParams, result: AnyResult }, async () => ({ resultType: 'complete' }))
  return true
}

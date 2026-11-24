/**
 * MCP tasks for long-running hub tools (MCP spec 2025-11-25 "tasks", the
 * experimental task-augmented tools/call implemented by @modelcontextprotocol/sdk 1.x).
 *
 * A client that sends `tools/call` with a `task` param for delegate/dispatch
 * gets a CreateTaskResult at once; the hub then watches the job and moves the
 * task to completed/failed, which the SDK announces with
 * notifications/tasks/status. Every other call (no `task` param, any other tool)
 * goes to the SDK's own handler untouched, so its result is byte-identical.
 *
 * The SDK's McpServer registers tools as taskSupport "forbidden" and its own
 * tools/call handler would then run a task-augmented call as a plain one, so
 * this wraps the two request handlers. That reads the SDK's private handler map
 * (Server._requestHandlers); installTaskSupport() returns false, and tasks stay
 * off, if a future SDK removes it. test/mcp-task-notifications.test.mjs fails
 * loudly in that case.
 */
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { watchJobUntilTerminal, jobIdOf, buildJobNotice, noticeText } from './mcp-jobs.mjs'

export const TASKS_CAPABILITY = Object.freeze({ list: {}, cancel: {}, requests: { tools: { call: {} } } })

const DEFAULT_TTL_MS = 60 * 60 * 1000
const POLL_INTERVAL_MS = 2000
const STATUS_MESSAGE_META = 'agent-hub/statusMessage'

export function tasksEnabled(env = process.env) {
  const v = String(env?.AGENT_HUB_MCP_TASKS ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/**
 * The SDK store has no way to attach a message to a terminal transition, and
 * the failure reason (errorKind, error, agent/model, attempts) must travel in the
 * notifications/tasks/status notification itself.
 */
export class HubTaskStore extends InMemoryTaskStore {
  async storeTaskResult(taskId, status, result, sessionId) {
    await super.storeTaskResult(taskId, status, result, sessionId)
    const message = result?._meta?.[STATUS_MESSAGE_META]
    if (message) {
      const stored = this.tasks.get(taskId)
      if (stored) stored.task.statusMessage = message
    }
  }
}

const textResult = (payload, extra = {}) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  ...extra,
})

function failureResult(notice) {
  return textResult(notice, { isError: true, _meta: { [STATUS_MESSAGE_META]: noticeText(notice) } })
}

async function runTask({ entry, name, args, extra, taskId, env, readResultFn, cancelJobFn, pollMs }) {
  const store = extra.taskStore
  const attempts = []
  let payload
  try {
    payload = await entry.handler(args, extra, { onAttempt: (a) => attempts.push(a) })
  } catch (error) {
    const message = `agent-hub error: ${error?.message ?? String(error)}`
    await store
      .storeTaskResult(taskId, 'failed', {
        content: [{ type: 'text', text: message }],
        isError: true,
        _meta: { [STATUS_MESSAGE_META]: message },
      })
      .catch(() => {})
    return
  }

  const jobId = jobIdOf(payload)
  if (!jobId) {
    await store.storeTaskResult(taskId, 'completed', textResult(payload)).catch(() => {})
    return
  }

  let stopped = false
  const record = await watchJobUntilTerminal({
    jobId,
    env,
    readResultFn,
    pollMs,
    shouldStop: () => stopped,
    // tasks/cancel marks the task cancelled in the store; stop the job with it.
    onTick: async () => {
      const task = await store.getTask(taskId).catch(() => null)
      if (task?.status === 'cancelled' && !stopped) {
        stopped = true
        await cancelJobFn(jobId, { env }).catch(() => {})
      }
    },
  })
  if (!record) return

  const notice = {
    ...buildJobNotice(record, { attempts, tool: name }),
    ...(payload?.dispatchKey ? { dispatchKey: payload.dispatchKey } : {}),
    ...(payload?.executionId ? { executionId: payload.executionId } : {}),
  }
  if (record.status === 'succeeded') {
    await store.storeTaskResult(taskId, 'completed', textResult(notice)).catch(() => {})
  } else if (record.status === 'canceled') {
    // Cancelled outside the task (job_cancel): the task ends cancelled too.
    await store.updateTaskStatus(taskId, 'cancelled', noticeText(notice)).catch(() => {})
  } else {
    await store.storeTaskResult(taskId, 'failed', failureResult(notice)).catch(() => {})
  }
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
 * @param {object} opts
 * @param {Map<string, {schema: import('zod').ZodTypeAny, handler: Function}>} opts.tools
 *   task-capable tools: zod object schema for the arguments (same defaults the
 *   SDK applies) and the raw handler (args, extra, {onAttempt}) -> payload
 */
export function installTaskSupport(mcpServer, { tools, env = process.env, readResultFn, cancelJobFn, pollMs = 500 }) {
  const lowLevel = mcpServer.server
  const handlers = lowLevel?._requestHandlers
  const originalCall = handlers?.get?.('tools/call')
  const originalList = handlers?.get?.('tools/list')
  if (typeof originalCall !== 'function' || typeof originalList !== 'function') return false

  lowLevel.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await originalList(request, extra)
    return {
      ...result,
      tools: result.tools.map((tool) => (tools.has(tool.name) ? { ...tool, execution: { ...tool.execution, taskSupport: 'optional' } } : tool)),
    }
  })

  lowLevel.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    const entry = tools.get(name)
    if (!request.params.task || !entry || !extra.taskStore) return originalCall(request, extra)

    const parsed = entry.schema.safeParse(request.params.arguments ?? {})
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.message}`)
    }
    const task = await extra.taskStore.createTask({ ttl: request.params.task.ttl ?? DEFAULT_TTL_MS, pollInterval: POLL_INTERVAL_MS })
    // Deliberately not awaited: the CreateTaskResult goes out now, the task
    // finishes when the job does.
    void runTask({ entry, name, args: parsed.data, extra, taskId: task.taskId, env, readResultFn, cancelJobFn, pollMs }).catch(() => {})
    return {
      task,
      _meta: {
        'io.modelcontextprotocol/model-immediate-response':
          `${name} started as task ${task.taskId}. The hub reports completion or failure (errorKind, error, agent/model` +
          `${name === 'dispatch' ? ', fallbacks tried' : ''}) through the task status; no polling is needed.`,
      },
    }
  })
  return true
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema, CreateTaskResultSchema, TaskStatusNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

// The server reads AGENT_HUB_HOME at call time; set it before anything touches the store.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-mcp-tasks-'))
process.env.AGENT_HUB_HOME = HOME
process.env.AGENT_HUB_DISABLE_STARTUP_DISCOVERY = '1'

const { createJob, readResult, updateResult } = await import('../src/jobstore.mjs')
const { buildServer } = await import('../src/index.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A real job record that a fake start function flips to a terminal state later. */
function fakeJob({ agent = 'copilot', model = 'gpt-5.1', finish, afterMs = 80 }) {
  const job = createJob({ agent, model, task: 'do it', cwd: '/tmp', title: 'fake', mode: 'write' })
  updateResult(job.jobId, { status: 'running' })
  setTimeout(() => updateResult(job.jobId, finish), afterMs)
  return job
}

async function connect({ deps = {}, env = {} } = {}) {
  const server = buildServer({ env: { ...process.env, ...env }, deps, taskPollMs: 15 })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const channel = []
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') channel.push(n.params)
  }
  const statuses = []
  client.setNotificationHandler(TaskStatusNotificationSchema, async (n) => {
    statuses.push(n.params)
  })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server, statuses, channel, close: () => client.close() }
}

async function callAsTask(client, name, args) {
  return client.request({ method: 'tools/call', params: { name, arguments: args, task: { ttl: 60_000 } } }, CreateTaskResultSchema)
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(10)
  }
  throw new Error('timed out waiting for condition')
}

const delegateArgs = { agent: 'copilot', model: 'gpt-5.1', task: 'do it', cwd: '/tmp', mode: 'write' }

test('task-capable call on delegate returns a task at once and a terminal status notification on success', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ finish: { status: 'succeeded' } })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const { client, statuses, close } = await connect({ deps })
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.find((t) => t.name === 'delegate').execution?.taskSupport, 'optional')
    assert.equal(tools.find((t) => t.name === 'dispatch').execution?.taskSupport, 'optional')

    const started = Date.now()
    const created = await callAsTask(client, 'delegate', delegateArgs)
    assert.ok(Date.now() - started < 70, 'the task is created before the job finishes')
    assert.equal(created.task.status, 'working')

    const done = await until(() => statuses.find((s) => s.taskId === created.task.taskId && s.status === 'completed'))
    assert.equal(done.status, 'completed')

    const result = await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.status, 'succeeded')
    assert.equal(payload.agent, 'copilot')
    assert.equal(payload.model, 'gpt-5.1')
    assert.equal(result.isError, undefined)
  } finally {
    await close()
  }
})

test('task-capable call whose job fails on quota notifies failed with errorKind, error, agent and model', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ agent: 'agy', model: 'gemini-3.8-pro', finish: { status: 'failed', errorKind: 'quota', error: 'Individual quota reached. Resets in 3h.' } })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const { client, statuses, close } = await connect({ deps })
  try {
    const created = await callAsTask(client, 'delegate', { ...delegateArgs, agent: 'agy', model: 'gemini-3.8-pro' })
    const failed = await until(() => statuses.find((s) => s.taskId === created.task.taskId && s.status === 'failed'))
    assert.match(failed.statusMessage, /quota/)
    assert.match(failed.statusMessage, /Individual quota reached/)
    assert.match(failed.statusMessage, /agy/)
    assert.match(failed.statusMessage, /gemini-3\.8-pro/)

    const result = await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema)
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.errorKind, 'quota')
    assert.equal(payload.error, 'Individual quota reached. Resets in 3h.')
    assert.equal(payload.agent, 'agy')
    assert.equal(payload.model, 'gemini-3.8-pro')
  } finally {
    await close()
  }
})

test('dispatch failure notification lists the fallback attempts that were tried', async () => {
  const deps = {
    dispatch: async ({ onAttempt }) => {
      onAttempt({ agent: 'agy', model: 'gemini-3.8-pro', jobId: null, status: 'failed', errorKind: 'quota', error: 'agy quota exhausted' })
      const job = fakeJob({ agent: 'copilot', model: 'gpt-5.1', finish: { status: 'failed', errorKind: 'quota', error: 'copilot quota/rate limit' } })
      onAttempt({ agent: 'copilot', model: 'gpt-5.1', jobId: job.jobId, status: 'running', errorKind: null, error: null })
      return { job: readResult(job.jobId), dispatchKey: 'k', executionId: 'e', candidate: { agent: 'copilot', model: 'gpt-5.1' } }
    },
  }
  const { client, statuses, close } = await connect({ deps })
  try {
    const created = await callAsTask(client, 'dispatch', { task: 'do it', cwd: '/tmp', mode: 'write' })
    const failed = await until(() => statuses.find((s) => s.taskId === created.task.taskId && s.status === 'failed'))
    assert.match(failed.statusMessage, /agy\/gemini-3\.8-pro/)
    assert.match(failed.statusMessage, /copilot\/gpt-5\.1/)

    const result = await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.attempts.length, 2)
    assert.deepEqual(
      payload.attempts.map((a) => [a.agent, a.model, a.status, a.errorKind]),
      [
        ['agy', 'gemini-3.8-pro', 'failed', 'quota'],
        ['copilot', 'gpt-5.1', 'failed', 'quota'],
      ]
    )
    assert.equal(payload.attempts[1].error, 'copilot quota/rate limit')
  } finally {
    await close()
  }
})

test('tasks/cancel cancels the underlying job', async () => {
  const canceled = []
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ finish: { status: 'succeeded' }, afterMs: 5000 })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
    cancelJob: async (jobId) => {
      canceled.push(jobId)
      updateResult(jobId, { status: 'canceled' })
      return readResult(jobId)
    },
  }
  const { client, close } = await connect({ deps })
  try {
    const created = await callAsTask(client, 'delegate', delegateArgs)
    const cancelled = await client.experimental.tasks.cancelTask(created.task.taskId)
    assert.equal(cancelled.status, 'cancelled')
    await until(() => canceled.length === 1)
  } finally {
    await close()
  }
})

test('a client that does not ask for a task gets the exact historical result and tools/list is unchanged for other tools', async () => {
  const payload = { jobId: 'job-fixed-1', status: 'queued', errorKind: null }
  const deps = { delegateTool: () => payload }
  const { client, statuses, close } = await connect({ deps })
  try {
    const res = await client.callTool({ name: 'delegate', arguments: delegateArgs })
    assert.equal(res.content[0].text, JSON.stringify(payload, null, 2))
    assert.deepEqual(res.structuredContent, payload)
    assert.equal(res.isError, undefined)
    assert.equal(res.task, undefined)
    await sleep(60)
    assert.deepEqual(statuses, [], 'no task, no status notification')

    const { tools } = await client.listTools()
    assert.equal(tools.find((t) => t.name === 'job_status').execution?.taskSupport, 'forbidden')
  } finally {
    await close()
  }
})

test('task support can be switched off: no task capability, task-augmented calls are served as plain calls', async () => {
  const payload = { jobId: 'job-fixed-2', status: 'queued', errorKind: null }
  const deps = { delegateTool: () => payload }
  const { client, close } = await connect({ deps, env: { AGENT_HUB_MCP_TASKS: 'off' } })
  try {
    assert.equal(client.getServerCapabilities().tasks, undefined)
    const { tools } = await client.listTools()
    assert.equal(tools.find((t) => t.name === 'delegate').execution?.taskSupport, 'forbidden')
  } finally {
    await close()
  }
})

test('channel mode (opt in): a plain delegate call keeps its result and a terminal channel event reaches the client', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ agent: 'agy', model: 'gemini-3.8-pro', finish: { status: 'failed', errorKind: 'quota', error: 'Individual quota reached.' } })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const { client, channel, close } = await connect({ deps, env: { AGENT_HUB_CHANNEL: '1' } })
  try {
    assert.deepEqual(client.getServerCapabilities().experimental?.['claude/channel'], {})
    const res = await client.callTool({ name: 'delegate', arguments: delegateArgs })
    const payload = JSON.parse(res.content[0].text)
    assert.equal(payload.status, 'running')

    const event = await until(() => channel.find((c) => c.meta?.job_id === payload.jobId))
    assert.equal(event.meta.status, 'failed')
    assert.equal(event.meta.error_kind, 'quota')
    assert.match(event.content, /Individual quota reached/)
    assert.match(event.content, /agy/)
    assert.match(event.content, /gemini-3\.8-pro/)
  } finally {
    await close()
  }
})

test('without the channel opt in there is no channel capability and no channel event', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ finish: { status: 'succeeded' }, afterMs: 30 })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const { client, channel, close } = await connect({ deps })
  try {
    assert.equal(client.getServerCapabilities().experimental?.['claude/channel'], undefined)
    await client.callTool({ name: 'delegate', arguments: delegateArgs })
    await sleep(150)
    assert.deepEqual(channel, [])
  } finally {
    await close()
  }
})

test('dispatch reports every start attempt through onAttempt, fallbacks included, and without it keeps its result', async () => {
  const { dispatch } = await import('../src/dispatch.mjs')
  const startJobFn = async (args) => {
    if (args.agent === 'opencode') {
      return { job: { jobId: 'job-fast-fail', agent: args.agent, model: args.model, status: 'failed', errorKind: 'quota', error: 'Rate limit exceeded' }, done: Promise.resolve() }
    }
    return { job: { jobId: 'job-fallback', agent: args.agent, model: args.model, status: 'running', dispatchKey: args.dispatchKey }, done: Promise.resolve() }
  }
  const route = {
    routeFn: async () => ({
      primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' },
      fallbacks: [{ agent: 'agy', model: 'gemini-3.8-flash-low' }],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn,
    harness: 'generic',
  }
  const attempts = []
  const withHook = await dispatch({ task: 'attempts', taskType: 'triage', cwd: '/tmp/attempts-a', dispatchKey: 'attempts-a', onAttempt: (a) => attempts.push(a), ...route })
  // the policy retries the failed candidate before it falls back, and every try is reported
  assert.ok(attempts.length >= 2)
  const last = attempts[attempts.length - 1]
  assert.deepEqual([last.agent, last.status, last.errorKind, last.jobId], ['agy', 'running', null, 'job-fallback'])
  for (const a of attempts.slice(0, -1)) {
    assert.deepEqual([a.agent, a.status, a.errorKind, a.jobId], ['opencode', 'failed', 'quota', 'job-fast-fail'])
  }
  assert.equal(attempts[0].error, 'Rate limit exceeded')

  const without = await dispatch({ task: 'attempts', taskType: 'triage', cwd: '/tmp/attempts-b', dispatchKey: 'attempts-b', ...route })
  assert.equal(without.job.jobId, withHook.job.jobId)
  assert.equal(without.candidate.agent, 'agy')
})

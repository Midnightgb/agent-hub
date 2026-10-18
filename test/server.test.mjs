import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs')

export async function connect(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-server-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    // Startup discovery (src/startup.mjs) spawns real agy/opencode/copilot
    // processes in the background once the server boots for real; this
    // suite must never do that, so every spawned server disables it.
    env: { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_DISABLE_STARTUP_DISCOVERY: '1', ...env },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
  return { client, home, close: () => client.close() }
}

test('the server boots over stdio and exposes the full tool set', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'agent_ack',
        'agent_inbox',
        'agent_peers',
        'agent_send_message',
        'agents_metrics',
        'agents_quota',
        'agents_status',
        'delegate',
        'dispatch',
        'execute_plan',
        'execution_graph',
        'job_cancel',
        'job_reply',
        'job_result',
        'job_status',
        'job_wait',
        'jules_accounts',
        'jules_check',
        'jules_delegate',
        'jules_interact',
        'jules_schedules',
        'jules_sessions',
        'jules_sources',
        'jules_supervise',
        'jules_wait',
        'learning_propose',
        'plan_task',
        'route',
        'task_assign',
        'task_close',
        'task_continue',
        'task_status',
      ]
    )
  } finally {
    await close()
  }
})

test('listTools() resolves quickly — startup discovery (background CLI spawns) never blocks the stdio handshake', async () => {
  const { client, close } = await connect()
  try {
    const startedAt = Date.now()
    await client.listTools()
    assert.ok(Date.now() - startedAt < 2000, 'the handshake + first tool call should never wait on CLI discovery')
  } finally {
    await close()
  }
})

test('delegate requires agent, model, task and cwd', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const delegateTool = tools.find((t) => t.name === 'delegate')
    const required = delegateTool.inputSchema.required ?? []
    for (const field of ['agent', 'model', 'task', 'cwd']) {
      assert.ok(required.includes(field), `delegate.inputSchema should require "${field}"`)
    }
  } finally {
    await close()
  }
})

test('dispatch requires task and cwd', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const dispatchTool = tools.find((t) => t.name === 'dispatch')
    assert.ok(dispatchTool)
    const required = dispatchTool.inputSchema.required ?? []
    for (const field of ['task', 'cwd']) {
      assert.ok(required.includes(field), `dispatch.inputSchema should require "${field}"`)
    }
  } finally {
    await close()
  }
})

test('route only accepts known task types', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const routeTool = tools.find((t) => t.name === 'route')
    const taskTypeSchema = routeTool.inputSchema.properties.taskType
    assert.ok(Array.isArray(taskTypeSchema.enum) && taskTypeSchema.enum.length > 0)
  } finally {
    await close()
  }
})

test('job_reply requires jobId; message is optional at the schema level (a jules approve_plan reply sends no message)', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const jobReply = tools.find((t) => t.name === 'job_reply')
    const required = jobReply.inputSchema.required ?? []
    assert.ok(required.includes('jobId'), 'job_reply.inputSchema should require "jobId"')
    assert.ok(!required.includes('message'), 'message must be optional — a jules action:"approve_plan" reply sends no message text')
  } finally {
    await close()
  }
})

test('jules_delegate requires only task, and its description flags the remote/PR/alpha/no-cancel caveats', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const julesDelegate = tools.find((t) => t.name === 'jules_delegate')
    assert.ok(julesDelegate, 'jules_delegate must be registered')
    assert.deepEqual(julesDelegate.inputSchema.required ?? [], ['task'])
    for (const phrase of [/google/i, /pull request/i, /alpha/i, /cancel/i]) {
      assert.match(julesDelegate.description, phrase, `jules_delegate.description should mention ${phrase}`)
    }
  } finally {
    await close()
  }
})

test('jules_sources has no required input and explains sources are connected in the Jules web UI', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const julesSources = tools.find((t) => t.name === 'jules_sources')
    assert.ok(julesSources, 'jules_sources must be registered')
    assert.deepEqual(julesSources.inputSchema.required ?? [], [])
    assert.match(julesSources.description, /web UI/i)
    assert.match(julesSources.description, /cannot be added/i)
  } finally {
    await close()
  }
})

test('jules_check reads the Jules API live and documents the reboot/no-poller recovery path', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const julesCheck = tools.find((t) => t.name === 'jules_check')
    assert.ok(julesCheck, 'jules_check must be registered')
    assert.deepEqual(julesCheck.inputSchema.required ?? [], [])
    for (const phrase of [/Jules API/i, /reboot/i, /poll/i, /jules_sessions/]) {
      assert.match(julesCheck.description, phrase, `jules_check.description should mention ${phrase}`)
    }
  } finally {
    await close()
  }
})

test('jules_sessions lists sessions live with no local polling and documents the recovery path', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const julesSessions = tools.find((t) => t.name === 'jules_sessions')
    assert.ok(julesSessions, 'jules_sessions must be registered')
    for (const phrase of [/Jules API/i, /reboot/i, /poll/i, /jules_check/, /jobId/]) {
      assert.match(julesSessions.description, phrase, `jules_sessions.description should mention ${phrase}`)
    }
  } finally {
    await close()
  }
})

test('jules_delegate mentions jules_check as the way to pick a session up later', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const julesDelegate = tools.find((t) => t.name === 'jules_delegate')
    assert.match(julesDelegate.description, /jules_check/)
  } finally {
    await close()
  }
})

test('job_reply accepts an optional action input', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const jobReply = tools.find((t) => t.name === 'job_reply')
    assert.ok(jobReply.inputSchema.properties.action, 'job_reply should accept an "action" input')
    assert.ok(!(jobReply.inputSchema.required ?? []).includes('action'), 'action must be optional')
  } finally {
    await close()
  }
})

test('job_cancel is marked destructive', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const jobCancel = tools.find((t) => t.name === 'job_cancel')
    assert.equal(jobCancel.annotations?.destructiveHint, true)
  } finally {
    await close()
  }
})

test('jules_accounts is registered read-only with no required input', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'jules_accounts')
    assert.ok(tool, 'jules_accounts must be registered')
    assert.deepEqual(tool.inputSchema.required ?? [], [])
    assert.equal(tool.annotations?.readOnlyHint, true)
  } finally {
    await close()
  }
})

test('jules_delegate and jules_sources accept an optional account', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    for (const name of ['jules_delegate', 'jules_sources']) {
      const tool = tools.find((t) => t.name === name)
      assert.ok(tool.inputSchema.properties.account, `${name} should accept an "account" input`)
      assert.ok(!(tool.inputSchema.required ?? []).includes('account'), `${name} account must be optional`)
    }
  } finally {
    await close()
  }
})

test('jules_supervise is registered with expected schema and annotations', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'jules_supervise')
    assert.ok(tool, 'jules_supervise must be registered')
    assert.deepEqual(tool.inputSchema.required ?? [], [])
    assert.equal(tool.annotations?.readOnlyHint, false)
    assert.ok(tool.inputSchema.properties.jobId, 'accepts jobId')
    assert.ok(tool.inputSchema.properties.sessionId, 'accepts sessionId')
    assert.ok(tool.inputSchema.properties.autoApprovePlan, 'accepts autoApprovePlan')
    assert.ok(tool.inputSchema.properties.autoResolveFeedback, 'accepts autoResolveFeedback')
    assert.ok(tool.inputSchema.properties.maxAutoReplies, 'accepts maxAutoReplies')
    assert.ok(tool.inputSchema.properties.pauseAfterAmbiguity, 'accepts pauseAfterAmbiguity')
    for (const phrase of [/watch/i, /hard gates/i, /PAUSED/]) {
      assert.match(tool.description, phrase, `jules_supervise.description should mention ${phrase}`)
    }
  } finally {
    await close()
  }
})

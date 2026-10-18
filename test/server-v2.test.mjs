import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { RouteResult, MetricsResponse } from '../src/schemas.mjs'
import { connect } from './server.test.mjs'

/** Write a fake terminal job straight into a running server's AGENT_HUB_HOME, bypassing jobrunner. */
function writeFakeJob(home, overrides = {}) {
  const { responseText, ...recordOverrides } = overrides
  const jobId = recordOverrides.jobId || 'fake-job-1'
  const dir = path.join(home, 'runs', jobId)
  fs.mkdirSync(dir, { recursive: true })
  const record = {
    jobId,
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    title: 'fake job',
    cwd: '/tmp',
    mode: 'read',
    status: 'succeeded',
    errorKind: null,
    error: null,
    timeoutS: null,
    timeoutSource: 'default',
    taskType: null,
    turnDepth: 0,
    learningIds: [],
    variant: null,
    sessionId: null,
    parentJobId: null,
    tokens: null,
    costUsd: null,
    pid: null,
    pgid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...recordOverrides,
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(record, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'response.txt'), responseText ?? 'hello world response', 'utf8')
  return record
}

test('annotations include idempotentHint where specified', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    for (const name of ['agents_status', 'route', 'job_status', 'job_wait', 'job_result', 'agents_metrics', 'execution_graph', 'learning_propose']) {
      assert.equal(byName[name].annotations?.idempotentHint, true, `${name} should have idempotentHint`)
    }
  } finally {
    await close()
  }
})

test('route returns structuredContent that parses with RouteResult', async () => {
  const { client, close } = await connect()
  try {
    const result = await client.callTool({ name: 'route', arguments: { taskType: 'recon' } })
    assert.ok(result.structuredContent, 'route should return structuredContent')
    const parsed = RouteResult.safeParse(result.structuredContent)
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues))
  } finally {
    await close()
  }
})

test('agents_metrics on an empty home returns structuredContent with rows []', async () => {
  const { client, close } = await connect()
  try {
    const result = await client.callTool({ name: 'agents_metrics', arguments: {} })
    assert.ok(result.structuredContent)
    const parsed = MetricsResponse.safeParse(result.structuredContent)
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues))
    assert.deepEqual(result.structuredContent.rows, [])
  } finally {
    await close()
  }
})

test('execution_graph is registered and returns an empty graph on an empty home', async () => {
  const { client, close } = await connect()
  try {
    const { tools } = await client.listTools()
    assert.ok(tools.some((t) => t.name === 'execution_graph'), 'execution_graph must be registered as an MCP tool')
    const result = await client.callTool({ name: 'execution_graph', arguments: {} })
    assert.ok(result.structuredContent)
    assert.deepEqual(result.structuredContent.roots, [])
    assert.deepEqual(result.structuredContent.edges, [])
  } finally {
    await close()
  }
})

test('learning_propose returns a pending learning, and a second identical call returns the same id', async () => {
  const { client, close } = await connect()
  try {
    const args = { text: 'agy hangs on prompts over 4k tokens', agent: 'agy', taskType: 'recon' }
    const first = await client.callTool({ name: 'learning_propose', arguments: args })
    assert.equal(first.structuredContent.learning.status, 'pending')
    assert.ok(first.structuredContent.learning.id)

    const second = await client.callTool({ name: 'learning_propose', arguments: args })
    assert.equal(second.structuredContent.learning.id, first.structuredContent.learning.id)
  } finally {
    await close()
  }
})

test("delegate with taskType 'nope' is rejected without spawning anything", async () => {
  const { client, close } = await connect()
  try {
    let threw = false
    let result
    try {
      result = await client.callTool({
        name: 'delegate',
        arguments: { agent: 'agy', model: 'gemini-3.8-flash-low', task: 'hi', cwd: '/tmp', taskType: 'nope' },
      })
    } catch {
      threw = true
    }
    assert.ok(threw || result?.isError, 'an unknown taskType should be rejected, either as an MCP error or isError:true')
  } finally {
    await close()
  }
})

test('job_status/job_result/resources read a fake job written directly into AGENT_HUB_HOME', async () => {
  const { client, home, close } = await connect()
  try {
    const record = writeFakeJob(home, { jobId: 'fake-job-status', responseText: 'line1\nline2\nline3' })

    const status = await client.callTool({ name: 'job_status', arguments: { jobId: record.jobId } })
    assert.equal(status.structuredContent.status, 'succeeded')
    assert.equal(status.structuredContent.jobId, record.jobId)

    const resultOut = await client.callTool({ name: 'job_result', arguments: { jobId: record.jobId, maxLines: 2 } })
    assert.equal(resultOut.structuredContent.truncated, true)
    assert.match(resultOut.structuredContent.text, /line1\nline2/)

    const resource = await client.readResource({ uri: `agent-hub://jobs/${record.jobId}` })
    const parsedRecord = JSON.parse(resource.contents[0].text)
    assert.equal(parsedRecord.jobId, record.jobId)
    assert.equal(resource.contents[0].mimeType, 'application/json')

    const responseResource = await client.readResource({ uri: `agent-hub://jobs/${record.jobId}/response` })
    assert.equal(responseResource.contents[0].text, 'line1\nline2\nline3')
    assert.equal(responseResource.contents[0].mimeType, 'text/plain')
  } finally {
    await close()
  }
})

test('reading a resource for an unknown jobId fails with "job not found"', async () => {
  const { client, close } = await connect()
  try {
    await assert.rejects(() => client.readResource({ uri: 'agent-hub://jobs/does-not-exist' }), /job not found/)
  } finally {
    await close()
  }
})

test('reading the response resource for a job with no response.txt yet returns an empty string', async () => {
  const { client, home, close } = await connect()
  try {
    const dir = path.join(home, 'runs', 'fake-job-no-response')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'result.json'),
      JSON.stringify({
        jobId: 'fake-job-no-response',
        agent: 'agy',
        model: 'x',
        title: '',
        cwd: '/tmp',
        mode: 'read',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf8'
    )

    const responseResource = await client.readResource({ uri: 'agent-hub://jobs/fake-job-no-response/response' })
    assert.equal(responseResource.contents[0].text, '')
  } finally {
    await close()
  }
})

test('listResourceTemplates shows both job resource templates', async () => {
  const { client, close } = await connect()
  try {
    const { resourceTemplates } = await client.listResourceTemplates()
    const uris = resourceTemplates.map((t) => t.uriTemplate).sort()
    assert.deepEqual(uris, ['agent-hub://jobs/{jobId}', 'agent-hub://jobs/{jobId}/response'])
  } finally {
    await close()
  }
})

test('listPrompts shows the three prompts and getPrompt("guided-write", args) contains the goal and job_reply', async () => {
  const { client, close } = await connect()
  try {
    const { prompts } = await client.listPrompts()
    assert.deepEqual(
      prompts.map((p) => p.name).sort(),
      ['adversarial-review', 'guided-write', 'recon']
    )

    const result = await client.getPrompt({ name: 'guided-write', arguments: { goal: 'add a health endpoint', cwd: '/tmp/worktree' } })
    const text = result.messages[0].content.text
    assert.match(text, /add a health endpoint/)
    assert.match(text, /job_reply/)
  } finally {
    await close()
  }
})

test('delegate returns its job record instead of crashing on the registered handler', async () => {
  // Regression: the C1.2 origin-mapping wiring wrapped delegateTool(...) in
  // .then(), but delegateTool is synchronous and returns a plain object, so
  // EVERY delegate call died with "delegateTool(...).then is not a function".
  // dispatch() survived the same wrapping only because it really is async.
  //
  // Write mode with the (empty) WRITE_ALLOWLIST is rejected before anything
  // is spawned, so this exercises the whole registered handler -- including
  // the origin-mapping step -- without starting a real CLI.
  const { client, close } = await connect()
  try {
    const result = await client.callTool({
      name: 'delegate',
      arguments: { agent: 'agy', model: 'gemini-3.8-flash-low', task: 'hi', cwd: '/tmp', mode: 'write' },
    })

    assert.ok(!result.isError, `delegate must not error: ${JSON.stringify(result.content)}`)
    assert.ok(result.structuredContent?.jobId, 'delegate must return a jobId')
    assert.equal(result.structuredContent.status, 'failed')
    assert.equal(result.structuredContent.errorKind, 'worktree_denied')
  } finally {
    await close()
  }
})

test('same-tree-fanout S3: job_wait over MCP accepts jobIds and still answers a single jobId, both passing the output schema', async () => {
  const { client, home, close } = await connect()
  try {
    writeFakeJob(home, { jobId: 'fanout-a' })
    writeFakeJob(home, { jobId: 'fanout-b' })
    const many = await client.callTool({ name: 'job_wait', arguments: { jobIds: ['fanout-a', 'fanout-b'], timeoutS: 5 } })
    assert.notEqual(many.isError, true, JSON.stringify(many.content))
    assert.deepEqual(many.structuredContent.jobs.map((j) => j.jobId), ['fanout-a', 'fanout-b'])
    assert.deepEqual(many.structuredContent.pending, [])
    assert.equal(many.structuredContent.done, true)

    const one = await client.callTool({ name: 'job_wait', arguments: { jobId: 'fanout-a', timeoutS: 5 } })
    assert.notEqual(one.isError, true, JSON.stringify(one.content))
    assert.equal(one.structuredContent.jobId, 'fanout-a')
    assert.equal(one.structuredContent.status, 'succeeded')
  } finally {
    await close()
  }
})

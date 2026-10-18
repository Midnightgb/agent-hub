import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractLastJsonLine } from '../src/adapters/base.mjs'

// same-tree-fanout T2 (S3): job_wait({ jobIds }) waits on a fan-out of jobs.

function fakeAdapter(script) {
  return {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => ({ ok: true, text: extractLastJsonLine(stdout)?.response ?? '', tokens: null, sessionId: null }),
    classifyError: (stdout, exitInfo = {}) => (exitInfo.timedOut ? { kind: 'timeout', message: 'timeout' } : extractLastJsonLine(stdout) ? null : { kind: 'crash', message: 'no JSON' }),
    listModels: () => [],
  }
}

const QUICK = `console.log(JSON.stringify({status:"SUCCESS",response:"ok"}))`
const SLOW = `setTimeout(() => console.log(JSON.stringify({status:"SUCCESS",response:"late"})), 2500)`

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-waitmany-'))
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const { startJob } = await import('../src/jobrunner.mjs?t=' + tag)
  const tools = await import('../src/tools/jobs.mjs?t=' + tag)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-waitmany-cwd-'))
  const start = (script) => startJob({ agent: 'fake', model: 'x', task: 't', cwd, mode: 'read', adapterFor: () => fakeAdapter(script) })
  return { start, tools }
}

test('S3: job_wait with jobIds returns every job once all are terminal', async () => {
  const { start, tools } = await setup()
  const a = start(QUICK)
  const b = start(QUICK)
  const res = await tools.jobWaitTool({ jobIds: [a.job.jobId, b.job.jobId], timeoutS: 10 })
  assert.equal(res.done, true)
  assert.equal(res.timedOut, false)
  assert.deepEqual(res.pending, [])
  assert.deepEqual(res.completed.sort(), [a.job.jobId, b.job.jobId].sort())
  assert.deepEqual(res.jobs.map((j) => j.jobId), [a.job.jobId, b.job.jobId], 'jobs keep the caller order')
  assert.deepEqual(res.jobs.map((j) => j.status), ['succeeded', 'succeeded'])
})

test('S3: when the budget expires, job_wait with jobIds reports which jobs are still pending', async () => {
  const { start, tools } = await setup()
  const quick = start(QUICK)
  const slow = start(SLOW)
  await quick.done
  const res = await tools.jobWaitTool({ jobIds: [quick.job.jobId, slow.job.jobId], timeoutS: 1 })
  assert.equal(res.done, false)
  assert.equal(res.timedOut, true)
  assert.deepEqual(res.completed, [quick.job.jobId])
  assert.deepEqual(res.pending, [slow.job.jobId])
  assert.equal(res.jobs[0].status, 'succeeded')
  assert.ok(['queued', 'running'].includes(res.jobs[1].status))
  await slow.done
})

test('S3: until:"any" returns as soon as one job is terminal, listing the rest as pending', async () => {
  const { start, tools } = await setup()
  const quick = start(QUICK)
  const slow = start(SLOW)
  const res = await tools.jobWaitTool({ jobIds: [slow.job.jobId, quick.job.jobId], until: 'any', timeoutS: 10 })
  assert.equal(res.done, true)
  assert.equal(res.timedOut, false)
  assert.deepEqual(res.completed, [quick.job.jobId])
  assert.deepEqual(res.pending, [slow.job.jobId])
  await slow.done
})

test('S3: job_wait rejects jobId together with jobIds, an empty jobIds, and neither', async () => {
  const { tools } = await setup()
  await assert.rejects(() => tools.jobWaitTool({ jobId: 'a', jobIds: ['b'] }), /exactly one of jobId or jobIds/)
  await assert.rejects(() => tools.jobWaitTool({ jobIds: [] }), /exactly one of jobId or jobIds/)
  await assert.rejects(() => tools.jobWaitTool({}), /exactly one of jobId or jobIds/)
})

test('S3: job_wait with a single jobId keeps its previous shape', async () => {
  const { start, tools } = await setup()
  const a = start(QUICK)
  const res = await tools.jobWaitTool({ jobId: a.job.jobId, timeoutS: 10 })
  assert.equal(res.jobId, a.job.jobId)
  assert.equal(res.status, 'succeeded')
  assert.equal(res.done, true)
  assert.equal(res.waiting, false)
  assert.equal(res.timedOut, false)
  assert.equal(res.jobs, undefined)
})

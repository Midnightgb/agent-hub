import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runWatchCli } from '../src/notify/cli.mjs'
import { appendEvent, readTail } from '../src/eventlog.mjs'
import { createJob, updateResult, reconcileOrphans } from '../src/jobstore.mjs'

function tmpEnv() {
  return { AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-watchcli-')) }
}

function newJob(env, extra = {}) {
  return createJob({ agent: 'agy', model: 'm', task: 't', cwd: '/tmp', title: 't', env, ...extra })
}

function captureLog(fn) {
  const lines = []
  const orig = console.log
  const origErr = console.error
  console.log = (l) => lines.push(String(l))
  console.error = () => {}
  return fn().then(
    (v) => {
      console.log = orig
      console.error = origErr
      return { lines, value: v }
    },
    (e) => {
      console.log = orig
      console.error = origErr
      throw e
    }
  )
}

const withTimeout = (p, ms = 5000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('watch did not exit')), ms))])

test('--job routes only the targeted job events (--once)', async () => {
  const env = tmpEnv()
  appendEvent({ kind: 'job.finished', jobId: 'job-a', title: 'A' }, { env })
  appendEvent({ kind: 'job.finished', jobId: 'job-b', title: 'B' }, { env })
  const { lines } = await captureLog(() => runWatchCli(['--once', '--job', 'job-b'], { env }))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /job-b/)
})

test('without filters every job is still routed (--once unchanged)', async () => {
  const env = tmpEnv()
  appendEvent({ kind: 'job.finished', jobId: 'job-a' }, { env })
  appendEvent({ kind: 'job.failed', jobId: 'job-b' }, { env })
  const { lines } = await captureLog(() => runWatchCli(['--once'], { env }))
  assert.equal(lines.length, 2)
})

test('job.canceled is routed to the console sink', async () => {
  const env = tmpEnv()
  appendEvent({ kind: 'job.canceled', jobId: 'job-c' }, { env })
  const { lines } = await captureLog(() => runWatchCli(['--once'], { env }))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /job\.canceled/)
})

test('--until-terminal exits immediately when the job was already terminal', async () => {
  const env = tmpEnv()
  const job = newJob(env)
  updateResult(job.jobId, { status: 'succeeded' }, env)
  await captureLog(() => withTimeout(runWatchCli(['--follow', '--job', job.jobId, '--until-terminal'], { env })))
})

test('--until-terminal --job waits for every job, then exits on the last terminal event', async () => {
  const env = tmpEnv()
  const a = newJob(env)
  const b = newJob(env)
  let done = false
  const run = captureLog(() =>
    withTimeout(runWatchCli(['--follow', '--job', `${a.jobId},${b.jobId}`, '--until-terminal'], { env }))
  ).then(() => {
    done = true
  })
  await new Promise((r) => setTimeout(r, 300))
  updateResult(a.jobId, { status: 'succeeded' }, env)
  appendEvent({ kind: 'job.finished', jobId: a.jobId }, { env })
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(done, false, 'must keep waiting while b is running')
  updateResult(b.jobId, { status: 'canceled' }, env)
  appendEvent({ kind: 'job.canceled', jobId: b.jobId }, { env })
  await run
  assert.equal(done, true)
})

test('--until-terminal --root waits for the jobs of that root only', async () => {
  const env = tmpEnv()
  const a = newJob(env, { root_execution_id: 'root-1' })
  const other = newJob(env, { root_execution_id: 'root-2' })
  updateResult(other.jobId, { status: 'running' }, env)
  let done = false
  const run = captureLog(() => withTimeout(runWatchCli(['--follow', '--root', 'root-1', '--until-terminal'], { env }))).then(
    () => {
      done = true
    }
  )
  await new Promise((r) => setTimeout(r, 300))
  updateResult(a.jobId, { status: 'failed' }, env)
  appendEvent({ kind: 'job.failed', jobId: a.jobId }, { env })
  await run
  assert.equal(done, true)
})

test('--until-terminal without --job/--root is a usage error', async () => {
  const env = tmpEnv()
  const prev = process.exitCode
  const { value } = await captureLog(() => runWatchCli(['--follow', '--until-terminal'], { env }))
  assert.equal(value, false)
  assert.equal(process.exitCode, 2)
  process.exitCode = prev
})

test('reconcileOrphans emits a job.failed/orphaned event', async () => {
  const env = tmpEnv()
  const job = newJob(env)
  updateResult(job.jobId, { status: 'running', pid: 999999, pgid: 999999 }, env)
  assert.deepEqual(reconcileOrphans(env), [job.jobId])
  const event = readTail({ n: 10, env }).find((e) => e.jobId === job.jobId)
  assert.equal(event?.kind, 'job.failed')
  assert.equal(event?.errorKind, 'orphaned')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { extractLastJsonLine } from '../src/adapters/base.mjs'
import { startJob } from '../src/jobrunner.mjs'
import { createJob, updateResult, responsePath, readResult } from '../src/jobstore.mjs'
import { proposeLearning, decideLearning, listLearnings, selectLearnings, augmentTask } from '../src/learnings.mjs'
import { startLearningProbe, learningProbeResult, probeVerdictHint } from '../src/learning-probes.mjs'
import { learningProbeTool, learningProbeResultTool } from '../src/tools/learnings.mjs'
import { createServer } from '../src/dashboard.mjs'

// learning-probes (odd/tasks/learning-probes.md, S1-S4). No real agent CLI is
// ever spawned: jobs either run a `node -e` fake adapter through the real
// startJob, or are bare createJob records whose status the test sets.

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-learning-probes-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-learning-probes-cwd-'))
  process.env.AGENT_HUB_HOME = home
  const env = { ...process.env, AGENT_HUB_HOME: home }
  return { home, cwd, env }
}

function readEvents(home) {
  const file = path.join(home, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function readPrompt(home, jobId) {
  return fs.readFileSync(path.join(home, 'runs', jobId, 'prompt.txt'), 'utf8')
}

const SUCCESS_SCRIPT = `console.log(JSON.stringify({status:"SUCCESS",response:"PONG"}))`

function fakeAdapter(script = SUCCESS_SCRIPT) {
  return {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => {
      const json = extractLastJsonLine(stdout)
      if (!json || json.status !== 'SUCCESS') return { ok: false }
      return { ok: true, text: json.response, tokens: null, sessionId: null }
    },
    classifyError: (stdout) => (extractLastJsonLine(stdout)?.status === 'SUCCESS' ? null : { kind: 'crash', retriable: false, message: 'fake' }),
    listModels: () => [],
  }
}

/** startJobFn running the real startJob against a fake `node -e` adapter; collects each job's `done`. */
function realStartJob() {
  const calls = []
  const dones = []
  const fn = (opts) => {
    calls.push(opts)
    const started = startJob({ ...opts, adapterFor: () => fakeAdapter() })
    dones.push(started.done)
    return started
  }
  return { fn, calls, dones }
}

/** startJobFn that only creates a queued job record (no process); the test drives the status. */
function recordOnlyStartJob() {
  const calls = []
  const fn = (opts) => {
    calls.push(opts)
    const job = createJob({ agent: opts.agent, model: opts.model, task: opts.task, cwd: opts.cwd, mode: opts.mode, taskType: opts.taskType, env: opts.env })
    if (opts.output) updateResult(job.jobId, { output: opts.output }, opts.env)
    return { job, done: Promise.resolve() }
  }
  return { fn, calls }
}

/** Mark a job terminal with a given duration and response text. */
function finish(env, jobId, { status = 'succeeded', durationMs = 1000, text = 'ok', errorKind = null } = {}) {
  const createdAt = '2026-10-18T10:00:00.000Z'
  const updatedAt = new Date(Date.parse(createdAt) + durationMs).toISOString()
  fs.writeFileSync(responsePath(jobId, env), text, 'utf8')
  // updateResult stamps updatedAt itself, so write the record file directly afterwards.
  updateResult(jobId, { status, errorKind }, env)
  const file = path.join(env.AGENT_HUB_HOME, 'runs', jobId, 'result.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...record, createdAt, updatedAt }), 'utf8')
}

function reviewText(severities) {
  const findings = severities.map((severity, i) => ({ severity, file: null, line: null, title: `f${i}`, detail: '' }))
  return `prose\n\n\`\`\`json\n${JSON.stringify({ summary: 's', findings })}\n\`\`\`\n`
}

function seed(env, { agent = 'fake', model = 'm1', taskType = null, sourceJobId } = {}) {
  const approved = proposeLearning({ agent, model, text: 'approved note: prefer small diffs' }, env)
  decideLearning(approved.id, 'approved', env)
  const pending = proposeLearning(
    { ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(taskType ? { taskType } : {}), text: 'pending note: read package.json first', ...(sourceJobId ? { sourceJobId } : {}) },
    env
  )
  return { approved, pending }
}

// --- startJob injection (S1, S3) ---

test('a normal job still gets exactly the approved selection: the prompt is byte-identical to augmentTask(task, selectLearnings())', async () => {
  const { home, cwd, env } = setup()
  seed(env)
  const expected = augmentTask('do it', selectLearnings({ agent: 'fake', model: 'm1', env })).task
  const started = startJob({ agent: 'fake', model: 'm1', task: 'do it', cwd, mode: 'read', env, adapterFor: () => fakeAdapter() })
  await started.done
  assert.equal(readPrompt(home, started.job.jobId), expected)
  assert.ok(!expected.includes('pending note'))
  assert.equal(readResult(started.job.jobId, env).learningIds.length, 1)
})

test('startJob extraLearnings appends the probed learning after the normal selection and records its id', async () => {
  const { home, cwd, env } = setup()
  const { approved, pending } = seed(env)
  const started = startJob({ agent: 'fake', model: 'm1', task: 'do it', cwd, mode: 'read', env, adapterFor: () => fakeAdapter(), extraLearnings: [pending] })
  await started.done
  assert.equal(readPrompt(home, started.job.jobId), augmentTask('do it', [approved, pending]).task)
  assert.deepEqual(readResult(started.job.jobId, env).learningIds, [approved.id, pending.id])
})

// --- learning_probe (S1) ---

test('learning_probe starts two read jobs in parallel with the same task, cwd, agent and model', async () => {
  const { cwd, env } = setup()
  const { pending } = seed(env)
  const start = realStartJob()
  const out = learningProbeTool({ learningId: pending.id, task: 'audit the repo', cwd }, { env, startJobFn: start.fn })
  assert.deepEqual(Object.keys(out).sort(), ['controlJobId', 'probeId', 'treatmentJobId'])
  assert.equal(start.calls.length, 2)
  for (const call of start.calls) {
    assert.equal(call.mode, 'read')
    assert.equal(call.task, 'audit the repo')
    assert.equal(call.cwd, cwd)
    assert.equal(call.agent, 'fake')
    assert.equal(call.model, 'm1')
  }
  // Both were started before either finished (fan-out, not sequential).
  assert.notEqual(readResult(out.controlJobId, env).status, 'succeeded')
  await Promise.all(start.dones)
  assert.notEqual(out.controlJobId, out.treatmentJobId)
})

test('learning_probe: the treatment prompt carries the probed learning, the control prompt does not, and learningIds are recorded', async () => {
  const { home, cwd, env } = setup()
  const { approved, pending } = seed(env)
  const start = realStartJob()
  const out = startLearningProbe({ learningId: pending.id, task: 'audit the repo', cwd }, { env, startJobFn: start.fn })
  await Promise.all(start.dones)
  const control = readPrompt(home, out.controlJobId)
  const treatment = readPrompt(home, out.treatmentJobId)
  assert.ok(treatment.includes('pending note: read package.json first'))
  assert.ok(!control.includes('pending note'))
  assert.ok(control.includes('approved note'))
  assert.deepEqual(readResult(out.controlJobId, env).learningIds, [approved.id])
  assert.deepEqual(readResult(out.treatmentJobId, env).learningIds, [approved.id, pending.id])
})

test('learning_probe defaults agent/model/taskType from the learning and task/cwd from its sourceJobId (hub augmentation stripped)', () => {
  const { cwd, env } = setup()
  const source = createJob({ agent: 'fake', model: 'm1', task: augmentTask('original task', [{ id: 'x', text: 'old note' }]).task, cwd, env })
  const { pending } = seed(env, { taskType: 'recon', sourceJobId: source.jobId })
  const start = recordOnlyStartJob()
  startLearningProbe({ learningId: pending.id }, { env, startJobFn: start.fn })
  assert.equal(start.calls.length, 2)
  for (const call of start.calls) {
    assert.equal(call.task, 'original task')
    assert.equal(call.cwd, cwd)
    assert.equal(call.agent, 'fake')
    assert.equal(call.model, 'm1')
    assert.equal(call.taskType, 'recon')
  }
})

test('learning_probe requires task/cwd when the source job is unavailable, before any job starts', () => {
  const { env } = setup()
  const { pending } = seed(env, { sourceJobId: 'job-does-not-exist' })
  const start = recordOnlyStartJob()
  assert.throws(() => startLearningProbe({ learningId: pending.id }, { env, startJobFn: start.fn }), /missing task, cwd/)
  assert.equal(start.calls.length, 0)
})

test('learning_probe rejects non-pending, unknown, under-specified and write-mode probes before any job starts', () => {
  const { cwd, env } = setup()
  const { approved, pending } = seed(env)
  const rejected = proposeLearning({ text: 'rejected note' }, env)
  decideLearning(rejected.id, 'rejected', env)
  const unscoped = proposeLearning({ text: 'unscoped note' }, env)
  const start = recordOnlyStartJob()
  const run = (input) => startLearningProbe({ task: 't', cwd, ...input }, { env, startJobFn: start.fn })

  assert.throws(() => run({ learningId: approved.id }), /only pending learnings can be probed \(learning .* is approved\)/)
  assert.throws(() => run({ learningId: rejected.id }), /is rejected/)
  assert.throws(() => run({ learningId: 'learn-nope' }), /learning not found: learn-nope/)
  assert.throws(() => run({ learningId: unscoped.id }), /missing agent, model/)
  assert.throws(() => run({ learningId: pending.id, task: undefined }), /missing task/)
  assert.throws(() => run({ learningId: pending.id, mode: 'write' }), /probes are read-only/)
  assert.throws(() => run({ learningId: pending.id, agent: 'jules' }), /remote agent/)
  assert.equal(start.calls.length, 0)
  assert.equal(listLearnings({}, env).find((l) => l.id === pending.id).probes, undefined)
})

// --- learning_probe_result (S2) ---

test('learning_probe_result returns done:false with both statuses while a job is still running', () => {
  const { cwd, env } = setup()
  const { pending } = seed(env)
  const start = recordOnlyStartJob()
  const out = startLearningProbe({ learningId: pending.id, task: 't', cwd }, { env, startJobFn: start.fn })
  finish(env, out.controlJobId)
  const result = learningProbeResultTool({ probeId: out.probeId }, { env })
  assert.equal(result.done, false)
  assert.equal(result.control.status, 'succeeded')
  assert.equal(result.treatment.status, 'queued')
  assert.equal(listLearnings({}, env)[0].probes?.[0]?.comparison ?? null, null)
})

test('learning_probe_result builds a per-arm comparison and persists it once (idempotent), recording one learning.probed event', () => {
  const { home, cwd, env } = setup()
  const { approved, pending } = seed(env)
  const start = recordOnlyStartJob()
  const out = startLearningProbe({ learningId: pending.id, task: 't', cwd, output: 'review' }, { env, startJobFn: start.fn })
  finish(env, out.controlJobId, { durationMs: 2000, text: reviewText(['blocker', 'major', 'minor']) })
  finish(env, out.treatmentJobId, { durationMs: 3000, text: reviewText(['major', 'info']) })

  const first = learningProbeResult({ probeId: out.probeId }, { env })
  assert.equal(first.done, true)
  const { control, treatment, verdictHint } = first.comparison
  assert.equal(control.jobId, out.controlJobId)
  assert.equal(control.status, 'succeeded')
  assert.equal(control.errorKind, null)
  assert.equal(control.durationMs, 2000)
  assert.equal(control.responseChars, reviewText(['blocker', 'major', 'minor']).length)
  assert.deepEqual(control.findings, { blocker: 1, major: 1, minor: 1, info: 0 })
  assert.deepEqual(treatment.findings, { blocker: 0, major: 1, minor: 0, info: 1 })
  assert.equal(verdictHint, 'treatment_better')

  const stored = listLearnings({}, env).find((l) => l.id === pending.id)
  assert.equal(stored.probes.length, 1)
  assert.deepEqual(stored.probes[0].comparison, first.comparison)
  assert.ok(stored.probes[0].completedAt)

  // Second call: same comparison, nothing re-persisted, no second event.
  const before = fs.readFileSync(path.join(home, 'learnings.json'), 'utf8')
  const second = learningProbeResult({ probeId: out.probeId }, { env })
  assert.deepEqual(second.comparison, first.comparison)
  assert.equal(fs.readFileSync(path.join(home, 'learnings.json'), 'utf8'), before)
  assert.equal(readEvents(home).filter((e) => e.kind === 'learning.probed').length, 1)

  // S3: probing never changes status, and normal selection still ignores it.
  assert.equal(stored.status, 'pending')
  assert.deepEqual(
    selectLearnings({ agent: 'fake', model: 'm1', env }).map((l) => l.id),
    [approved.id]
  )
})

test('learning_probe_result rejects an unknown probeId', () => {
  const { env } = setup()
  assert.throws(() => learningProbeResult({ probeId: 'probe-nope' }, { env }), /probe not found: probe-nope/)
})

// --- verdict hint rules (S2) ---

const arm = (overrides = {}) => ({ status: 'succeeded', durationMs: 10_000, findings: null, ...overrides })

test('verdict hint: when exactly one arm succeeded, that arm is better', () => {
  assert.equal(probeVerdictHint(arm({ status: 'failed' }), arm()).verdictHint, 'treatment_better')
  assert.equal(probeVerdictHint(arm(), arm({ status: 'canceled' })).verdictHint, 'control_better')
})

test('verdict hint: when neither arm succeeded, it is inconclusive', () => {
  assert.equal(probeVerdictHint(arm({ status: 'failed' }), arm({ status: 'failed' })).verdictHint, 'inconclusive')
})

test('verdict hint: with review findings on both arms, fewer blocker+major wins; equal counts fall through', () => {
  const few = { blocker: 0, major: 1, minor: 5, info: 0 }
  const many = { blocker: 1, major: 1, minor: 0, info: 0 }
  assert.equal(probeVerdictHint(arm({ findings: many }), arm({ findings: few })).verdictHint, 'treatment_better')
  assert.equal(probeVerdictHint(arm({ findings: few }), arm({ findings: many })).verdictHint, 'control_better')
  assert.equal(probeVerdictHint(arm({ findings: few }), arm({ findings: { ...few, minor: 0 } })).verdictHint, 'no_difference')
})

test('verdict hint: both succeeded without a findings difference -> faster wins only past 50% and 30 s, else no_difference', () => {
  assert.equal(probeVerdictHint(arm({ durationMs: 100_000 }), arm({ durationMs: 40_000 })).verdictHint, 'treatment_better')
  assert.equal(probeVerdictHint(arm({ durationMs: 40_000 }), arm({ durationMs: 100_000 })).verdictHint, 'control_better')
  // >50% but under 30 s apart.
  assert.equal(probeVerdictHint(arm({ durationMs: 30_000 }), arm({ durationMs: 10_000 })).verdictHint, 'no_difference')
  // >30 s apart but under 50%.
  assert.equal(probeVerdictHint(arm({ durationMs: 140_000 }), arm({ durationMs: 100_000 })).verdictHint, 'no_difference')
})

// --- compatibility and visibility (S3, S4) ---

test('an old learnings.json without probes still loads, selects and can be probed', () => {
  const { home, cwd, env } = setup()
  const old = {
    version: 1,
    learnings: [
      { id: 'learn-old-1', agent: 'fake', model: 'm1', taskType: null, text: 'old approved', status: 'approved', source: 'mcp', sourceJobId: null, createdAt: '2026-01-01T00:00:00.000Z', decidedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'learn-old-2', agent: 'fake', model: 'm1', taskType: null, text: 'old pending', status: 'pending', source: 'mcp', sourceJobId: null, createdAt: '2026-01-01T00:00:00.000Z', decidedAt: null },
    ],
  }
  fs.writeFileSync(path.join(home, 'learnings.json'), JSON.stringify(old), 'utf8')
  assert.equal(listLearnings({}, env).length, 2)
  assert.deepEqual(selectLearnings({ agent: 'fake', model: 'm1', env }).map((l) => l.id), ['learn-old-1'])
  const start = recordOnlyStartJob()
  const out = startLearningProbe({ learningId: 'learn-old-2', task: 't', cwd }, { env, startJobFn: start.fn })
  const stored = listLearnings({}, env).find((l) => l.id === 'learn-old-2')
  assert.equal(stored.probes.length, 1)
  assert.equal(stored.probes[0].probeId, out.probeId)
  assert.equal(stored.probes[0].comparison, null)
})

test('GET /api/learnings returns each learning with its probes', async () => {
  const { cwd, env } = setup()
  const { pending } = seed(env)
  const start = recordOnlyStartJob()
  const out = startLearningProbe({ learningId: pending.id, task: 't', cwd }, { env, startJobFn: start.fn })
  const server = createServer({ env })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  try {
    const body = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/api/learnings', headers: { Host: '127.0.0.1' } }, (res) => {
          let raw = ''
          res.on('data', (c) => (raw += c))
          res.on('end', () => resolve(JSON.parse(raw)))
        })
        .on('error', reject)
    })
    const learning = body.learnings.find((l) => l.id === pending.id)
    assert.equal(learning.probes.length, 1)
    assert.equal(learning.probes[0].controlJobId, out.controlJobId)
    assert.equal(learning.probes[0].treatmentJobId, out.treatmentJobId)
  } finally {
    server.close()
  }
})

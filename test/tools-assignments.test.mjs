import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createJob, updateResult, readResult } from '../src/jobstore.mjs'
import { resetDbInstances } from '../src/storage/sqlite.mjs'
import { paths } from '../src/config.mjs'
import { getAssignment, beginTurn, rebindTurn, createAssignment } from '../src/assignments.mjs'
import {
  ASSIGNABLE_AGENTS,
  tokenCount,
  contextTokenCount,
  contextBudget,
  reconcileAssignment,
  taskAssignTool,
  taskContinueTool,
  taskStatusTool,
  taskCloseTool,
} from '../src/tools/assignments.mjs'
import { jobReplyTool } from '../src/tools/jobs.mjs'

after(() => resetDbInstances())

function tmpEnv() {
  return { AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tools-assignments-')) }
}

/**
 * A fake startJob that records its arguments and creates a REAL job record
 * (so the jobId comes from jobstore, exactly like production) without ever
 * spawning a CLI. `status` lets a test simulate a failed-fast job.
 */
function fakeStarter(env, { status = 'running', throwError = null } = {}) {
  const calls = []
  const startJobFn = (args) => {
    calls.push(args)
    if (throwError) throw throwError
    const job = createJob({ ...args, env })
    if (status !== 'queued') updateResult(job.jobId, { status, errorKind: status === 'failed' ? 'write_gate' : null }, env)
    return { job: readResult(job.jobId, env) }
  }
  return { startJobFn, calls }
}

function finishJob(jobId, env, patch = {}) {
  updateResult(jobId, { status: 'succeeded', sessionId: 'ses-1', tokens: 1200, ...patch }, env)
}

function assignInput(overrides = {}) {
  return {
    agent: 'opencode',
    model: 'opencode/big-pickle',
    title: 'Implement T2',
    task: 'Wire the task_* tools.',
    planRef: 'odd/tasks/task-assignments.md#T2',
    cwd: '/tmp',
    mode: 'read',
    ...overrides,
  }
}

async function assignAndFinish(env, overrides = {}, finishPatch = {}) {
  const { startJobFn } = fakeStarter(env)
  const res = await taskAssignTool({ ...assignInput(overrides), startJobFn, env })
  finishJob(res.jobId, env, finishPatch)
  return res
}

describe('tokenCount', () => {
  test('accepts a plain number, a codex usage object, and missing values', () => {
    assert.equal(tokenCount(1500), 1500)
    assert.equal(tokenCount({ input: 1000, cachedInput: 400, output: 200, reasoning: 50 }), 1200)
    assert.equal(tokenCount({ total: 77 }), 77)
    assert.equal(tokenCount(null), 0)
    assert.equal(tokenCount(undefined), 0)
    assert.equal(tokenCount(-5), 0)
  })
})

describe('contextTokenCount', () => {
  test('uses codex input-side tokens, a plain total as the proxy, and null when absent', () => {
    // codex: cachedInput is a subset of input, output is not context of the next prompt.
    assert.equal(contextTokenCount({ input: 1000, cachedInput: 400, output: 200, reasoning: 50 }), 1000)
    assert.equal(contextTokenCount(1500), 1500)
    assert.equal(contextTokenCount({ total: 77 }), 77)
    assert.equal(contextTokenCount({ output: 5 }), null)
    assert.equal(contextTokenCount(null), null)
    assert.equal(contextTokenCount(undefined), null)
    assert.equal(contextTokenCount(-5), null)
  })
})

function writeDiscovery(env, discovery) {
  fs.writeFileSync(paths(env).discoveryFile, JSON.stringify(discovery))
}

function opencodeCatalog(model, context) {
  return {
    opencode: {
      agent: 'opencode', checkedAt: '2026-10-08T00:00:00.000Z', error: null,
      models: [{ id: model, label: model, limit: { context, output: 4096 } }],
    },
  }
}

describe('context budget', () => {
  test('reconcile records the last turn occupancy: codex input side, replaced each turn', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env, { agent: 'codex', model: 'default' }, { tokens: { input: 1000, cachedInput: 400, output: 200, reasoning: 50 } })
    let a = reconcileAssignment(first.assignmentId, { env })
    assert.equal(a.contextTokens, 1000)
    assert.equal(a.tokensUsed, 1200)

    const { startJobFn } = fakeStarter(env)
    const next = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn, env })
    finishJob(next.jobId, env, { tokens: { input: 3000, cachedInput: 2500, output: 100, reasoning: 0 } })
    a = reconcileAssignment(first.assignmentId, { env })
    assert.equal(a.contextTokens, 3000)
    assert.equal(a.tokensUsed, 4300)
  })

  test('a turn without token data leaves the recorded occupancy unchanged', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    assert.equal(reconcileAssignment(first.assignmentId, { env }).contextTokens, 1200)

    const { startJobFn } = fakeStarter(env)
    const next = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn, env })
    finishJob(next.jobId, env, { status: 'failed', errorKind: 'timeout', tokens: null })
    assert.equal(reconcileAssignment(first.assignmentId, { env }).contextTokens, 1200)
  })

  test('falls back to the default window when the catalog does not know the model', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const res = taskStatusTool({ assignmentId: first.assignmentId, env })
    assert.deepEqual(res.contextBudget, { contextTokens: 1200, contextWindow: 200000, fraction: 0.006, source: 'default' })
  })

  test('uses the catalog context window when the live catalog lists the model', async () => {
    const env = tmpEnv()
    writeDiscovery(env, opencodeCatalog('opencode/big-pickle', 1_000_000))
    const first = await assignAndFinish(env)
    const res = taskStatusTool({ assignmentId: first.assignmentId, env })
    assert.equal(res.contextBudget.contextWindow, 1_000_000)
    assert.equal(res.contextBudget.source, 'catalog')
    assert.equal(res.contextBudget.fraction, 0.0012)
    assert.equal(res.contextBudget.warning, undefined)
  })

  test('warns at and above the fraction, not below', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const assignment = reconcileAssignment(first.assignmentId, { env })

    writeDiscovery(env, opencodeCatalog('opencode/big-pickle', 2000))
    const at = contextBudget(assignment, { env })
    assert.equal(at.fraction, 0.6)
    assert.match(at.warning, /task_close/)

    writeDiscovery(env, opencodeCatalog('opencode/big-pickle', 1500))
    assert.match(contextBudget(assignment, { env }).warning, /task_close/)

    writeDiscovery(env, opencodeCatalog('opencode/big-pickle', 2001))
    assert.equal(contextBudget(assignment, { env }).warning, undefined)
  })

  test('reports a null fraction before any turn recorded occupancy', () => {
    const env = tmpEnv()
    const a = createAssignment({ agent: 'agy', model: 'gemini-flash', brief: 'b' }, env)
    assert.deepEqual(contextBudget(a, { env }), { contextTokens: null, contextWindow: 200000, fraction: null, source: 'default' })
  })

  test('the warn fraction is overridable through the environment', async () => {
    const env = { ...tmpEnv(), AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION: '0.005' }
    const first = await assignAndFinish(env)
    const res = taskStatusTool({ assignmentId: first.assignmentId, env })
    assert.equal(res.contextBudget.fraction, 0.006)
    assert.match(res.contextBudget.warning, /task_close/)
  })

  test('task_continue reports the budget of the session it resumes, without the turn-depth warning', async () => {
    const env = { ...tmpEnv(), AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS: '1500' }
    const first = await assignAndFinish(env)
    const { startJobFn } = fakeStarter(env)
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn, env })
    assert.equal(res.errorKind, null)
    assert.equal(res.contextBudget.contextTokens, 1200)
    assert.equal(res.contextBudget.contextWindow, 1500)
    assert.equal(res.contextBudget.fraction, 0.8)
    assert.match(res.contextBudget.warning, /task_close/)
    assert.equal(res.warning, undefined)
  })
})

describe('rebindTurn (store)', () => {
  test('moves the turn lock from a reservation to the real jobId only for the holder', () => {
    const env = tmpEnv()
    const a = createAssignment({ agent: 'agy', brief: 'b' }, env)
    assert.equal(beginTurn(a.id, 'reserve-1', env).ok, true)
    const wrong = rebindTurn(a.id, 'other', 'job-1', env)
    assert.equal(wrong.ok, false)
    assert.equal(wrong.reason, 'lock_mismatch')
    const ok = rebindTurn(a.id, 'reserve-1', 'job-1', env)
    assert.equal(ok.ok, true)
    assert.equal(ok.assignment.inFlightJobId, 'job-1')
  })
})

describe('task_assign', () => {
  test('creates an active assignment holding the lock for the first job', async () => {
    const env = tmpEnv()
    const { startJobFn, calls } = fakeStarter(env)
    const res = await taskAssignTool({ ...assignInput(), startJobFn, env })

    assert.equal(res.errorKind, null)
    assert.equal(res.status, 'running')
    assert.ok(res.assignmentId.startsWith('asg-'))
    assert.ok(res.jobId)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].agent, 'opencode')
    assert.equal(calls[0].model, 'opencode/big-pickle')
    assert.equal(calls[0].task, 'Wire the task_* tools.')
    assert.equal(calls[0].turnDepth, 0)

    const a = getAssignment(res.assignmentId, env)
    assert.equal(a.status, 'active')
    assert.equal(a.brief, 'Wire the task_* tools.')
    assert.equal(a.planRef, 'odd/tasks/task-assignments.md#T2')
    assert.equal(a.inFlightJobId, res.jobId)
    assert.equal(a.turns, 0)
  })

  test('refuses an agent without local session resume, without creating anything', async () => {
    const env = tmpEnv()
    const { startJobFn, calls } = fakeStarter(env)
    for (const agent of ['jules', 'copilot']) {
      const res = await taskAssignTool({ ...assignInput({ agent }), startJobFn, env })
      assert.equal(res.status, 'failed')
      assert.equal(res.errorKind, 'unsupported_agent')
      assert.equal(res.assignmentId, null)
      assert.match(res.error, /jules_interact/)
    }
    assert.equal(calls.length, 0)
    assert.deepEqual([...ASSIGNABLE_AGENTS].sort(), ['agy', 'codex', 'opencode'])
  })

  test('rejects an unknown taskType before creating an assignment', async () => {
    const env = tmpEnv()
    const { startJobFn } = fakeStarter(env)
    await assert.rejects(() => taskAssignTool({ ...assignInput({ taskType: 'nope' }), startJobFn, env }), /unknown taskType/)
    assert.deepEqual(taskStatusTool({ env }).assignments, [])
  })

  test('a spawn that throws releases the lock and returns the error', async () => {
    const env = tmpEnv()
    const { startJobFn } = fakeStarter(env, { throwError: new Error('cwd is not a secondary worktree') })
    const res = await taskAssignTool({ ...assignInput(), startJobFn, env })
    assert.equal(res.status, 'failed')
    assert.equal(res.errorKind, 'spawn_failed')
    assert.match(res.error, /secondary worktree/)
    const a = getAssignment(res.assignmentId, env)
    assert.equal(a.inFlightJobId, null)
    assert.equal(a.status, 'active')
  })

  test('a failed-fast job releases the lock and surfaces its errorKind', async () => {
    const env = tmpEnv()
    const { startJobFn } = fakeStarter(env, { status: 'failed' })
    const res = await taskAssignTool({ ...assignInput(), startJobFn, env })
    assert.equal(res.status, 'failed')
    assert.equal(res.errorKind, 'write_gate')
    assert.ok(res.jobId)
    assert.equal(getAssignment(res.assignmentId, env).inFlightJobId, null)
  })
})

describe('reconcileAssignment', () => {
  test('leaves a running turn in flight', async () => {
    const env = tmpEnv()
    const { startJobFn } = fakeStarter(env)
    const res = await taskAssignTool({ ...assignInput(), startJobFn, env })
    const a = reconcileAssignment(res.assignmentId, { env })
    assert.equal(a.inFlightJobId, res.jobId)
    assert.equal(a.headJobId, null)
  })

  test('completes a terminal turn: head, session, turns and tokens advance', async () => {
    const env = tmpEnv()
    const res = await assignAndFinish(env)
    const a = reconcileAssignment(res.assignmentId, { env })
    assert.equal(a.inFlightJobId, null)
    assert.equal(a.headJobId, res.jobId)
    assert.equal(a.sessionId, 'ses-1')
    assert.equal(a.turns, 1)
    assert.equal(a.tokensUsed, 1200)
  })

  test('a failed job still completes the turn so the human can see it and reply', async () => {
    const env = tmpEnv()
    const res = await assignAndFinish(env, {}, { status: 'failed', errorKind: 'timeout', tokens: null })
    const a = reconcileAssignment(res.assignmentId, { env })
    assert.equal(a.headJobId, res.jobId)
    assert.equal(a.sessionId, 'ses-1')
    assert.equal(a.turns, 1)
    assert.equal(a.tokensUsed, 0)
  })

  test('a fresh reservation counts as busy; a stale one is released', () => {
    const env = tmpEnv()
    const a = createAssignment({ agent: 'agy', brief: 'b' }, env)
    const now = Date.now()
    beginTurn(a.id, `reserve-${now}-abcd`, env)
    assert.equal(reconcileAssignment(a.id, { env, now: () => now + 1000 }).inFlightJobId, `reserve-${now}-abcd`)
    assert.equal(reconcileAssignment(a.id, { env, now: () => now + 10 * 60_000 }).inFlightJobId, null)
  })

  test('a lock held by a job with no record is released', () => {
    const env = tmpEnv()
    const a = createAssignment({ agent: 'agy', brief: 'b' }, env)
    beginTurn(a.id, '2026-10-08T00-00-00-000Z-deadbeef', env)
    assert.equal(reconcileAssignment(a.id, { env }).inFlightJobId, null)
  })

  test('returns null for an unknown id', () => {
    assert.equal(reconcileAssignment('asg-missing', { env: tmpEnv() }), null)
  })
})

describe('task_continue', () => {
  test('resumes the head session without a caller jobId and advances head and turns', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const { startJobFn, calls } = fakeStarter(env)

    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'fix the review findings', startJobFn, env })
    assert.equal(res.errorKind, null)
    assert.equal(res.status, 'running')
    assert.equal(res.parentJobId, first.jobId)
    assert.ok(res.jobId && res.jobId !== first.jobId)
    assert.equal(calls[0].sessionId, 'ses-1')
    assert.equal(calls[0].parentJobId, first.jobId)
    assert.equal(calls[0].task, 'fix the review findings')
    assert.equal(calls[0].agent, 'opencode')

    let a = getAssignment(first.assignmentId, env)
    assert.equal(a.headJobId, first.jobId)
    assert.equal(a.turns, 1)
    assert.equal(a.inFlightJobId, res.jobId)

    finishJob(res.jobId, env, { sessionId: 'ses-1', tokens: 300 })
    a = reconcileAssignment(first.assignmentId, { env })
    assert.equal(a.headJobId, res.jobId)
    assert.equal(a.turns, 2)
    assert.equal(a.tokensUsed, 1500)
  })

  test('does not surface the turn-depth warning inside an assignment', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    updateResult(first.jobId, { turnDepth: 10 }, env)
    const { startJobFn } = fakeStarter(env)
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'again', startJobFn, env })
    assert.equal(res.errorKind, null)
    assert.equal(res.warning, undefined)
  })

  test('is refused as busy while the current turn is still running', async () => {
    const env = tmpEnv()
    const { startJobFn } = fakeStarter(env)
    const first = await taskAssignTool({ ...assignInput(), startJobFn, env })
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn, env })
    assert.equal(res.status, 'failed')
    assert.equal(res.errorKind, 'busy')
    assert.equal(res.inFlightJobId, first.jobId)
  })

  test('is refused for a closed assignment', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    await taskCloseTool({ assignmentId: first.assignmentId, verdict: 'accepted', env })
    const { startJobFn, calls } = fakeStarter(env)
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn, env })
    assert.equal(res.errorKind, 'closed')
    assert.equal(calls.length, 0)
  })

  test('is refused for an unknown assignment', async () => {
    const env = tmpEnv()
    const res = await taskContinueTool({ assignmentId: 'asg-missing', message: 'more', env })
    assert.equal(res.errorKind, 'not_found')
  })

  test('requires a head job with a sessionId', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env, {}, { sessionId: null })
    const { startJobFn, calls } = fakeStarter(env)
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn, env })
    assert.equal(res.errorKind, 'no_session')
    assert.equal(calls.length, 0)
    assert.equal(getAssignment(first.assignmentId, env).inFlightJobId, null)
  })

  test('requires message text', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: '   ', env })
    assert.equal(res.errorKind, 'invalid')
  })

  test('a reply that fails releases the lock and returns its errorKind', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)

    const failing = fakeStarter(env, { status: 'failed' })
    const res = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn: failing.startJobFn, env })
    assert.equal(res.status, 'failed')
    assert.equal(res.errorKind, 'write_gate')
    let a = getAssignment(first.assignmentId, env)
    assert.equal(a.inFlightJobId, null)
    assert.equal(a.headJobId, first.jobId)
    assert.equal(a.turns, 1)

    const throwing = fakeStarter(env, { throwError: new Error('boom') })
    const res2 = await taskContinueTool({ assignmentId: first.assignmentId, message: 'more', startJobFn: throwing.startJobFn, env })
    assert.equal(res2.errorKind, 'spawn_failed')
    a = getAssignment(first.assignmentId, env)
    assert.equal(a.inFlightJobId, null)
  })
})

describe('task_status', () => {
  test('returns the reconciled record with head and in-flight job summaries', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const res = taskStatusTool({ assignmentId: first.assignmentId, env })
    assert.equal(res.errorKind, null)
    assert.equal(res.assignment.headJobId, first.jobId)
    assert.equal(res.assignment.turns, 1)
    assert.equal(res.headJob.jobId, first.jobId)
    assert.equal(res.headJob.status, 'succeeded')
    assert.equal(res.headJob.sessionId, 'ses-1')
    assert.equal(res.headJob.tokens, 1200)
    assert.equal(res.inFlightJob, null)
  })

  test('reports an unknown id as not_found', () => {
    const res = taskStatusTool({ assignmentId: 'asg-missing', env: tmpEnv() })
    assert.equal(res.errorKind, 'not_found')
    assert.equal(res.assignment, null)
  })

  test('lists assignments filtered by status and agent, reconciling active ones', async () => {
    const env = tmpEnv()
    const a1 = await assignAndFinish(env, { agent: 'agy', model: 'gemini-flash' })
    const a2 = await assignAndFinish(env, { agent: 'codex', model: 'default' })
    await taskCloseTool({ assignmentId: a2.assignmentId, verdict: 'abandoned', env })

    const all = taskStatusTool({ env }).assignments
    assert.equal(all.length, 2)
    const active = taskStatusTool({ status: 'active', env }).assignments
    assert.deepEqual(active.map((a) => a.id), [a1.assignmentId])
    assert.equal(active[0].turns, 1, 'listed active assignments are reconciled')
    assert.deepEqual(taskStatusTool({ agent: 'codex', env }).assignments.map((a) => a.id), [a2.assignmentId])
    assert.equal(taskStatusTool({ limit: 1, env }).assignments.length, 1)
  })
})

describe('task_close', () => {
  test('closes with accepted after reconciling the finished turn', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const res = await taskCloseTool({ assignmentId: first.assignmentId, verdict: 'accepted', note: 'merged', env })
    assert.equal(res.errorKind, null)
    assert.equal(res.assignment.status, 'closed')
    assert.equal(res.assignment.closeVerdict, 'accepted')
    assert.equal(res.assignment.closeNote, 'merged')
    assert.equal(res.assignment.turns, 1)
  })

  test('closes with abandoned', async () => {
    const env = tmpEnv()
    const first = await assignAndFinish(env)
    const res = await taskCloseTool({ assignmentId: first.assignmentId, verdict: 'abandoned', env })
    assert.equal(res.assignment.closeVerdict, 'abandoned')
  })

  test('is refused while a turn is running, and for an already closed assignment', async () => {
    const env = tmpEnv()
    const { startJobFn } = fakeStarter(env)
    const first = await taskAssignTool({ ...assignInput(), startJobFn, env })
    const busy = await taskCloseTool({ assignmentId: first.assignmentId, verdict: 'accepted', env })
    assert.equal(busy.errorKind, 'busy')
    assert.equal(busy.inFlightJobId, first.jobId)

    finishJob(first.jobId, env)
    assert.equal((await taskCloseTool({ assignmentId: first.assignmentId, verdict: 'accepted', env })).errorKind, null)
    assert.equal((await taskCloseTool({ assignmentId: first.assignmentId, verdict: 'accepted', env })).errorKind, 'closed')
    assert.equal((await taskCloseTool({ assignmentId: 'asg-missing', verdict: 'accepted', env })).errorKind, 'not_found')
  })
})

describe('plain job_reply', () => {
  test('still surfaces the turn-depth warning outside assignments', async () => {
    const env = tmpEnv()
    const parent = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', sessionId: 's', env })
    updateResult(parent.jobId, { status: 'succeeded', turnDepth: 10 }, env)
    const res = await jobReplyTool({
      jobId: parent.jobId,
      message: 'again',
      env,
      startJobFn: () => ({ job: { jobId: 'r1', status: 'running', errorKind: null } }),
    })
    assert.match(res.warning, /fresh delegate/)
  })
})

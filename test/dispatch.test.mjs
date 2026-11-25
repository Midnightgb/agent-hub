import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  dispatch,
  computeDispatchKey,
  fingerprintRemoteIntent,
  findMatchingSession,
  calculateDispatchTimeoutS,
  findRecentJobByDispatchKey,
} from '../src/dispatch.mjs'
import { createJob, listJobs, readResult } from '../src/jobstore.mjs'
import { paths, ADAPTIVE_TIMEOUT } from '../src/config.mjs'
import { allowOpencodeModels } from './helpers/opencode-catalog.mjs'

function makeTempHome() {
  const home = allowOpencodeModels(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dispatch-test-')), ['opencode/test'])
  const env = { ...process.env, AGENT_HUB_HOME: home }
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('computeDispatchKey computes deterministic sha256 from task+cwd+taskType+workflowStep', () => {
  const k1 = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1' })
  const k2 = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1' })
  const k3 = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-2' })

  assert.equal(typeof k1, 'string')
  assert.equal(k1.length, 64)
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
})

test('calculateDispatchTimeoutS applies 1x/1.5x/2x attempt backoff clamped to capS', () => {
  const mockResolve = () => ({ timeoutS: 100 })

  const t1 = calculateDispatchTimeoutS({ attempt: 1, resolveEffectiveTimeoutSFn: mockResolve })
  const t2 = calculateDispatchTimeoutS({ attempt: 2, resolveEffectiveTimeoutSFn: mockResolve })
  const t3 = calculateDispatchTimeoutS({ attempt: 3, resolveEffectiveTimeoutSFn: mockResolve })
  const t4 = calculateDispatchTimeoutS({ attempt: 5, resolveEffectiveTimeoutSFn: mockResolve })

  assert.equal(t1, 100) // 1x
  assert.equal(t2, 150) // 1.5x
  assert.equal(t3, 200) // 2x
  assert.equal(t4, 200) // capped at 2x

  // Test capS clamping
  const hugeResolve = () => ({ timeoutS: 3000 })
  const capped = calculateDispatchTimeoutS({ attempt: 2, resolveEffectiveTimeoutSFn: hugeResolve })
  assert.equal(capped, ADAPTIVE_TIMEOUT.capS)
})

test('a) DOS dispatch CONCURRENTES misma dispatchKey → exactamente 1 job (Promise.all, con startJob mockeado con delay)', async () => {
  let startJobCalls = 0
  const jobsCreated = []

  const mockStartJob = async (args) => {
    startJobCalls++
    await new Promise((r) => setTimeout(r, 60))
    const job = {
      jobId: `job-concurrent-${startJobCalls}`,
      agent: args.agent,
      model: args.model,
      status: 'queued',
      createdAt: new Date().toISOString(),
      dispatchKey: args.dispatchKey,
      executionId: args.executionId,
    }
    jobsCreated.push(job)
    return { job, done: Promise.resolve() }
  }

  const [res1, res2] = await Promise.all([
    dispatch({
      task: 'same-task',
      taskType: 'recon',
      cwd: '/tmp/test-concurrent',
      mode: 'read',
      dispatchKey: 'concurrent-key-1',
      startJobFn: mockStartJob,
      routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-low' }, fallbacks: [] }),
      runPreflightFn: async () => ({ status: 'ready' }),
      circuitBreakerOpenFn: () => false,
    }),
    dispatch({
      task: 'same-task',
      taskType: 'recon',
      cwd: '/tmp/test-concurrent',
      mode: 'read',
      dispatchKey: 'concurrent-key-1',
      startJobFn: mockStartJob,
      routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-low' }, fallbacks: [] }),
      runPreflightFn: async () => ({ status: 'ready' }),
      circuitBreakerOpenFn: () => false,
    }),
  ])

  assert.equal(startJobCalls, 1, 'startJob must be called exactly once')
  assert.equal(jobsCreated.length, 1, 'exactly 1 job must be created')
  assert.equal(res1.job.jobId, res2.job.jobId, 'both dispatches must return the same job')
  assert.equal(res1.dispatchKey, 'concurrent-key-1')
  assert.equal(res2.dispatchKey, 'concurrent-key-1')
  assert.equal(res1.executionId, res2.executionId)
})

test('b) re-dispatch secuencial misma key → mismo jobId', async () => {
  let startJobCalls = 0

  const mockStartJob = async (args) => {
    startJobCalls++
    return {
      job: {
        jobId: 'job-seq-42',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
        executionId: args.executionId,
      },
      done: Promise.resolve(),
    }
  }

  const res1 = await dispatch({
    task: 'seq-task',
    taskType: 'triage',
    cwd: '/tmp/test-seq',
    dispatchKey: 'seq-key-1',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  const res2 = await dispatch({
    task: 'seq-task',
    taskType: 'triage',
    cwd: '/tmp/test-seq',
    dispatchKey: 'seq-key-1',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  assert.equal(startJobCalls, 1, 'startJob must not be invoked on sequential re-dispatch with same key')
  assert.equal(res1.job.jobId, 'job-seq-42')
  assert.equal(res2.job.jobId, res1.job.jobId)
})

test('c) keys distintas → jobs distintos', async () => {
  let startJobCalls = 0

  const mockStartJob = async (args) => {
    startJobCalls++
    return {
      job: {
        jobId: `job-distinct-${startJobCalls}`,
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
        executionId: args.executionId,
      },
      done: Promise.resolve(),
    }
  }

  const res1 = await dispatch({
    task: 'task-1',
    taskType: 'research',
    cwd: '/tmp/test-c1',
    dispatchKey: 'key-1',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-medium' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  const res2 = await dispatch({
    task: 'task-2',
    taskType: 'research',
    cwd: '/tmp/test-c2',
    dispatchKey: 'key-2',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-medium' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  assert.equal(startJobCalls, 2)
  assert.notEqual(res1.job.jobId, res2.job.jobId)
  assert.equal(res1.dispatchKey, 'key-1')
  assert.equal(res2.dispatchKey, 'key-2')
})

test('d) fingerprint remoto re-adopta en vez de crear', async () => {
  let createSessionCalls = 0
  let startJobCalls = 0

  const existingSession = {
    id: 'sess-existing-jules-101',
    name: 'sessions/sess-existing-jules-101',
    title: 'PR review intent',
    createTime: new Date(Date.now() - 120000).toISOString(),
    sourceContext: { source: 'sources/github.com/org/repo', githubRepoContext: { startingBranch: 'main' } },
    state: 'IN_PROGRESS',
    prompt: 'Analyze repository architecture',
  }

  const linkedJob = {
    jobId: 'job-jules-linked-101',
    agent: 'jules',
    model: 'default',
    status: 'running',
    remote: { sessionId: 'sess-existing-jules-101', state: 'IN_PROGRESS' },
    createdAt: new Date(Date.now() - 120000).toISOString(),
    dispatchKey: 'jules-key-101',
    executionId: 'exec_original',
  }

  const mockClient = {
    listSessions: async () => ({ sessions: [existingSession] }),
    createSession: async () => {
      createSessionCalls++
      return { id: 'sess-new-202' }
    },
  }

  const mockStartJob = async () => {
    startJobCalls++
    return { job: { jobId: 'job-new' } }
  }

  const res = await dispatch({
    task: 'Analyze repository architecture',
    taskType: 'architecture',
    cwd: '/tmp/repo',
    dispatchKey: 'jules-key-101',
    source: 'sources/github.com/org/repo',
    startingBranch: 'main',
    title: 'PR review intent',
    candidate: { agent: 'jules', model: 'default' },
    client: mockClient,
    startJobFn: mockStartJob,
    listJobsFn: () => [linkedJob],
  })

  assert.equal(createSessionCalls, 0, 'createSession must never be called when matching session exists')
  assert.equal(startJobCalls, 0, 'startJob must never be called when re-adopting')
  assert.equal(res.job.jobId, 'job-jules-linked-101')
  assert.equal(res.job.remote.sessionId, 'sess-existing-jules-101')
})

test('closes TOCTOU gap by revalidating breaker and preflight at execution time', async () => {
  let startJobCandidate = null
  const mockStartJob = async (args) => {
    startJobCandidate = { agent: args.agent, model: args.model }
    return {
      job: {
        jobId: 'job-toctou-1',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
      },
      done: Promise.resolve(),
    }
  }

  // Route returned primary (agy) and fallback (opencode), but agy's breaker is now open
  const res = await dispatch({
    task: 'test-toctou',
    taskType: 'triage',
    cwd: '/tmp/test-toctou',
    routeFn: async () => ({
      primary: { agent: 'agy', model: 'gemini-3.8-flash-low' },
      fallbacks: [{ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }],
    }),
    circuitBreakerOpenFn: ({ agent }) => agent === 'agy', // agy breaker is open!
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
  })

  assert.equal(startJobCandidate.agent, 'opencode')
  assert.equal(res.candidate.agent, 'opencode')
})

test('automatic fallback to next candidate when first candidate fails fast', async () => {
  const attempted = []

  const mockStartJob = async (args) => {
    attempted.push(`${args.agent}:${args.model}`)
    if (args.agent === 'opencode') {
      return {
        job: {
          jobId: 'job-failed-fast',
          agent: args.agent,
          model: args.model,
          status: 'failed',
          errorKind: 'quota',
          error: 'Rate limit exceeded',
        },
        done: Promise.resolve(),
      }
    }
    return {
      job: {
        jobId: 'job-succeeded-fallback',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
      },
      done: Promise.resolve(),
    }
  }

  const res = await dispatch({
    task: 'test-fallback',
    taskType: 'recon',
    cwd: '/tmp/test-fallback',
    category: 'quality', // quality policy has retry: false, fallback: true
    routeFn: async () => ({
      primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' },
      fallbacks: [{ agent: 'agy', model: 'gemini-3.8-flash-low' }],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
  })

  assert.deepEqual(attempted, [
    'opencode:opencode/muse-spark-1.3-contributor-free',
    'agy:gemini-3.8-flash-low',
  ])
  assert.equal(res.candidate.agent, 'agy')
  assert.equal(res.job.jobId, 'job-succeeded-fallback')
})

// D2 (agy-hub-verification): dispatch() accepts an optional `verify` array
// and forwards it to startJobFn untouched (jobrunner.mjs's startJob does the
// canonical normalization/storage). Invalid input must fail fast, before
// routing/breaker/reservation state changes, so startJobFn is never called.

test('dispatch rejects an invalid verify check before ever calling startJobFn (fail fast, before dispatch)', async () => {
  let called = false
  const mockStartJob = async () => {
    called = true
    return { job: { jobId: 'never', status: 'queued' }, done: Promise.resolve() }
  }

  await assert.rejects(
    () =>
      dispatch({
        task: 'test-verify-invalid',
        cwd: '/tmp/test-verify',
        routeFn: async () => ({ primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, fallbacks: [] }),
        circuitBreakerOpenFn: () => false,
        runPreflightFn: async () => ({ status: 'ready' }),
        startJobFn: mockStartJob,
        verify: [{ name: 'bad', argv: [] }],
      }),
    /argv must be a non-empty array of non-empty strings/
  )
  assert.equal(called, false)
})

test('dispatch forwards a valid verify array to startJobFn', async () => {
  let receivedVerify = null
  const mockStartJob = async (args) => {
    receivedVerify = args.verify
    return {
      job: { jobId: 'job-verify-1', agent: args.agent, model: args.model, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey },
      done: Promise.resolve(),
    }
  }

  await dispatch({
    task: 'test-verify-forward',
    cwd: '/tmp/test-verify',
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, fallbacks: [] }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  assert.deepEqual(receivedVerify, [{ name: 'tests', argv: ['npm', 'test'] }])
})

test('same-tree-fanout S2: dispatch forwards isolation to startJobFn, and omits it when not given', async () => {
  const received = []
  const mockStartJob = async (args) => {
    received.push(Object.prototype.hasOwnProperty.call(args, 'isolation') ? args.isolation : '<absent>')
    return {
      job: { jobId: `job-iso-${received.length}`, agent: args.agent, model: args.model, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey },
      done: Promise.resolve(),
    }
  }
  const base = {
    cwd: '/tmp/test-isolation',
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-medium' }, fallbacks: [] }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
  }
  await dispatch({ ...base, task: 'iso-forward-scratch', isolation: 'scratch' })
  await dispatch({ ...base, task: 'iso-forward-default' })
  assert.deepEqual(received, ['scratch', '<absent>'])
})

test('same-tree-fanout S4: a label makes the dispatchKey distinct; no label keeps the legacy hash', async () => {
  const crypto = await import('node:crypto')
  const legacy = crypto.createHash('sha256').update('review this/tmp/repoadversarial-review').digest('hex')
  assert.equal(computeDispatchKey({ task: 'review this', cwd: '/tmp/repo', taskType: 'adversarial-review' }), legacy)
  const a = computeDispatchKey({ task: 'review this', cwd: '/tmp/repo', taskType: 'adversarial-review', label: 'r1' })
  const b = computeDispatchKey({ task: 'review this', cwd: '/tmp/repo', taskType: 'adversarial-review', label: 'r2' })
  assert.notEqual(a, legacy)
  assert.notEqual(a, b)
})

test('same-tree-fanout S4: dispatches with the same task but different labels start separate jobs; the same label still dedupes', async () => {
  let starts = 0
  const mockStartJob = async (args) => {
    starts += 1
    return {
      job: { jobId: `job-label-${starts}`, agent: args.agent, model: args.model, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey },
      done: Promise.resolve(),
    }
  }
  const base = {
    task: 'label-fanout-task',
    cwd: '/tmp/test-label',
    routeFn: async () => ({ primary: { agent: 'copilot', model: 'auto' }, fallbacks: [] }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
  }
  const r1 = await dispatch({ ...base, label: 'reviewer-1' })
  const r2 = await dispatch({ ...base, label: 'reviewer-2' })
  const r1again = await dispatch({ ...base, label: 'reviewer-1' })
  assert.equal(starts, 2)
  assert.notEqual(r1.dispatchKey, r2.dispatchKey)
  assert.equal(r1again.dispatchKey, r1.dispatchKey)
})

function fanoutStartJob(calls) {
  return async (args) => {
    calls.push(args)
    return {
      job: { jobId: `job-fan-${calls.length}`, agent: args.agent, model: args.model, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey },
      done: Promise.resolve(),
    }
  }
}

const fanoutBase = (calls, primary) => ({
  cwd: '/tmp/test-fanout',
  taskType: 'adversarial-review',
  routeFn: async () => ({ primary, fallbacks: [] }),
  circuitBreakerOpenFn: () => false,
  runPreflightFn: async () => ({ status: 'ready' }),
  startJobFn: fanoutStartJob(calls),
})

test('same-tree-fanout S6: fanout:true also starts the parallelWith reviewer and returns it as parallelJobs', async () => {
  const calls = []
  const primary = { agent: 'agy', model: 'claude-sonnet-4-6', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'read' } }
  const res = await dispatch({ ...fanoutBase(calls, primary), task: 'fanout-on', fanout: true, output: 'review', isolation: 'auto' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].agent, 'agy')
  assert.equal(calls[0].output, 'review', 'output is forwarded to the primary')
  const parallel = calls[1]
  assert.equal(parallel.agent, 'copilot')
  assert.equal(parallel.model, 'auto')
  assert.equal(parallel.mode, 'read')
  assert.equal(parallel.task, 'fanout-on')
  assert.equal(parallel.output, 'review')
  assert.equal(parallel.isolation, 'auto')
  assert.notEqual(parallel.dispatchKey, calls[0].dispatchKey)
  assert.deepEqual(res.parallelJobs, [{ jobId: 'job-fan-2', agent: 'copilot', model: 'auto', status: 'queued', errorKind: null }])
})

test('same-tree-fanout S6: without fanout the parallelWith pair is not started and the reply has no parallelJobs', async () => {
  const calls = []
  const primary = { agent: 'agy', model: 'claude-sonnet-4-6', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'read' } }
  const res = await dispatch({ ...fanoutBase(calls, primary), task: 'fanout-off' })
  assert.equal(calls.length, 1)
  assert.equal('parallelJobs' in res, false)
})

test('same-tree-fanout S6: a write-mode or host-only parallelWith is reported as skipped, never started', async () => {
  const calls = []
  const write = { agent: 'agy', model: 'm', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'write' } }
  const res = await dispatch({ ...fanoutBase(calls, write), task: 'fanout-write', fanout: true })
  assert.equal(calls.length, 1)
  assert.equal(res.parallelJobs.length, 1)
  assert.equal(res.parallelJobs[0].jobId, null)
  assert.match(res.parallelJobs[0].skipped, /write mode is never fanned out/)

  const calls2 = []
  const host = { agent: 'agy', model: 'm', mode: 'read', parallelWith: { agent: 'claude', model: 'sonnet', mode: 'read' } }
  const res2 = await dispatch({ ...fanoutBase(calls2, host), task: 'fanout-host', fanout: true })
  assert.equal(calls2.length, 1)
  assert.match(res2.parallelJobs[0].skipped, /host-only/)
})

test('reserves write lock when mode is write and passes reservationToken to startJob', async () => {
  let acquireLockCalled = false
  let passedReservationToken = null

  const res = await dispatch({
    task: 'write-task',
    taskType: 'mechanical-edit',
    cwd: '/tmp/worktree-1',
    mode: 'write',
    routeFn: async () => ({
      primary: { agent: 'opencode', model: 'deepseek/deepseek-v4-flash', mode: 'write' },
      fallbacks: [],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    acquireWriteLockFn: ({ cwd, jobId }) => {
      acquireLockCalled = true
      return { acquired: true, file: '/tmp/lock.file', token: 'reservation-token-abc' }
    },
    startJobFn: async (args) => {
      passedReservationToken = args.reservationToken
      return {
        job: {
          jobId: 'job-write-1',
          agent: args.agent,
          model: args.model,
          status: 'queued',
          createdAt: new Date().toISOString(),
          dispatchKey: args.dispatchKey,
        },
      }
    },
  })

  assert.ok(acquireLockCalled, 'acquireWriteLock must be called to reserve lock')
  assert.equal(passedReservationToken, 'reservation-token-abc', 'startJob must receive reservationToken')
  assert.equal(res.job.jobId, 'job-write-1')
})

test('timeout simulado en candidato remoto → reconcile/resume intentado ANTES que crear nueva ejecución', async () => {
  const callOrder = []
  let attempts = 0

  const mockStartJob = async (args) => {
    attempts++
    callOrder.push(`startJob:attempt-${args.attempt}:resumed-${Boolean(args.resumed)}`)
    if (attempts === 1) {
      return {
        job: {
          jobId: 'job-remote-timeout-1',
          agent: args.agent,
          status: 'failed',
          errorKind: 'timeout',
          error: 'Remote session timed out',
          remote: { sessionId: 'sess-remote-999' },
        },
        done: Promise.resolve(),
      }
    }
    return {
      job: {
        jobId: 'job-remote-resumed-2',
        agent: args.agent,
        status: 'queued',
        remote: { sessionId: args.sessionId },
      },
      done: Promise.resolve(),
    }
  }

  const mockOnResume = async (ctx) => {
    callOrder.push(`onResume:sessionId-${ctx.sessionId}`)
  }

  const res = await dispatch({
    task: 'remote architecture task',
    cwd: '/tmp/repo',
    candidate: { agent: 'jules', model: 'default' },
    startJobFn: mockStartJob,
    onResume: mockOnResume,
  })

  assert.equal(callOrder[0], 'startJob:attempt-1:resumed-false')
  assert.equal(callOrder[1], 'onResume:sessionId-sess-remote-999')
  assert.equal(callOrder[2], 'startJob:attempt-1:resumed-true')
  assert.equal(res.job.jobId, 'job-remote-resumed-2')
})

test('error auth a mitad de ejecución respeta auth→no-retry aunque el caller no pasó category', async () => {
  let startJobCalls = 0

  const mockStartJob = async (args) => {
    startJobCalls++
    return {
      job: {
        jobId: 'job-auth-fail',
        agent: args.agent,
        model: args.model,
        status: 'failed',
        errorKind: 'auth',
        error: '401 Invalid API Key',
      },
      done: Promise.resolve(),
    }
  }

  let caughtError = null
  try {
    await dispatch({
      task: 'task-without-category',
      cwd: '/tmp/test-auth',
      candidate: { agent: 'opencode', model: 'default' },
      startJobFn: mockStartJob,
    })
  } catch (err) {
    caughtError = err
  }

  assert.ok(caughtError, 'dispatch must throw when terminal escalation is reached')
  assert.equal(startJobCalls, 1, 'auth error must never be retried')
  assert.equal(caughtError.escalation, 'human')
})

test('reserva honesta: startJob adopta reservationToken válido como execution lease', async () => {
  const { home, env, cleanup } = makeTempHome()
  try {
    const cwd = path.join(home, 'worktree-wt')
    fs.mkdirSync(cwd, { recursive: true })

    const { acquireWriteLock, readWriteLock } = await import('../src/worktree.mjs')
    const { startJob } = await import('../src/jobrunner.mjs')
    const EventEmitter = (await import('node:events')).EventEmitter

    const reservation = acquireWriteLock({ cwd, jobId: 'dispatch-exec-1', env })
    assert.ok(reservation.acquired)
    const token = reservation.token

    const lockBefore = readWriteLock({ cwd, env })
    assert.equal(lockBefore.jobId, 'dispatch-exec-1')
    assert.equal(lockBefore.token, token)

    const { job } = startJob({
      agent: 'opencode',
      model: 'opencode/test',
      task: 'write code',
      cwd,
      mode: 'write',
      allowlist: [cwd],
      reservationToken: token,
      env,
      spawn: () => {
        const ee = new EventEmitter()
        ee.pid = 99999
        ee.kill = () => {}
        return ee
      },
    })

    assert.notEqual(job.status, 'failed')
    const lockAfter = readWriteLock({ cwd, env })
    assert.equal(lockAfter.jobId, job.jobId, 'lock must be adopted with new jobId')
    assert.equal(lockAfter.token, token, 'adopted lock must keep the same reservation token')
  } finally {
    cleanup()
  }
})

test('reserva honesta: token stale → error limpio (locked), nunca robo', async () => {
  const { home, env, cleanup } = makeTempHome()
  try {
    const cwd = path.join(home, 'worktree-wt-stale')
    fs.mkdirSync(cwd, { recursive: true })

    const { acquireWriteLock, readWriteLock } = await import('../src/worktree.mjs')
    const { startJob } = await import('../src/jobrunner.mjs')

    const activeLock = acquireWriteLock({ cwd, jobId: 'other-holder-job', env })
    assert.ok(activeLock.acquired)

    const { job } = startJob({
      agent: 'opencode',
      model: 'opencode/test',
      task: 'write code',
      cwd,
      mode: 'write',
      allowlist: [cwd],
      reservationToken: 'stale-token-12345',
      env,
      spawn: () => {
        throw new Error('should not spawn')
      },
    })

    assert.equal(job.status, 'failed')
    assert.equal(job.errorKind, 'locked')
    assert.match(job.error, /Reservation invalid/i)

    const currentLock = readWriteLock({ cwd, env })
    assert.equal(currentLock.jobId, 'other-holder-job')
    assert.equal(currentLock.token, activeLock.token)
  } finally {
    cleanup()
  }
})


// T2 (dispatch-host-only-hang): `agent: 'claude'` candidates route to the
// host's own Agent tool (see src/router.mjs's DELEGATION_MAP) -- there is no
// 'claude' entry in src/adapters/index.mjs, so starting one here used to
// reserve the worktree lock and then crash deep inside startJob. Combined
// with the pre-T1 fallback bug, a route with only a claude candidate froze
// the whole MCP process (2026-09-28 incident). dispatch() must now drop
// host-only candidates before reserving anything.
test('T2: a dispatch that only routes to host-only claude rejects fast with errorKind host_only, before reserving the worktree', async () => {
  let acquireLockCalled = false
  let startJobCalled = false

  await assert.rejects(
    dispatch({
      task: 'host-only-task',
      taskType: 'implementation-with-repo-rules',
      cwd: '/tmp/test-host-only',
      mode: 'write',
      routeFn: async () => ({ primary: { agent: 'claude', model: 'opus' }, fallbacks: [] }),
      circuitBreakerOpenFn: () => false,
      runPreflightFn: async () => ({ status: 'ready' }),
      acquireWriteLockFn: () => {
        acquireLockCalled = true
        return { acquired: true, file: '/tmp/lock.file', token: 'should-not-happen' }
      },
      startJobFn: async () => {
        startJobCalled = true
        throw new Error('startJobFn must never be called for a host-only route')
      },
    }),
    (err) => {
      assert.equal(err.errorKind, 'host_only')
      assert.match(err.message, /claude code|host/i)
      assert.match(err.message, /opus/, 'error must name the routed model')
      return true
    }
  )

  assert.equal(acquireLockCalled, false, 'acquireWriteLockFn must never be called for a host-only route')
  assert.equal(startJobCalled, false, 'startJobFn must never be called for a host-only route')
})

test('T2: a host-only-only dispatch in write mode leaves no worktree lock on disk', async () => {
  const { home, env, cleanup } = makeTempHome()
  try {
    const cwd = path.join(home, 'worktree-host-only')
    fs.mkdirSync(cwd, { recursive: true })
    const { readWriteLock } = await import('../src/worktree.mjs')

    await assert.rejects(
      dispatch({
        task: 'host-only-task',
        taskType: 'implementation-with-repo-rules',
        cwd,
        mode: 'write',
        env,
        routeFn: async () => ({ primary: { agent: 'claude', model: 'opus' }, fallbacks: [] }),
        circuitBreakerOpenFn: () => false,
        runPreflightFn: async () => ({ status: 'ready' }),
      }),
      (err) => err.errorKind === 'host_only'
    )

    assert.equal(readWriteLock({ cwd, env }), null, 'no worktree lock file must remain after a host-only rejection')
  } finally {
    cleanup()
  }
})

test('T2: a chain [claude, agy] drops the host-only candidate and dispatches on the executable fallback', async () => {
  let startJobAgent = null

  const res = await dispatch({
    task: 'chain-task',
    taskType: 'implementation-with-repo-rules',
    cwd: '/tmp/test-chain',
    routeFn: async () => ({
      primary: { agent: 'claude', model: 'opus' },
      fallbacks: [{ agent: 'agy', model: 'claude-opus-4-6-thinking' }],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: async (args) => {
      startJobAgent = args.agent
      return {
        job: {
          jobId: 'job-chain-1',
          agent: args.agent,
          model: args.model,
          status: 'queued',
          createdAt: new Date().toISOString(),
          dispatchKey: args.dispatchKey,
        },
        done: Promise.resolve(),
      }
    },
  })

  assert.equal(startJobAgent, 'agy', 'the first executable candidate (agy) must become primary')
  assert.equal(res.job.agent, 'agy')
})

test('T2: an agy candidate using a Claude model name is unaffected by the host-only claude filter', async () => {
  let startJobArgs = null

  const res = await dispatch({
    task: 'agy-claude-model-task',
    taskType: 'implementation-with-repo-rules',
    cwd: '/tmp/test-agy-claude-model',
    routeFn: async () => ({
      primary: { agent: 'agy', model: 'claude-sonnet-4-6' },
      fallbacks: [],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: async (args) => {
      startJobArgs = args
      return {
        job: {
          jobId: 'job-agy-claude-model-1',
          agent: args.agent,
          model: args.model,
          status: 'queued',
          createdAt: new Date().toISOString(),
          dispatchKey: args.dispatchKey,
        },
        done: Promise.resolve(),
      }
    },
  })

  assert.equal(startJobArgs.agent, 'agy')
  assert.equal(startJobArgs.model, 'claude-sonnet-4-6')
  assert.equal(res.job.agent, 'agy')
})

test('computeDispatchKey scopes by workflowId without breaking the legacy hash', () => {
  const legacy = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1' })
  const same = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1', workflowId: null })
  const other = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1', workflowId: 'wf-2' })
  assert.equal(legacy, same, 'omitted workflowId keeps the exact legacy hash')
  assert.notEqual(legacy, other, 'same step in another workflow must not share a job')
})

test('scratch-writers S1: a write dispatch with writeScope forwards it and never reserves the per-cwd write lock', async () => {
  let acquireLockCalled = false
  let forwarded = null
  const res = await dispatch({
    task: 'scoped-write-task',
    taskType: 'mechanical-edit',
    cwd: '/tmp/primary-checkout',
    mode: 'write',
    writeScope: ['src/**'],
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'deepseek/deepseek-v4-flash', mode: 'write' }, fallbacks: [] }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    acquireWriteLockFn: () => {
      acquireLockCalled = true
      return { acquired: true, token: 'should-not-be-used' }
    },
    startJobFn: async (args) => {
      forwarded = args
      return { job: { jobId: 'job-scoped-1', agent: args.agent, model: args.model, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey } }
    },
  })
  assert.equal(acquireLockCalled, false, 'a scratch writer must not take the per-cwd write lock')
  assert.deepEqual(forwarded.writeScope, ['src/**'])
  assert.equal(forwarded.reservationToken ?? null, null)
  assert.equal(res.job.jobId, 'job-scoped-1')
})

test('scratch-writers S1: dispatch rejects an invalid writeScope before routing', async () => {
  let routed = false
  const base = {
    task: 'bad-scope',
    cwd: '/tmp/x',
    routeFn: async () => {
      routed = true
      return { primary: { agent: 'opencode', model: 'm' }, fallbacks: [] }
    },
    startJobFn: async () => assert.fail('startJob must not run'),
  }
  await assert.rejects(() => dispatch({ ...base, mode: 'write', writeScope: ['/abs'] }), /writeScope/)
  await assert.rejects(() => dispatch({ ...base, mode: 'read', writeScope: ['src/**'] }), /writeScope.*mode.*write/)
  assert.equal(routed, false)
})

test('scratch-writers B4: dispatches differing only in writeScope start separate jobs; an unscoped key keeps the legacy hash', async () => {
  const crypto = await import('node:crypto')
  const legacy = crypto.createHash('sha256').update('edit this/tmp/repomechanical-edit').digest('hex')
  assert.equal(computeDispatchKey({ task: 'edit this', cwd: '/tmp/repo', taskType: 'mechanical-edit' }), legacy)
  const k1 = computeDispatchKey({ task: 'edit this', cwd: '/tmp/repo', taskType: 'mechanical-edit', writeScope: ['src/**', 'docs/**'] })
  const k1sorted = computeDispatchKey({ task: 'edit this', cwd: '/tmp/repo', taskType: 'mechanical-edit', writeScope: ['docs/**', 'src/**'] })
  assert.notEqual(k1, legacy)
  assert.equal(k1, k1sorted, 'scope order does not matter')

  const started = []
  const base = {
    task: 'scoped-fanout-task',
    taskType: 'mechanical-edit',
    cwd: '/tmp/test-scoped-fanout',
    mode: 'write',
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'm', mode: 'write' }, fallbacks: [] }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: async (args) => {
      started.push(args.writeScope)
      return { job: { jobId: `job-scope-${started.length}`, agent: args.agent, model: args.model, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey }, done: Promise.resolve() }
    },
  }
  const r1 = await dispatch({ ...base, writeScope: ['src/one.txt'] })
  const r2 = await dispatch({ ...base, writeScope: ['src/two.txt'] })
  assert.deepEqual(started, [['src/one.txt'], ['src/two.txt']])
  assert.notEqual(r1.job.jobId, r2.job.jobId)
})

// dispatch-caller-mode: an explicit caller `mode` wins over the routed chain
// step's declared mode on every step; without one, the step mode still wins.
function modeHarness(primary, { fallbacks = [] } = {}) {
  const seen = { startJob: [], timeoutModes: [], lockCalls: 0, routed: 0 }
  const deps = {
    cwd: '/tmp/test-caller-mode',
    taskType: 'mechanical-edit',
    routeFn: async () => {
      seen.routed++
      return { primary, fallbacks }
    },
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    calculateTimeoutFn: ({ mode }) => {
      seen.timeoutModes.push(mode)
      return 60
    },
    acquireWriteLockFn: () => {
      seen.lockCalls++
      return { acquired: true, token: 'caller-mode-token' }
    },
    startJobFn: async (args) => {
      seen.startJob.push(args)
      return {
        job: { jobId: `job-caller-mode-${seen.startJob.length}-${args.dispatchKey.slice(0, 8)}`, agent: args.agent, model: args.model, mode: args.mode, status: 'queued', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey },
        done: Promise.resolve(),
      }
    },
  }
  return { seen, deps }
}

test('dispatch-caller-mode: an explicit mode "read" beats a write chain step (startJob, timeout, no write lock) and records modeOverride', async () => {
  const { seen, deps } = modeHarness({ agent: 'opencode', model: 'm', mode: 'write' })
  const res = await dispatch({ ...deps, task: 'caller-mode-explicit-read', mode: 'read' })
  assert.equal(seen.startJob.length, 1)
  assert.equal(seen.startJob[0].mode, 'read', 'startJob runs the caller mode')
  assert.deepEqual(seen.timeoutModes, ['read'], 'the timeout is computed for the caller mode')
  assert.equal(seen.lockCalls, 0, 'a read dispatch never reserves the per-cwd write lock')
  assert.equal(seen.startJob[0].reservationToken ?? null, null)
  assert.deepEqual(res.modeOverride, { requested: 'read', stepMode: 'write' })
})

test('dispatch-caller-mode: an explicit mode "write" beats a read chain step: the write lock is reserved and the job runs write', async () => {
  const { seen, deps } = modeHarness({ agent: 'opencode', model: 'm', mode: 'read' })
  const res = await dispatch({ ...deps, task: 'caller-mode-explicit-write', mode: 'write' })
  assert.equal(seen.lockCalls, 1, 'the per-cwd write lock is reserved')
  assert.equal(seen.startJob[0].mode, 'write')
  assert.equal(seen.startJob[0].reservationToken, 'caller-mode-token')
  assert.deepEqual(seen.timeoutModes, ['write'])
  assert.deepEqual(res.modeOverride, { requested: 'write', stepMode: 'read' })
})

test('dispatch-caller-mode: an explicit mode "write" with a writeScope always forwards the scope, even on a read chain step', async () => {
  const { seen, deps } = modeHarness({ agent: 'opencode', model: 'm', mode: 'read' })
  const res = await dispatch({ ...deps, task: 'caller-mode-explicit-scoped-write', mode: 'write', writeScope: ['src/**'] })
  assert.equal(seen.startJob[0].mode, 'write')
  assert.deepEqual(seen.startJob[0].writeScope, ['src/**'], 'the writeScope is never silently dropped')
  assert.equal(seen.lockCalls, 0, 'a scratch writer still takes no per-cwd write lock')
  assert.deepEqual(res.modeOverride, { requested: 'write', stepMode: 'read' })
})

test('dispatch-caller-mode: the explicit mode also wins on a fallback step and modeOverride reports the step that ran', async () => {
  let call = 0
  const { seen, deps } = modeHarness({ agent: 'agy', model: 'a', mode: 'read' }, { fallbacks: [{ agent: 'opencode', model: 'b', mode: 'write' }] })
  const inner = deps.startJobFn
  deps.startJobFn = async (args) => {
    call++
    if (call === 1) {
      seen.startJob.push(args)
      return { job: { jobId: 'job-caller-mode-fail', agent: args.agent, model: args.model, status: 'failed', errorKind: 'unknown', error: 'boom', createdAt: new Date().toISOString(), dispatchKey: args.dispatchKey } }
    }
    return inner(args)
  }
  const res = await dispatch({ ...deps, task: 'caller-mode-fallback', mode: 'read', category: 'default', executeWithPolicyFn: async (fn, _resolve, ctx) => {
    const first = await fn({ ...ctx, attempt: 0 })
    if (first.status !== 'failed') return first
    return fn({ ...ctx, candidate: ctx.fallbacks[0], attempt: 1 })
  } })
  assert.deepEqual(seen.startJob.map((a) => a.mode), ['read', 'read'], 'every chain step runs the caller mode')
  assert.equal(res.candidate.agent, 'opencode')
  assert.deepEqual(res.modeOverride, { requested: 'read', stepMode: 'write' })
})

test('dispatch-caller-mode: without an explicit mode the chain step mode still wins (previous behavior) and no modeOverride is reported', async () => {
  const write = modeHarness({ agent: 'opencode', model: 'm', mode: 'write' })
  const resWrite = await dispatch({ ...write.deps, task: 'caller-mode-implicit-write-step' })
  assert.equal(write.seen.startJob[0].mode, 'write', 'the write step mode wins')
  assert.deepEqual(write.seen.timeoutModes, ['write'])
  assert.equal(write.seen.lockCalls, 0, 'unchanged: an implicit-mode dispatch reserves no per-cwd lock itself')
  assert.equal('modeOverride' in resWrite, false)

  const bare = modeHarness({ agent: 'opencode', model: 'm' })
  const resBare = await dispatch({ ...bare.deps, task: 'caller-mode-implicit-bare-step' })
  assert.equal(bare.seen.startJob[0].mode, 'read', 'a step without a mode falls back to read')
  assert.equal('modeOverride' in resBare, false)
})

test('dispatch-caller-mode: an explicit mode equal to the step mode reports no modeOverride', async () => {
  const { deps } = modeHarness({ agent: 'opencode', model: 'm', mode: 'write' })
  const res = await dispatch({ ...deps, task: 'caller-mode-same', mode: 'write' })
  assert.equal('modeOverride' in res, false)
})

test('dispatch-caller-mode: chainModeWins keeps the legacy resolution for the workflow engine (step mode wins, lock follows the passed mode)', async () => {
  const { seen, deps } = modeHarness({ agent: 'opencode', model: 'm', mode: 'write' })
  const res = await dispatch({ ...deps, task: 'caller-mode-workflow-legacy', mode: 'read', chainModeWins: true })
  assert.equal(seen.startJob[0].mode, 'write')
  assert.equal(seen.lockCalls, 0)
  assert.equal('modeOverride' in res, false)
  assert.equal('chainModeWins' in seen.startJob[0], false, 'the flag is not forwarded to startJob')
})

test('dispatch-caller-mode: a writeScope whose effective mode is not write is rejected before routing, reservation or startJob', async () => {
  const explicitRead = modeHarness({ agent: 'opencode', model: 'm', mode: 'write' })
  await assert.rejects(
    () => dispatch({ ...explicitRead.deps, task: 'caller-mode-scope-read', mode: 'read', writeScope: ['src/**'] }),
    /writeScope requires mode "write" \(the effective mode for this dispatch is "read"\)/
  )
  const implicit = modeHarness({ agent: 'opencode', model: 'm', mode: 'write' })
  await assert.rejects(
    () => dispatch({ ...implicit.deps, task: 'caller-mode-scope-implicit', writeScope: ['src/**'] }),
    /writeScope requires an explicit mode "write"/
  )
  for (const { seen } of [explicitRead, implicit]) {
    assert.equal(seen.routed, 0)
    assert.equal(seen.lockCalls, 0)
    assert.equal(seen.startJob.length, 0)
  }
})

test('dispatch-caller-mode: parallelWith reviewers stay read-only even when the caller forces mode "write" on the primary', async () => {
  const { seen, deps } = modeHarness({ agent: 'agy', model: 'm', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'read' } })
  const res = await dispatch({ ...deps, task: 'caller-mode-fanout', mode: 'write', fanout: true })
  assert.deepEqual(seen.startJob.map((a) => [a.agent, a.mode]), [['agy', 'write'], ['copilot', 'read']])
  assert.equal(res.parallelJobs.length, 1)
})

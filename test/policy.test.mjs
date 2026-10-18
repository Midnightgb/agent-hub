import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_TAXONOMY, classifyError } from '../src/policy/taxonomy.mjs'
import { POLICY_TABLE, policyFor } from '../src/policy/registry.mjs'
import { executeWithPolicy, recoveryStageOrder } from '../src/policy/executor.mjs'

// P0.4: every taxonomy category has an explicit declarative policy, so
// policyFor() never returns null for a classified error.
test('POLICY_TABLE covers every ERROR_TAXONOMY category', () => {
  for (const category of Object.keys(ERROR_TAXONOMY)) {
    const policy = policyFor(category)
    assert.ok(policy, `missing policy for category "${category}"`)
    assert.ok('retry' in policy && 'fallback' in policy && 'escalation' in policy)
  }
  assert.equal(policyFor('no-such-category'), null)
})

test('billing and auth never retry and escalate to a human', () => {
  assert.equal(policyFor('billing').retry, false)
  assert.equal(policyFor('billing').fallback, false)
  assert.equal(policyFor('billing').escalation, 'human')
  assert.equal(policyFor('auth').retry, false)
  assert.equal(policyFor('auth').escalation, 'human')
})

// T4 (opencode-live-catalog): an opencode adapter classifyError() kind of
// 'no_route' (provider.no-route / "Variant unavailable") must be its own
// taxonomy category, not fall through the text heuristics into 'crash' --
// retrying the exact same model#variant would fail identically every time,
// and it must never count against the model as if it had actually crashed.
test('classifyError(taxonomy) treats an explicit kind:"no_route" as its own category, never falling through to crash', () => {
  assert.equal(classifyError('provider.no-route: Variant unavailable for opencode/nemotron-3-ultra-free: high', { kind: 'no_route' }), 'no_route')
})

test('policyFor("no_route") never retries and escalates to a human (unsupported variant will never succeed on retry)', () => {
  const policy = policyFor('no_route')
  assert.equal(policy.retry, false)
  assert.equal(policy.escalation, 'human')
})

test('recoveryStageOrder defaults to retry -> resume -> fallback -> escalate', () => {
  assert.deepEqual(
    recoveryStageOrder({}).map((s) => s.name),
    ['retry', 'resume', 'fallback', 'escalate']
  )
})

test('recoveryStageOrder honors an adapter-aware override and keeps escalate last', () => {
  // Remote adapters must resume/reconcile before any retry that could
  // create a duplicate session.
  assert.deepEqual(
    recoveryStageOrder({ recoveryOrder: ['resume', 'fallback', 'retry'] }).map((s) => s.name),
    ['resume', 'fallback', 'retry', 'escalate']
  )
  assert.deepEqual(
    recoveryStageOrder({ recoveryOrder: ['escalate', 'bogus', 'retry'] }).map((s) => s.name),
    ['retry', 'resume', 'fallback', 'escalate']
  )
})

test('executeWithPolicy on billing fails fast to human escalation without retrying', async () => {
  let calls = 0
  let caught = null
  try {
    await executeWithPolicy(
      async () => {
        calls++
        throw new Error('402 Insufficient Balance')
      },
      'billing',
      {}
    )
  } catch (err) {
    caught = err
  }
  assert.ok(caught, 'billing must throw')
  assert.equal(calls, 1, 'billing must not be retried')
  assert.equal(caught.escalation, 'human')
})

test('classifyError maps an adapter-reported incomplete turn to the non-retried quality category, like empty', () => {
  assert.equal(classifyError('agy yielded with 1 background task(s) still running', { errorKind: 'incomplete' }), 'quality')
})

test('transport retries once, after a delay long enough for a replaced service to come back', () => {
  const policy = policyFor('transport')
  assert.equal(policy.retry, 1)
  assert.ok(policy.retryDelayMs >= 5000, `retryDelayMs too short: ${policy.retryDelayMs}`)
  assert.equal(policy.fallback, true)
})

test('executeWithPolicy waits retryDelayMs before a retry, then falls back instead of retrying again', async () => {
  const sleeps = []
  const attempts = []
  const result = await executeWithPolicy(
    async (ctx) => {
      attempts.push(ctx.candidate)
      if (ctx.candidate === 'fallback') return { status: 'succeeded' }
      return { status: 'failed', errorKind: 'transport', error: 'Transport' }
    },
    { retry: 1, retryDelayMs: 10_000, resume: false, fallback: true, escalation: 'human' },
    { candidate: 'primary', fallbacks: ['fallback'], sleep: async (ms) => { sleeps.push(ms) } }
  )

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(attempts, ['primary', 'primary', 'fallback'])
  assert.deepEqual(sleeps, [10_000])
})

test('executeWithPolicy does not sleep when the policy has no retryDelayMs', async () => {
  const sleeps = []
  let calls = 0
  await executeWithPolicy(
    async () => (++calls === 1 ? { status: 'failed', errorKind: 'crash' } : { status: 'succeeded' }),
    { retry: 1, resume: false, fallback: false, escalation: 'human' },
    { sleep: async (ms) => { sleeps.push(ms) } }
  )
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [])
})

// Reproduces the 2026-09-28 incident: dispatch.mjs always sets ctx.onFallback
// (it re-validates a popped candidate), and the fallback stage used to stay
// applicable forever on that alone, even with an empty fallbacks array — the
// while(true) loop in executeWithPolicy then spins on already-resolved
// promises with no real candidate to switch to, starving the event loop
// (this froze the whole MCP process, not just this call). A real infinite
// loop cannot be safely awaited by a test (it also starves setTimeout, so a
// timer-based race would never fire either), so onFallback here counts its
// own calls and throws a distinct "bailout" error once it has run far more
// times than any correct implementation should need — that turns an
// unbounded spin into a bounded, fast assertion failure instead of a frozen
// test process.
test('executeWithPolicy stops offering the fallback stage once no fallback candidates remain', async () => {
  let taskCalls = 0
  let fallbackCalls = 0
  const bailout = new Error('test bailout: fallback stage kept running with no candidates left')
  const taskFn = async () => {
    taskCalls++
    throw new Error('boom')
  }
  const ctx = {
    fallbacks: [],
    onFallback: async () => {
      fallbackCalls++
      if (fallbackCalls > 5) throw bailout
    },
  }

  await assert.rejects(executeWithPolicy(taskFn, null, ctx), (err) => {
    assert.notEqual(err, bailout, `fallback stage ran ${fallbackCalls} times with no candidates instead of stopping`)
    assert.match(err.message, /boom|Escalated to human/)
    return true
  })
  assert.ok(taskCalls <= 3, `expected prompt termination, taskFn was called ${taskCalls} times`)
})

test('executeWithPolicy uses a single fallback candidate once, then escalates per existing semantics', async () => {
  const attempts = []
  const fallbackCandidate = { agent: 'agy', model: 'x' }
  let fallbackCalls = 0
  const bailout = new Error('test bailout: fallback stage ran more than once for a single candidate')
  const taskFn = async (activeCtx) => {
    attempts.push(activeCtx.candidate ?? null)
    throw new Error('boom')
  }
  const ctx = {
    candidate: null,
    fallbacks: [fallbackCandidate],
    onFallback: async () => {
      fallbackCalls++
      if (fallbackCalls > 1) throw bailout
    },
  }

  await assert.rejects(executeWithPolicy(taskFn, null, ctx), (err) => {
    assert.notEqual(err, bailout, `fallback stage ran ${fallbackCalls} times for a single candidate instead of stopping after one swap`)
    assert.match(err.message, /Escalated to human/)
    return true
  })
  assert.deepEqual(attempts, [null, null, fallbackCandidate], 'expected two attempts on the primary candidate then one on the fallback')
})

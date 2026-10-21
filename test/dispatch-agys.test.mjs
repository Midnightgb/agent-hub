import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { dispatch, createExecutionHandle } from '../src/dispatch.mjs'

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-agys-test-'))
  const env = { ...process.env, AGENT_HUB_HOME: home }
  delete env.AGENT_HUB_AGYS
  delete env.AGENT_HUB_AGYS_PROFILE
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

function fakeRoute(candidate = { agent: 'agy', model: 'gemini-3.8-flash' }, fallbacks = []) {
  return {
    routeFn: async () => ({ primary: candidate, fallbacks }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  }
}

test('agy + injected resolveProfileFn returning { profile: "work", status: "selected" } -> startJobFn receives profile and profileStatus', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-1', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    await dispatch({
      task: 'test-agy-profile',
      taskType: 'recon',
      cwd: '/tmp/test-agy',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(resolveCalls, 1)
    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, 'work')
    assert.equal(capturedArgs.profileStatus, 'selected')
  } finally {
    cleanup()
  }
})

test('resolveProfileFn receives the candidate model (quota is per model group, T3)', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    const mockStartJob = async (args) => ({
      job: { jobId: 'j-model', status: 'queued' },
      done: Promise.resolve(),
    })

    const seenModels = []
    const fakeResolveProfile = async ({ model }) => {
      seenModels.push(model)
      return { profile: 'work', status: 'selected' }
    }

    await dispatch({
      task: 'test-agy-model',
      taskType: 'recon',
      cwd: '/tmp/test-agy-model',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'agy', model: 'claude-sonnet-4-6' }),
    })

    assert.deepEqual(seenModels, ['claude-sonnet-4-6'])
  } finally {
    cleanup()
  }
})

test('the memo is scoped per model GROUP: an agy fallback in a DIFFERENT quota group (gemini -> claude) re-resolves instead of reusing the gemini profile', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    const resolveCallsByModel = []
    const fakeResolveProfile = async ({ model }) => {
      resolveCallsByModel.push(model)
      // A model-aware fake: pretend Gemini picks 'work' and Claude/GPT picks 'backup'.
      return model?.startsWith('gemini') ? { profile: 'work', status: 'selected' } : { profile: 'backup', status: 'selected' }
    }

    const capturedList = []
    const mockStartJob = async (args) => {
      capturedList.push(args)
      if (capturedList.length === 1) {
        return {
          job: { jobId: 'j-group-1', agent: args.agent, model: args.model, status: 'failed', errorKind: 'quota', error: 'quota reached' },
          done: Promise.resolve(),
        }
      }
      return { job: { jobId: 'j-group-2', agent: args.agent, model: args.model, status: 'queued' }, done: Promise.resolve() }
    }

    await dispatch({
      task: 'test-memo-cross-group',
      taskType: 'recon',
      cwd: '/tmp/test-memo-cross-group',
      category: 'quality',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute(
        { agent: 'agy', model: 'gemini-3.8-flash' },
        [{ agent: 'agy', model: 'claude-sonnet-4-6' }]
      ),
    })

    assert.deepEqual(resolveCallsByModel, ['gemini-3.8-flash', 'claude-sonnet-4-6'], 'a different quota group must re-resolve, not reuse the memo')
    assert.equal(capturedList[0].profile, 'work')
    assert.equal(capturedList[1].profile, 'backup')
  } finally {
    cleanup()
  }
})

test('non-agy candidate (e.g. opencode) -> resolveProfileFn is NEVER called and captured profile is null', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-2', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    await dispatch({
      task: 'test-non-agy',
      taskType: 'recon',
      cwd: '/tmp/test-non-agy',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'opencode', model: 'opencode/muse-spark' }),
    })

    assert.equal(resolveCalls, 0, 'resolveProfileFn must never be called for non-agy candidate')
    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)
  } finally {
    cleanup()
  }
})

test('default resolveProfileFn with env AGENT_HUB_AGYS=off -> captured profile/profileStatus are null', async () => {
  const { env, cleanup } = makeTempHome()
  env.AGENT_HUB_AGYS = 'off'
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-3', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    await dispatch({
      task: 'test-default-agys',
      taskType: 'recon',
      cwd: '/tmp/test-default-agys',
      env,
      startJobFn: mockStartJob,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)
  } finally {
    cleanup()
  }
})

test('the memo: dispatch retry re-running agy candidate calls resolveProfileFn at most once', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    const capturedList = []
    const mockStartJob = async (args) => {
      capturedList.push(args)
      if (capturedList.length === 1) {
        return {
          job: {
            jobId: 'j-retry-1',
            agent: args.agent,
            model: args.model,
            status: 'failed',
            errorKind: 'network',
            error: 'Connection reset',
          },
          done: Promise.resolve(),
        }
      }
      return {
        job: {
          jobId: 'j-retry-2',
          agent: args.agent,
          model: args.model,
          status: 'queued',
        },
        done: Promise.resolve(),
      }
    }

    await dispatch({
      task: 'test-memo-retry',
      taskType: 'recon',
      cwd: '/tmp/test-memo-retry',
      category: 'crash',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(capturedList.length, 2, 'startJobFn called twice across retry')
    assert.equal(resolveCalls, 1, 'resolveProfileFn must be called at most once across retries for the same agent')
    assert.equal(capturedList[0].profile, 'work')
    assert.equal(capturedList[0].profileStatus, 'selected')
    assert.equal(capturedList[1].profile, 'work')
    assert.equal(capturedList[1].profileStatus, 'selected')
  } finally {
    cleanup()
  }
})

test('dispatch asks resolveProfileFn to reserve:true for its auto pick (T2 burst spreading, same rationale as jobrunner)', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    const mockStartJob = async () => ({ job: { jobId: 'j-reserve', status: 'queued' }, done: Promise.resolve() })
    let receivedReserve = 'NOT_CALLED'
    const fakeResolveProfile = async ({ reserve }) => {
      receivedReserve = reserve
      return { profile: 'work', status: 'selected' }
    }

    await dispatch({
      task: 'test-dispatch-reserve',
      taskType: 'recon',
      cwd: '/tmp/test-dispatch-reserve',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(receivedReserve, true)
  } finally {
    cleanup()
  }
})

test('the memo: dispatch fallback re-running agy candidate calls resolveProfileFn at most once', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }

    const capturedList = []
    const mockStartJob = async (args) => {
      capturedList.push(args)
      if (capturedList.length === 1) {
        return {
          job: {
            jobId: 'j-fallback-1',
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
          jobId: 'j-fallback-2',
          agent: args.agent,
          model: args.model,
          status: 'queued',
        },
        done: Promise.resolve(),
      }
    }

    await dispatch({
      task: 'test-memo-fallback',
      taskType: 'recon',
      cwd: '/tmp/test-memo-fallback',
      category: 'quality',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      ...fakeRoute(
        { agent: 'agy', model: 'gemini-3.8-flash' },
        [{ agent: 'agy', model: 'gemini-2.5-flash' }]
      ),
    })

    assert.equal(capturedList.length, 2, 'startJobFn called twice across fallback')
    assert.equal(resolveCalls, 1, 'resolveProfileFn must be called at most once across fallbacks for the same agent')
    assert.equal(capturedList[0].profile, 'work')
    assert.equal(capturedList[0].profileStatus, 'selected')
    assert.equal(capturedList[1].profile, 'work')
    assert.equal(capturedList[1].profileStatus, 'selected')
  } finally {
    cleanup()
  }
})

test('error or malformed resolveProfileFn result falls back to nulls without throwing', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return {
        job: { jobId: 'j-err', status: 'queued' },
        done: Promise.resolve(),
      }
    }

    // Throwing resolver
    await dispatch({
      task: 'test-throwing-resolver',
      taskType: 'recon',
      cwd: '/tmp/test-throwing',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: async () => {
        throw new Error('agys CLI crashed')
      },
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs)
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)

    // Malformed resolver returning invalid shape
    capturedArgs = null
    await dispatch({
      task: 'test-malformed-resolver',
      taskType: 'recon',
      cwd: '/tmp/test-malformed',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: async () => 'unexpected string',
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs)
    assert.equal(capturedArgs.profile, null)
    assert.equal(capturedArgs.profileStatus, null)
  } finally {
    cleanup()
  }
})

test('dispatch with an explicit valid profile bypasses resolveProfileFn entirely and marks the job "pinned"', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return { job: { jobId: 'j-pinned', status: 'queued' }, done: Promise.resolve() }
    }
    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }
    const listAgysProfilesFn = async () => [{ name: 'work1' }, { name: 'work2' }]

    await dispatch({
      task: 'test-dispatch-pinned',
      taskType: 'recon',
      cwd: '/tmp/test-dispatch-pinned',
      profile: 'work1',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      listAgysProfilesFn,
      isAgysAvailableFn: async () => true,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(resolveCalls, 0, 'resolveProfileFn must never be called when a profile is pinned')
    assert.ok(capturedArgs, 'startJobFn was called')
    assert.equal(capturedArgs.profile, 'work1')
    assert.equal(capturedArgs.profileStatus, 'pinned')
  } finally {
    cleanup()
  }
})

test('dispatch rejects an unknown explicit profile before ever calling startJobFn', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    const mockStartJob = async () => {
      throw new Error('startJobFn must never be called for an unknown profile')
    }
    const listAgysProfilesFn = async () => [{ name: 'work1' }, { name: 'work2' }]

    await assert.rejects(
      () =>
        dispatch({
          task: 'test-dispatch-unknown-profile',
          taskType: 'recon',
          cwd: '/tmp/test-dispatch-unknown-profile',
          profile: 'nope',
          env,
          startJobFn: mockStartJob,
          listAgysProfilesFn,
          isAgysAvailableFn: async () => true,
          ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
        }),
      /unknown agys profile "nope".*work1, work2/
    )
  } finally {
    cleanup()
  }
})

test('dispatch rejects an explicit profile when the routed candidate is not agy', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    const mockStartJob = async () => {
      throw new Error('startJobFn must never be called for a rejected agent')
    }

    await assert.rejects(
      () =>
        dispatch({
          task: 'test-dispatch-non-agy-profile',
          taskType: 'recon',
          cwd: '/tmp/test-dispatch-non-agy-profile',
          profile: 'work1',
          env,
          startJobFn: mockStartJob,
          ...fakeRoute({ agent: 'opencode', model: 'opencode/muse-spark' }),
        }),
      /profile is only meaningful for agent "agy"/
    )
  } finally {
    cleanup()
  }
})

test('dispatch keeps a pinned profile through a retry (RDD #97 failover never swaps an explicit pin)', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    let resolveCalls = 0
    const fakeResolveProfile = async () => {
      resolveCalls++
      return { profile: 'work', status: 'selected' }
    }
    const capturedList = []
    const mockStartJob = async (args) => {
      capturedList.push(args)
      if (capturedList.length === 1) {
        return {
          job: { jobId: 'j-pin-retry-1', agent: args.agent, model: args.model, status: 'failed', errorKind: 'network', error: 'Connection reset' },
          done: Promise.resolve(),
        }
      }
      return { job: { jobId: 'j-pin-retry-2', agent: args.agent, model: args.model, status: 'queued' }, done: Promise.resolve() }
    }
    const listAgysProfilesFn = async () => [{ name: 'work1' }]

    await dispatch({
      task: 'test-dispatch-pinned-retry',
      taskType: 'recon',
      cwd: '/tmp/test-dispatch-pinned-retry',
      category: 'crash',
      profile: 'work1',
      env,
      startJobFn: mockStartJob,
      resolveProfileFn: fakeResolveProfile,
      listAgysProfilesFn,
      isAgysAvailableFn: async () => true,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.equal(capturedList.length, 2, 'startJobFn called twice across retry')
    assert.equal(resolveCalls, 0, 'resolveProfileFn must never be called while a profile is pinned')
    assert.equal(capturedList[0].profile, 'work1')
    assert.equal(capturedList[0].profileStatus, 'pinned')
    assert.equal(capturedList[1].profile, 'work1')
    assert.equal(capturedList[1].profileStatus, 'pinned')
  } finally {
    cleanup()
  }
})

test('mode "off" + an explicit profile: the explicit per-call profile is authoritative', async () => {
  const { env, cleanup } = makeTempHome()
  env.AGENT_HUB_AGYS = 'off'
  try {
    let capturedArgs = null
    const mockStartJob = async (args) => {
      capturedArgs = args
      return { job: { jobId: 'j-pin-off', status: 'queued' }, done: Promise.resolve() }
    }
    const listAgysProfilesFn = async () => [{ name: 'work1' }]

    await dispatch({
      task: 'test-dispatch-pinned-off',
      taskType: 'recon',
      cwd: '/tmp/test-dispatch-pinned-off',
      profile: 'work1',
      env,
      startJobFn: mockStartJob,
      listAgysProfilesFn,
      isAgysAvailableFn: async () => true,
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash' }),
    })

    assert.ok(capturedArgs)
    assert.equal(capturedArgs.profile, 'work1')
    assert.equal(capturedArgs.profileStatus, 'pinned')
  } finally {
    cleanup()
  }
})

test('createExecutionHandle returns profile from job or null when absent', () => {
  const handleWithProfile = createExecutionHandle({ job: { jobId: 'j1', profile: 'work' } })
  assert.equal(handleWithProfile.profile, 'work')

  const handleWithoutProfile = createExecutionHandle({ job: { jobId: 'j1' } })
  assert.equal(handleWithoutProfile.profile, null)

  const handleNoJob = createExecutionHandle()
  assert.equal(handleNoJob.profile, null)
})

test('a browser requirement reaches route, agy profile resolution and startJob (ui-test implies it)', async () => {
  const { env, cleanup } = makeTempHome()
  try {
    const routeCalls = []
    const resolveCalls = []
    const started = []
    const common = {
      cwd: '/tmp/test-agy-browser',
      env,
      startJobFn: async (args) => {
        started.push(args)
        return { job: { jobId: `j-browser-${started.length}`, status: 'queued' }, done: Promise.resolve() }
      },
      resolveProfileFn: async (args) => {
        resolveCalls.push(args)
        return { profile: 'work', status: 'selected' }
      },
      ...fakeRoute({ agent: 'agy', model: 'gemini-3.8-flash-high' }),
    }
    const routeFn = async (args) => {
      routeCalls.push(args)
      return { primary: { agent: 'agy', model: 'gemini-3.8-flash-high' }, fallbacks: [] }
    }

    await dispatch({ ...common, routeFn, task: 'explicit', taskType: 'recon', requirements: ['browser'] })
    await dispatch({ ...common, routeFn, task: 'implied', taskType: 'ui-test' })
    await dispatch({ ...common, routeFn, task: 'none', taskType: 'recon' })

    assert.deepEqual(routeCalls.map((c) => c.requirements), [['browser'], undefined, undefined])
    assert.deepEqual(resolveCalls.map((c) => c.requireBrowser), [true, true, undefined])
    assert.deepEqual(started.map((s) => s.requireBrowser), [true, true, undefined])
  } finally {
    cleanup()
  }
})

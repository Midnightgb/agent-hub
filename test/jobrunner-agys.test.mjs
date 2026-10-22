import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { adapterFor } from '../src/adapters/index.mjs'
import { AGY_GUARD_BLOCK } from '../src/adapters/agy.mjs'

const AGY_QUOTA_FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agy', 'stream-quota-error.jsonl'),
  'utf8'
)

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-agys-'))
}

async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  return { ...jobrunner, jobstore }
}

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  process.nextTick(() => child.emit('close', 0, null))
  return child
}

// startJob is SYNCHRONOUS and must stay so: delegate()/dispatch() read
// `startJob(...).job` immediately. Profile resolution is therefore env-based
// (AGENT_HUB_AGYS_PROFILE) or an explicit parameter — never a promise.

test('startJob wraps agy in agys when AGENT_HUB_AGYS_PROFILE is set', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'say hello',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS_PROFILE: 'work' },
  })
  await done

  assert.equal(captured.length, 1)
  assert.equal(captured[0].cmd, 'agys')
  assert.equal(captured[0].args[0], 'run')
  assert.equal(captured[0].args[1], 'work')
  assert.equal(captured[0].args[2], '--')
  assert.ok(captured[0].args.includes('--model'))
  // The -low suffix becomes an explicit --effort so agys does not inject its own.
  assert.ok(captured[0].args.includes('gemini-3.8-flash'))
  assert.deepEqual(captured[0].args.slice(captured[0].args.indexOf('--effort'), captured[0].args.indexOf('--effort') + 2), ['--effort', 'low'])
  // D1: a real agy job's prompt carries the hub-owned guard block prepended
  // to the original task text (coexistence with the agys profile wrapping).
  const promptArg = captured[0].args[captured[0].args.indexOf('-p') + 1]
  assert.equal(promptArg, `${AGY_GUARD_BLOCK}\n\nsay hello`)

  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, 'work')
  assert.equal(record.profileStatus, 'selected')
  assert.equal(job.profile, 'work')
  assert.equal(job.profileStatus, 'selected')
})

test('startJob honors an explicit profile/profileStatus parameter', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'fallback',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'backup',
    profileStatus: 'fallback',
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(captured[0].cmd, 'agys')
  assert.deepEqual(captured[0].args.slice(0, 3), ['run', 'backup', '--'])
  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, 'backup')
  assert.equal(record.profileStatus, 'fallback')
})

test('startJob with agy and no agys env spawns plain agy with null profile fields', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'plain agy',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(captured[0].cmd, 'agy')
  assert.ok(!captured[0].args.includes('run'))
  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, null)
  assert.equal(record.profileStatus, null)
})

test('a non-agy agent ignores AGENT_HUB_AGYS_PROFILE entirely', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const { job, done } = startJob({
    agent: 'opencode',
    model: 'opencode/muse-spark-1.3-contributor-free',
    task: 'not agy',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS_PROFILE: 'work' },
  })
  await done

  assert.notEqual(captured[0].cmd, 'agys')
  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, null)
  assert.equal(record.profileStatus, null)
})

test('startJob with AGENT_HUB_AGYS=auto and a faked sync resolver spawns agys run <profile> -- ...', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const fakeResolver = ({ env }) => {
    if (env?.AGENT_HUB_AGYS === 'auto') {
      return { profile: 'auto-picked', status: 'selected' }
    }
    return { profile: null, status: null }
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'auto task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    resolveAgyProfileSyncFn: fakeResolver,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
  })
  await done

  assert.equal(captured.length, 1)
  assert.equal(captured[0].cmd, 'agys')
  assert.deepEqual(captured[0].args.slice(0, 3), ['run', 'auto-picked', '--'])
  assert.ok(captured[0].args.includes('--model'))
  assert.ok(captured[0].args.includes('gemini-3.8-flash'))
  assert.ok(captured[0].args.includes('--effort'))

  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, 'auto-picked')
  assert.equal(record.profileStatus, 'selected')
  assert.equal(job.profile, 'auto-picked')
  assert.equal(job.profileStatus, 'selected')
})

test('startJob forwards the job model to resolveAgyProfileSyncFn (T3 quota-aware selection needs it)', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => fakeChild()

  let receivedModel = 'NOT_CALLED'
  const capturingResolver = ({ model }) => {
    receivedModel = model
    return { profile: 'work', status: 'selected' }
  }

  const { done } = startJob({
    agent: 'agy',
    model: 'claude-sonnet-4-6',
    task: 'auto task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    resolveAgyProfileSyncFn: capturingResolver,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
  })
  await done

  assert.equal(receivedModel, 'claude-sonnet-4-6')
})

test('startJob asks resolveAgyProfileSyncFn to reserve:true for the auto pick (T2 burst spreading), but never for an explicit profile pin', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => fakeChild()

  let receivedReserve = 'NOT_CALLED'
  const capturingResolver = ({ reserve }) => {
    receivedReserve = reserve
    return { profile: 'work', status: 'selected' }
  }

  const { done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'auto task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    resolveAgyProfileSyncFn: capturingResolver,
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
  })
  await done

  assert.equal(receivedReserve, true, 'the auto pick that actually starts a job must reserve a load slot')

  // An explicit per-call profile never calls resolveAgyProfileSyncFn at all.
  let resolverCalled = false
  const { done: done2 } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'pinned task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'personal',
    resolveAgyProfileSyncFn: () => {
      resolverCalled = true
      return { profile: 'work', status: 'selected' }
    },
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
  })
  await done2
  assert.equal(resolverCalled, false, 'a pinned profile bypasses auto resolution/reservation entirely')
})

test('3 sequential agy startJob calls with similar Gemini quota spread across 3 different profiles (real resolveAgyProfileSync, no fakes)', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => fakeChild()

  const listStdout = `Active Profiles:
PROFILE          PRIO  EMAIL                CONFIG  PATH
alpha (default)  0     a@example.com        (-)     ~/.agys/profiles/alpha
beta             0     b@example.com        (-)     ~/.agys/profiles/beta
gamma            0     c@example.com        (-)     ~/.agys/profiles/gamma
`
  const quotaJson = JSON.stringify([
    { profileName: 'alpha', quota: { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.5 }] }] } },
    { profileName: 'beta', quota: { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.5 }] }] } },
    { profileName: 'gamma', quota: { groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.5 }] }] } },
  ])
  const execFn = (cmd, args) => {
    if (args[0] === 'list') return listStdout
    if (args[0] === 'quota') return quotaJson
    return ''
  }
  const { resolveAgyProfileSync, resetSyncProfileCache, resetAgyLoadReservations } = await import('../src/providers/agys.mjs?t=' + Date.now())
  resetSyncProfileCache()
  resetAgyLoadReservations()
  const resolveAgyProfileSyncFn = (args) => resolveAgyProfileSync({ ...args, execFn })

  const env = { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' }
  const picks = []
  for (let i = 0; i < 3; i++) {
    const { job, done } = startJob({
      agent: 'agy',
      model: 'gemini-3.8-flash-low',
      task: `job ${i}`,
      cwd: '/tmp',
      mode: 'read',
      adapterFor,
      spawn,
      resolveAgyProfileSyncFn,
      env,
    })
    await done
    picks.push(job.profile)
  }

  assert.equal(new Set(picks).size, 3, `expected 3 distinct profiles, got ${JSON.stringify(picks)}`)
})

test('startJob with faked sync resolver without agys env stays plain agy', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const fakeResolver = ({ env }) => {
    if (env?.AGENT_HUB_AGYS === 'auto') {
      return { profile: 'auto-picked', status: 'selected' }
    }
    return { profile: null, status: null }
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'plain task',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    resolveAgyProfileSyncFn: fakeResolver,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(captured.length, 1)
  assert.equal(captured[0].cmd, 'agy')
  assert.ok(!captured[0].args.includes('run'))

  const record = jobstore.readResult(job.jobId)
  assert.equal(record.profile, null)
  assert.equal(record.profileStatus, null)
})

test('job.started and job.finished events carry resolved profile and profileStatus', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    const child = fakeChild()
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({ status: 'SUCCESS', response: 'all good' }))
    })
    return child
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'test events profile',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'work',
    profileStatus: 'selected',
    env: { AGENT_HUB_HOME: home },
  })
  await done

  const eventsFile = path.join(home, 'events.jsonl')
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
  const started = lines.find((e) => e.kind === 'job.started' && e.jobId === job.jobId)
  const finished = lines.find((e) => e.kind === 'job.finished' && e.jobId === job.jobId)

  assert.ok(started, 'job.started event was emitted')
  assert.equal(started.profile, 'work')
  assert.equal(started.profileStatus, 'selected')

  assert.ok(finished, 'job.finished event was emitted')
  assert.equal(finished.profile, 'work')
  assert.equal(finished.profileStatus, 'selected')
})

test('job.failed event carries resolved profile and profileStatus when job fails', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    throw new Error('spawn crash')
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'test fail events profile',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'backup',
    profileStatus: 'fallback',
    env: { AGENT_HUB_HOME: home },
  })
  await done

  const eventsFile = path.join(home, 'events.jsonl')
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse)
  const failed = lines.find((e) => e.kind === 'job.failed' && e.jobId === job.jobId)

  assert.ok(failed, 'job.failed event was emitted')
  assert.equal(failed.profile, 'backup')
  assert.equal(failed.profileStatus, 'fallback')
})

test('a quota failure on an agy job with a resolved profile records exhaustion for that profile+model group (T4 failover)', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    const child = fakeChild()
    process.nextTick(() => {
      child.stdout.emit('data', AGY_QUOTA_FIXTURE)
    })
    return child
  }

  const recorded = []
  const fakeRecordQuotaExhaustion = (args) => {
    recorded.push(args)
    return null
  }

  const { job, done } = startJob({
    agent: 'agy',
    model: 'claude-sonnet-4-6',
    task: 'quota failover test',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'esp',
    profileStatus: 'selected',
    recordQuotaExhaustionFn: fakeRecordQuotaExhaustion,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(recorded.length, 1, 'recordQuotaExhaustionFn must be called exactly once')
  assert.equal(recorded[0].profile, 'esp')
  assert.equal(recorded[0].modelGroup, 'claude-gpt')
  assert.match(recorded[0].message, /Individual quota reached/)

  // Sanity: the job itself is still correctly classified as a quota failure.
  const { jobstore } = await freshModules(home)
  const record = jobstore.readResult(job.jobId, { AGENT_HUB_HOME: home })
  assert.equal(record.status, 'failed')
  assert.equal(record.errorKind, 'quota')
})

test('a quota failure with NO resolved profile does not call recordQuotaExhaustionFn (nothing to record)', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    const child = fakeChild()
    process.nextTick(() => {
      child.stdout.emit('data', AGY_QUOTA_FIXTURE)
    })
    return child
  }

  let calls = 0
  const fakeRecordQuotaExhaustion = () => {
    calls++
    return null
  }

  const { done } = startJob({
    agent: 'agy',
    model: 'claude-sonnet-4-6',
    task: 'quota failover test, no profile',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    recordQuotaExhaustionFn: fakeRecordQuotaExhaustion,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(calls, 0)
})

test('a non-quota failure on an agy job with a resolved profile does not call recordQuotaExhaustionFn', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    const child = fakeChild()
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({ status: 'CANCELED', response: '' }))
    })
    return child
  }

  let calls = 0
  const fakeRecordQuotaExhaustion = () => {
    calls++
    return null
  }

  const { done } = startJob({
    agent: 'agy',
    model: 'claude-sonnet-4-6',
    task: 'canceled, not quota',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'esp',
    profileStatus: 'selected',
    recordQuotaExhaustionFn: fakeRecordQuotaExhaustion,
    env: { AGENT_HUB_HOME: home },
  })
  await done

  assert.equal(calls, 0)
})


test('quota routing skip: a quota failure with no agys account records a pair exhaustion mark; off records none', async () => {
  for (const [routing, expected] of [['skip', 1], [undefined, 0]]) {
    const home = tmpHome()
    const { startJob } = await freshModules(home)
    const spawn = () => {
      const child = fakeChild()
      process.nextTick(() => child.stdout.emit('data', AGY_QUOTA_FIXTURE))
      return child
    }
    const marks = []
    const { done } = startJob({
      agent: 'agy',
      model: 'claude-sonnet-4-6',
      task: 'quota mark test',
      cwd: '/tmp',
      mode: 'read',
      adapterFor,
      spawn,
      recordQuotaExhaustionFn: () => null,
      recordQuotaMarkFn: (args) => marks.push(args),
      env: { AGENT_HUB_HOME: home, ...(routing ? { AGENT_HUB_QUOTA_ROUTING: routing } : {}) },
    })
    await done
    assert.equal(marks.length, expected)
    if (expected) {
      assert.equal(marks[0].agent, 'agy')
      assert.equal(marks[0].model, 'claude-sonnet-4-6')
      assert.match(marks[0].message, /Individual quota reached/)
    }
  }
})

test('quota routing skip: a quota failure on an agys account marks only that account, never the whole pair', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const spawn = () => {
    const child = fakeChild()
    process.nextTick(() => child.stdout.emit('data', AGY_QUOTA_FIXTURE))
    return child
  }
  const marks = []
  const accounts = []
  const { done } = startJob({
    agent: 'agy',
    model: 'claude-sonnet-4-6',
    task: 'quota mark test',
    cwd: '/tmp',
    mode: 'read',
    adapterFor,
    spawn,
    profile: 'esp',
    profileStatus: 'selected',
    recordQuotaExhaustionFn: (args) => accounts.push(args),
    recordQuotaMarkFn: (args) => marks.push(args),
    env: { AGENT_HUB_HOME: home, AGENT_HUB_QUOTA_ROUTING: 'skip' },
  })
  await done
  assert.equal(accounts.length, 1)
  assert.equal(marks.length, 0)
})

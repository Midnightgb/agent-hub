import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { extractLastJsonLine } from '../src/adapters/base.mjs'
import { adapterFor } from '../src/adapters/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-'))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepoWithSecondaryWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-repo-'))
  const primary = path.join(base, 'primary')
  const secondary = path.join(base, 'secondary')
  fs.mkdirSync(primary)
  git(['init', '-q'], primary)
  git(['config', 'user.email', 'test@test.local'], primary)
  git(['config', 'user.name', 'Test'], primary)
  fs.writeFileSync(path.join(primary, 'a.txt'), 'x')
  git(['add', '-A'], primary)
  git(['commit', '-q', '-m', 'init'], primary)
  git(['worktree', 'add', secondary, '-b', 'wt-branch'], primary)
  return { primary, secondary }
}

/** A fake adapter driving `node -e <script>` instead of a real CLI. */
function fakeAdapter(script) {
  return {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => {
      const json = extractLastJsonLine(stdout)
      if (!json || json.status !== 'SUCCESS') return { ok: false }
      return { ok: true, text: json.response, tokens: json.usage?.total_tokens ?? null, sessionId: json.conversation_id ?? null }
    },
    classifyError: (stdout, exitInfo = {}) => {
      if (exitInfo.timedOut) return { kind: 'timeout', retriable: true, message: 'fake timeout' }
      const json = extractLastJsonLine(stdout)
      if (!json) return { kind: 'crash', retriable: false, message: 'no JSON' }
      if (json.status !== 'SUCCESS') return { kind: 'crash', retriable: false, message: `status=${json.status}` }
      return null
    },
    listModels: () => [],
  }
}

const SUCCESS_SCRIPT = `console.log(JSON.stringify({status:"SUCCESS",response:"PONG",usage:{total_tokens:5},conversation_id:"c1"}))`
const FAIL_SCRIPT = `console.log(JSON.stringify({status:"CANCELED",response:""}))`
const HANG_SCRIPT = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`
const EXIT_130_SCRIPT = `process.exit(130)`

/** A fake adapter whose classifyError depends on the forwarded exit code, to prove finishJob threads it through. */
function fakeAdapterSensitiveToExitCode(script) {
  return {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', script],
    parseResult: () => ({ ok: false }),
    classifyError: (stdout, exitInfo = {}) => {
      if (exitInfo.timedOut) return { kind: 'timeout', retriable: true, message: 'fake timeout' }
      if (exitInfo.code === 130) return { kind: 'canceled', retriable: true, message: 'fake canceled (SIGINT)' }
      return { kind: 'crash', retriable: false, message: `fake crash, code=${exitInfo.code}` }
    },
    listModels: () => [],
  }
}

/** Import jobrunner + its sibling modules fresh, all pinned to the same AGENT_HUB_HOME. */
async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  const eventlog = await import('../src/eventlog.mjs?t=' + tag)
  return { ...jobrunner, jobstore, eventlog }
}

/** A minimal fake child_process.ChildProcess: closes on the next tick, never spawns anything real. */
function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  process.nextTick(() => child.emit('close', 0, null))
  return child
}

test('a successful read job ends up succeeded, with text/tokens recorded and a job.finished event', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 'Reply exactly: PONG',
    cwd: '/tmp',
    mode: 'read',
    title: 't',
    adapterFor: (a) => adapters[a],
  })
  assert.equal(job.status, 'running')
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'succeeded')
  assert.equal(finalResult.tokens, 5)
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'PONG')

  const events = eventlog.readTail({ n: 20 })
  const kinds = events.filter((e) => e.jobId === job.jobId).map((e) => e.kind)
  assert.deepEqual(kinds, ['job.queued', 'job.started', 'job.finished'])
})

test('a failing read job (CANCELED) ends up failed with errorKind and a job.failed event', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(FAIL_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed')
  assert.equal(finalResult.errorKind, 'crash')

  const events = eventlog.readTail({ n: 20 })
  assert.ok(events.some((e) => e.jobId === job.jobId && e.kind === 'job.failed'))
})

test('finishJob forwards the child exit code into classifyError, so an adapter can tell a 130/SIGINT apart from a crash', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const adapters = { fake: fakeAdapterSensitiveToExitCode(EXIT_130_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed')
  assert.equal(finalResult.errorKind, 'canceled')
})

test('startJob redacts JULES_API_KEY (and other secrets) via the sandbox filter, keeping the rest of the environment', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const previousKey = process.env.JULES_API_KEY
  process.env.JULES_API_KEY = 'super-secret-key'
  let capturedOptions = null
  const spawn = (cmd, argv, options) => {
    capturedOptions = options
    return fakeChild()
  }
  try {
    const { done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a], spawn })
    await done
  } finally {
    if (previousKey === undefined) delete process.env.JULES_API_KEY
    else process.env.JULES_API_KEY = previousKey
  }

  assert.ok(capturedOptions.env, 'spawn must receive an explicit env')
  assert.equal(Object.prototype.hasOwnProperty.call(capturedOptions.env, 'JULES_API_KEY'), false, 'JULES_API_KEY is omitted from child env by the sandbox filter')
  assert.equal(capturedOptions.env.PATH, process.env.PATH)
})

test('a write-mode job in a primary worktree is rejected before spawning anything', async () => {
  const home = tmpHome()
  const { primary } = makeRepoWithSecondaryWorktree()
  const { startJob } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: primary, mode: 'write', adapterFor: (a) => adapters[a] })
  await done

  assert.equal(job.status, 'failed')
  assert.equal(job.errorKind, 'worktree_denied')
})

test('a write-mode job in a secondary worktree is allowed and releases its lock on completion', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const first = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(first.job.status, 'running')
  await first.done
  assert.equal(jobstore.readResult(first.job.jobId).status, 'succeeded')

  // The lock must be released: a second write-mode job to the same cwd succeeds too.
  const second = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  await second.done
  assert.equal(jobstore.readResult(second.job.jobId).status, 'succeeded')
})

test('a second concurrent write-mode job to the same locked cwd is rejected immediately', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob } = await freshModules(home)
  const adapters = { fake: fakeAdapter(`setTimeout(() => console.log(JSON.stringify({status:"SUCCESS",response:"PONG"})), 300)`) }

  const first = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(first.job.status, 'running')

  const second = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(second.job.status, 'failed')
  assert.equal(second.job.errorKind, 'locked')

  await first.done
})

test('cancelJob kills the process group and marks the job canceled', async () => {
  const home = tmpHome()
  const { startJob, cancelJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(HANG_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', timeoutS: 30, adapterFor: (a) => adapters[a] })
  assert.equal(job.status, 'running')

  await new Promise((r) => setTimeout(r, 200)) // let the child install its SIGTERM handler
  const canceled = await cancelJob(job.jobId)
  assert.equal(canceled.status, 'canceled')
  assert.equal(jobstore.readResult(job.jobId).status, 'canceled')

  const events = eventlog.readTail({ n: 20 })
  assert.ok(events.some((e) => e.jobId === job.jobId && e.kind === 'job.canceled'))

  // Drain the background finishJob chain (it still runs once the SIGKILLed
  // child's own exit event fires) before the next test mutates the shared
  // process.env.AGENT_HUB_HOME — otherwise it reads the wrong AGENT_HUB_HOME.
  await done
})

test('startJob passes {model,prompt,cwd,mode,timeoutS} through the REAL adapterFor into buildArgv for agy and opencode, in both read and write mode', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }

  const cases = [
    { agent: 'agy', mode: 'read', model: 'gemini-3.8-flash-low', cwd: '/tmp' },
    { agent: 'agy', mode: 'write', model: 'gemini-3.8-flash-low', cwd: secondary },
    { agent: 'opencode', mode: 'read', model: 'opencode/muse-spark-1.3-contributor-free', cwd: '/tmp' },
    { agent: 'opencode', mode: 'write', model: 'deepseek/deepseek-v4-flash', cwd: secondary },
  ]

  for (const c of cases) {
    const { done } = startJob({ agent: c.agent, model: c.model, task: 'hi', cwd: c.cwd, mode: c.mode, adapterFor, spawn, env: { ...process.env, AGENT_HUB_AGYS: 'off' } })
    await done
  }

  const agyRead = captured.find((c) => c.cmd === 'agy' && c.args.includes('plan'))
  assert.ok(agyRead, 'agy read mode must reach buildArgv as --mode plan')
  assert.equal(agyRead.opts.stdin, undefined, 'agy has no stdinFor, so no stdin must be forwarded for it')
  assert.equal(agyRead.opts.env.PWD, agyRead.opts.cwd, 'PWD must match the cwd passed to spawn (E14), for every agent')

  const agyWrite = captured.find((c) => c.cmd === 'agy' && c.args.includes('accept-edits'))
  assert.ok(agyWrite, 'agy write mode must reach buildArgv as --mode accept-edits')

  const ocRead = captured.find((c) => c.cmd === 'opencode' && c.args.includes('plan'))
  assert.ok(ocRead, 'opencode read mode must reach buildArgv as --agent plan')
  assert.ok(!ocRead.args.includes('--auto'), 'opencode read mode must never get --auto')
  assert.ok(!ocRead.args.includes('--dir'), '--dir was removed in opencode v2 (E1)')
  assert.ok(!ocRead.args.includes('hi'), 'the prompt must never appear as an argv element (E3)')
  assert.equal(ocRead.opts.stdin, 'hi', 'the prompt must reach opencode via stdin instead of argv (E3/E4)')
  assert.equal(ocRead.opts.env.PWD, ocRead.opts.cwd, 'PWD must match the cwd passed to spawn (E14): opencode v2 resolves cwd from process.env.PWD')

  const ocWrite = captured.find((c) => c.cmd === 'opencode' && c.args.includes('build'))
  assert.ok(ocWrite, 'opencode write mode must reach buildArgv as --agent build')
  assert.ok(ocWrite.args.includes('--auto'), 'opencode write mode must get --auto (regression: jobrunner used to call opencode.buildArgv with {agentMode,write} that jobrunner never sent)')
  assert.equal(ocWrite.opts.stdin, 'hi', 'opencode write mode must also get the prompt on stdin')
})

// --- T3 (opencode-live-catalog): variant validation against the live catalog before spawn ---

const MUSE_SPARK = 'opencode/muse-spark-1.3-contributor-free' // MODEL_REGISTRY default variant: 'high'

async function writeOpencodeDiscovery(home, { error = null, variants = ['low', 'medium'] } = {}) {
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now() + Math.random())
  const { paths } = await import('../src/config.mjs?t=' + Date.now() + Math.random())
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).discoveryFile, {
    opencode: {
      agent: 'opencode',
      cmd: 'opencode',
      binPath: '/bin/opencode',
      version: 'opencode v2.0.18',
      error,
      models: error ? [] : [{ id: MUSE_SPARK, cost: [{ input: 0, output: 0 }], variants: variants.map((id) => ({ id })) }],
      checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h old -- must still be used (isGoodCatalogRow, no TTL)
    },
  })
}

function captureSpawn() {
  const captured = []
  const spawn = (cmd, args, opts) => {
    captured.push({ cmd, args, opts })
    return fakeChild()
  }
  return { spawn, captured }
}

test('startJob drops an unsupported reasoning variant before spawning opencode, using the model default, and records a job warning', async () => {
  const home = tmpHome()
  await writeOpencodeDiscovery(home) // catalog lists MUSE_SPARK with variants low/medium -- no 'high'
  const { startJob } = await freshModules(home)
  const { spawn, captured } = captureSpawn()

  const { job, done } = startJob({ agent: 'opencode', model: MUSE_SPARK, task: 'hi', cwd: '/tmp', mode: 'read', adapterFor, spawn })
  await done

  const call = captured.find((c) => c.cmd === 'opencode')
  assert.ok(call)
  assert.equal(call.args[call.args.indexOf('-m') + 1], MUSE_SPARK, 'the unsupported variant must be dropped -- bare model id, no #high')
  assert.equal(job.variant, null)
  assert.ok(Array.isArray(job.warnings) && job.warnings.length === 1, 'the job record must carry exactly one warning')
  assert.match(job.warnings[0], /high/)
  assert.match(job.warnings[0], new RegExp(MUSE_SPARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('startJob validates an explicit model#variant id the same way -- drops it and warns when unsupported', async () => {
  const home = tmpHome()
  await writeOpencodeDiscovery(home) // no 'high' variant
  const { startJob } = await freshModules(home)
  const { spawn, captured } = captureSpawn()

  const { job, done } = startJob({ agent: 'opencode', model: `${MUSE_SPARK}#high`, task: 'hi', cwd: '/tmp', mode: 'read', adapterFor, spawn })
  await done

  const call = captured.find((c) => c.cmd === 'opencode')
  assert.equal(call.args[call.args.indexOf('-m') + 1], MUSE_SPARK, 'the explicit #high must be stripped back to the bare model id')
  assert.equal(job.model, MUSE_SPARK, 'the job record must store the normalized (stripped) model id')
  assert.equal(job.variant, null)
  assert.ok(Array.isArray(job.warnings) && job.warnings.length === 1)
})

test('startJob keeps an explicit model#variant untouched when it IS in the catalog variants[]', async () => {
  const home = tmpHome()
  await writeOpencodeDiscovery(home, { variants: ['low', 'medium', 'high'] })
  const { startJob } = await freshModules(home)
  const { spawn, captured } = captureSpawn()

  const { job, done } = startJob({ agent: 'opencode', model: `${MUSE_SPARK}#high`, task: 'hi', cwd: '/tmp', mode: 'read', adapterFor, spawn })
  await done

  const call = captured.find((c) => c.cmd === 'opencode')
  assert.equal(call.args[call.args.indexOf('-m') + 1], `${MUSE_SPARK}#high`)
  assert.ok(!job.warnings || job.warnings.length === 0)
})

test('startJob leaves the variant untouched (no warning) when the catalog does not know the model at all', async () => {
  const home = tmpHome() // no discovery.json written
  const { startJob } = await freshModules(home)
  const { spawn, captured } = captureSpawn()

  const { job, done } = startJob({ agent: 'opencode', model: MUSE_SPARK, task: 'hi', cwd: '/tmp', mode: 'read', adapterFor, spawn })
  await done

  const call = captured.find((c) => c.cmd === 'opencode')
  assert.equal(call.args[call.args.indexOf('-m') + 1], `${MUSE_SPARK}#high`, 'the registry default variant must still apply with no catalog evidence')
  assert.ok(!job.warnings || job.warnings.length === 0)
})

test('startJob leaves the variant untouched (no warning) when the discovery row is errored', async () => {
  const home = tmpHome()
  await writeOpencodeDiscovery(home, { error: 'model list timed out' })
  const { startJob } = await freshModules(home)
  const { spawn, captured } = captureSpawn()

  const { job, done } = startJob({ agent: 'opencode', model: MUSE_SPARK, task: 'hi', cwd: '/tmp', mode: 'read', adapterFor, spawn })
  await done

  const call = captured.find((c) => c.cmd === 'opencode')
  assert.equal(call.args[call.args.indexOf('-m') + 1], `${MUSE_SPARK}#high`)
  assert.ok(!job.warnings || job.warnings.length === 0)
})

test('startJob hard-kills only after timeoutS + KILL_GRACE_S, giving agy\'s own --print-timeout room to fire and flush first', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const { KILL_GRACE_S } = await import('../src/config.mjs?t=' + Date.now())
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }
  let capturedTimeoutMs = null
  const runWithTimeout = (child, opts) => {
    capturedTimeoutMs = opts.timeoutMs
    return { exitPromise: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, timedOut: false }))) }
  }

  const { done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 'Reply exactly: PONG',
    cwd: '/tmp',
    mode: 'read',
    timeoutS: 100,
    adapterFor: (a) => adapters[a],
    runWithTimeout,
  })
  await done

  assert.equal(capturedTimeoutMs, (100 + KILL_GRACE_S) * 1000)
})

test('a failed job with partialText/sessionId on its error persists both — response.txt keeps the partial text, sessionId lets job_reply resume the abandoned turn', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const adapterWithPartial = {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', `console.log(JSON.stringify({status:"SUCCESS",response:"",conversation_id:"sess-xyz"}))`],
    parseResult: () => ({ ok: true, text: '' }),
    classifyError: () => ({ kind: 'timeout', retriable: true, message: 'abandoned', partialText: 'partial answer so far', sessionId: 'sess-xyz' }),
    listModels: () => [],
  }
  const adapters = { fake: adapterWithPartial }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed')
  assert.equal(finalResult.errorKind, 'timeout')
  assert.equal(finalResult.sessionId, 'sess-xyz')
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'partial answer so far')
})

test('finishJob fires the adapter\'s interruptArgv hook on a timeout with a recoverable sessionId, and records a job.interrupted event without touching the job\'s failed status/errorKind (E19)', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const calls = []
  const runCommandFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { stdout: JSON.stringify({ interrupted: true }), stderr: '', code: 0, signal: null, timedOut: false }
  }
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', SUCCESS_SCRIPT],
      parseResult: () => ({ ok: true, text: '' }),
      classifyError: () => ({ kind: 'timeout', retriable: true, message: 'fake timeout', sessionId: 'ses_abc' }),
      interruptArgv: ({ sessionId }) => ['api', 'session.interrupt', '--param', `sessionID=${sessionId}`],
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a], runCommandFn })
  await done

  assert.equal(calls.length, 1, 'the interrupt argv must be run exactly once')
  assert.equal(calls[0].cmd, process.execPath, 'the interrupt must be run with the adapter\'s own cmd')
  assert.deepEqual(calls[0].args, ['api', 'session.interrupt', '--param', 'sessionID=ses_abc'])

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed', 'the interrupt cleanup must never change the recorded status')
  assert.equal(finalResult.errorKind, 'timeout', 'the interrupt cleanup must never change the recorded errorKind')

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  const interrupted = events.find((e) => e.kind === 'job.interrupted')
  assert.ok(interrupted, 'a job.interrupted event must be recorded')
  assert.equal(interrupted.sessionId, 'ses_abc')
  assert.equal(interrupted.interrupted, true)
})

test('finishJob recovers the interrupt sessionId from the job record when the timeout error itself carries none (a timeout resuming an existing session)', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const calls = []
  const runCommandFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { stdout: JSON.stringify({ interrupted: false }), stderr: '', code: 0, signal: null, timedOut: false }
  }
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', SUCCESS_SCRIPT],
      parseResult: () => ({ ok: true, text: '' }),
      classifyError: () => ({ kind: 'timeout', retriable: true, message: 'fake timeout' }),
      interruptArgv: ({ sessionId }) => ['api', 'session.interrupt', '--param', `sessionID=${sessionId}`],
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', sessionId: 'ses_resumed', adapterFor: (a) => adapters[a], runCommandFn })
  await done

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['api', 'session.interrupt', '--param', 'sessionID=ses_resumed'], 'falls back to the job record\'s own sessionId (see jobrunner.mjs finishJob\'s existing error.sessionId ?? current.sessionId fallback)')

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  const interrupted = events.find((e) => e.kind === 'job.interrupted')
  assert.equal(interrupted.interrupted, false, 'the CLI reports false when the session had already finished — still recorded honestly')
})

test('finishJob never attempts a server-side interrupt when the adapter has no interruptArgv hook, so agy/codex/copilot/jules stay unaffected', async () => {
  const home = tmpHome()
  const { startJob, eventlog } = await freshModules(home)
  let called = false
  const runCommandFn = async () => {
    called = true
    return { stdout: '{}', stderr: '', code: 0, signal: null, timedOut: false }
  }
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', SUCCESS_SCRIPT],
      parseResult: () => ({ ok: true, text: '' }),
      classifyError: () => ({ kind: 'timeout', retriable: true, message: 'fake timeout', sessionId: 'ses_abc' }),
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a], runCommandFn })
  await done

  assert.equal(called, false, 'no interrupt hook means no interrupt attempt')
  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(!events.some((e) => e.kind === 'job.interrupted'))
})

test('finishJob never attempts a server-side interrupt when a non-timeout error carries a sessionId (e.g. a plain crash)', async () => {
  const home = tmpHome()
  const { startJob, eventlog } = await freshModules(home)
  let called = false
  const runCommandFn = async () => {
    called = true
    return { stdout: '{}', stderr: '', code: 0, signal: null, timedOut: false }
  }
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', SUCCESS_SCRIPT],
      parseResult: () => ({ ok: true, text: '' }),
      classifyError: () => ({ kind: 'crash', retriable: false, message: 'fake crash', sessionId: 'ses_abc' }),
      interruptArgv: ({ sessionId }) => ['api', 'session.interrupt', '--param', `sessionID=${sessionId}`],
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a], runCommandFn })
  await done

  assert.equal(called, false, 'the interrupt is a timeout-only cleanup, not a general-purpose one')
  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(!events.some((e) => e.kind === 'job.interrupted'))
})

test('a failing server-side interrupt attempt never throws into finalization, and the job still finalizes as failed/timeout', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const runCommandFn = async () => {
    throw new Error('boom: interrupt command failed to spawn')
  }
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', SUCCESS_SCRIPT],
      parseResult: () => ({ ok: true, text: '' }),
      classifyError: () => ({ kind: 'timeout', retriable: true, message: 'fake timeout', sessionId: 'ses_abc' }),
      interruptArgv: ({ sessionId }) => ['api', 'session.interrupt', '--param', `sessionID=${sessionId}`],
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a], runCommandFn })
  await done // must resolve, never reject

  const finalResult = jobstore.readResult(job.jobId)
  assert.equal(finalResult.status, 'failed')
  assert.equal(finalResult.errorKind, 'timeout')

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  const interrupted = events.find((e) => e.kind === 'job.interrupted')
  assert.ok(interrupted, 'the failed attempt is still recorded, not silently swallowed')
  assert.equal(interrupted.interrupted, null, 'unknown outcome when the interrupt command itself failed')
})

test('taskType is stored on result.json and carried on every job.* event', async () => {
  const home = tmpHome()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: '/tmp',
    mode: 'read',
    taskType: 'recon',
    adapterFor: (a) => adapters[a],
  })
  await done

  assert.equal(jobstore.readResult(job.jobId).taskType, 'recon')
  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(events.length >= 3)
  assert.ok(events.every((e) => e.taskType === 'recon'), 'every event must carry the job taskType')
})

test('turnDepth is stored on the record (root job defaults to 0)', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', adapterFor: (a) => adapters[a] })
  await done
  assert.equal(jobstore.readResult(job.jobId).turnDepth, 0)
})

test('the effective timeout and its source are resolved BEFORE createJob and drive both argv and the kill timer', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const calls = []
  const resolveEffectiveTimeoutSFn = (params) => {
    calls.push(params)
    return { timeoutS: 777, source: 'adaptive', p95Ms: 500000, samples: 12 }
  }
  let argvTimeoutS = null
  let killTimeoutMs = null
  const adapter = {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: (opts) => {
      argvTimeoutS = opts.timeoutS
      return ['-e', SUCCESS_SCRIPT]
    },
    parseResult: (stdout) => ({ ok: true, text: 'PONG', tokens: 5, sessionId: null }),
    classifyError: () => null,
    listModels: () => [],
  }
  const adapters = { fake: adapter }
  const child = fakeChild()
  const spawn = () => child
  const runWithTimeout = (c, opts) => {
    killTimeoutMs = opts.timeoutMs
    return { exitPromise: new Promise((resolve) => c.on('close', () => resolve({ timedOut: false }))) }
  }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: '/tmp',
    mode: 'read',
    taskType: 'recon',
    timeoutS: undefined,
    adapterFor: (a) => adapters[a],
    spawn,
    runWithTimeout,
    resolveEffectiveTimeoutSFn,
  })
  await done

  assert.equal(calls.length, 1)
  assert.equal(calls[0].taskType, 'recon')
  assert.equal(calls[0].explicit, undefined)
  const result = jobstore.readResult(job.jobId)
  assert.equal(result.timeoutS, 777)
  assert.equal(result.timeoutSource, 'adaptive')
  assert.equal(argvTimeoutS, 777)
  assert.equal(killTimeoutMs, (777 + 30) * 1000)
})

test('learnings augment the prompt and are recorded on a root job, but are skipped for a reply turn', async () => {
  const home = tmpHome()
  const { startJob, jobstore } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }
  let selectCalls = 0
  const selectLearningsFn = () => {
    selectCalls++
    return [{ id: 'l-1', text: 'watch out' }]
  }
  const augmentTaskFn = (task) => ({ task: `NOTE: watch out\n\n${task}`, learningIds: ['l-1'] })

  const root = startJob({
    agent: 'fake',
    model: 'x',
    task: 'do it',
    cwd: '/tmp',
    mode: 'read',
    adapterFor: (a) => adapters[a],
    selectLearningsFn,
    augmentTaskFn,
  })
  await root.done
  const rootResult = jobstore.readResult(root.job.jobId)
  assert.equal(selectCalls, 1)
  assert.equal(fs.readFileSync(path.join(home, 'runs', root.job.jobId, 'prompt.txt'), 'utf8'), 'NOTE: watch out\n\ndo it')
  assert.deepEqual(rootResult.learningIds, ['l-1'])

  const reply = startJob({
    agent: 'fake',
    model: 'x',
    task: 'follow up',
    cwd: '/tmp',
    mode: 'read',
    sessionId: 'sess-1',
    turnDepth: 1,
    adapterFor: (a) => adapters[a],
    selectLearningsFn,
    augmentTaskFn,
  })
  await reply.done
  assert.equal(selectCalls, 1, 'learnings must not be selected for a reply turn')
  assert.deepEqual(jobstore.readResult(reply.job.jobId).learningIds, [])
})

test('a read job that modifies the worktree is failed with errorKind read_mode_violation, keeping tokens and response text', async () => {
  const home = tmpHome()
  const { primary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  // A real child that both touches the worktree and prints a SUCCESS line, so
  // the CLI genuinely "succeeded" while violating read mode.
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(primary, 'changed.txt'))}, 'y'); console.log(JSON.stringify({status:"SUCCESS",response:"PONG",usage:{total_tokens:5}}))`
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', script],
      parseResult: (stdout) => {
        const json = extractLastJsonLine(stdout)
        return { ok: true, text: json.response, tokens: json.usage?.total_tokens ?? null, sessionId: null }
      },
      classifyError: (stdout, exitInfo = {}) => {
        if (exitInfo.timedOut) return { kind: 'timeout', message: 'timeout' }
        const json = extractLastJsonLine(stdout)
        if (!json) return { kind: 'crash', message: 'no JSON' }
        if (json.status !== 'SUCCESS') return { kind: 'crash', message: `status=${json.status}` }
        return null
      },
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: primary, mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'read_mode_violation')
  assert.match(result.error, /read-mode job modified/)
  assert.equal(result.tokens, 5, 'tokens are still kept on a read-mode violation')
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'PONG', 'response.txt is still kept')
  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(events.some((e) => e.kind === 'job.failed' && e.errorKind === 'read_mode_violation'))
})

test('an already-failed read job keeps its errorKind and only gains readModeViolation when the worktree changed', async () => {
  const home = tmpHome()
  const { primary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(primary, 'changed.txt'))}, 'y'); console.log(JSON.stringify({status:"CANCELED",response:""}))`
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', script],
      parseResult: () => ({ ok: false }),
      classifyError: (stdout) => {
        const json = extractLastJsonLine(stdout)
        if (!json) return { kind: 'crash', message: 'no JSON' }
        if (json.status !== 'SUCCESS') return { kind: 'crash', message: `status=${json.status}` }
        return null
      },
      listModels: () => [],
    },
  }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: primary, mode: 'read', adapterFor: (a) => adapters[a] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'crash')
  assert.match(result.readModeViolation, /read-mode job modified/)
  const failed = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId && e.kind === 'job.failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].errorKind, 'crash')
})

test('an unknown agent throws before any job record is created (adapterFor now resolves at the very top of startJob)', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)

  assert.throws(() => startJob({ agent: 'not-a-real-agent', model: 'x', task: 't', cwd: '/tmp' }), /unknown agent: not-a-real-agent/)

  const runsDir = path.join(home, 'runs')
  const entries = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((e) => e !== '.locks') : []
  assert.deepEqual(entries, [], 'no job directory should exist for an agent that was never resolved')
})

test('startJob routes a remote adapter (e.g. jules) to startRemoteJobFn, before the write-mode gate/lock and read-mode snapshot ever run', async () => {
  const home = tmpHome()
  const { startJob } = await freshModules(home)
  const { primary } = makeRepoWithSecondaryWorktree()
  const fakeAdapterForJules = { remote: true, id: 'jules-fake' }
  let captured = null
  const startRemoteJobFn = (args) => {
    captured = args
    return { job: { jobId: 'remote-job-1', status: 'queued', mode: 'write' }, done: Promise.resolve() }
  }

  const { job, done } = startJob({
    agent: 'jules',
    model: 'jules',
    task: 't',
    cwd: primary, // a PRIMARY worktree — checkWriteAllowed would reject this for a local write-mode job
    mode: 'write',
    adapterFor: () => fakeAdapterForJules,
    startRemoteJobFn,
  })
  await done

  assert.equal(job.jobId, 'remote-job-1')
  assert.notEqual(job.errorKind, 'worktree_denied', 'the write-mode gate must never run for a remote adapter')
  assert.equal(captured.agent, 'jules')
  assert.equal(captured.cwd, primary)
  assert.equal(captured.adapter, fakeAdapterForJules)
})

test('canceling a remote job never releases a write lock it never acquired (would otherwise break a concurrent local write-mode job on the same cwd)', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob, cancelJob, jobstore } = await freshModules(home)

  // A real local write-mode job holds the lock on `secondary`.
  const adapters = { fake: fakeAdapter(`setTimeout(() => console.log(JSON.stringify({status:"SUCCESS",response:"PONG"})), 300)`) }
  const localJob = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(localJob.job.status, 'running')

  // A "remote" jules job sharing the same cwd — must never touch the lock.
  const fakeAdapterForJules = { remote: true, id: 'jules-fake' }
  const startRemoteJobFn = ({ env, cwd }) => {
    const job = jobstore.createJob({ agent: 'jules', model: 'jules', task: 't', cwd, title: 't', mode: 'write', env })
    jobstore.updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-1' } }, env)
    return { job: jobstore.readResult(job.jobId, env), done: new Promise(() => {}) }
  }
  const remoteJob = startJob({ agent: 'jules', model: 'jules', task: 't', cwd: secondary, mode: 'write', adapterFor: () => fakeAdapterForJules, startRemoteJobFn })
  await cancelJob(remoteJob.job.jobId)
  assert.equal(jobstore.readResult(remoteJob.job.jobId).status, 'canceled')

  // A second concurrent local write-mode job to the same cwd is still rejected — the real lock is untouched.
  const second = startJob({ agent: 'fake', model: 'x', task: 't', cwd: secondary, mode: 'write', adapterFor: (a) => adapters[a] })
  assert.equal(second.job.status, 'failed')
  assert.equal(second.job.errorKind, 'locked')

  await localJob.done
})

test('canceling a remote job marks it canceled and appends job.canceled, without attempting to kill a local process group', async () => {
  const home = tmpHome()
  const { startJob, cancelJob, jobstore, eventlog } = await freshModules(home)
  const fakeAdapterForJules = { remote: true, id: 'jules-fake' }
  const startRemoteJobFn = ({ env }) => {
    const job = jobstore.createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/tmp', title: 't', mode: 'write', env })
    jobstore.updateResult(job.jobId, { status: 'running', remote: { provider: 'jules', sessionId: 'sess-1' } }, env)
    return { job: jobstore.readResult(job.jobId, env), done: new Promise(() => {}) } // the remote session keeps running
  }

  const { job } = startJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/tmp', mode: 'write', adapterFor: () => fakeAdapterForJules, startRemoteJobFn })
  assert.equal(job.status, 'running')

  const canceled = await cancelJob(job.jobId)
  assert.equal(canceled.status, 'canceled')
  assert.equal(jobstore.readResult(job.jobId).status, 'canceled')

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(events.some((e) => e.kind === 'job.canceled'))
})

test('cancelJob never leaves a spurious job.failed event alongside job.canceled (finishJob races the kill)', async () => {
  const home = tmpHome()
  const { startJob, cancelJob, eventlog } = await freshModules(home)
  // Exits almost immediately once SIGTERM lands, so finishJob's own exit
  // handler races cancelJob's status update as tightly as possible.
  const adapters = { fake: fakeAdapter(`process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)`) }

  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', timeoutS: 30, adapterFor: (a) => adapters[a] })
  await new Promise((r) => setTimeout(r, 150))
  await cancelJob(job.jobId)
  await done // drain the racing finishJob chain deterministically

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  const kinds = events.map((e) => e.kind)
  assert.ok(kinds.includes('job.canceled'))
  assert.ok(!kinds.includes('job.failed'), `expected no spurious job.failed, got: ${kinds.join(', ')}`)
})

test('cancelJob also interrupts the server-side session, not just the local client', async () => {
  // A user cancel kills the process group exactly like a timeout does, and
  // finishJob no-ops once it sees status:'canceled' — so without this the
  // opencode session keeps running on the shared server, still spending
  // tokens and still editing the worktree. Cancelling is precisely when the
  // user wants it stopped, so it must not be weaker than the timeout path.
  const home = tmpHome()
  const { startJob, cancelJob, eventlog } = await freshModules(home)

  const EMIT_SESSION_THEN_HANG = `console.log(JSON.stringify({type:"step_start",sessionID:"ses_cancel"})); process.on("SIGINT",()=>{}); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)`
  const calls = []
  const adapter = {
    ...fakeAdapter(EMIT_SESSION_THEN_HANG),
    sessionIdFrom: (stdout) => (stdout.includes('ses_cancel') ? 'ses_cancel' : null),
    interruptArgv: ({ sessionId }) => ['api', 'session.interrupt', '--param', `sessionID=${sessionId}`],
  }
  const runCommandFn = async (cmd, args) => {
    calls.push({ cmd, args })
    return { stdout: '{"interrupted":true}', stderr: '', code: 0, timedOut: false }
  }

  const { job, done } = startJob({
    agent: 'fake', model: 'x', task: 't', cwd: '/tmp', mode: 'read', timeoutS: 30,
    adapterFor: () => adapter, runCommandFn,
  })
  await new Promise((r) => setTimeout(r, 300)) // let the child emit its first line

  await cancelJob(job.jobId)

  assert.equal(calls.length, 1, `expected one interrupt attempt, got ${JSON.stringify(calls)}`)
  assert.deepEqual(calls[0].args, ['api', 'session.interrupt', '--param', 'sessionID=ses_cancel'])
  assert.ok(eventlog.readTail({ n: 20 }).some((e) => e.jobId === job.jobId && e.kind === 'job.interrupted'))

  await done
})

test('a write-mode job whose command changes no file reports noChanges: true and emits job.no_changes', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: secondary,
    mode: 'write',
    title: 'test write job',
    taskType: 'mechanical-edit',
    adapterFor: (a) => adapters[a],
  })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.noChanges, true)

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  const noChangesEvent = events.find((e) => e.kind === 'job.no_changes')
  assert.ok(noChangesEvent, 'a job.no_changes event must exist')
  assert.equal(noChangesEvent.agent, 'fake')
  assert.equal(noChangesEvent.model, 'x')
  assert.equal(noChangesEvent.cwd, secondary)
  assert.equal(noChangesEvent.title, 'test write job')
  assert.equal(noChangesEvent.taskType, 'mechanical-edit')
  assert.equal(noChangesEvent.summary, 'write-mode job finished without modifying any file')
})

test('a write-mode job that modifies a file has falsy noChanges and no job.no_changes event', async () => {
  const home = tmpHome()
  const { secondary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(secondary, 'changed.txt'))}, 'y'); console.log(JSON.stringify({status:"SUCCESS",response:"PONG",usage:{total_tokens:5}}))`
  const adapters = {
    fake: {
      id: 'fake',
      cmd: process.execPath,
      buildArgv: () => ['-e', script],
      parseResult: (stdout) => {
        const json = extractLastJsonLine(stdout)
        return { ok: true, text: json.response, tokens: json.usage?.total_tokens ?? null, sessionId: null }
      },
      classifyError: (stdout, exitInfo = {}) => {
        if (exitInfo.timedOut) return { kind: 'timeout', message: 'timeout' }
        const json = extractLastJsonLine(stdout)
        if (!json) return { kind: 'crash', message: 'no JSON' }
        if (json.status !== 'SUCCESS') return { kind: 'crash', message: `status=${json.status}` }
        return null
      },
      listModels: () => [],
    },
  }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: (a) => adapters[a],
  })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.ok(!result.noChanges, 'noChanges must be falsy when files were modified')

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(!events.some((e) => e.kind === 'job.no_changes'), 'must not emit job.no_changes when files were modified')
})

test('an existing read-mode job result is unchanged (noChanges is falsy/omitted)', async () => {
  const home = tmpHome()
  const { primary } = makeRepoWithSecondaryWorktree()
  const { startJob, jobstore, eventlog } = await freshModules(home)
  const adapters = { fake: fakeAdapter(SUCCESS_SCRIPT) }

  const { job, done } = startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd: primary,
    mode: 'read',
    adapterFor: (a) => adapters[a],
  })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.noChanges, undefined)

  const events = eventlog.readTail({ n: 20 }).filter((e) => e.jobId === job.jobId)
  assert.ok(!events.some((e) => e.kind === 'job.no_changes'), 'read-mode job must not emit job.no_changes')
})


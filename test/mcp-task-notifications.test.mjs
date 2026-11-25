import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

// The server reads AGENT_HUB_HOME at call time; set it before anything touches the store.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-mcp-tasks-'))
process.env.AGENT_HUB_HOME = HOME
process.env.AGENT_HUB_DISABLE_STARTUP_DISCOVERY = '1'

const { createJob, readResult, updateResult } = await import('../src/jobstore.mjs')
const { buildServer } = await import('../src/index.mjs')
const { preservePartialWork, buildRerouteTask, isQuotaFailure } = await import('../src/reroute.mjs')
const { installTaskSupport } = await import('../src/notify/mcp-tasks.mjs')
const { JobSupervisor } = await import('../src/notify/mcp-supervisor.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TASKS = 'io.modelcontextprotocol/tasks'

/** A real job record that flips to a terminal state later. */
function fakeJob({ agent = 'copilot', model = 'gpt-5.1', mode = 'write', cwd = '/tmp', finish, afterMs = 60 }) {
  const job = createJob({ agent, model, task: 'do it', cwd, title: 'fake', mode })
  updateResult(job.jobId, { status: 'running' })
  setTimeout(() => updateResult(job.jobId, finish), afterMs)
  return job
}

/**
 * An in-process server on a raw JSON-RPC wire. era 2026: every request carries the
 * protocol version and client capabilities in _meta (no handshake). era 2025: the
 * legacy initialize handshake.
 */
async function connect({ deps = {}, env = {}, era = '2026', extensions = { [TASKS]: {} }, taskPollMs = 15 } = {}) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  serveStdio(() => buildServer({ env: { ...process.env, ...env }, deps, taskPollMs }), { transport: serverT })
  const pending = new Map()
  const notifications = []
  clientT.onmessage = (m) => {
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else notifications.push(m)
  }
  await clientT.start()
  let nextId = 0
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.304' },
    'io.modelcontextprotocol/clientCapabilities': extensions ? { extensions } : {},
  }
  const request = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      clientT.send({ jsonrpc: '2.0', id, method, params: era === '2026' ? { ...params, _meta: meta } : params })
    })
  if (era === '2025') {
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' } })
    assert.ok(init.result, 'legacy initialize is served')
    await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  } else {
    const discover = await request('server/discover')
    assert.ok(discover.result, 'server/discover is served')
  }
  const call = (name, args) => request('tools/call', { name, arguments: args })
  return { request, call, notifications, close: () => clientT.close() }
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(15)
  }
  throw new Error('timed out waiting for condition')
}

const pollTask = (c, taskId, status) =>
  until(async () => {
    const r = await c.request('tasks/get', { taskId })
    assert.ok(r.result, JSON.stringify(r))
    return r.result.status === status ? r.result : null
  })

const delegateArgs = { agent: 'copilot', model: 'gpt-5.1', task: 'do it', cwd: '/tmp', mode: 'write' }

/** dispatch stand-in: candidates run in order, each with its own scripted outcome. */
function fakeDispatchFactory({ chain, outcomes, calls, mode = 'write', cwd = '/tmp', afterMs = 50 }) {
  return async (args) => {
    calls.push(args)
    let primary = chain[0]
    let fallbacks = chain.slice(1)
    if (args.routeFn) ({ primary, fallbacks } = await args.routeFn())
    const idx = chain.findIndex((c) => c.agent === primary.agent && c.model === primary.model)
    const job = fakeJob({ agent: primary.agent, model: primary.model, mode, cwd, finish: outcomes[idx] ?? { status: 'succeeded' }, afterMs })
    args.onAttempt?.({ agent: primary.agent, model: primary.model, jobId: job.jobId, status: 'running', errorKind: null, error: null })
    args.onRoute?.({ candidate: primary, remaining: fallbacks, executionId: 'exec_t', rootExecutionId: 'exec_t' })
    return { job: readResult(job.jobId), dispatchKey: args.dispatchKey ?? 'k', executionId: 'exec_t', candidate: primary }
  }
}

const quota = (error = 'Individual quota reached. Resets in 3h.') => ({ status: 'failed', errorKind: 'quota', error })
const CHAIN = [
  { agent: 'agy', model: 'gemini-3.8-pro' },
  { agent: 'copilot', model: 'gpt-5.1' },
  { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' },
  { agent: 'codex', model: 'default' },
  { agent: 'gentle-shell', model: 'anthropic/claude-sonnet-5-5' },
]

// ---- 2026-07-28 tasks ----------------------------------------------------

test('a 2026-07-28 client that declares the tasks extension gets a task handle for delegate and a completed result', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ finish: { status: 'succeeded' }, afterMs: 600 })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const c = await connect({ deps })
  try {
    const started = Date.now()
    const res = await c.call('delegate', delegateArgs)
    assert.ok(Date.now() - started < 400, 'the task handle comes back before the job ends')
    assert.equal(res.result.resultType, 'task')
    assert.equal(res.result.status, 'working')
    assert.ok(res.result.taskId)
    assert.equal(res.result.ttlMs, null)

    const done = await pollTask(c, res.result.taskId, 'completed')
    assert.equal(done.resultType, 'complete')
    const notice = JSON.parse(done.result.content[0].text)
    assert.equal(notice.status, 'succeeded')
    assert.equal(notice.agent, 'copilot')
    assert.equal(notice.model, 'gpt-5.1')
  } finally {
    await c.close()
  }
})

test('a quota failure ends the task failed with errorKind, error, agent and model in the error', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ agent: 'agy', model: 'gemini-3.8-pro', finish: quota() })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const c = await connect({ deps })
  try {
    const res = await c.call('delegate', { ...delegateArgs, agent: 'agy', model: 'gemini-3.8-pro' })
    const failed = await pollTask(c, res.result.taskId, 'failed')
    assert.match(failed.error.message, /quota/)
    assert.match(failed.error.message, /Individual quota reached/)
    assert.match(failed.error.message, /agy\/gemini-3\.8-pro/)
    assert.equal(failed.error.data.errorKind, 'quota')
    assert.equal(failed.error.data.error, 'Individual quota reached. Resets in 3h.')
    assert.equal(failed.error.data.agent, 'agy')
    assert.equal(failed.error.data.model, 'gemini-3.8-pro')
    assert.equal(failed.statusMessage, failed.error.message)
  } finally {
    await c.close()
  }
})

test('tasks/cancel cancels the job and the task reads cancelled', async () => {
  const canceled = []
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ finish: { status: 'succeeded' }, afterMs: 5000 })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
    cancelJob: async (jobId) => {
      canceled.push(jobId)
      updateResult(jobId, { status: 'canceled' })
      return readResult(jobId)
    },
  }
  const c = await connect({ deps })
  try {
    const res = await c.call('delegate', delegateArgs)
    const cancel = await c.request('tasks/cancel', { taskId: res.result.taskId })
    assert.equal(cancel.result.resultType, 'complete')
    assert.deepEqual(canceled, [res.result.taskId])
    const view = await c.request('tasks/get', { taskId: res.result.taskId })
    assert.equal(view.result.status, 'cancelled')
    const unknown = await c.request('tasks/get', { taskId: 'nope' })
    assert.ok(unknown.error, 'an unknown task is an error')
  } finally {
    await c.close()
  }
})

test('tasks/get still answers from the job record when this process has no tracker', async () => {
  const job = fakeJob({ finish: quota('copilot quota/rate limit'), afterMs: 10 })
  const c = await connect()
  try {
    const failed = await pollTask(c, job.jobId, 'failed')
    assert.match(failed.error.message, /copilot quota\/rate limit/)
  } finally {
    await c.close()
  }
})

// ---- reroute after start ---------------------------------------------------

test('dispatch task: a quota failure mid-job continues on the next routed fallback and the notice lists both attempts', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota('Individual quota reached.'), 1: { status: 'succeeded' } } }) }
  const c = await connect({ deps })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    assert.equal(res.result.resultType, 'task')
    assert.equal(calls[0].waitMode, 'none', 'a task never makes dispatch wait for the job')
    const done = await pollTask(c, res.result.taskId, 'completed')
    const notice = JSON.parse(done.result.content[0].text)
    assert.equal(notice.status, 'succeeded')
    assert.equal(notice.reroutes, 1)
    assert.deepEqual(
      notice.attempts.map((a) => [a.agent, a.status, a.errorKind]),
      [
        ['agy', 'failed', 'quota'],
        ['copilot', 'succeeded', null],
      ]
    )
    assert.equal(notice.attempts[0].error, 'Individual quota reached.')
    assert.equal(calls.length, 2)
    // the second dispatch is pinned to the next routed candidate and keeps the lineage
    const second = calls[1]
    assert.deepEqual(await second.routeFn(), { primary: CHAIN[1], fallbacks: CHAIN.slice(2) })
    assert.equal(second.parentExecutionId, 'exec_t')
    assert.equal(second.rootExecutionId, 'exec_t')
    assert.notEqual(second.dispatchKey, calls[0].dispatchKey ?? 'k')
  } finally {
    await c.close()
  }
})

test('reroute is bounded: at most 3 reroutes, then the failure is reported with every attempt', async () => {
  const calls = []
  const everyQuota = Object.fromEntries(CHAIN.map((_, i) => [i, quota(`quota on candidate ${i}`)]))
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: everyQuota, afterMs: 20 }) }
  const c = await connect({ deps })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    const failed = await pollTask(c, res.result.taskId, 'failed')
    assert.equal(calls.length, 4, 'the first dispatch plus 3 reroutes; the fifth candidate is never started')
    assert.equal(failed.error.data.attempts.length, 4)
    assert.equal(failed.error.data.reroutes, 3)
    assert.match(failed.error.message, /quota on candidate 3/)
  } finally {
    await c.close()
  }
})

test('a non-quota failure is not rerouted and behaves as before', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: { status: 'failed', errorKind: 'crash', error: 'agy exited 1' } } }) }
  const c = await connect({ deps })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    const failed = await pollTask(c, res.result.taskId, 'failed')
    assert.equal(calls.length, 1)
    assert.equal(failed.error.data.errorKind, 'crash')
    assert.equal(failed.error.data.reroutes, undefined)
  } finally {
    await c.close()
  }
})

test('a write job rerouted after quota starts from the partial changes in the working tree and is told to review them', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-reroute-repo-'))
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'init')

  const calls = []
  const seenAtStart = []
  const base = fakeDispatchFactory({ chain: CHAIN, calls, cwd: repo, outcomes: { 0: quota(), 1: { status: 'succeeded' } } })
  const deps = {
    dispatch: async (args) => {
      seenAtStart.push(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'))
      const res = await base(args)
      // the first attempt edits the tree, then hits quota
      if (calls.length === 1) fs.writeFileSync(path.join(repo, 'a.txt'), 'half done by attempt 1\n')
      return res
    },
  }
  const c = await connect({ deps })
  try {
    const res = await c.call('dispatch', { task: 'finish the refactor', cwd: repo, mode: 'write' })
    await pollTask(c, res.result.taskId, 'completed')
    assert.equal(calls.length, 2)
    assert.equal(seenAtStart[1], 'half done by attempt 1\n', 'the tree was not reset between attempts')
    assert.match(calls[1].task, /^finish the refactor/)
    assert.match(calls[1].task, /git status/)
    assert.match(calls[1].task, /git diff/)
    assert.match(calls[1].task, /Individual quota reached/)
    assert.equal(calls[0].task, 'finish the refactor', 'the first attempt gets the task untouched')
  } finally {
    await c.close()
  }
})

test('a scoped writer that hit quota has its saved in-scope patch applied before the next attempt', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-reroute-scoped-'))
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'partial\n')
  const patchPath = path.join(repo, '..', `scope-${path.basename(repo)}.patch`)
  fs.writeFileSync(patchPath, git('diff'))
  git('checkout', '--', 'a.txt')

  const previous = { mode: 'write', cwd: repo, agent: 'agy', model: 'm', errorKind: 'quota', error: 'out of quota', status: 'failed', scratchWrite: { applied: false, unappliedPaths: ['a.txt'], patchPath } }
  const partial = await preservePartialWork(previous)
  assert.equal(partial.kind, 'patch-applied')
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'partial\n')
  const task = buildRerouteTask({ task: 'T', previous, partial })
  assert.match(task, /git status/)

  // a read job leaves nothing behind: the task is passed on untouched
  assert.equal(buildRerouteTask({ task: 'T', previous: { ...previous, mode: 'read' }, partial: await preservePartialWork({ ...previous, mode: 'read' }) }), 'T')
  assert.equal(isQuotaFailure({ status: 'failed', errorKind: 'quota' }), true)
  assert.equal(isQuotaFailure({ status: 'failed', errorKind: 'crash', error: 'quota in the message' }), false)
  assert.equal(isQuotaFailure({ status: 'failed', errorKind: 'unknown', error: 'copilot quota/rate limit' }), true)
})

test('reroute also runs for a plain dispatch call (no task), and the result of that call is unchanged', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } } }) }
  const c = await connect({ deps, era: '2025' })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    assert.equal(res.result.isError, undefined)
    assert.equal(JSON.parse(res.result.content[0].text).candidate.agent, 'agy')
    await until(() => calls.length === 2)
  } finally {
    await c.close()
  }
})

test('AGENT_HUB_REROUTE=off keeps a quota failure final', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota() } }) }
  const c = await connect({ deps, env: { AGENT_HUB_REROUTE: 'off' } })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    const failed = await pollTask(c, res.result.taskId, 'failed')
    assert.equal(calls.length, 1)
    assert.equal(failed.error.data.errorKind, 'quota')
  } finally {
    await c.close()
  }
})

// ---- legacy clients and everything that must not change ------------------

test('a legacy 2025-era client gets the exact historical result and the same tool list shape', async () => {
  const payload = { jobId: 'job-fixed-1', status: 'queued', errorKind: null }
  const deps = { delegateTool: () => payload }
  const c = await connect({ deps, era: '2025' })
  try {
    const res = await c.call('delegate', delegateArgs)
    assert.equal(res.result.content[0].text, JSON.stringify(payload, null, 2))
    assert.deepEqual(res.result.structuredContent, payload)
    assert.equal(res.result.isError, undefined)
    assert.equal(res.result.resultType, undefined)
    assert.equal(res.result.taskId, undefined)
    const list = await c.request('tools/list')
    assert.equal(list.result.tools.length, 34)
    assert.equal(list.result.tools.find((t) => t.name === 'delegate').execution, undefined)
  } finally {
    await c.close()
  }
})

test('a 2026 client without the tasks extension, and tools other than delegate/dispatch, get plain results', async () => {
  const payload = { jobId: 'job-fixed-2', status: 'queued', errorKind: null }
  const deps = { delegateTool: () => payload }
  const noExt = await connect({ deps, extensions: null })
  try {
    const res = await noExt.call('delegate', delegateArgs)
    assert.equal(res.result.resultType, 'complete')
    assert.equal(res.result.content[0].text, JSON.stringify(payload, null, 2))
  } finally {
    await noExt.close()
  }
  const withExt = await connect({ deps })
  try {
    const job = createJob({ agent: 'copilot', model: 'gpt-5.1', task: 't', cwd: '/tmp', title: 'x' })
    const res = await withExt.call('job_status', { jobId: job.jobId })
    assert.equal(res.result.resultType, 'complete')
    assert.equal(JSON.parse(res.result.content[0].text).jobId, job.jobId)
  } finally {
    await withExt.close()
  }
})

test('AGENT_HUB_MCP_TASKS=off: no extension advertised and a tasks client gets plain results', async () => {
  const payload = { jobId: 'job-fixed-3', status: 'queued', errorKind: null }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const env = { ...process.env, AGENT_HUB_MCP_TASKS: 'off' }
  serveStdio(() => buildServer({ env, deps: { delegateTool: () => payload } }), { transport: serverT })
  const got = []
  clientT.onmessage = (m) => got.push(m)
  await clientT.start()
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS]: {} } } }
  await clientT.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } })
  await clientT.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: delegateArgs, _meta: meta } })
  await until(() => got.length >= 2)
  const discover = got.find((m) => m.id === 1)
  assert.equal(discover.result.capabilities.extensions?.[TASKS], undefined)
  assert.equal(got.find((m) => m.id === 2).result.resultType, 'complete')
  await clientT.close()
})

// ---- channel (legacy connections, opt in) ---------------------------------

test('channel mode (opt in): a plain delegate call keeps its result and a terminal channel event reaches a legacy client', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ agent: 'agy', model: 'gemini-3.8-pro', finish: quota('Individual quota reached.') })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const c = await connect({ deps, env: { AGENT_HUB_CHANNEL: '1' }, era: '2025' })
  try {
    const res = await c.call('delegate', delegateArgs)
    const payload = JSON.parse(res.result.content[0].text)
    assert.equal(payload.status, 'running')
    const event = await until(() => c.notifications.find((n) => n.method === 'notifications/claude/channel' && n.params.meta?.job_id === payload.jobId))
    assert.equal(event.params.meta.status, 'failed')
    assert.equal(event.params.meta.error_kind, 'quota')
    assert.match(event.params.content, /Individual quota reached/)
    assert.match(event.params.content, /agy/)
  } finally {
    await c.close()
  }
})

test('without the channel opt in there is no channel event', async () => {
  const deps = {
    delegateTool: () => {
      const job = fakeJob({ finish: { status: 'succeeded' }, afterMs: 30 })
      return { jobId: job.jobId, status: 'running', errorKind: null }
    },
  }
  const c = await connect({ deps, era: '2025' })
  try {
    await c.call('delegate', delegateArgs)
    await sleep(150)
    assert.equal(c.notifications.filter((n) => n.method === 'notifications/claude/channel').length, 0)
  } finally {
    await c.close()
  }
})

// ---- dispatch hooks ---------------------------------------------------------

test('dispatch reports every start attempt through onAttempt and the unused fallbacks through onRoute, and without them keeps its result', async () => {
  const { dispatch } = await import('../src/dispatch.mjs')
  const startJobFn = async (args) => {
    if (args.agent === 'opencode') {
      return { job: { jobId: 'job-fast-fail', agent: args.agent, model: args.model, status: 'failed', errorKind: 'quota', error: 'Rate limit exceeded' }, done: Promise.resolve() }
    }
    return { job: { jobId: 'job-fallback', agent: args.agent, model: args.model, status: 'running', dispatchKey: args.dispatchKey }, done: Promise.resolve() }
  }
  const route = {
    routeFn: async () => ({
      primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' },
      fallbacks: [
        { agent: 'agy', model: 'gemini-3.8-flash-low' },
        { agent: 'copilot', model: 'gpt-5.1' },
      ],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn,
    harness: 'generic',
  }
  const attempts = []
  let routed = null
  const withHook = await dispatch({ task: 'attempts', taskType: 'triage', cwd: '/tmp/attempts-a', dispatchKey: 'attempts-a', onAttempt: (a) => attempts.push(a), onRoute: (r) => (routed = r), ...route })
  // the policy retries the failed candidate before it falls back, and every try is reported
  assert.ok(attempts.length >= 2)
  const last = attempts[attempts.length - 1]
  assert.deepEqual([last.agent, last.status, last.errorKind, last.jobId], ['agy', 'running', null, 'job-fallback'])
  for (const a of attempts.slice(0, -1)) {
    assert.deepEqual([a.agent, a.status, a.errorKind, a.jobId], ['opencode', 'failed', 'quota', 'job-fast-fail'])
  }
  assert.equal(attempts[0].error, 'Rate limit exceeded')
  assert.equal(routed.candidate.agent, 'agy')
  assert.deepEqual(routed.remaining.map((c) => c.agent), ['copilot'])

  const without = await dispatch({ task: 'attempts', taskType: 'triage', cwd: '/tmp/attempts-b', dispatchKey: 'attempts-b', ...route })
  assert.equal(without.job.jobId, withHook.job.jobId)
  assert.equal(without.candidate.agent, 'agy')
})

// ---- cancel during a reroute, reroute visible through the original job id -----

test('tasks/cancel while the next attempt is starting also cancels that successor job', async () => {
  const calls = []
  const canceled = []
  let restarting = false
  // first attempt fails on quota at once; its successor would run for 5s
  const base = fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } }, afterMs: 5000 })
  const deps = {
    dispatch: async (args) => {
      // the reroute's dispatch takes a while (lock retries, preflight): the cancel lands inside that window
      if (args.routeFn) {
        restarting = true
        await sleep(400)
      }
      const res = await base(args)
      if (!args.routeFn) updateResult(res.job.jobId, quota())
      return res
    },
    cancelJob: async (jobId) => {
      canceled.push(jobId)
      updateResult(jobId, { status: 'canceled' })
      return readResult(jobId)
    },
  }
  const c = await connect({ deps })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    await until(() => restarting)
    const cancel = await c.request('tasks/cancel', { taskId: res.result.taskId })
    assert.equal(cancel.result.resultType, 'complete')
    // the successor job exists only after the restart returns; it must still be cancelled
    await until(() => canceled.length === 2)
    const successor = readResult(canceled[1])
    assert.notEqual(canceled[1], res.result.taskId)
    assert.equal(successor.agent, 'copilot')
    assert.equal(successor.status, 'canceled')
    assert.equal((await c.request('tasks/get', { taskId: res.result.taskId })).result.status, 'cancelled')
    await sleep(100)
    assert.equal(calls.length, 2, 'no third attempt after the cancel')
  } finally {
    await c.close()
  }
})

test('a legacy client polling the original job id sees the reroute: running while the chain runs, then the last attempt, with reroutedTo', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } }, afterMs: 200 }) }
  const c = await connect({ deps, era: '2025' })
  try {
    const res = await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write' })
    const originalId = JSON.parse(res.result.content[0].text).job.jobId
    const status = async () => JSON.parse((await c.call('job_status', { jobId: originalId })).result.content[0].text)

    // the first attempt has failed on quota, the successor is running: never reads as failed
    const midChain = await until(async () => {
      const v = await status()
      return v.reroutedTo && v.status === 'running' ? v : null
    })
    assert.equal(midChain.rerouting, true)
    assert.equal(midChain.finalJobId, midChain.reroutedTo)
    assert.equal(midChain.errorKind, null)

    // job_wait on the original id returns when the whole chain ends
    const waited = JSON.parse((await c.call('job_wait', { jobId: originalId, timeoutS: 10 })).result.content[0].text)
    assert.equal(waited.done, true)
    assert.equal(waited.status, 'succeeded')
    assert.equal(waited.reroutedTo, midChain.reroutedTo)
    assert.equal(waited.rerouting, false)
    assert.equal(waited.jobId, originalId)

    // job_result answers with the last attempt's outcome
    const result = JSON.parse((await c.call('job_result', { jobId: originalId })).result.content[0].text)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.finalJobId, midChain.reroutedTo)

    // the successor's own view is a plain job (nothing rerouted from it)
    const own = JSON.parse((await c.call('job_status', { jobId: midChain.reroutedTo })).result.content[0].text)
    assert.equal('reroutedTo' in own, false)
  } finally {
    await c.close()
  }
})

test('a job that never rerouted has the exact historical job_status shape', async () => {
  const job = fakeJob({ finish: quota(), afterMs: 5 })
  await sleep(40)
  const c = await connect({ era: '2025' })
  try {
    const view = JSON.parse((await c.call('job_status', { jobId: job.jobId })).result.content[0].text)
    assert.equal(view.status, 'failed')
    assert.equal(view.errorKind, 'quota')
    for (const key of ['reroutedTo', 'finalJobId', 'rerouting']) assert.equal(key in view, false, key)
  } finally {
    await c.close()
  }
})

// ---- a reroute never contradicts what the caller already saw ------------------

const parseText = (res) => JSON.parse(res.result.content[0].text)

test('a dispatch that returned a terminal failure to the caller (waitMode attention/terminal) is never rerouted', async () => {
  for (const waitMode of ['attention', 'terminal']) {
    const calls = []
    const base = fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } }, afterMs: 5000 })
    // dispatch waited for the job: the caller gets the terminal quota failure in the payload
    const deps = {
      dispatch: async (args) => {
        const res = await base(args)
        if (args.routeFn) return res
        updateResult(res.job.jobId, quota())
        const record = readResult(res.job.jobId)
        return { ...res, job: record, wait: { done: true, aborted: false, timedOut: false, waiting: false, status: 'failed', record } }
      },
    }
    const c = await connect({ deps, era: '2025' })
    try {
      const payload = parseText(await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write', waitMode }))
      assert.equal(payload.wait.status, 'failed')
      await sleep(300)
      assert.equal(calls.length, 1, `${waitMode}: no second dispatch after the caller saw the failure`)
      const view = parseText(await c.call('job_status', { jobId: payload.job.jobId }))
      assert.equal(view.status, 'failed')
      assert.equal(view.errorKind, 'quota')
      assert.equal('reroutedTo' in view, false)
    } finally {
      await c.close()
    }
  }
})

test('a non-terminal dispatch (waitMode none) that hits a quota failure still reroutes exactly once', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } }, afterMs: 40 }) }
  const c = await connect({ deps, era: '2025' })
  try {
    const payload = parseText(await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write', waitMode: 'none' }))
    const waited = parseText(await c.call('job_wait', { jobId: payload.job.jobId, timeoutS: 10 }))
    assert.equal(waited.status, 'succeeded')
    await sleep(150)
    assert.equal(calls.length, 2)
  } finally {
    await c.close()
  }
})

test('job_wait never returns a quota failure that the hub is about to reroute, even when the supervisor polls slower', async () => {
  const calls = []
  const deps = { dispatch: fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } }, afterMs: 40 }) }
  // the supervisor reads the record every 1s, job_wait every 300ms: job_wait sees the failure first
  const c = await connect({ deps, era: '2025', taskPollMs: 1000 })
  try {
    const payload = parseText(await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write', waitMode: 'none' }))
    const waited = parseText(await c.call('job_wait', { jobId: payload.job.jobId, timeoutS: 15 }))
    assert.equal(waited.done, true)
    assert.equal(waited.status, 'succeeded', 'the caller only sees the outcome of the whole chain')
    assert.ok(waited.reroutedTo)
    assert.equal(calls.length, 2)
  } finally {
    await c.close()
  }
})

test('job_cancel on the original id while a reroute is pending stops the successor', async () => {
  const calls = []
  let restarting = false
  const base = fakeDispatchFactory({ chain: CHAIN, calls, outcomes: { 0: quota(), 1: { status: 'succeeded' } }, afterMs: 5000 })
  const deps = {
    dispatch: async (args) => {
      if (args.routeFn) {
        restarting = true
        await sleep(400)
      }
      const res = await base(args)
      if (!args.routeFn) updateResult(res.job.jobId, quota())
      return res
    },
    cancelJob: async (jobId) => {
      updateResult(jobId, { status: 'canceled' })
      return readResult(jobId)
    },
  }
  const c = await connect({ deps, era: '2025' })
  try {
    const payload = parseText(await c.call('dispatch', { task: 'build it', cwd: '/tmp', mode: 'write', waitMode: 'none' }))
    const originalId = payload.job.jobId
    await until(() => restarting)
    const cancelled = parseText(await c.call('job_cancel', { jobId: originalId }))
    assert.equal(cancelled.rerouteCancelled, true)
    assert.notEqual(cancelled.status, 'running', 'job_cancel does not report a cancelled reroute as still going')
    // the successor that was starting when the cancel landed never keeps running
    const original = await until(() => {
      const r = readResult(originalId)
      return r.reroutePending ? null : r
    })
    // the restart was already in flight: its successor exists and is cancelled at once
    assert.ok(original.reroutedTo)
    await until(() => readResult(original.reroutedTo).status === 'canceled')
    await sleep(150)
    assert.equal(calls.length, 2, 'no further attempt after the cancel')
    const view = parseText(await c.call('job_status', { jobId: originalId }))
    assert.notEqual(view.status, 'running')
    assert.notEqual(view.status, 'succeeded')
  } finally {
    await c.close()
  }
})

test('a stale reroutePending flag (the server died mid-reroute) stops reading as running', async () => {
  const job = createJob({ agent: 'agy', model: 'gemini-3.8-pro', task: 't', cwd: '/tmp', title: 'stale' })
  updateResult(job.jobId, { ...quota(), reroutePending: true, reroutePendingAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
  const fresh = createJob({ agent: 'agy', model: 'gemini-3.8-pro', task: 't', cwd: '/tmp', title: 'fresh' })
  updateResult(fresh.jobId, { ...quota(), reroutePending: true, reroutePendingAt: new Date().toISOString() })
  const c = await connect({ era: '2025' })
  try {
    const stale = parseText(await c.call('job_status', { jobId: job.jobId }))
    assert.equal(stale.status, 'failed')
    assert.equal(stale.errorKind, 'quota')
    const waited = parseText(await c.call('job_wait', { jobId: job.jobId, timeoutS: 1 }))
    assert.equal(waited.done, true)
    assert.equal(waited.status, 'failed')
    // a pending flag that is still fresh keeps reading as running
    assert.equal(parseText(await c.call('job_status', { jobId: fresh.jobId })).status, 'running')
  } finally {
    await c.close()
  }
})

test('the supervisor drops finished trackers after their retention', async () => {
  const supervisor = new JobSupervisor({ cancelJobFn: async () => {}, pollMs: 10, retainMs: 0 })
  const job = fakeJob({ finish: { status: 'succeeded' }, afterMs: 20 })
  const tracker = supervisor.start({ tool: 'delegate', jobId: job.jobId })
  assert.equal(supervisor.get(job.jobId), tracker, 'a working tracker is kept')
  await tracker.done
  assert.equal(tracker.status, 'completed')
  assert.equal(supervisor.get(job.jobId), null)
  assert.equal(supervisor.trackers.size, 0)
})

// ---- the SDK hook the task support depends on --------------------------------

test('the SDK still exposes the request-handler hook that task support wraps (fails loudly if a bump removes it)', () => {
  const mcp = new McpServer({ name: 'probe', version: '1' }, { capabilities: { extensions: { [TASKS]: {} } } })
  mcp.registerTool('noop', { description: 'x' }, async () => ({ content: [] }))
  assert.equal(typeof mcp.server._getRequestHandler, 'function', 'Server._getRequestHandler is gone: the tasks wrapper cannot be installed')
  assert.equal(typeof mcp.server._getRequestHandler('tools/call'), 'function')
  const supervisor = new JobSupervisor({ cancelJobFn: async () => {} })
  assert.equal(installTaskSupport(mcp, { tools: new Map(), supervisor, readResultFn: readResult }), true)
  // and the real server wires it: a 2026 client with the extension gets a task, so it returned true there too
})

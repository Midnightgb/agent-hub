import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractLastJsonLine } from '../src/adapters/base.mjs'

// opencode-model-policy T3 (S3): an opencode model the policy does not allow
// is rejected before launch, whatever path asked for it.

const FREE = [{ input: 0, output: 0 }]
const PAID = [{ input: 1, output: 2 }]
const CATALOG = {
  opencode: {
    checkedAt: new Date().toISOString(),
    error: null,
    models: [
      { id: 'opencode/glm-5.3-flash-free', cost: FREE },
      { id: 'opencode-go/kimi-k3', cost: PAID },
    ],
  },
}

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-policy-enforce-'))
  fs.writeFileSync(path.join(home, 'discovery.json'), JSON.stringify(CATALOG))
  return home
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  return {
    ...(await import('../src/jobrunner.mjs?t=' + tag)),
    ...(await import('../src/model-policy.mjs?t=' + tag)),
    jobstore: await import('../src/jobstore.mjs?t=' + tag),
    tools: await import('../src/tools/jobs.mjs?t=' + tag),
    router: await import('../src/router.mjs?t=' + tag),
  }
}

function fakeAdapter() {
  return {
    id: 'fake',
    cmd: process.execPath,
    readPolicy: 'enforced',
    buildArgv: () => ['-e', 'console.log(JSON.stringify({status:"SUCCESS",response:"PONG"}))'],
    parseResult: (stdout) => ({ ok: true, text: extractLastJsonLine(stdout)?.response ?? '', tokens: null, sessionId: null }),
    classifyError: (stdout) => (extractLastJsonLine(stdout) ? null : { kind: 'crash', message: 'no JSON' }),
    listModels: () => [],
  }
}

const start = (startJob, { agent = 'opencode', model, env }) =>
  startJob({ agent, model, task: 't', cwd: os.tmpdir(), mode: 'read', adapterFor: () => fakeAdapter(), env })

function runDirs(home) {
  try {
    return fs.readdirSync(path.join(home, 'runs'))
  } catch {
    return []
  }
}

test('S3: startJob rejects a blocked opencode model before any job record exists', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob } = await fresh(home)
  assert.throws(
    () => start(startJob, { model: 'opencode-go/kimi-k3', env }),
    (error) => {
      assert.equal(error.code, 'model_blocked')
      assert.match(error.message, /opencode model "opencode-go\/kimi-k3" is blocked by the model policy/)
      assert.match(error.message, /dashboard/)
      return true
    }
  )
  assert.deepEqual(runDirs(home), [])
})

test('S3: a model the user blocked in the dashboard is rejected even when it is free', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob, setModelDecision } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode/glm-5.3-flash-free', allowed: false, env })
  assert.throws(() => start(startJob, { model: 'opencode/glm-5.3-flash-free', env }), { code: 'model_blocked' })
})

test('S3: an allowed opencode model starts and succeeds (previous behavior)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob, setModelDecision, jobstore } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true, env })
  const { job, done } = start(startJob, { model: 'opencode-go/kimi-k3', env })
  await done
  assert.equal(jobstore.readResult(job.jobId, env).status, 'succeeded')
})

test('A3: agents other than opencode are not checked against the policy', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob, jobstore } = await fresh(home)
  const { job, done } = start(startJob, { agent: 'copilot', model: 'some-unlisted-model', env })
  await done
  assert.equal(jobstore.readResult(job.jobId, env).status, 'succeeded')
})

test('merge-open-prs S2: gentle-shell on a disallowed opencode-go model is rejected before launch', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob, tools } = await fresh(home)
  for (const model of ['opencode-go/kimi-k3', 'opencode-go/x']) {
    assert.throws(
      () => start(startJob, { agent: 'gentle-shell', model, env }),
      (error) => {
        assert.equal(error.code, 'model_blocked')
        assert.match(error.message, new RegExp(`gentle-shell model "${model.replace('/', '\\/')}" is blocked by the model policy`))
        assert.match(error.message, /dashboard \(Agents → opencode\)/)
        return true
      }
    )
  }
  assert.throws(
    () => tools.delegateTool({ agent: 'gentle-shell', model: 'opencode-go/kimi-k3', task: 't', cwd: os.tmpdir(), env }),
    { code: 'model_blocked' }
  )
  assert.deepEqual(runDirs(home), [])
})

test('merge-open-prs S2: gentle-shell follows the opencode decision for an opencode-go model', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob, setModelDecision, jobstore } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true, env })
  const { job, done } = start(startJob, { agent: 'gentle-shell', model: 'opencode-go/kimi-k3', env })
  await done
  assert.equal(jobstore.readResult(job.jobId, env).status, 'succeeded')
})

test('merge-open-prs S2: gentle-shell on a non-opencode-go model is not checked against the policy', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { startJob, jobstore } = await fresh(home)
  const { job, done } = start(startJob, { agent: 'gentle-shell', model: 'anthropic/claude-sonnet-5-5', env })
  await done
  assert.equal(jobstore.readResult(job.jobId, env).status, 'succeeded')
})

test('S3: delegate surfaces the block as an error naming the model', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { tools } = await fresh(home)
  assert.throws(
    () => tools.delegateTool({ agent: 'opencode', model: 'opencode-go/kimi-k3', task: 't', cwd: os.tmpdir(), env }),
    /opencode model "opencode-go\/kimi-k3" is blocked/
  )
})

test('S3: route skips a concrete opencode step the policy blocks (e.g. added by an accepted proposal)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { expandChain } = await fresh(home)
  const { chain, emptyPools } = expandChain(
    [
      { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
      { agent: 'opencode', model: 'opencode-go/kimi-k3', mode: 'read' },
      { agent: 'opencode', model: 'opencode/glm-5.3-flash-free', mode: 'read' },
    ],
    { env }
  )
  assert.deepEqual(chain.map((c) => c.model), ['gemini-3.8-flash-low', 'opencode/glm-5.3-flash-free'])
  assert.deepEqual(emptyPools, [{ agent: 'opencode', model: 'opencode-go/kimi-k3', reason: 'model_blocked' }])
})

test('S3: a model#variant id is judged by its base model', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { modelDecision, setModelDecision } = await fresh(home)
  assert.equal(modelDecision({ agent: 'opencode', model: 'opencode/glm-5.3-flash-free#high', env }).allowed, true)
  assert.equal(modelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3#max', env }).allowed, false)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true, env })
  assert.equal(modelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3#max', env }).allowed, true)
})

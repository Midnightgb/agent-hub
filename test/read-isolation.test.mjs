import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { extractLastJsonLine } from '../src/adapters/base.mjs'
import { ADAPTERS } from '../src/adapters/index.mjs'

// same-tree-fanout T1 (S1, S2): read jobs fan out in the caller's own checkout.
// An adapter whose CLI enforces read-only gets a warn-level guard; an adapter
// that cannot be trusted (agy) runs in a hub-managed scratch copy.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-readiso-'))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-readiso-repo-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 'test@test.local'], repo)
  git(['config', 'user.name', 'Test'], repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'committed')
  fs.mkdirSync(path.join(repo, 'sub'))
  fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'b')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  return repo
}

/** A fake adapter running `node -e <script>` with an optional declared read policy. */
function fakeAdapter(script, readPolicy) {
  return {
    id: 'fake',
    cmd: process.execPath,
    ...(readPolicy ? { readPolicy } : {}),
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => {
      const json = extractLastJsonLine(stdout)
      return { ok: true, text: json?.response ?? '', tokens: null, sessionId: null }
    },
    classifyError: (stdout, exitInfo = {}) => {
      if (exitInfo.timedOut) return { kind: 'timeout', message: 'timeout' }
      const json = extractLastJsonLine(stdout)
      if (!json) return { kind: 'crash', message: 'no JSON' }
      return null
    },
    listModels: () => [],
  }
}

const respond = (expr) => `console.log(JSON.stringify({status:"SUCCESS",response:String(${expr})}))`

async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  return { ...jobrunner, jobstore }
}

function run(startJob, { adapter, cwd, env, isolation }) {
  return startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd,
    mode: 'read',
    adapterFor: () => adapter,
    ...(env ? { env } : {}),
    ...(isolation ? { isolation } : {}),
  })
}

test('the shipped adapters declare their read policy: agy runs in a scratch copy, copilot/codex/opencode enforce read-only', () => {
  assert.equal(ADAPTERS.agy.readPolicy, 'scratch')
  assert.equal(ADAPTERS.copilot.readPolicy, 'enforced')
  assert.equal(ADAPTERS.codex.readPolicy, 'enforced')
  assert.equal(ADAPTERS.opencode.readPolicy, 'enforced')
})

test('S1: an enforced-read adapter whose tree changes during the run succeeds with a warn-level read guard', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'changed.txt'))}, 'y'); ${respond('"PONG"')}`
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'enforced'), cwd: repo })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.errorKind ?? null, null)
  assert.equal(result.readGuard.level, 'warn')
  assert.deepEqual(result.readGuard.changedPaths, ['changed.txt'])
  assert.ok(result.warnings.some((w) => /read guard \(warn\): 1 path\(s\) changed/.test(w) && w.includes('changed.txt')))
  assert.equal(result.isolation.mode, 'in-place')
  assert.equal(result.isolation.guard, 'warn')
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'PONG')
})

test('S1: AGENT_HUB_READGUARD=strict restores the failing read_mode_violation for an enforced-read adapter', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'changed.txt'))}, 'y'); ${respond('"PONG"')}`
  const env = { ...process.env, AGENT_HUB_READGUARD: 'strict' }
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'enforced'), cwd: repo, env })
  await done

  const result = jobstore.readResult(job.jobId, env)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'read_mode_violation')
  assert.equal(result.isolation.guard, 'strict')
})

test('S1: an adapter that declares no read policy keeps the strict guard (previous behavior)', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'changed.txt'))}, 'y'); ${respond('"PONG"')}`
  const { job, done } = run(startJob, { adapter: fakeAdapter(script), cwd: repo })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'read_mode_violation')
  assert.equal(result.isolation.mode, 'in-place')
  assert.equal(result.isolation.guard, 'strict')
})

test('S2: a scratch-policy read job sees uncommitted and untracked files, and its writes never reach the caller tree', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty')
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked')
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'secret')
  const statusBefore = git(['status', '--porcelain'], repo)
  const { startJob, jobstore } = await freshModules(home)
  const script = [
    "const fs = require('fs')",
    "const seen = [fs.readFileSync('a.txt','utf8'), fs.readFileSync('new.txt','utf8'), fs.existsSync('ignored.txt')].join('|')",
    "fs.writeFileSync('agy-wrote.txt', 'z')",
    "fs.writeFileSync('a.txt', 'clobbered')",
    respond('seen + "|" + process.cwd()'),
  ].join('; ')
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'scratch'), cwd: repo })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  const [a, n, ignored, childCwd] = fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8').split('|')
  assert.equal(a, 'dirty', 'the copy carries uncommitted tracked changes')
  assert.equal(n, 'untracked', 'the copy carries untracked, non-ignored files')
  assert.equal(ignored, 'false', 'ignored files are not copied')
  // The copy is already gone here, so compare paths as strings.
  assert.notEqual(childCwd, repo)
  assert.ok(childCwd.startsWith(path.join(home, 'scratch') + path.sep), childCwd)

  assert.equal(fs.existsSync(path.join(repo, 'agy-wrote.txt')), false)
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'dirty')
  assert.equal(git(['status', '--porcelain'], repo), statusBefore)

  assert.equal(result.isolation.mode, 'scratch')
  assert.deepEqual(result.isolation.discardedPaths, ['a.txt', 'agy-wrote.txt'])
  assert.equal(fs.existsSync(result.isolation.dir), false, 'the scratch copy is removed when the job ends')
  assert.equal(git(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm).length, 1, 'the scratch worktree is pruned')
})

test('S2: a scratch job started from a subdirectory runs in the same subdirectory of the copy', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = respond("require('fs').readFileSync('b.txt','utf8') + '|' + require('path').basename(process.cwd())")
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'scratch'), cwd: path.join(repo, 'sub') })
  await done

  assert.equal(jobstore.readResult(job.jobId).status, 'succeeded')
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'b|sub')
})

test('S2: concurrent scratch jobs on one repo each get their own copy and all copies are removed', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync('mine.txt', String(process.pid)); ${respond('process.cwd()')}`
  const runs = [1, 2, 3].map(() => run(startJob, { adapter: fakeAdapter(script, 'scratch'), cwd: repo }))
  await Promise.all(runs.map((r) => r.done))

  const results = runs.map((r) => jobstore.readResult(r.job.jobId))
  assert.deepEqual(results.map((r) => r.status), ['succeeded', 'succeeded', 'succeeded'])
  assert.equal(new Set(results.map((r) => r.isolation.dir)).size, 3)
  for (const r of results) assert.equal(fs.existsSync(r.isolation.dir), false)
  assert.equal(fs.existsSync(path.join(repo, 'mine.txt')), false)
  assert.equal(git(['worktree', 'list', '--porcelain'], repo).match(/^worktree /gm).length, 1)
})

test('S2: a change to the caller tree during a scratch job is a warning, not a failure', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'by-someone-else.txt'))}, 'y'); ${respond('"ok"')}`
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'scratch'), cwd: repo })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.readGuard.level, 'warn')
  assert.deepEqual(result.readGuard.changedPaths, ['by-someone-else.txt'])
})

test('S2: when no scratch copy can be made (not a git repo) the job runs in place with the strict guard and a warning', async () => {
  const home = tmpHome()
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-readiso-plain-'))
  const { startJob, jobstore } = await freshModules(home)
  const { job, done } = run(startJob, { adapter: fakeAdapter(respond('process.cwd()'), 'scratch'), cwd: notRepo })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(fs.realpathSync(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8')), fs.realpathSync(notRepo))
  assert.equal(result.isolation.mode, 'in-place')
  assert.equal(result.isolation.guard, 'strict')
  assert.match(result.isolation.fallbackReason, /not a git work tree/)
  assert.ok(result.warnings.some((w) => /scratch copy unavailable/.test(w)))
})

test('S2: isolation:"in-place" runs a scratch-policy adapter in the caller tree with the strict guard', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync('changed.txt', 'y'); ${respond('"PONG"')}`
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'scratch'), cwd: repo, isolation: 'in-place' })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'read_mode_violation')
  assert.equal(result.isolation.mode, 'in-place')
})

test('S2: isolation:"scratch" isolates an enforced-read adapter too', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = `require('fs').writeFileSync('changed.txt', 'y'); ${respond('"PONG"')}`
  const { job, done } = run(startJob, { adapter: fakeAdapter(script, 'enforced'), cwd: repo, isolation: 'scratch' })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.isolation.mode, 'scratch')
  assert.equal(fs.existsSync(path.join(repo, 'changed.txt')), false)
})

test('an invalid isolation value is rejected before any job record exists', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob } = await freshModules(home)
  assert.throws(() => run(startJob, { adapter: fakeAdapter(respond('1'), 'enforced'), cwd: repo, isolation: 'sideways' }), /isolation must be one of auto, in-place, scratch/)
})

test('write mode is unchanged: isolation is not applied and the primary checkout is still refused', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: repo, mode: 'write', adapterFor: () => fakeAdapter(respond('1'), 'scratch') })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'worktree_denied')
  assert.equal(result.isolation ?? null, null)
})

test('delegate forwards isolation to startJob, and job_status/job_result expose isolation, readGuard and warnings', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const tools = await import('../src/tools/jobs.mjs?t=' + Date.now())
  let forwarded = null
  const script = `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'changed.txt'))}, 'y'); ${respond('"PONG"')}`
  let done
  const res = tools.delegateTool({
    agent: 'agy',
    model: 'x',
    task: 't',
    cwd: repo,
    isolation: 'in-place',
    startJobFn: (args) => {
      forwarded = args.isolation
      const started = startJob({ ...args, agent: 'fake', adapterFor: () => fakeAdapter(script, 'enforced') })
      done = started.done
      return started
    },
  })
  await done
  assert.equal(forwarded, 'in-place')

  const status = tools.jobStatusTool({ jobId: res.jobId })
  assert.equal(status.status, 'succeeded')
  assert.equal(status.isolation.mode, 'in-place')
  assert.equal(status.readGuard.level, 'warn')
  assert.ok(status.warnings.some((w) => w.includes('changed.txt')))
  const result = tools.jobResultTool({ jobId: res.jobId })
  assert.equal(result.readGuard.level, 'warn')
  assert.equal(result.isolation.guard, 'warn')
  assert.equal(jobstore.readResult(res.jobId).status, 'succeeded')
})

test('job_status keeps its previous shape for a job without isolation data (write job)', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob } = await freshModules(home)
  const tools = await import('../src/tools/jobs.mjs?t=' + Date.now())
  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd: repo, mode: 'write', adapterFor: () => fakeAdapter(respond('1')) })
  await done
  const status = tools.jobStatusTool({ jobId: job.jobId })
  assert.deepEqual(Object.keys(status).sort(), ['agent', 'createdAt', 'cwd', 'error', 'errorKind', 'jobId', 'mode', 'model', 'status', 'title', 'updatedAt', 'verification'])
})

test('S2: creating a scratch copy sweeps leftover copies older than a day, keeping recent ones', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { createScratchCopy, removeScratchCopy } = await import('../src/scratchcopy.mjs?t=' + Date.now())
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const scratchRoot = path.join(home, 'scratch')
  fs.mkdirSync(path.join(scratchRoot, 'stale'), { recursive: true })
  fs.mkdirSync(path.join(scratchRoot, 'recent'), { recursive: true })
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  fs.utimesSync(path.join(scratchRoot, 'stale'), twoDaysAgo, twoDaysAgo)

  const copy = createScratchCopy({ cwd: repo, id: 'fresh', env })
  assert.equal(copy.ok, true)
  assert.equal(fs.existsSync(path.join(scratchRoot, 'stale')), false)
  assert.equal(fs.existsSync(path.join(scratchRoot, 'recent')), true)
  removeScratchCopy({ root: copy.root, dir: copy.dir })
  assert.equal(fs.existsSync(copy.dir), false)
})

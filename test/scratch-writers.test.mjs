import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { extractLastJsonLine } from '../src/adapters/base.mjs'

// scratch-writers T1 (S1-S4): a write job with a writeScope runs in a
// hub-managed scratch copy of the caller's repo; on success the hub applies
// only the in-scope part of the agent's diff to the caller's working tree.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-scratchw-'))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-scratchw-repo-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 'test@test.local'], repo)
  git(['config', 'user.name', 'Test'], repo)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.mkdirSync(path.join(repo, 'docs'))
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a1\na2\na3\n')
  fs.writeFileSync(path.join(repo, 'src', 'b.txt'), 'b\n')
  fs.writeFileSync(path.join(repo, 'docs', 'd.txt'), 'd\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  return repo
}

/** A fake adapter running `node -e <script>` in the job's spawn cwd. */
function fakeAdapter(script) {
  return {
    id: 'fake',
    cmd: process.execPath,
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => {
      const json = extractLastJsonLine(stdout)
      return { ok: true, text: json?.response ?? '', tokens: null, sessionId: 'sess-1' }
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
const writeFiles = (files) =>
  Object.entries(files)
    .map(([rel, content]) => `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(rel)}), {recursive:true}); require('fs').writeFileSync(${JSON.stringify(rel)}, ${JSON.stringify(content)})`)
    .join('; ')

async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  const tools = await import('../src/tools/jobs.mjs?t=' + tag)
  return { ...jobrunner, jobstore, tools }
}

function runWriter(startJob, { script, cwd, writeScope, env, ...rest }) {
  return startJob({
    agent: 'fake',
    model: 'x',
    task: 't',
    cwd,
    mode: 'write',
    adapterFor: () => fakeAdapter(script),
    ...(writeScope !== undefined ? { writeScope } : {}),
    ...(env ? { env } : {}),
    ...rest,
  })
}

function scratchEntries(home) {
  try {
    return fs.readdirSync(path.join(home, 'scratch'))
  } catch {
    return []
  }
}

function writeLockFiles(home) {
  try {
    return fs.readdirSync(path.join(home, 'runs', '.locks'))
  } catch {
    return []
  }
}

test('S1+S2: a scratch writer in the primary checkout applies only its in-scope paths to the caller working tree', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const headBefore = git(['rev-parse', 'HEAD'], repo).trim()
  const { startJob, jobstore } = await freshModules(home)
  const script = [
    writeFiles({ 'src/a.txt': 'a1\na2 changed\na3\n', 'src/new.txt': 'new\n', 'docs/d.txt': 'docs changed\n', 'top.txt': 'top\n' }),
    respond('process.cwd()'),
  ].join('; ')
  const { job, done } = runWriter(startJob, { script, cwd: repo, writeScope: ['src/**'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  assert.equal(result.errorKind ?? null, null)
  assert.deepEqual(result.writeScope, ['src/**'])
  assert.deepEqual(result.scratchWrite.appliedPaths, ['src/a.txt', 'src/new.txt'])
  assert.deepEqual(result.scratchWrite.discardedPaths, ['docs/d.txt', 'top.txt'])
  assert.match(result.scratchWrite.base, /^[0-9a-f]{40}$/)
  assert.equal(result.noChanges ?? false, false)

  // The agent ran inside the scratch copy, not in the caller's tree.
  const childCwd = fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8')
  assert.ok(childCwd.startsWith(path.join(home, 'scratch') + path.sep), childCwd)

  // Caller working tree: in-scope applied, out-of-scope untouched.
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8'), 'a1\na2 changed\na3\n')
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'new.txt'), 'utf8'), 'new\n')
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'd.txt'), 'utf8'), 'd\n')
  assert.equal(fs.existsSync(path.join(repo, 'top.txt')), false)

  // Working tree only: index, HEAD and refs are untouched.
  assert.equal(git(['diff', '--cached', '--name-only'], repo), '')
  assert.equal(git(['status', '--porcelain'], repo), ' M src/a.txt\n?? src/new.txt\n')
  assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), headBefore)
  assert.equal(git(['rev-list', '--all', '--count'], repo).trim(), '1')

  // The in-scope patch is saved under runs/<jobId>/scope.patch.
  assert.equal(result.scratchWrite.patchPath, path.join(home, 'runs', job.jobId, 'scope.patch'))
  const patch = fs.readFileSync(result.scratchWrite.patchPath, 'utf8')
  assert.match(patch, /src\/a\.txt/)
  assert.match(patch, /src\/new\.txt/)
  assert.doesNotMatch(patch, /docs\/d\.txt|top\.txt/)

  // Diff stats report only the applied paths.
  assert.equal(result.diffStats.filesChanged, 2)
  assert.deepEqual(result.diffStats.files.map((f) => f.path), ['src/a.txt', 'src/new.txt'])
  assert.equal(result.diffStats.additions, 2)
  assert.equal(result.diffStats.deletions, 1)
  assert.equal(result.diffStats.error, null)

  // No per-cwd write lock was taken, and the copy is gone.
  assert.deepEqual(writeLockFiles(home).filter((f) => !f.startsWith('apply-')), [])
  assert.deepEqual(scratchEntries(home), [])
})

test('S1: a scratch writer started from a subdirectory runs in the same subdirectory of the copy', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = [writeFiles({ 'b.txt': 'b from sub\n' }), respond("require('path').basename(process.cwd())")].join('; ')
  const { job, done } = runWriter(startJob, { script, cwd: path.join(repo, 'src'), writeScope: ['src/**'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  assert.equal(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8'), 'src')
  assert.deepEqual(result.scratchWrite.appliedPaths, ['src/b.txt'])
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'b.txt'), 'utf8'), 'b from sub\n')
})

test('S2: commits the agent makes inside the copy are part of its diff, and never reach the caller refs', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = [
    writeFiles({ 'src/c.txt': 'committed by agent\n' }),
    "require('child_process').execFileSync('git', ['add', '-A'])",
    "require('child_process').execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'agent commit'])",
    writeFiles({ 'src/d.txt': 'uncommitted by agent\n' }),
    respond('"ok"'),
  ].join('; ')
  const { job, done } = runWriter(startJob, { script, cwd: repo, writeScope: ['src'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  assert.deepEqual(result.scratchWrite.appliedPaths, ['src/c.txt', 'src/d.txt'])
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'c.txt'), 'utf8'), 'committed by agent\n')
  assert.equal(git(['rev-list', '--all', '--count'], repo).trim(), '1', 'the agent commit stays in the copy')
  assert.equal(git(['log', '--all', '--format=%s'], repo).trim(), 'init')
})

test('S3: caller edits to other files during the run are kept and the writer still applies', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  // Pre-existing uncommitted caller change in scope: replayed into the copy and kept.
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'a1 caller\na2\na3\n')
  const { startJob, jobstore } = await freshModules(home)
  const script = [
    // The "caller" edits another file of its own tree while the agent runs.
    `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'docs', 'd.txt'))}, 'caller during run\\n')`,
    writeFiles({ 'src/a.txt': 'a1 caller\na2\na3 agent\n' }),
    respond('"ok"'),
  ].join('; ')
  const { job, done } = runWriter(startJob, { script, cwd: repo, writeScope: ['src/**'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  assert.deepEqual(result.scratchWrite.appliedPaths, ['src/a.txt'])
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8'), 'a1 caller\na2\na3 agent\n')
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'd.txt'), 'utf8'), 'caller during run\n')
})

test('S3: two concurrent scratch writers with disjoint scopes both apply', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const one = runWriter(startJob, { script: [writeFiles({ 'src/one.txt': '1\n', 'docs/x.txt': 'x\n' }), respond('1')].join('; '), cwd: repo, writeScope: ['src/one.txt'] })
  const two = runWriter(startJob, { script: [writeFiles({ 'docs/two.txt': '2\n', 'src/y.txt': 'y\n' }), respond('2')].join('; '), cwd: repo, writeScope: ['docs/two.txt'] })
  await Promise.all([one.done, two.done])

  const r1 = jobstore.readResult(one.job.jobId)
  const r2 = jobstore.readResult(two.job.jobId)
  assert.equal(r1.status, 'succeeded', r1.error)
  assert.equal(r2.status, 'succeeded', r2.error)
  assert.deepEqual(r1.scratchWrite.appliedPaths, ['src/one.txt'])
  assert.deepEqual(r2.scratchWrite.appliedPaths, ['docs/two.txt'])
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'one.txt'), 'utf8'), '1\n')
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'two.txt'), 'utf8'), '2\n')
  assert.equal(fs.existsSync(path.join(repo, 'docs', 'x.txt')), false)
  assert.equal(fs.existsSync(path.join(repo, 'src', 'y.txt')), false)
  assert.deepEqual(scratchEntries(home), [])
})

test('S4: an overlapping caller edit ends the job in apply_conflict, applies nothing and keeps the patch', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = [
    `require('fs').writeFileSync(${JSON.stringify(path.join(repo, 'src', 'a.txt'))}, 'caller rewrote\\n')`,
    writeFiles({ 'src/a.txt': 'a1\na2 agent\na3\n', 'src/z.txt': 'agent new\n' }),
    respond('"ok"'),
  ].join('; ')
  const { job, done } = runWriter(startJob, { script, cwd: repo, writeScope: ['src/**'], verify: [{ name: 'noop', argv: [process.execPath, '-e', '0'] }] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'apply_conflict')
  assert.match(result.error, /src\/a\.txt/)
  assert.deepEqual(result.scratchWrite.conflictPaths, ['src/a.txt'])
  assert.deepEqual(result.scratchWrite.appliedPaths, [])
  assert.equal(result.verification.skipped, true)

  // All or nothing: neither the conflicting file nor the clean one was applied.
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.txt'), 'utf8'), 'caller rewrote\n')
  assert.equal(fs.existsSync(path.join(repo, 'src', 'z.txt')), false)
  assert.equal(git(['status', '--porcelain'], repo), ' M src/a.txt\n')

  assert.equal(result.scratchWrite.patchPath, path.join(home, 'runs', job.jobId, 'scope.patch'))
  const patch = fs.readFileSync(result.scratchWrite.patchPath, 'utf8')
  assert.match(patch, /src\/a\.txt/)
  assert.match(patch, /src\/z\.txt/)
  assert.equal('diffStats' in result, false, 'nothing was applied, so there are no diff stats')
  assert.deepEqual(scratchEntries(home), [])
})

test('S2: a writer that changes nothing in scope succeeds with noChanges and no patch', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const script = [writeFiles({ 'docs/out.txt': 'out\n' }), respond('"ok"')].join('; ')
  const { job, done } = runWriter(startJob, { script, cwd: repo, writeScope: ['src/**'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  assert.equal(result.noChanges, true)
  assert.deepEqual(result.scratchWrite.appliedPaths, [])
  assert.deepEqual(result.scratchWrite.discardedPaths, ['docs/out.txt'])
  assert.equal(result.scratchWrite.patchPath, null)
  assert.equal(fs.existsSync(path.join(home, 'runs', job.jobId, 'scope.patch')), false)
  assert.equal(git(['status', '--porcelain'], repo), '')
})

test('S1: an invalid writeScope is rejected before any job record exists', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore, tools } = await freshModules(home)
  const adapter = fakeAdapter(respond('1'))
  const bad = [[], [''], ['   '], ['/etc/passwd'], ['../outside'], ['src/../../x'], ['C:\\x'], [':(exclude)src'], 'src/**', [42]]
  for (const writeScope of bad) {
    assert.throws(() => startJob({ agent: 'fake', model: 'x', task: 't', cwd: repo, mode: 'write', writeScope, adapterFor: () => adapter }), /writeScope/, JSON.stringify(writeScope))
  }
  assert.throws(() => startJob({ agent: 'fake', model: 'x', task: 't', cwd: repo, mode: 'read', writeScope: ['src/**'], adapterFor: () => adapter }), /writeScope.*mode.*write/)
  assert.throws(() => tools.delegateTool({ agent: 'opencode', model: 'x', task: 't', cwd: repo, mode: 'read', writeScope: ['src/**'], startJobFn: () => assert.fail('startJob must not run') }), /writeScope/)
  assert.throws(() => tools.delegateTool({ agent: 'opencode', model: 'x', task: 't', cwd: repo, mode: 'write', writeScope: ['../x'], startJobFn: () => assert.fail('startJob must not run') }), /writeScope/)
  assert.deepEqual(jobstore.listJobs(), [])
})

test('S1: a scratch writer whose cwd is not a git repo fails with scratch_unavailable and never runs in place', async () => {
  const home = tmpHome()
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-scratchw-plain-'))
  const marker = path.join(plain, 'ran.txt')
  const { startJob, jobstore } = await freshModules(home)
  const { job, done } = runWriter(startJob, { script: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); ${respond('1')}`, cwd: plain, writeScope: ['**'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'scratch_unavailable')
  assert.match(result.error, /not a git work tree/)
  assert.equal(fs.existsSync(marker), false, 'the agent never ran')
  assert.deepEqual(scratchEntries(home), [])
})

test('S1 (previous behavior): a write without writeScope in the primary checkout is still worktree_denied', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  const { job, done } = runWriter(startJob, { script: respond('1'), cwd: repo })
  await done
  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'worktree_denied')
  assert.equal('scratchWrite' in result, false)
  assert.equal('writeScope' in result, false)
})

test('S1 (previous behavior): an allowlisted write without writeScope still runs in place under the per-cwd lock', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  let lockCalls = 0
  const script = [writeFiles({ 'docs/inplace.txt': 'x\n' }), respond('process.cwd()')].join('; ')
  const { job, done } = runWriter(startJob, {
    script,
    cwd: repo,
    allowlist: [repo],
    acquireWriteLockFn: (args) => {
      lockCalls++
      return { acquired: true, token: 'tok-' + args.jobId }
    },
  })
  await done
  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'succeeded', result.error)
  assert.equal(lockCalls, 1)
  assert.equal(fs.realpathSync(fs.readFileSync(jobstore.responsePath(job.jobId), 'utf8')), fs.realpathSync(repo))
  assert.equal(fs.readFileSync(path.join(repo, 'docs', 'inplace.txt'), 'utf8'), 'x\n')
  assert.equal('scratchWrite' in result, false)
})

test('S2: an agent failure applies nothing, keeps the in-scope patch and removes the copy', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, jobstore } = await freshModules(home)
  // No JSON on stdout: the fake adapter classifies this as a crash.
  const { job, done } = runWriter(startJob, { script: writeFiles({ 'src/half.txt': 'partial\n' }), cwd: repo, writeScope: ['src/**'] })
  await done

  const result = jobstore.readResult(job.jobId)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorKind, 'crash')
  assert.equal(result.scratchWrite.applied, false)
  assert.deepEqual(result.scratchWrite.appliedPaths, [])
  assert.deepEqual(result.scratchWrite.unappliedPaths, ['src/half.txt'])
  assert.ok(fs.existsSync(result.scratchWrite.patchPath))
  assert.equal(fs.existsSync(path.join(repo, 'src', 'half.txt')), false)
  assert.equal(git(['status', '--porcelain'], repo), '')
  assert.deepEqual(scratchEntries(home), [])
})

test('S2: job_status and job_result expose scratchWrite and writeScope', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const { startJob, tools } = await freshModules(home)
  let done
  const res = tools.delegateTool({
    agent: 'opencode',
    model: 'x',
    task: 't',
    cwd: repo,
    mode: 'write',
    writeScope: ['src/**'],
    startJobFn: (args) => {
      const started = startJob({ ...args, agent: 'fake', adapterFor: () => fakeAdapter([writeFiles({ 'src/s.txt': 's\n' }), respond('1')].join('; ')) })
      done = started.done
      return started
    },
  })
  await done
  const status = tools.jobStatusTool({ jobId: res.jobId })
  assert.equal(status.status, 'succeeded', status.error)
  assert.deepEqual(status.writeScope, ['src/**'])
  assert.deepEqual(status.scratchWrite.appliedPaths, ['src/s.txt'])
  const result = tools.jobResultTool({ jobId: res.jobId })
  assert.deepEqual(result.scratchWrite.appliedPaths, ['src/s.txt'])
  assert.deepEqual(result.writeScope, ['src/**'])
})

test('job_reply on a scratch-writer parent inherits its writeScope; a plain parent forwards none', async () => {
  const home = tmpHome()
  const { jobstore, tools } = await freshModules(home)
  const mk = (extra) => {
    const job = jobstore.createJob({ agent: 'opencode', model: 'm', task: 't', cwd: '/tmp/r', title: 'p', mode: 'write' })
    jobstore.updateResult(job.jobId, { status: 'succeeded', sessionId: 'sess-x', ...extra })
    return job.jobId
  }
  const calls = []
  const startJobFn = (args) => {
    calls.push(args)
    return { job: { jobId: 'child-' + calls.length, status: 'queued' }, done: Promise.resolve() }
  }
  await tools.jobReplyTool({ jobId: mk({ writeScope: ['src/**'] }), message: 'go on', startJobFn })
  await tools.jobReplyTool({ jobId: mk({}), message: 'go on', startJobFn })
  await tools.jobReplyTool({ jobId: mk({ writeScope: ['src/**'] }), message: 'just look', mode: 'read', startJobFn })
  assert.deepEqual(calls[0].writeScope, ['src/**'])
  assert.equal(calls[0].mode, 'write')
  assert.equal('writeScope' in calls[1], false)
  assert.equal('writeScope' in calls[2], false, 'a read reply never carries a writeScope')
})

test('S3: the per-repository apply lock is exclusive, bounded and reclaims a stale holder', async () => {
  const home = tmpHome()
  const repo = makeRepo()
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const { acquireApplyLock } = await import('../src/scratchwrite.mjs?t=' + Date.now())
  const held = await acquireApplyLock({ root: repo, env })
  assert.equal(held.acquired, true)
  const busy = await acquireApplyLock({ root: repo, env, waitMs: 120 })
  assert.equal(busy.acquired, false)
  assert.match(busy.reason, /apply lock/)
  held.release()
  const again = await acquireApplyLock({ root: repo, env, waitMs: 120 })
  assert.equal(again.acquired, true)
  // Simulate a holder that died: a pid that cannot be alive.
  fs.writeFileSync(again.file, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }))
  const reclaimed = await acquireApplyLock({ root: repo, env, waitMs: 120 })
  assert.equal(reclaimed.acquired, true)
  reclaimed.release()
  assert.equal(fs.existsSync(reclaimed.file), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractLastJsonLine } from '../src/adapters/base.mjs'
import { parseReviewOutput, REVIEW_SEVERITIES } from '../src/review-output.mjs'

// same-tree-fanout T3 (S5): output:'review' asks for, and validates, a final
// JSON block of review findings.

const fence = (obj) => 'Some prose first.\n\n```json\n' + JSON.stringify(obj, null, 2) + '\n```\n'
const finding = (over = {}) => ({ severity: 'major', file: 'src/a.mjs', line: 12, title: 'Unchecked null', detail: 'x can be null here', ...over })

test('S5: parseReviewOutput accepts the last fenced JSON block and normalizes optional fields', () => {
  const text = fence({ summary: 'old', findings: [] }) + '\nrevised:\n' + fence({ summary: 'One issue', findings: [finding(), { severity: 'info', title: 'Nit' }] })
  const res = parseReviewOutput(text)
  assert.equal(res.ok, true, res.error)
  assert.equal(res.review.summary, 'One issue')
  assert.deepEqual(res.review.findings[1], { severity: 'info', file: null, line: null, title: 'Nit', detail: '' })
  assert.deepEqual(REVIEW_SEVERITIES, ['blocker', 'major', 'minor', 'info'])
})

test('S5: parseReviewOutput rejects a missing block, a bad severity, a missing summary and too many findings', () => {
  assert.match(parseReviewOutput('no json here').error, /no fenced ```json review block/)
  assert.match(parseReviewOutput(fence({ summary: 's', findings: [finding({ severity: 'critical' })] })).error, /findings\[0\]\.severity must be one of blocker, major, minor, info/)
  assert.match(parseReviewOutput(fence({ findings: [] })).error, /summary must be a non-empty string/)
  const many = Array.from({ length: 21 }, () => finding())
  assert.match(parseReviewOutput(fence({ summary: 's', findings: many })).error, /at most 20 findings/)
  assert.match(parseReviewOutput('```json\n{not json\n```').error, /not valid JSON/)
})

function fakeAdapter(responseText) {
  const script = `console.log(JSON.stringify({status:"SUCCESS",response:${JSON.stringify(responseText)}}))`
  return {
    id: 'fake',
    cmd: process.execPath,
    readPolicy: 'enforced',
    buildArgv: () => ['-e', script],
    parseResult: (stdout) => ({ ok: true, text: extractLastJsonLine(stdout)?.response ?? '', tokens: null, sessionId: null }),
    classifyError: (stdout) => (extractLastJsonLine(stdout) ? null : { kind: 'crash', message: 'no JSON' }),
    listModels: () => [],
  }
}

async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-review-'))
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const { startJob } = await import('../src/jobrunner.mjs?t=' + tag)
  const tools = await import('../src/tools/jobs.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-review-cwd-'))
  return { home, startJob, tools, jobstore, cwd }
}

test('S5: a review job gets the JSON instruction in its prompt and job_result returns the parsed review', async () => {
  const { home, startJob, tools, jobstore, cwd } = await setup()
  const response = fence({ summary: 'Looks fine', findings: [finding()] })
  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 'review the diff', cwd, mode: 'read', output: 'review', adapterFor: () => fakeAdapter(response) })
  await done

  const prompt = fs.readFileSync(path.join(home, 'runs', job.jobId, 'prompt.txt'), 'utf8')
  assert.ok(prompt.startsWith('review the diff'))
  assert.match(prompt, /```json/)
  assert.match(prompt, /"severity": "blocker\|major\|minor\|info"/)
  assert.equal(jobstore.readResult(job.jobId).output, 'review')

  const result = tools.jobResultTool({ jobId: job.jobId })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.review.summary, 'Looks fine')
  assert.equal(result.review.findings.length, 1)
  assert.equal(result.reviewError, undefined)
})

test('S5: an unparseable review is reported as reviewError without failing the job', async () => {
  const { startJob, tools, cwd } = await setup()
  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 't', cwd, mode: 'read', output: 'review', adapterFor: () => fakeAdapter('I found nothing, no JSON.') })
  await done
  const result = tools.jobResultTool({ jobId: job.jobId })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.review, null)
  assert.match(result.reviewError, /no fenced ```json review block/)
})

test('S5: a job without output keeps the previous job_result shape and prompt', async () => {
  const { home, startJob, tools, cwd } = await setup()
  const { job, done } = startJob({ agent: 'fake', model: 'x', task: 'plain task', cwd, mode: 'read', adapterFor: () => fakeAdapter('hi') })
  await done
  assert.equal(fs.readFileSync(path.join(home, 'runs', job.jobId, 'prompt.txt'), 'utf8'), 'plain task')
  const result = tools.jobResultTool({ jobId: job.jobId })
  assert.equal('review' in result, false)
  assert.equal('reviewError' in result, false)
})

test('S5: an unknown output value is rejected before any job record exists', async () => {
  const { startJob, cwd } = await setup()
  assert.throws(() => startJob({ agent: 'fake', model: 'x', task: 't', cwd, mode: 'read', output: 'essay', adapterFor: () => fakeAdapter('x') }), /output must be "review"/)
})

test('S5: delegate forwards output to startJob', async () => {
  const { tools, cwd } = await setup()
  let forwarded = null
  tools.delegateTool({ agent: 'copilot', model: 'auto', task: 't', cwd, output: 'review', startJobFn: (args) => { forwarded = args.output; return { job: { jobId: 'j', status: 'queued' } } } })
  assert.equal(forwarded, 'review')
})

test('T5: a finding detail that contains a code fence still parses', () => {
  const review = { summary: 's', findings: [{ severity: 'minor', title: 't', detail: 'use this:\n```js\nfoo()\n```\ninstead' }] }
  const res = parseReviewOutput('prose\n```json\n' + JSON.stringify(review, null, 2) + '\n```\n')
  assert.equal(res.ok, true, res.error)
  assert.match(res.review.findings[0].detail, /```js/)
})

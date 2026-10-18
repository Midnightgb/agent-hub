import crypto from 'node:crypto'
import fs from 'node:fs'
import { updateJsonLocked } from './fsutil.mjs'
import { appendEvent } from './eventlog.mjs'
import { paths, WRITE_ALLOWLIST } from './config.mjs'
import { TASK_TYPES } from './schemas.mjs'
import { listLearnings } from './learnings.mjs'
import { startJob as defaultStartJob } from './jobrunner.mjs'
import { readResult, responsePath, promptPath } from './jobstore.mjs'
import { REMOTE_AGENTS } from './adapters/index.mjs'
import { parseReviewOutput, REVIEW_OUTPUT_INSTRUCTION, REVIEW_SEVERITIES } from './review-output.mjs'

/**
 * Contrastive learning probes (odd/tasks/learning-probes.md). A probe runs the
 * same read task twice, in parallel: a CONTROL job with the normal approved
 * learning selection, and a TREATMENT job with that selection plus one
 * pending learning. learningProbeResult() then compares the two arms and
 * stores the comparison on the learning as evidence (`probes[]` in
 * learnings.json) for the human who approves or rejects it.
 *
 * Probes never change a learning's status: approval stays human, and
 * selectLearnings() keeps ignoring pending learnings for every other job.
 */

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])
const DEFAULT_FILE = { version: 1, learnings: [] }

// Verdict hint duration rule: the faster arm wins only when the slower one
// took more than 1.5x as long AND the gap exceeds 30 seconds.
const DURATION_RATIO = 1.5
const DURATION_MIN_GAP_MS = 30_000

const HUB_LEARNINGS_PREFIX_RE = /^<hub-learnings>\n[\s\S]*?\n<\/hub-learnings>\n\n/
const REVIEW_SUFFIX = `\n\n${REVIEW_OUTPUT_INSTRUCTION}`

/** A recorded prompt minus what the hub itself added (learnings block, review instruction). */
function stripHubAugmentation(prompt) {
  let task = prompt.replace(HUB_LEARNINGS_PREFIX_RE, '')
  if (task.endsWith(REVIEW_SUFFIX)) task = task.slice(0, -REVIEW_SUFFIX.length)
  return task
}

/** Task and cwd of the job a learning came from, or nulls when that job or its prompt is gone. */
function sourceJobDefaults(sourceJobId, env) {
  if (!sourceJobId) return { task: null, cwd: null }
  let cwd = null
  let task = null
  try {
    cwd = readResult(sourceJobId, env).cwd ?? null
  } catch {
    return { task: null, cwd: null }
  }
  try {
    task = stripHubAugmentation(fs.readFileSync(promptPath(sourceJobId, env), 'utf8')).trim() || null
  } catch {
    // no prompt on disk: the caller must pass task
  }
  return { task, cwd }
}

/**
 * learning_probe: start the control and treatment jobs. Every check runs
 * before the first job starts, so a rejected call leaves no job behind.
 * Returns `{ probeId, controlJobId, treatmentJobId }`.
 */
export function startLearningProbe(
  { learningId, task, cwd, agent, model, taskType, output, mode = 'read' } = {},
  { env = process.env, startJobFn = defaultStartJob } = {}
) {
  if (mode !== 'read') throw new Error(`learning_probe: probes are read-only (mode must be 'read', got '${mode}')`)
  const learning = listLearnings({}, env).find((l) => l.id === learningId)
  if (!learning) throw new Error(`learning not found: ${learningId}`)
  if (learning.status !== 'pending') {
    throw new Error(`learning_probe: only pending learnings can be probed (learning ${learningId} is ${learning.status})`)
  }

  const source = sourceJobDefaults(learning.sourceJobId, env)
  const resolved = {
    agent: agent ?? learning.agent ?? null,
    model: model ?? learning.model ?? null,
    taskType: taskType ?? learning.taskType ?? null,
    task: task ?? source.task,
    cwd: cwd ?? source.cwd,
  }
  const missing = ['agent', 'model', 'task', 'cwd'].filter((k) => resolved[k] == null || String(resolved[k]).trim() === '')
  if (missing.length > 0) {
    throw new Error(
      `learning_probe: missing ${missing.join(', ')}; pass them explicitly (neither the learning's scope nor its source job provides them)`
    )
  }
  if (resolved.taskType != null && !TASK_TYPES.includes(resolved.taskType)) throw new Error(`unknown taskType: ${resolved.taskType}`)
  if (REMOTE_AGENTS.has(resolved.agent)) throw new Error(`learning_probe: remote agent "${resolved.agent}" cannot be probed (read jobs run locally)`)

  const probeId = `probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const base = {
    agent: resolved.agent,
    model: resolved.model,
    task: resolved.task,
    cwd: resolved.cwd,
    mode: 'read',
    taskType: resolved.taskType,
    turnDepth: 0,
    allowlist: WRITE_ALLOWLIST,
    env,
    ...(output ? { output } : {}),
  }
  // Both jobs start back to back and run concurrently (startJob never waits).
  // If the treatment fails to start, the control keeps running as an ordinary
  // read job; no probe record is written.
  const control = startJobFn({ ...base, title: `probe control ${learningId}` })
  const treatment = startJobFn({ ...base, title: `probe treatment ${learningId}`, extraLearnings: [learning] })

  const probe = {
    probeId,
    controlJobId: control.job.jobId,
    treatmentJobId: treatment.job.jobId,
    agent: resolved.agent,
    model: resolved.model,
    taskType: resolved.taskType,
    cwd: resolved.cwd,
    output: output ?? null,
    createdAt: new Date().toISOString(),
    comparison: null,
    completedAt: null,
  }
  updateJsonLocked(
    paths(env).learningsFile,
    (current) => {
      const target = current.learnings.find((l) => l.id === learningId)
      if (target) target.probes = [...(Array.isArray(target.probes) ? target.probes : []), probe]
      return current
    },
    { defaultValue: DEFAULT_FILE }
  )
  return { probeId, controlJobId: probe.controlJobId, treatmentJobId: probe.treatmentJobId }
}

function findProbe(probeId, env) {
  for (const learning of listLearnings({}, env)) {
    const probe = (Array.isArray(learning.probes) ? learning.probes : []).find((p) => p.probeId === probeId)
    if (probe) return { learning, probe }
  }
  throw new Error(`probe not found: ${probeId}`)
}

function durationMs(job) {
  const start = Date.parse(job.createdAt)
  const end = Date.parse(job.updatedAt)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null
}

function readResponse(jobId, env) {
  try {
    return fs.readFileSync(responsePath(jobId, env), 'utf8')
  } catch {
    return ''
  }
}

/** One arm of the comparison: status, errorKind, duration, response size and (review output) findings by severity. */
function armSummary(job, { output, env }) {
  const text = readResponse(job.jobId, env)
  const summary = {
    jobId: job.jobId,
    status: job.status,
    errorKind: job.errorKind ?? null,
    durationMs: durationMs(job),
    responseChars: text.length,
    learningIds: Array.isArray(job.learningIds) ? job.learningIds : [],
    findings: null,
  }
  if (output === 'review') {
    const parsed = parseReviewOutput(text)
    if (parsed.ok) {
      summary.findings = Object.fromEntries(REVIEW_SEVERITIES.map((s) => [s, parsed.review.findings.filter((f) => f.severity === s).length]))
    } else {
      summary.reviewError = parsed.error
    }
  }
  return summary
}

/**
 * Deterministic verdict HINT for a finished probe, never a judgment: the
 * human still reads both responses before approving. Rules, in order:
 * 1. exactly one arm `succeeded` -> that arm is better;
 * 2. neither succeeded -> `inconclusive`;
 * 3. both succeeded and both carry parsed review findings with a different
 *    blocker+major count -> the arm with fewer is better;
 * 4. otherwise the faster arm is better when the slower took more than 1.5x
 *    as long and more than 30 s longer;
 * 5. otherwise `no_difference`.
 * Returns `{ verdictHint, reason }`.
 */
export function probeVerdictHint(control, treatment) {
  const controlOk = control.status === 'succeeded'
  const treatmentOk = treatment.status === 'succeeded'
  if (controlOk !== treatmentOk) {
    return treatmentOk
      ? { verdictHint: 'treatment_better', reason: `only the treatment succeeded (control ${control.status})` }
      : { verdictHint: 'control_better', reason: `only the control succeeded (treatment ${treatment.status})` }
  }
  if (!controlOk) return { verdictHint: 'inconclusive', reason: 'neither arm succeeded' }

  if (control.findings && treatment.findings) {
    const severe = (f) => (f.blocker ?? 0) + (f.major ?? 0)
    const c = severe(control.findings)
    const t = severe(treatment.findings)
    if (c !== t) {
      return {
        verdictHint: t < c ? 'treatment_better' : 'control_better',
        reason: `blocker+major findings: treatment ${t}, control ${c}`,
      }
    }
  }

  const c = control.durationMs
  const t = treatment.durationMs
  if (Number.isFinite(c) && Number.isFinite(t)) {
    const fast = Math.min(c, t)
    const slow = Math.max(c, t)
    if (slow - fast > DURATION_MIN_GAP_MS && slow > fast * DURATION_RATIO) {
      return { verdictHint: t < c ? 'treatment_better' : 'control_better', reason: `duration: treatment ${t} ms, control ${c} ms` }
    }
  }
  return { verdictHint: 'no_difference', reason: 'both succeeded with no decisive findings or duration gap' }
}

/**
 * learning_probe_result: non-blocking. While either job is non-terminal it
 * returns `done:false` with both statuses. Once both are terminal it builds
 * the comparison, persists it on the probe once (later calls return the
 * stored one) and records one `learning.probed` event.
 */
export function learningProbeResult({ probeId } = {}, { env = process.env } = {}) {
  const { learning, probe } = findProbe(probeId, env)
  const head = { probeId, learningId: learning.id, learningStatus: learning.status, controlJobId: probe.controlJobId, treatmentJobId: probe.treatmentJobId }
  if (probe.comparison) return { ...head, done: true, comparison: probe.comparison }

  const controlJob = readResult(probe.controlJobId, env)
  const treatmentJob = readResult(probe.treatmentJobId, env)
  if (!TERMINAL.has(controlJob.status) || !TERMINAL.has(treatmentJob.status)) {
    return { ...head, done: false, control: { jobId: controlJob.jobId, status: controlJob.status }, treatment: { jobId: treatmentJob.jobId, status: treatmentJob.status } }
  }

  const control = armSummary(controlJob, { output: probe.output, env })
  const treatment = armSummary(treatmentJob, { output: probe.output, env })
  const fresh = { control, treatment, ...probeVerdictHint(control, treatment) }

  let stored = fresh
  let wrote = false
  updateJsonLocked(
    paths(env).learningsFile,
    (current) => {
      const target = current.learnings.find((l) => l.id === learning.id)?.probes?.find((p) => p.probeId === probeId)
      if (!target) return undefined
      if (target.comparison) {
        stored = target.comparison
        return undefined
      }
      target.comparison = fresh
      target.completedAt = new Date().toISOString()
      wrote = true
      return current
    },
    { defaultValue: DEFAULT_FILE }
  )
  if (wrote) {
    appendEvent({ kind: 'learning.probed', agent: probe.agent, model: probe.model, taskType: probe.taskType, summary: `${stored.verdictHint} ${learning.id} ${probeId}` }, { env })
  }
  return { ...head, done: true, comparison: stored }
}

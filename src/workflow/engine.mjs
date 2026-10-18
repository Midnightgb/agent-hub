import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  artifactsDir,
  collectManifest,
  readArtifact,
  resolveArtifactRefs,
  writeArtifact,
  writeManifest,
} from '../artifacts.mjs'
import { validateHandoff, resolveHandoffSchema } from '../handoff.mjs'
import { writeHandoff, readHandoff } from '../context.mjs'
import {
  getDb,
  upsertWorkflow,
  getWorkflow,
  upsertWorkflowNode,
  getWorkflowNode,
  listWorkflowNodes,
  claimWorkflowNode,
  publishWorkflowNodeReady,
  touchWorkflowNode,
  reclaimOrphanedWorkflowNode,
} from '../storage/index.mjs'
import { appendEvent } from '../eventlog.mjs'
import { resolveHarness } from '../harness/registry.mjs'
import { calculateDispatchTimeoutS, dispatch, waitExecution as defaultWaitExecution } from '../dispatch.mjs'
import { readResult as readJobResult, updateResult } from '../jobstore.mjs'
import { runVerification, normalizeVerifyConfig } from '../verify.mjs'
import { judgeVerdict } from '../judge.mjs'
import { buildRevisionFeedback } from '../revision.mjs'
import { createWorkflow } from './schema.mjs'
import { NODE_STATUS, WAITING_REASONS, isTerminalStatus, assertValidTransition } from './state.mjs'
import { resolveDependencies, evaluateCondition } from './resolver.mjs'
import { evaluateValue } from './dsl.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Concurrency & Race Condition Resolution (C1.8 / C1.9):
 *
 * We use atomic Compare-And-Swap (CAS) on the `claimed_by` column in `workflow_nodes`:
 *   UPDATE workflow_nodes
 *   SET claimed_by = @claimedBy, status = 'running', attempt = attempt + 1, updated_at = @now
 *   WHERE workflow_id = @workflowId AND step_id = @stepId AND status IN ('pending', 'ready')
 *     AND (claimed_by IS NULL OR claimed_by = '' OR claimed_by = @claimedBy)
 *
 * Why `claimed_by` CAS over a separate leases table:
 * 1. Single source of truth: Node state and claim ownership are updated in a single atomic SQL statement
 *    under SQLite's WAL mode.
 * 2. Eliminates distributed state inconsistency: A separate leases table requires dual-phase updates
 *    (lease acquire -> status update -> lease delete), creating windows for orphaned leases or phantom executions.
 * 3. Idempotent re-entry: If the same scheduler worker retries after transient failure, `claimed_by = @claimedBy`
 *    safely allows continuation without deadlock.
 */

/** Default claim-lease TTL: a running node owned by someone else may only be
 * revived after this long without an update. */
export const CLAIM_LEASE_TTL_MS = 30_000

/**
 * Normalizes a node's handoff configuration.
 * undefined/null/false -> null
 * true -> { required: false, schema: 'BaseHandoff' }
 * object -> { required: value.required === true, schema: typeof value.schema === 'string' ? value.schema : 'BaseHandoff' }
 * An unknown schema name throws via resolveHandoffSchema.
 * @param {object} node
 * @returns {{ required: boolean, schema: string } | null}
 */
export function normalizeHandoffConfig(node) {
  const value = node?.handoff
  if (value === undefined || value === null || value === false) {
    return null
  }
  if (value === true) {
    return { required: false, schema: 'BaseHandoff' }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const schema = typeof value.schema === 'string' ? value.schema : 'BaseHandoff'
    const schemaObj = resolveHandoffSchema(schema)
    if (!schemaObj) {
      throw new Error(`unknown handoff schema: ${schema}`)
    }
    return {
      required: value.required === true,
      schema,
    }
  }
  return null
}

function refreshNodeStates(ctx, workflowId, nodeStates) {
  const rows = listWorkflowNodes(ctx, workflowId)
  for (const row of rows) {
    let result = null
    try {
      result = row.result_json ? JSON.parse(row.result_json) : null
    } catch {
      result = row.result_json
    }
    const current = nodeStates.get(row.step_id)
    nodeStates.set(row.step_id, {
      ...(current || {}),
      status: row.status,
      attempt: row.attempt,
      result: result ?? current?.result ?? null,
      claimed_by: row.claimed_by,
      updated_at: row.updated_at,
    })
  }
}

/**
 * C1.1: única vía ready→running. Asserts the transition, then performs the
 * atomic CAS. Returns true when this worker now owns the node.
 * A node still PENDING is not claimed here: the wave publishes it READY
 * first through the conditional publish (which never clobbers a claim).
 */
export function claimNode(ctx, { workflowId, stepId, claimedBy, attempt }) {
  const row = getWorkflowNode(ctx, workflowId, stepId)
  const current = row?.status ?? NODE_STATUS.PENDING
  if (current !== NODE_STATUS.READY) return false
  assertValidTransition(current, NODE_STATUS.RUNNING, stepId)
  return claimWorkflowNode(ctx, { workflowId, stepId, claimedBy, attempt })
}

/**
 * C1.1: vía para el resto de transiciones. Always asserts validity first.
 */
export function transitionNode(ctx, { workflowId, stepId, from, to, attempt, resultJson = null, claimedBy }) {
  const row = getWorkflowNode(ctx, workflowId, stepId)
  const current = from ?? row?.status
  assertValidTransition(current, to, stepId)
  const now = new Date().toISOString()
  upsertWorkflowNode(ctx, {
    workflow_id: workflowId,
    step_id: stepId,
    status: to,
    attempt: attempt ?? row?.attempt ?? 0,
    updated_at: now,
    claimed_by: claimedBy === undefined ? (row?.claimed_by ?? null) : claimedBy,
    ...(resultJson !== null ? { result_json: resultJson } : {}),
  })
  return getWorkflowNode(ctx, workflowId, stepId)
}

/**
 * Adopt a status an external actor already wrote for this node instead of
 * overwriting it. Terminal statuses have no outgoing transitions, so writing
 * FAILED (or READY) over CANCELED/FAILED/SUCCEEDED throws and escapes
 * runWorkflow; adopting keeps the workflow honest about what really happened.
 * @returns {boolean} true when an external terminal state was adopted.
 */
function adoptExternalTerminal(ctx, { workflow, node, nodeStates, attempt, revision, error }) {
  const row = getWorkflowNode(ctx, workflow.id, node.id)
  if (!row || !isTerminalStatus(row.status)) return false
  nodeStates.set(node.id, {
    ...(nodeStates.get(node.id) || {}),
    status: row.status,
    attempt: row.attempt ?? attempt,
    ...(error ? { error } : {}),
    revision,
  })
  return true
}

/**
 * A canceled job is terminal: mark the node canceled (valid from running or
 * waiting) and stop. Never retry it, never overwrite it with FAILED.
 */
function finalizeCanceledNode(ctx, { workflow, node, nodeStates, attempt, revision, error }) {
  const row = getWorkflowNode(ctx, workflow.id, node.id)
  if (!isTerminalStatus(row?.status)) {
    transitionNode(ctx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.CANCELED, attempt })
  }
  nodeStates.set(node.id, {
    ...(nodeStates.get(node.id) || {}),
    status: NODE_STATUS.CANCELED,
    attempt,
    ...(error ? { error } : {}),
    revision,
  })
}

/**
 * Can a non-terminal node owned by ANOTHER worker be re-queued?
 *
 * Only when its lease expired, or when an explicit liveness probe says the
 * owner is gone. A fresh foreign claim is a live peer: stealing it would run
 * the node twice, and the CAS claim is supposed to be the single winner gate
 * (see the "double scheduler" test). Runtime passes call this on every wave so
 * a peer that dies mid-run is reclaimed as soon as its lease expires, which is
 * what bounds the scheduler wait.
 *
 * The write itself is a compare-and-set (T1): it only releases the row when
 * it STILL has the exact status/owner/updated_at that justified the reclaim.
 * `transitionNode` would re-read the CURRENT row for its own validity check
 * and then UPSERT unconditionally — so if a peer (P1) reclaimed AND
 * re-claimed the node between our read and this write, that unconditional
 * UPSERT would happily overwrite P1's fresh claim (RUNNING -> READY is a
 * legal transition either way). The CAS below makes a lost race a no-op
 * instead.
 *
 * @returns {boolean} true when the node was released back to READY.
 */
export function reclaimOrphanedNode(ctx, { workflowId, stepId, row, claimedBy, ownerAlive, hasExplicitProbe, leaseTtlMs }) {
  if (!row || isTerminalStatus(row.status)) return false
  if (row.status !== NODE_STATUS.RUNNING && row.status !== NODE_STATUS.WAITING) return false
  const owner = row.claimed_by
  if (!owner || owner === claimedBy) return false
  const updatedAt = Date.parse(row.updated_at ?? '') || 0
  const leaseExpired = updatedAt > 0 && Date.now() - updatedAt > leaseTtlMs
  // With an explicit probe the owner's liveness is authoritative: an expired
  // lease alone never takes a node from an owner that still answers (see
  // test/chaos/chaos.test.mjs "chaos 3"). Without a probe the lease is the only
  // signal there is, so expiry is what marks the owner gone.
  const ownerConfirmedDead = hasExplicitProbe ? !ownerAlive(owner, claimedBy) : true
  if (!leaseExpired || !ownerConfirmedDead) return false
  // Static validity check: we already know row.status is RUNNING or WAITING,
  // both of which can legally transition to READY. This does not re-read the
  // row — the CAS below is the only thing allowed to decide based on live state.
  assertValidTransition(row.status, NODE_STATUS.READY, stepId)
  return reclaimOrphanedWorkflowNode(ctx, {
    workflowId,
    stepId,
    expectedStatus: row.status,
    expectedClaimedBy: owner,
    expectedUpdatedAt: row.updated_at,
  })
}

/**
 * Claim heartbeat: while a node is in flight, keep its lease timestamp fresh so
 * a peer scheduler (and the stall bound) can tell "slow but alive" from "dead".
 * Without it `updated_at` is written once at claim time, so any job running
 * longer than the lease looks like a dead owner and gets preempted.
 *
 * Returns a stop function. A failed heartbeat never breaks the run it protects.
 */
function startNodeHeartbeat(ctx, { workflowId, stepId, intervalMs, touchFn }) {
  if (!(intervalMs > 0) || typeof touchFn !== 'function') return () => {}
  const timer = setInterval(() => {
    try {
      touchFn(ctx, { workflowId, stepId })
    } catch {
      // A heartbeat must never break the run it protects.
    }
  }, intervalMs)
  if (timer.unref) timer.unref()
  return () => clearInterval(timer)
}

/**
 * Is any non-terminal node still holding a fresh lease? A live owner that is
 * heartbeating is progress, even when no status changed: that is what keeps a
 * slow-but-alive peer from being declared stalled.
 */
function hasFreshLease(ctx, { workflow, leaseTtlMs, now = Date.now() }) {
  return workflow.nodes.some((n) => {
    const row = getWorkflowNode(ctx, workflow.id, n.id)
    if (!row || isTerminalStatus(row.status)) return false
    const updatedAt = Date.parse(row.updated_at ?? '') || 0
    return updatedAt > 0 && now - updatedAt <= leaseTtlMs
  })
}

function isHandleLike(value) {
  if (!value || typeof value !== 'object') return false
  if (typeof value.abort === 'function' && typeof value.jobId === 'string') return true
  if (value.__handle && typeof value.__handle?.jobId === 'string') return true
  return false
}

function unwrapHandle(value) {
  if (!value || typeof value !== 'object') return null
  if (value.__handle && typeof value.__handle?.jobId === 'string') return value.__handle
  if (typeof value.abort === 'function' && typeof value.jobId === 'string') return value
  if (value.job && typeof value.job.jobId === 'string' && typeof value.abort === 'function') return value
  return null
}

/**
 * A dispatch result that carries a jobId but no handle protocol (bare job
 * record, or {job} without abort) is a PENDING execution, never a final
 * result. Live validation proved the old fallthrough marked a freshly-queued
 * record SUCCEEDED. Wrap it as a minimal handle so it goes through
 * waitForHandleTerminal like everything else; an already-terminal record
 * resolves immediately there.
 */
function pendingJobHandle(value) {
  if (!value || typeof value !== 'object') return null
  const jobId =
    (typeof value.jobId === 'string' && value.jobId) ||
    (value.job && typeof value.job.jobId === 'string' && value.job.jobId) ||
    null
  if (!jobId) return null
  return { jobId }
}

/**
 * Resolves a fanout `items` expression without `new Function`/`eval`.
 * Array => as-is; string => C1.1 DSL value expression evaluated against
 * current step states (must yield an array); otherwise falls back to the
 * parent result items when dependsOn is set.
 */
export function resolveFanoutItems({ node, nodeStates }) {
  if (Array.isArray(node.items)) return node.items
  if (typeof node.items === 'string') {
    const rawSteps = {}
    for (const [id, s] of nodeStates.entries()) {
      rawSteps[id] = s
    }
    try {
      const value = evaluateValue(node.items, { steps: rawSteps })
      if (Array.isArray(value)) return value
    } catch {
      // fall through to empty
    }
    return []
  }
  if (node.dependsOn && node.dependsOn.length > 0) {
    const parentState = nodeStates.get(node.dependsOn[0])
    if (Array.isArray(parentState?.result?.items)) {
      return parentState.result.items
    } else if (Array.isArray(parentState?.result)) {
      return parentState.result
    }
  }
  return []
}

/**
 * Executes the evidence sequence: prepares artifacts directory and instructions,
 * optionally executes the dispatch action, then processes post-terminal evidence
 * (verification, judge verdict, handoff validation, manifest collection).
 */
export async function executeEvidenceSequence({
  workflow,
  node,
  childId = null,
  ctx,
  env = process.env,
  runCommandFn = null,
  nodeStates,
  task = '',
  result = null,
  revision = 0,
  maxRevisionAttempts = 0,
  allowRevision = true,
  execute = null,
}) {
  const stepId = childId || node.id
  const declared = Array.isArray(node.artifacts) ? node.artifacts : []
  const handoffConfig = normalizeHandoffConfig(node)

  let dispatchedTask = task

  if (declared.length > 0) {
    const dir = artifactsDir({ workflowId: workflow.id, stepId }, env)
    fs.mkdirSync(dir, { recursive: true })
    dispatchedTask =
      dispatchedTask +
      '\n\n' +
      'Evidence artifacts: write these files to ' +
      dir +
      ' (absolute path), one file per name, exactly these filenames: ' +
      declared.join(', ') +
      '. Do not write any other file there.'
  }

  if (handoffConfig) {
    const dir = artifactsDir({ workflowId: workflow.id, stepId }, env)
    fs.mkdirSync(dir, { recursive: true })
    const schemaObj = resolveHandoffSchema(handoffConfig.schema)
    const requiresStr = schemaObj?.requires ? schemaObj.requires.join(', ') : 'summary'
    dispatchedTask =
      dispatchedTask +
      '\n\n' +
      'Structured handoff: also write handoff.json to ' +
      dir +
      ' (absolute path): a JSON object with summary (a non-empty string) and the arrays findings/decisions/constraints/changedFiles/openQuestions/artifacts (arrays of strings). ' +
      'Required fields for schema ' +
      handoffConfig.schema +
      ': ' +
      requiresStr +
      '.'
  }

  let finalResult = result
  if (typeof execute === 'function') {
    finalResult = await execute(dispatchedTask)
  }

  let verification = null
  let judge = null
  if (normalizeVerifyConfig(node)) {
    verification = await runVerification({
      node: { ...node, id: stepId },
      workflowId: workflow.id,
      stepId,
      cwd: node.cwd ?? null,
      env,
      runCommandFn: runCommandFn ?? undefined,
    })
    if (verification) {
      try {
        writeArtifact(
          {
            workflowId: workflow.id,
            stepId,
            name: 'verification.json',
            content: JSON.stringify(verification, null, 2),
          },
          env
        )
      } catch {}
      judge = judgeVerdict({
        verification,
        stepId,
        revision,
        maxRevisionAttempts,
        required: verification.required,
      })
      try {
        writeArtifact(
          {
            workflowId: workflow.id,
            stepId,
            name: 'judge.json',
            content: JSON.stringify(judge, null, 2),
          },
          env
        )
      } catch {}
    }
  }

  const jobId = finalResult?.job?.jobId ?? finalResult?.jobId ?? null
  if (judge && jobId) {
    try {
      updateResult(jobId, { verified: verification.verified, judge_verdict: judge.verdict, revision }, env)
    } catch {}
  }

  if (allowRevision && judge && judge.verdict === 'needs_revision') {
    const err = new Error(judge.reason)
    err.code = 'REVISION_REQUESTED'
    err.judge = judge
    err.verification = verification
    throw err
  }

  if (!allowRevision && judge && judge.required && !verification?.verified) {
    const err = new Error(judge.reason)
    err.code = 'JUDGE_REJECTED'
    err.judge = judge
    err.verification = verification
    throw err
  }

  if (judge && (judge.verdict === 'rejected' || judge.verdict === 'blocked') && judge.required) {
    const err = new Error(judge.reason)
    err.code = 'JUDGE_REJECTED'
    err.judge = judge
    err.verification = verification
    throw err
  }

  let producedHandoff = null
  if (handoffConfig) {
    let handoffRaw = null
    try {
      const art = readArtifact({ workflowId: workflow.id, stepId, name: 'handoff.json' }, env)
      if (art?.content) {
        handoffRaw = JSON.parse(art.content)
      }
    } catch {}

    const validation = validateHandoff(handoffRaw, { schema: handoffConfig.schema })
    if (validation.ok) {
      producedHandoff = writeHandoff(
        {
          workflowId: workflow.id,
          stepId,
          handoff: validation.value,
          schema: handoffConfig.schema,
        },
        env
      )
    } else {
      if (handoffConfig.required) {
        const err = new Error('handoff required: ' + JSON.stringify(validation.errors))
        err.code = 'HANDOFF_INVALID'
        throw err
      }
    }
  }

  let manifest = null
  if (declared.length > 0) {
    manifest = collectManifest({ workflowId: workflow.id, stepId, declared }, env)
    writeManifest({ workflowId: workflow.id, stepId }, manifest, env)
  }

  return {
    result: finalResult,
    task: dispatchedTask,
    verification,
    judge,
    handoff: producedHandoff,
    manifest,
  }
}

/**
 * Executes a single node with retry backoff and timeout enforcement.
 *
 * C1.1 delegate semantics: dispatch() returns a handle; waitExecution()
 * observes the job record until a REAL terminal status. SUCCEEDED is
 * persisted only after terminal success — a still-pending job never
 * advances the node. Timeouts abort the handle, confirm the record, and
 * retry with attempt+1. Waiting (AWAITING_* / PAUSED) persists WAITING and
 * resumes without re-dispatching.
 */
async function executeNode({
  workflow,
  node,
  ctx,
  env,
  dispatchFn,
  runCommandFn = null,
  nodeStates,
  claimedBy,
  backoffMs,
  waitExecutionFn = defaultWaitExecution,
  readResultFn = null,
  onWaiting = null,
  waitingTimeoutS = 300,
  pollIntervalMs = 25,
}) {
  const handoffConfig = normalizeHandoffConfig(node)
  const maxAttempts = node.maxAttempts ?? 1
  let attempt = nodeStates.get(node.id)?.attempt || 1
  const maxRevisionAttempts = Number.isInteger(node.maxRevisionAttempts) && node.maxRevisionAttempts > 0 ? node.maxRevisionAttempts : 0
  let revision = 0
  let revisionFeedback = ''
  let lastError = null
  const readRecord = readResultFn ?? ((jobId) => readJobResult(jobId, env))
  // Harness defaults from env for the started event (emitted before the
  // dispatch returns); once dispatchFn answers, its harness/waitMode win.
  const defaultProfile = resolveHarness({ env })
  let nodeHarness = defaultProfile.id
  let nodeWaitMode = defaultProfile.delegation.defaultWaitMode
  const adoptHarness = (value) => {
    nodeHarness = value?.harness ?? value?.job?.harness ?? nodeHarness
    nodeWaitMode = value?.waitMode ?? value?.job?.waitMode ?? nodeWaitMode
  }

  appendEvent(
    {
      kind: 'job.started',
      jobId: `${workflow.id}_${node.id}`,
      workflow_id: workflow.id,
      step_id: node.id,
      agent: node.agent,
      model: node.model,
      cwd: node.cwd,
      title: node.task ?? node.id,
      harness: nodeHarness,
      waitMode: nodeWaitMode,
    },
    { env }
  )

  while (attempt <= maxAttempts) {
    try {
      let result = null
      let verification = null
      let judge = null
      let producedHandoff = null
      let manifest = null

      if (node.type === 'delegate') {
        const resolved = resolveArtifactRefs(node.task ?? '', { env })
        if (resolved.missing.length > 0) {
          throw new Error('unresolved artifact ref: ' + resolved.missing[0])
        }
        let dispatchedTask = resolved.text
        if (revisionFeedback) {
          dispatchedTask = revisionFeedback + '\n\n' + dispatchedTask
        }

        const deps = Array.isArray(node.dependsOn) ? node.dependsOn : []
        const upstreamHandoffs = []
        for (const depId of deps) {
          const depHandoff = nodeStates.get(depId)?.handoff
          if (depHandoff) {
            let json = JSON.stringify(depHandoff, null, 0)
            if (json.length > 4000) {
              json = json.slice(0, 4000) + '...'
            }
            upstreamHandoffs.push(`${depId}: ${json}`)
          }
        }
        if (upstreamHandoffs.length > 0) {
          dispatchedTask =
            dispatchedTask +
            '\n\n' +
            'Upstream context:\n' +
            upstreamHandoffs.join('\n')
        }

        const evidenceOutcome = await executeEvidenceSequence({
          workflow,
          node,
          childId: node.id,
          ctx,
          env,
          runCommandFn,
          nodeStates,
          task: dispatchedTask,
          revision,
          maxRevisionAttempts,
          allowRevision: true,
          execute: async (finalTask) => {
            let timeoutS = node.timeoutS
            if (!timeoutS && typeof calculateDispatchTimeoutS === 'function') {
              try {
                timeoutS = calculateDispatchTimeoutS({
                  agent: node.agent,
                  model: node.model,
                  mode: node.mode,
                  taskType: node.taskType,
                  attempt,
                  env,
                })
              } catch {
                timeoutS = 30
              }
            }
            timeoutS = timeoutS || 30
            const attemptDeadline = Date.now() + timeoutS * 1000

            let parentExecutionId = null
            const firstDepId = Array.isArray(node.dependsOn) && node.dependsOn.length > 0 ? node.dependsOn[0] : null
            if (firstDepId) {
              const depResult = nodeStates.get(firstDepId)?.result
              parentExecutionId = depResult?.job?.jobId ?? depResult?.jobId ?? null
            }

            const dispatchPromise = Promise.resolve().then(() =>
              dispatchFn({
                task: finalTask,
                taskType: node.taskType,
                agent: node.agent,
                model: node.model,
                cwd: node.cwd,
                mode: node.mode,
                // NodeSchema defaults mode to 'read', so it is not a caller choice:
                // keep the chain step mode winning, as before dispatch-caller-mode.
                chainModeWins: true,
                workflowStep: node.id,
                workflow_id: workflow.id,
                step_id: node.id,
                attempt,
                timeoutS,
                env,
                rootExecutionId: workflow.id,
                parentExecutionId,
              })
            )
            const timeoutPromise = new Promise((_, reject) => {
              const timer = setTimeout(() => {
                const err = new Error(`Node "${node.id}" timed out after ${timeoutS}s (attempt ${attempt}/${maxAttempts})`)
                err.code = 'ETIMEDOUT'
                reject(err)
              }, timeoutS * 1000)
              if (timer.unref) timer.unref()
            })

            const dispatched = await Promise.race([dispatchPromise, timeoutPromise])
            dispatchPromise.catch(() => {})
            adoptHarness(dispatched)

            const handle = unwrapHandle(dispatched) ?? pendingJobHandle(dispatched)
            if (!handle) {
              return dispatched
            }
            const remainingS = Math.max(0.05, (attemptDeadline - Date.now()) / 1000)
            return await waitForHandleTerminal({
              workflow,
              node,
              ctx,
              env,
              handle,
              timeoutS: remainingS,
              attempt,
              maxAttempts,
              nodeStates,
              claimedBy,
              waitExecutionFn,
              readRecord,
              onWaiting,
              waitingTimeoutS,
              pollIntervalMs,
            })
          },
        })

        result = evidenceOutcome.result
        verification = evidenceOutcome.verification
        judge = evidenceOutcome.judge
        producedHandoff = evidenceOutcome.handoff
        manifest = evidenceOutcome.manifest
      } else if (node.type === 'fanout') {
        const items = resolveFanoutItems({ node, nodeStates })
        const childMaxRevisionAttempts =
          Number.isInteger(node.maxRevisionAttempts) && node.maxRevisionAttempts > 0
            ? node.maxRevisionAttempts
            : 0

        const childResults = []
        const failingChildIds = []

        await Promise.all(
          items.map(async (item, idx) => {
            const childStepId = `${node.id}_${idx}`
            const now = new Date().toISOString()
            upsertWorkflowNode(ctx, { workflow_id: workflow.id, step_id: childStepId, status: NODE_STATUS.PENDING, attempt: 1, updated_at: now })
            transitionNode(ctx, { workflowId: workflow.id, stepId: childStepId, to: NODE_STATUS.READY, attempt: 1 })
            claimNode(ctx, { workflowId: workflow.id, stepId: childStepId, claimedBy, attempt: 1 })
            nodeStates.set(childStepId, {
              status: NODE_STATUS.RUNNING,
              attempt: 1,
              result: null,
              error: null,
              claimed_by: claimedBy,
            })

            const itemTask =
              typeof item === 'string'
                ? `${node.task ? node.task + ': ' : ''}${item}`
                : `${node.task || 'Process item'} ${JSON.stringify(item)}`

            try {
              const evidenceOutcome = await executeEvidenceSequence({
                workflow,
                node,
                childId: childStepId,
                ctx,
                env,
                runCommandFn,
                nodeStates,
                task: itemTask,
                revision: 0,
                maxRevisionAttempts: childMaxRevisionAttempts,
                allowRevision: false,
                execute: async (dispatchedTask) => {
                  // Fanout child: parentExecutionId is null because the fanout node
                  // itself produces no job (has no jobId).
                  const childRes = await dispatchFn({
                    task: dispatchedTask,
                    taskType: node.taskType,
                    agent: node.agent,
                    model: node.model,
                    cwd: node.cwd,
                    mode: node.mode,
                    // NodeSchema defaults mode to 'read', so it is not a caller choice:
                    // keep the chain step mode winning, as before dispatch-caller-mode.
                    chainModeWins: true,
                    workflowStep: childStepId,
                    workflow_id: workflow.id,
                    step_id: childStepId,
                    attempt: 1,
                    env,
                    rootExecutionId: workflow.id,
                    parentExecutionId: null,
                  })

                  const childHandle = unwrapHandle(childRes) ?? pendingJobHandle(childRes)
                  adoptHarness(childRes)
                  let finalChild = childRes
                  if (childHandle) {
                    finalChild = await waitForHandleTerminal({
                      workflow,
                      node: { ...node, id: childStepId },
                      ctx,
                      env,
                      handle: childHandle,
                      timeoutS: node.timeoutS || 30,
                      attempt: 1,
                      maxAttempts: 1,
                      nodeStates,
                      claimedBy,
                      waitExecutionFn,
                      readRecord,
                      onWaiting,
                      waitingTimeoutS,
                      pollIntervalMs,
                    })
                  }
                  return finalChild
                },
              })

              const finalChild = evidenceOutcome.result
              transitionNode(ctx, { workflowId: workflow.id, stepId: childStepId, to: NODE_STATUS.SUCCEEDED, attempt: 1, resultJson: JSON.stringify(finalChild ?? { success: true }) })
              nodeStates.set(childStepId, {
                ...nodeStates.get(childStepId),
                status: NODE_STATUS.SUCCEEDED,
                attempt: 1,
                result: finalChild ?? { success: true },
                error: null,
                ...(evidenceOutcome.verification ? { verification: evidenceOutcome.verification } : {}),
                ...(evidenceOutcome.judge ? { judge: evidenceOutcome.judge } : {}),
                ...(evidenceOutcome.handoff ? { handoff: evidenceOutcome.handoff } : {}),
                revision: 0,
              })

              childResults[idx] = finalChild
            } catch (err) {
              failingChildIds.push(childStepId)
              const childErrorPayload = {
                error: err?.message || String(err),
                code: err?.code || null,
                attempts: 1,
                ...(err?.verification ? { verification: err.verification } : {}),
                ...(err?.judge ? { judge: err.judge } : {}),
                revision: 0,
              }
              transitionNode(ctx, { workflowId: workflow.id, stepId: childStepId, to: NODE_STATUS.FAILED, attempt: 1, resultJson: JSON.stringify(childErrorPayload) })
              nodeStates.set(childStepId, {
                ...nodeStates.get(childStepId),
                status: NODE_STATUS.FAILED,
                attempt: 1,
                error: err,
                result: childErrorPayload,
                ...(err?.verification ? { verification: err.verification } : {}),
                ...(err?.judge ? { judge: err.judge } : {}),
                revision: 0,
              })
              childResults[idx] = childErrorPayload
            }
          })
        )

        if (failingChildIds.length > 0) {
          const err = new Error(`fanout children failed: ${failingChildIds.join(', ')}`)
          err.code = 'FANOUT_CHILDREN_FAILED'
          err.failingChildIds = failingChildIds
          err.items = childResults
          err.count = items.length
          throw err
        }

        result = { items: childResults, count: items.length }
      } else if (node.type === 'fanin') {
        // C1.5 Fanin node aggregates results from all upstream dependencies
        const aggregated = {}
        for (const depId of node.dependsOn) {
          const depState = nodeStates.get(depId)
          aggregated[depId] = depState?.result ?? null
        }
        result = { aggregated }
      } else if (node.type === 'notify') {
        result = { notified: true, stepId: node.id }
      }

      // Transition to SUCCEEDED (only reachable after a real terminal outcome)
      const now = new Date().toISOString()
      transitionNode(ctx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.SUCCEEDED, attempt, resultJson: JSON.stringify(result ?? { success: true }) })
      nodeStates.set(node.id, {
        ...nodeStates.get(node.id),
        status: NODE_STATUS.SUCCEEDED,
        attempt,
        result,
        error: null,
        ...(verification ? { verification } : {}),
        ...(judge ? { judge } : {}),
        ...(producedHandoff ? { handoff: producedHandoff } : {}),
        revision,
      })

      appendEvent(
        {
          kind: 'job.finished',
          jobId: result?.job?.jobId ?? result?.jobId ?? `${workflow.id}_${node.id}`,
          workflow_id: workflow.id,
          step_id: node.id,
          agent: node.agent,
          model: node.model,
          cwd: node.cwd,
          title: node.task ?? node.id,
          harness: nodeHarness,
          waitMode: nodeWaitMode,
          ...(manifest ? { artifacts: manifest.artifacts } : {}),
          ...(verification ? { verification } : {}),
          ...(judge ? { judge } : {}),
          ...(producedHandoff ? { handoff: producedHandoff } : {}),
          revision,
        },
        { env }
      )

      return
    } catch (err) {
      lastError = err

      // A canceled job is terminal, and a node an external actor already
      // finalized must never be written over (see the helpers below).
      if (err.code === 'ECANCELED') {
        finalizeCanceledNode(ctx, { workflow, node, nodeStates, attempt, revision, error: err })
        return
      }
      if (adoptExternalTerminal(ctx, { workflow, node, nodeStates, attempt, revision, error: err })) return

      if (err.code === 'REVISION_REQUESTED' && revision < maxRevisionAttempts) {
        revisionFeedback = buildRevisionFeedback({ judge: err.judge, verification: err.verification })
        revision++
        attempt = 1
        transitionNode(ctx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.READY, attempt })
        claimNode(ctx, { workflowId: workflow.id, stepId: node.id, claimedBy, attempt })
        nodeStates.set(node.id, {
          ...nodeStates.get(node.id),
          attempt,
          revision,
        })
        continue
      }
      if (err.code === 'REVISION_REQUESTED' || err.code === 'JUDGE_REJECTED' || err.code === 'FANOUT_CHILDREN_FAILED') {
        break
      }
      if (attempt < maxAttempts) {
        const delay = backoffMs * attempt
        if (delay > 0) await sleep(delay)
        attempt++
        transitionNode(ctx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.READY, attempt })
        claimNode(ctx, { workflowId: workflow.id, stepId: node.id, claimedBy, attempt })
        nodeStates.set(node.id, {
          ...nodeStates.get(node.id),
          attempt,
        })
      } else {
        break
      }
    }
  }

  // Attempts exhausted -> FAILED. If an external actor finalized the node
  // meanwhile, adopt that instead of writing over a terminal state.
  if (adoptExternalTerminal(ctx, { workflow, node, nodeStates, attempt, revision, error: lastError })) return
  const now = new Date().toISOString()
  const errorPayload = {
    error: lastError?.message || String(lastError),
    code: lastError?.code || null,
    attempts: attempt,
    ...(lastError?.verification ? { verification: lastError.verification } : {}),
    ...(lastError?.judge ? { judge: lastError.judge } : {}),
    revision,
  }
  transitionNode(ctx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.FAILED, attempt, resultJson: JSON.stringify(errorPayload) })
  nodeStates.set(node.id, {
    ...nodeStates.get(node.id),
    status: NODE_STATUS.FAILED,
    attempt,
    error: lastError,
    result: errorPayload,
    ...(lastError?.judge ? { judge: lastError.judge } : {}),
    revision,
  })

  appendEvent(
    {
      kind: 'job.failed',
      jobId: `${workflow.id}_${node.id}`,
      workflow_id: workflow.id,
      step_id: node.id,
      agent: node.agent,
      model: node.model,
      cwd: node.cwd,
      title: node.task ?? node.id,
      summary: lastError?.message,
      harness: nodeHarness,
      waitMode: nodeWaitMode,
      ...(lastError?.verification ? { verification: lastError.verification } : {}),
      ...(lastError?.judge ? { judge: lastError.judge } : {}),
      revision,
    },
    { env }
  )
}

/**
 * Waits for a dispatch handle until terminal, handling waiting/timeout.
 * - terminal succeeded -> returns the record (node may advance)
 * - terminal failed/canceled -> throws (retry/fail path)
 * - waiting -> persists WAITING, blocks until external resume to running
 *   (no re-dispatch), then waits again
 * - local timeout -> abort + confirm + throw ETIMEDOUT (retry attempt+1)
 */
async function waitForHandleTerminal({
  workflow,
  node,
  ctx,
  env,
  handle,
  timeoutS,
  attempt,
  maxAttempts,
  nodeStates,
  claimedBy,
  waitExecutionFn,
  readRecord,
  onWaiting,
  waitingTimeoutS,
  pollIntervalMs,
}) {
  const jobId = handle.jobId ?? handle?.job?.jobId
  const waitStart = Date.now()
  for (;;) {
    const elapsedS = (Date.now() - waitStart) / 1000
    const remainingS = Math.max(1, timeoutS - elapsedS)
    const outcome = await waitExecutionFn(handle, {
      timeoutS: remainingS,
      pollIntervalMs,
      readResultFn: readRecord,
      onWaiting: async ({ record, reason }) => {
        await onWaiting?.({ workflowId: workflow.id, stepId: node.id, record, reason })
      },
    })

    if (outcome?.aborted) {
      const err = new Error(`Node "${node.id}" aborted (attempt ${attempt}/${maxAttempts})`)
      err.code = 'EABORTED'
      throw err
    }

    if (outcome?.waiting) {
      const reason = outcome.reason ?? 'external_event'
      // running -> waiting (persisted; scheduler holds the claim)
      const now = new Date().toISOString()
      transitionNode(ctx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.WAITING, attempt, claimedBy, resultJson: JSON.stringify({ waiting: true, waitReason: reason, jobId, remoteState: outcome.remoteState ?? null }) })
      nodeStates.set(node.id, {
        ...nodeStates.get(node.id),
        status: NODE_STATUS.WAITING,
        attempt,
        result: { waiting: true, waitReason: reason, jobId },
      })
      await onWaiting?.({ workflowId: workflow.id, stepId: node.id, record: outcome.record, reason })

      // Block until an external actor resumes (waiting -> running) without
      // dispatching again. Bounded so a forgotten wait still surfaces.
      const resumeDeadline = Date.now() + Math.max(1, waitingTimeoutS) * 1000
      for (;;) {
        await sleep(Math.max(10, pollIntervalMs))
        const row = getWorkflowNode(ctx, workflow.id, node.id)
        if (!row || row.status !== NODE_STATUS.WAITING) {
          const current = row?.status
          if (current === NODE_STATUS.RUNNING) break // resumed: wait on the same handle again
          if (current === NODE_STATUS.CANCELED) {
            const err = new Error(`Node "${node.id}" canceled while waiting`)
            err.code = 'ECANCELED'
            throw err
          }
          if (current === NODE_STATUS.FAILED) {
            const err = new Error(`Node "${node.id}" failed while waiting`)
            err.code = 'EWAITFAILED'
            throw err
          }
          break
        }
        if (Date.now() >= resumeDeadline) {
          try { await handle.abort?.() } catch {}
          const err = new Error(`Node "${node.id}" waiting timed out after ${waitingTimeoutS}s (attempt ${attempt}/${maxAttempts})`)
          err.code = 'ETIMEDOUT'
          throw err
        }
      }
      continue
    }

    if (outcome?.timedOut) {
      // Local deadline: abort the handle, confirm the record, retry attempt+1.
      let confirmed = null
      try {
        await handle.abort?.()
      } catch {}
      try {
        confirmed = readRecord(jobId)
      } catch {}
      if (confirmed && ['succeeded', 'failed', 'canceled'].includes(confirmed.status)) {
        if (confirmed.status === 'succeeded') return confirmed
        const err = new Error(`Node "${node.id}" confirmed ${confirmed.status} after abort: ${confirmed.error ?? ''}`)
        err.code = confirmed.status === 'canceled' ? 'ECANCELED' : 'EABORTED'
        err.record = confirmed
        throw err
      }
      const err = new Error(`Node "${node.id}" timed out after ${timeoutS}s (attempt ${attempt}/${maxAttempts})`)
      err.code = 'ETIMEDOUT'
      throw err
    }

    const status = outcome?.status ?? outcome?.record?.status
    const record = outcome?.record ?? null
    if (status === 'succeeded') {
      return record ?? { success: true, jobId }
    }
    if (status === 'failed' || status === 'canceled') {
      const err = new Error(
        `Node "${node.id}" execution ${status}: ${record?.error ?? record?.errorKind ?? 'unknown'} (attempt ${attempt}/${maxAttempts})`
      )
      err.code = status === 'canceled' ? 'ECANCELED' : 'EEXECFAILED'
      err.record = record
      throw err
    }
    // Unknown outcome shape: treat as timeout so the retry path engages.
    const err = new Error(`Node "${node.id}" wait returned unknown outcome (attempt ${attempt}/${maxAttempts})`)
    err.code = 'ETIMEDOUT'
    throw err
  }
}

/**
 * Runs a workflow DAG to completion.
 *
 * @param {object} params
 * @param {object} [params.workflow] - Workflow definition object
 * @param {string} [params.workflowId] - Workflow ID (for resumption from DB)
 * @param {object} [params.ctx] - DB storage context (from getDb(env))
 * @param {object} [params.env=process.env]
 * @param {Function} [params.dispatchFn=dispatch] - Dispatch function
 * @param {string} [params.claimedBy] - Scheduler worker identity for atomic CAS
 * @param {number} [params.pollIntervalMs=25]
 * @param {number} [params.backoffMs=50]
 * @returns {Promise<{ workflowId: string, status: string, nodes: Record<string, object> }>}
 */
export async function runWorkflow({
  workflow: inputWorkflow,
  workflowId: inputWorkflowId,
  ctx,
  env = process.env,
  dispatchFn = dispatch,
  runCommandFn = null,
  claimedBy = `scheduler_${crypto.randomUUID()}`,
  pollIntervalMs = 25,
  backoffMs = 50,
  waitExecutionFn = defaultWaitExecution,
  readResultFn = null,
  onWaiting = null,
  waitingTimeoutS = 300,
  leaseTtlMs = CLAIM_LEASE_TTL_MS,
  isOwnerAlive = null,
  stallTimeoutS = 0,
  heartbeatMs = 0,
  touchWorkflowNodeFn = touchWorkflowNode,
} = {}) {
  const dbCtx = ctx || getDb(env)
  let workflow = null
  const isResume = Boolean(!inputWorkflow && inputWorkflowId)
  // Liveness probe semantics: a foreign owner is presumed GONE only when its
  // lease expired. Pass an explicit isOwnerAlive(owner, me) to reclaim earlier
  // (probe says dead). Without a probe a fresh claim is respected: we never
  // steal a live peer's node.
  const ownerAlive = typeof isOwnerAlive === 'function' ? isOwnerAlive : () => false
  const hasExplicitProbe = typeof isOwnerAlive === 'function'

  if (inputWorkflow) {
    workflow = createWorkflow(inputWorkflow)
    upsertWorkflow(dbCtx, {
      id: workflow.id,
      name: workflow.name,
      created_at: workflow.createdAt,
      definition_json: JSON.stringify(workflow),
      status: 'running',
      updated_at: new Date().toISOString(),
    })
  } else if (inputWorkflowId) {
    const row = getWorkflow(dbCtx, inputWorkflowId)
    if (!row) {
      throw new Error(`Workflow not found: ${inputWorkflowId}`)
    }
    workflow = createWorkflow(JSON.parse(row.definition_json))
  } else {
    throw new Error('Either workflow or workflowId must be provided')
  }

  // Load existing node state from DB
  const nodeStates = new Map()
  const existingRows = listWorkflowNodes(dbCtx, workflow.id)
  const existingByStep = new Map(existingRows.map((r) => [r.step_id, r]))

  for (const node of workflow.nodes) {
    const row = existingByStep.get(node.id)
    if (row) {
      let result = null
      try {
        result = row.result_json ? JSON.parse(row.result_json) : null
      } catch {
        result = row.result_json
      }

      let status = row.status
      let claimed = row.claimed_by

      // An orphaned node (owner gone) is re-queued only when its lease expired
      // or an explicit probe says the owner is dead; a live peer's node is
      // never stolen.
      if (reclaimOrphanedNode(dbCtx, { workflowId: workflow.id, stepId: node.id, row, claimedBy, ownerAlive, hasExplicitProbe, leaseTtlMs })) {
        status = NODE_STATUS.READY
        claimed = null
      }

      let existingHandoff = null
      try {
        existingHandoff = readHandoff({ workflowId: workflow.id, stepId: node.id }, env)
      } catch {}

      nodeStates.set(node.id, {
        status,
        attempt: row.attempt || 0,
        result,
        error: null,
        claimed_by: status === NODE_STATUS.READY ? null : (status === row.status ? claimed : claimed),
        ...(existingHandoff ? { handoff: existingHandoff } : {}),
      })
    } else {
      const now = new Date().toISOString()
      upsertWorkflowNode(dbCtx, { workflow_id: workflow.id, step_id: node.id, status: NODE_STATUS.PENDING, attempt: 0, updated_at: now })
      nodeStates.set(node.id, {
        status: NODE_STATUS.PENDING,
        attempt: 0,
        result: null,
        error: null,
        claimed_by: null,
      })
    }
  }

  // Execution loop (wave scheduler). Progress is tracked by the node-state
  // signature: if nothing changes for the stall budget, the run fails with a
  // diagnostic instead of waiting (or spinning) forever. Default budget is
  // 5x the claim lease.
  const stallBudgetMs = (stallTimeoutS > 0 ? stallTimeoutS : Math.max(30, (leaseTtlMs / 1000) * 5)) * 1000
  // Refresh the claim lease well before it expires, so the node never looks
  // dead to a peer while it is genuinely working.
  const heartbeatIntervalMs = heartbeatMs > 0 ? heartbeatMs : Math.max(1000, Math.floor(leaseTtlMs / 3))
  let lastSignature = null
  let lastProgressAt = Date.now()

  while (true) {
    refreshNodeStates(dbCtx, workflow.id, nodeStates)

    // A peer can die mid-run, so the lease is re-checked on every pass: an
    // orphan is reclaimed as soon as its lease expires, which is what bounds
    // the wait below instead of hanging on a dead claim.
    for (const candidate of workflow.nodes) {
      const candidateRow = getWorkflowNode(dbCtx, workflow.id, candidate.id)
      if (reclaimOrphanedNode(dbCtx, { workflowId: workflow.id, stepId: candidate.id, row: candidateRow, claimedBy, ownerAlive, hasExplicitProbe, leaseTtlMs })) {
        nodeStates.set(candidate.id, {
          ...(nodeStates.get(candidate.id) || {}),
          status: NODE_STATUS.READY,
          attempt: candidateRow.attempt,
          claimed_by: null,
        })
      }
    }

    const signature = workflow.nodes
      .map((n) => `${n.id}:${nodeStates.get(n.id)?.status ?? ''}:${nodeStates.get(n.id)?.attempt ?? ''}`)
      .join('|')
    const leaseAlive = hasFreshLease(dbCtx, { workflow, leaseTtlMs })
    if (signature !== lastSignature || leaseAlive) {
      lastSignature = signature
      lastProgressAt = Date.now()
    } else if (Date.now() - lastProgressAt > stallBudgetMs) {
      const stuck = workflow.nodes
        .filter((n) => !isTerminalStatus(nodeStates.get(n.id)?.status))
        .map((n) => `${n.id}=${nodeStates.get(n.id)?.status ?? 'unknown'} owner=${nodeStates.get(n.id)?.claimed_by ?? 'none'}`)
        .join(', ')
      appendEvent(
        { kind: 'workflow.stalled', workflow_id: workflow.id, reason: 'no node state change', stuck, stallTimeoutS: stallBudgetMs / 1000 },
        { env }
      )
      throw new Error(`Workflow "${workflow.id}" stalled: no node state change for ${stallBudgetMs / 1000}s (${stuck})`)
    }

    const isAllTerminal = workflow.nodes.every((n) => isTerminalStatus(nodeStates.get(n.id)?.status))
    if (isAllTerminal) break

    // 1. Dependency resolution
    const resolution = resolveDependencies({ workflow, nodeStates })

    // 2. Persist skipped transitions
    for (const { node, reason } of resolution.skipped) {
      const current = nodeStates.get(node.id)
      if (current && current.status !== NODE_STATUS.SKIPPED) {
        const now = new Date().toISOString()
        const skipResult = { skipped: true, reason }
        transitionNode(dbCtx, { workflowId: workflow.id, stepId: node.id, to: NODE_STATUS.SKIPPED, attempt: current.attempt, resultJson: JSON.stringify(skipResult) })
        nodeStates.set(node.id, {
          ...current,
          status: NODE_STATUS.SKIPPED,
          result: skipResult,
        })
      }
    }

    // 3. Ready wave execution
    const readyNodes = resolution.ready

    if (readyNodes.length === 0) {
      const anyActive = Array.from(nodeStates.values()).some(
        (s) => s.status === NODE_STATUS.RUNNING || s.status === NODE_STATUS.WAITING
      )
      if (anyActive) {
        await sleep(pollIntervalMs)
        continue
      }
      break
    }

    // 4. Parallel wave execution via Promise.all
    let claimedAny = false
    await Promise.all(
      readyNodes.map(async (node) => {
        // Publish PENDING -> READY through a CONDITIONAL update (only from
        // pending): it can never overwrite another scheduler's running
        // claim, so the CAS claim below stays the single winner gate.
        publishWorkflowNodeReady(dbCtx, { workflowId: workflow.id, stepId: node.id })
        const published = getWorkflowNode(dbCtx, workflow.id, node.id)
        if (published?.status === NODE_STATUS.READY) {
          nodeStates.set(node.id, { ...nodeStates.get(node.id), status: NODE_STATUS.READY })
        }
        // Atomic CAS Claim via claimNode: única vía ready→running (C1.8 / C1.9)
        const currentAttempt = (nodeStates.get(node.id)?.attempt || 0) + 1
        const claimed = claimNode(dbCtx, {
          workflowId: workflow.id,
          stepId: node.id,
          claimedBy,
          attempt: currentAttempt,
        })

        if (!claimed) {
          // Another scheduler already claimed or executed this node
          return
        }
        claimedAny = true

        nodeStates.set(node.id, {
          ...nodeStates.get(node.id),
          status: NODE_STATUS.RUNNING,
          attempt: currentAttempt,
          claimed_by: claimedBy,
        })

        const stopHeartbeat = startNodeHeartbeat(dbCtx, {
          workflowId: workflow.id,
          stepId: node.id,
          intervalMs: heartbeatIntervalMs,
          touchFn: touchWorkflowNodeFn,
        })
        try {
          await executeNode({
            workflow,
            node,
            ctx: dbCtx,
            env,
            dispatchFn,
            runCommandFn,
            nodeStates,
            claimedBy,
            backoffMs,
            waitExecutionFn,
            readResultFn,
            onWaiting,
            waitingTimeoutS,
            pollIntervalMs,
          })
        } finally {
          stopHeartbeat()
        }
      })
    )

    // A whole ready wave that nobody could claim means another scheduler owns
    // those nodes (or a stale claim blocks the CAS). Yield instead of spinning:
    // without this the loop burns CPU at 100% until the claim frees up.
    if (!claimedAny) await sleep(pollIntervalMs)
  }

  refreshNodeStates(dbCtx, workflow.id, nodeStates)

  const allSucceeded = workflow.nodes.every(
    (n) =>
      nodeStates.get(n.id)?.status === NODE_STATUS.SUCCEEDED ||
      nodeStates.get(n.id)?.status === NODE_STATUS.SKIPPED
  )

  const finalStatus = allSucceeded ? 'succeeded' : 'failed'
  const existingWorkflow = getWorkflow(dbCtx, workflow.id)
  const previousStatus = existingWorkflow?.status

  upsertWorkflow(dbCtx, {
    id: workflow.id,
    name: workflow.name,
    status: finalStatus,
    updated_at: new Date().toISOString(),
  })

  if (!isTerminalStatus(previousStatus)) {
    const counts = {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      canceled: 0,
    }
    for (const state of nodeStates.values()) {
      counts.total++
      if (state?.status === NODE_STATUS.SUCCEEDED) counts.succeeded++
      else if (state?.status === NODE_STATUS.FAILED) counts.failed++
      else if (state?.status === NODE_STATUS.SKIPPED) counts.skipped++
      else if (state?.status === NODE_STATUS.CANCELED) counts.canceled++
    }

    appendEvent(
      {
        kind: 'workflow.completed',
        workflow_id: workflow.id,
        status: finalStatus,
        counts,
      },
      { env }
    )
  }

  return {
    workflowId: workflow.id,
    status: finalStatus,
    nodes: Object.fromEntries(nodeStates.entries()),
  }
}

export { isHandleLike }

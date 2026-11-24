/**
 * Reroute after start: a job that STARTED and then failed on quota or a rate
 * limit moves to the next routed fallback instead of ending the dispatch.
 *
 * dispatch() only recovers while a job fails to start (preflight, breaker,
 * lock); once the CLI is running, a quota error is finalized as `failed`. The
 * MCP supervisor (src/notify/mcp-supervisor.mjs) uses these helpers to carry on.
 * Only quota-class failures qualify; every other errorKind ends the dispatch as
 * before.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { classifyError } from './policy/taxonomy.mjs'
import { applyScopedPatch } from './scratchwrite.mjs'

export const DEFAULT_MAX_REROUTES = 3

export function rerouteEnabled(env = process.env) {
  const v = String(env?.AGENT_HUB_REROUTE ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

export function maxReroutes(env = process.env) {
  const n = Number.parseInt(env?.AGENT_HUB_REROUTE_MAX ?? '', 10)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_REROUTES
}

/** A finished job that failed on quota/rate limit (classified like the policy layer does). */
export function isQuotaFailure(record) {
  if (!record || record.status !== 'failed') return false
  return classifyError(record.error ?? '', { errorKind: record.errorKind }) === 'quota'
}

/**
 * A write job's partial work. A job running in a worktree left its edits in
 * place already. A scoped writer's edits live in a scratch copy that is gone,
 * but its in-scope diff was saved as a patch: apply it to the tree so the next
 * attempt starts from it. Returns a description of what the next attempt finds.
 */
export async function preservePartialWork(previous, { env = process.env, exec = execFileSync } = {}) {
  if (previous?.mode !== 'write') return { kind: 'none' }
  const sw = previous.scratchWrite
  if (!sw) return { kind: 'worktree' }
  if (sw.applied) return { kind: 'applied' }
  const paths = sw.unappliedPaths ?? []
  if (!sw.patchPath || paths.length === 0 || !fs.existsSync(sw.patchPath)) return { kind: 'none' }
  try {
    const root = exec('git', ['rev-parse', '--show-toplevel'], { cwd: previous.cwd, encoding: 'utf8' }).trim()
    const outcome = await applyScopedPatch({ root, patch: fs.readFileSync(sw.patchPath), inScope: paths, env })
    if (outcome.ok) return { kind: 'patch-applied', paths }
    return { kind: 'patch-conflict', paths, patchPath: sw.patchPath }
  } catch {
    return { kind: 'patch-conflict', paths, patchPath: sw.patchPath }
  }
}

/** The task text for the next attempt: the original task plus what happened. */
export function buildRerouteTask({ task, previous, partial }) {
  const who = [previous?.agent, previous?.model].filter(Boolean).join('/')
  const why = `${previous?.errorKind ?? 'quota'}${previous?.error ? `: ${previous.error}` : ''}`
  const lines = ['', '', `[agent-hub reroute] A previous attempt (${who || 'unknown'}) stopped before finishing: ${why}.`]
  switch (partial?.kind) {
    case 'worktree':
    case 'patch-applied':
    case 'applied':
      lines.push(
        'It may have left partial changes in the working tree. Before doing anything else run `git status` and `git diff`, review what is there, and continue the work from those changes instead of starting from a clean tree.'
      )
      break
    case 'patch-conflict':
      lines.push(
        `Its partial changes could not be applied to the tree; they are saved as a patch at ${partial.patchPath} (apply or read it with \`git apply\` / \`git apply --stat\`). Run \`git status\` and \`git diff\` first, then continue the work.`
      )
      break
    default:
      return task
  }
  return `${task}${lines.join('\n')}`
}

const MAX_CHAIN_HOPS = 10

/**
 * A job that was rerouted after quota is not the end of its dispatch: the
 * supervisor marks it with `reroutePending` while the next attempt starts and
 * `reroutedTo` once it runs. Read-side views (job_status, job_wait, job_result,
 * job_cancel) call this to report the dispatch's outcome through the original
 * job id. Returns null for a job that never rerouted, so its view is unchanged.
 */
export function rerouteOverlay(record, readResultFn, env = process.env, depth = 0) {
  if (!record || (!record.reroutedTo && !record.reroutePending)) return null
  const pending = { status: 'running', errorKind: null, error: null, updatedAt: record.updatedAt, reroutedTo: record.reroutedTo ?? null, finalJobId: null, tail: null }
  if (!record.reroutedTo || depth >= MAX_CHAIN_HOPS) return pending
  let next
  try {
    next = readResultFn(record.reroutedTo, env)
  } catch {
    return pending
  }
  const deeper = rerouteOverlay(next, readResultFn, env, depth + 1)
  if (deeper) return { ...deeper, reroutedTo: record.reroutedTo }
  return {
    status: next.status,
    errorKind: next.errorKind ?? null,
    error: next.error ?? null,
    updatedAt: next.updatedAt ?? record.updatedAt,
    reroutedTo: record.reroutedTo,
    finalJobId: next.jobId,
    tail: next,
  }
}

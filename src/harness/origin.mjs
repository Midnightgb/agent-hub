/**
 * C1.2 harness-origin mapping: jobId -> harness session.
 *
 * recordOrigin() persists which harness session (e.g. the calling
 * Claude Code / OpenCode session) a job was dispatched from, so a FUTURE
 * wake-up bridge can route completion/attention back to the right session.
 *
 * Deliberately mapping-only: NOTHING consumes this table yet, no wake-up is
 * attempted anywhere, and every profile in src/harness/ documents
 * supportsWake=false. Harness Profiles quedan como están (no behavior
 * change): this module only records provenance.
 */
import { getDb, upsertHarnessOrigin, getHarnessOrigin } from '../storage/index.mjs'

/**
 * Persist the jobId -> harness-session mapping.
 * @param {object} [params]
 * @param {string} [params.jobId]
 * @param {string} [params.harnessSessionId]
 * @param {string} [params.harness] - harness profile id ('generic' | 'claude-code' | 'opencode')
 * @param {object} [params.env=process.env]
 * @returns {object|null} the stored row, or null when there is no jobId to map
 */
export function recordOrigin({ jobId, harnessSessionId, harness, env = process.env } = {}) {
  if (jobId == null || String(jobId).length === 0) return null
  const ctx = getDb(env)
  return upsertHarnessOrigin(ctx, {
    job_id: String(jobId),
    harness_session_id: harnessSessionId ?? null,
    harness: harness ?? null,
  })
}

/**
 * Read the mapping back, or null when the job has no recorded origin.
 */
export function getOrigin(jobId, { env = process.env } = {}) {
  if (jobId == null || String(jobId).length === 0) return null
  const ctx = getDb(env)
  return getHarnessOrigin(ctx, String(jobId))
}

/**
 * Extract a harness session id from an MCP handler's extra argument
 * (the SDK delivers it beside args — e.g. extra._meta/sessionId — never
 * inside args). Returns null when the transport provided none.
 */
export function harnessSessionIdFromExtra(extra) {
  if (!extra || typeof extra !== 'object') return null
  // SDK 1.x delivered _meta on the extra itself; SDK 2.x nests it under ctx.mcpReq.
  const raw = extra._meta ?? extra.mcpReq?._meta
  const meta = raw && typeof raw === 'object' ? raw : null
  return (
    extra.sessionId ??
    extra.harnessSessionId ??
    extra.clientSessionId ??
    meta?.sessionId ??
    meta?.harnessSessionId ??
    null
  )
}

/**
 * Best-effort origin capture for dispatch/delegate handlers: records the
 * mapping only when both a jobId and a harness session id are known,
 * never throws (origin bookkeeping must not fail a dispatch).
 * @returns {object|null} the stored row, or null when skipped/failed
 */
export function recordDispatchOrigin({ jobId, extra, harness, env = process.env } = {}) {
  try {
    if (jobId == null || String(jobId).length === 0) return null
    const harnessSessionId = harnessSessionIdFromExtra(extra)
    if (harnessSessionId == null) return null
    return recordOrigin({ jobId, harnessSessionId, harness, env })
  } catch {
    return null
  }
}

/**
 * Policy registry for Fase A execution policies.
 * Maps error categories to recovery policies (retry, resume, fallback, escalation).
 *
 * Covers every ERROR_TAXONOMY category so policyFor() never returns null for
 * a classified error — dispatch() (A1) can rely on a declarative policy for
 * any failure. `retry: N` caps attempts for that class (billing/auth never
 * retry: retrying them burns quota or loops on a rejected key).
 */

export const POLICY_TABLE = {
  // A rejected key or dead card will not fix itself: fail fast to a human.
  billing: { retry: false, resume: false, fallback: false, escalation: 'human' },
  auth: { retry: false, resume: false, fallback: false, escalation: 'human' },
  // Quota may clear on reset or another account: retry, then fall back
  // (next chain candidate / next Jules account), then escalate.
  quota: { retry: 2, resume: false, fallback: true, escalation: 'human' },
  timeout: { retry: true, resume: true, fallback: false, escalation: 'verifier' },
  // A dropped connection (e.g. opencode replacing its shared service after an
  // auto-update, ~3-9s) usually recovers on its own: wait, retry once, then
  // fall back. Retrying immediately or repeatedly would re-run a write task
  // over partial edits while the service is still coming back.
  transport: { retry: 1, retryDelayMs: 10_000, resume: false, fallback: true, escalation: 'human' },
  // A crashed CLI may be transient: one bounded retry, then alternate adapter.
  crash: { retry: 1, resume: false, fallback: true, escalation: 'human' },
  quality: { retry: false, resume: false, fallback: true, escalation: 'verifier' },
  'write-conflict': { retry: false, resume: false, fallback: false, escalation: 'human' },
  // T4 (opencode-live-catalog): never retry the same model#variant (it will
  // fail identically), but DO fall back -- a different chain candidate (a
  // different model, or the same model without that variant) may well work.
  no_route: { retry: false, resume: false, fallback: true, escalation: 'human' },
}

/**
 * Returns the ExecutionPolicy for a given error category.
 *
 * @param {string} category
 * @returns {object|null}
 */
export function policyFor(category) {
  return POLICY_TABLE[category] ?? null
}

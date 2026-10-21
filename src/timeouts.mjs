import { resolveTimeoutS, ADAPTIVE_TIMEOUT, METRICS_MIN_SAMPLES, TASK_TYPE_TIMEOUTS_S } from './config.mjs'
import { metricsFor } from './metrics.mjs'

/**
 * Effective timeout for one job: an explicit timeoutS always wins; otherwise
 * the static default from config.mjs, raised (never lowered) from observed
 * p95 latency once there are enough samples.
 *
 * Work package P3: applies adaptive timeouts by querying metrics for
 * (agent, model, mode, taskType). If taskType data is thin or absent, it
 * falls back to general (taskType: null) metrics. Latency is scaled by
 * ADAPTIVE_TIMEOUT.multiplier and capped at ADAPTIVE_TIMEOUT.capS.
 * Metrics retrieval errors are safely caught to prevent breaking delegation.
 *
 * @param {object} [params]
 * @param {string} [params.agent]
 * @param {string} [params.model]
 * @param {string} [params.mode='read']
 * @param {string|null} [params.taskType=null]
 * @param {number} [params.explicit]
 * @param {object} [params.env=process.env]
 * @param {Function} [params.metricsForFn=metricsFor]
 * @returns {{timeoutS: number, source: 'explicit'|'adaptive'|'default', p95Ms: number|null, samples: number}}
 */
export function resolveEffectiveTimeoutS({
  agent,
  model,
  mode = 'read',
  taskType = null,
  explicit,
  env = process.env,
  metricsForFn = metricsFor,
} = {}) {
  if (explicit != null) {
    return { timeoutS: explicit, source: 'explicit', p95Ms: null, samples: 0 }
  }

  const base = Math.max(resolveTimeoutS(agent, model), TASK_TYPE_TIMEOUTS_S[taskType] ?? 0)

  let row = null
  try {
    row = metricsForFn({ agent, model, mode, taskType, env })
    const isRowEligible = (r) => r != null && r.samples >= METRICS_MIN_SAMPLES && r.p95Ms != null

    if (taskType != null && !isRowEligible(row)) {
      const fallbackRow = metricsForFn({ agent, model, mode, taskType: null, env })
      if (isRowEligible(fallbackRow)) {
        row = fallbackRow
      }
    }
  } catch {
    return { timeoutS: base, source: 'default', p95Ms: null, samples: 0 }
  }

  const samples = row?.samples ?? 0
  const p95Ms = row?.p95Ms ?? null

  if (samples >= METRICS_MIN_SAMPLES && p95Ms != null) {
    const adaptive = Math.min(
      ADAPTIVE_TIMEOUT.capS,
      Math.ceil((p95Ms / 1000) * ADAPTIVE_TIMEOUT.multiplier)
    )
    if (adaptive > base) {
      return { timeoutS: adaptive, source: 'adaptive', p95Ms, samples }
    }
  }

  return { timeoutS: base, source: 'default', p95Ms, samples }
}

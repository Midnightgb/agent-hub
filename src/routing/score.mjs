import { capabilitiesFor } from '../capabilities.mjs'
import { METRICS_MIN_SAMPLES } from '../config.mjs'

export const DEFAULT_PREFERENCES = Object.freeze({ quality: 0.5, cost: 0.2, latency: 0.3 })

export function metricKey(agent, model) {
  return agent + ':' + model
}

export function normalizePreferences(preferences = {}) {
  let q = Number.isFinite(preferences?.quality) ? Math.max(preferences.quality, 0) : 0
  let c = Number.isFinite(preferences?.cost) ? Math.max(preferences.cost, 0) : 0
  let l = Number.isFinite(preferences?.latency) ? Math.max(preferences.latency, 0) : 0

  let sum = q + c + l
  if (sum === 0) {
    q = DEFAULT_PREFERENCES.quality
    c = DEFAULT_PREFERENCES.cost
    l = DEFAULT_PREFERENCES.latency
    sum = q + c + l
  }

  const qNorm = Math.round((q / sum) * 10000) / 10000
  const cNorm = Math.round((c / sum) * 10000) / 10000
  const lNorm = Math.round((l / sum) * 10000) / 10000

  const weights = { quality: qNorm, cost: cNorm, latency: lNorm }
  const currentSum = Math.round((weights.quality + weights.cost + weights.latency) * 10000) / 10000
  const drift = Math.round((1 - currentSum) * 10000) / 10000

  if (drift !== 0) {
    let maxKey = 'quality'
    if (weights.cost > weights[maxKey]) maxKey = 'cost'
    if (weights.latency > weights[maxKey]) maxKey = 'latency'
    weights[maxKey] = Math.round((weights[maxKey] + drift) * 10000) / 10000
  }

  return weights
}

export function rankCandidates({ candidates = [], metrics = {}, preferences = {}, requirements = [], modelRegistry, minSamples = METRICS_MIN_SAMPLES, env = process.env } = {}) {
  const excluded = []
  const eligible = []
  // browser is the only environment-detected capability; read config files only when it is required.
  const capsEnv = requirements.includes('browser') ? env : null

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]
    const caps = capabilitiesFor(candidate.agent, candidate.model, { modelRegistry, env: capsEnv })
    const missing = requirements.filter((req) => !caps[req])
    if (missing.length > 0) {
      excluded.push({ agent: candidate.agent, model: candidate.model, missing })
    } else {
      eligible.push({ candidate, index: i })
    }
  }

  for (const item of eligible) {
    const { candidate } = item
    const row = metrics?.[metricKey(candidate.agent, candidate.model)]
    const insufficientSamples = row && row.samples !== undefined && row.samples < minSamples

    item.insufficientSamples = insufficientSamples
    item.qualityRaw = Number.isFinite(row?.qualityScore) ? Math.min(Math.max(row.qualityScore / 10, 0), 1)
                    : Number.isFinite(row?.verifiedRate) ? row.verifiedRate
                    : Number.isFinite(row?.successRate) ? row.successRate : null
    item.latencyMs  = Number.isFinite(row?.p95Ms) ? row.p95Ms : null
    item.costUsd    = Number.isFinite(row?.costUsdAvg) ? row.costUsdAvg : null

    item.qualityNorm = item.qualityRaw !== null ? item.qualityRaw : null
  }

  const latencies = eligible.filter(item => !item.insufficientSamples).map((item) => item.latencyMs).filter((v) => v !== null)
  const minLatency = latencies.length > 0 ? Math.min(...latencies) : null
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : null

  const costs = eligible.filter(item => !item.insufficientSamples).map((item) => item.costUsd).filter((v) => v !== null)
  const minCost = costs.length > 0 ? Math.min(...costs) : null
  const maxCost = costs.length > 0 ? Math.max(...costs) : null

  for (const item of eligible) {
    if (item.insufficientSamples) {
      item.latencyNorm = null
      item.costNorm = null
      item.qualityNorm = null
      continue
    }

    if (item.latencyMs === null) {
      item.latencyNorm = null
    } else if (maxLatency === minLatency) {
      item.latencyNorm = 1
    } else {
      item.latencyNorm = 1 - (item.latencyMs - minLatency) / (maxLatency - minLatency)
    }

    if (item.costUsd === null) {
      item.costNorm = null
    } else if (maxCost === minCost) {
      item.costNorm = 1
    } else {
      item.costNorm = 1 - (item.costUsd - minCost) / (maxCost - minCost)
    }
  }

  const baseWeights = normalizePreferences(preferences)

  const scored = eligible.map((item) => {
    const rawMap = { quality: item.qualityRaw, latency: item.latencyMs, cost: item.costUsd }
    const normMap = { quality: item.qualityNorm, latency: item.latencyNorm, cost: item.costNorm }

    let activeWeightSum = 0
    if (normMap.quality !== null) activeWeightSum += baseWeights.quality
    if (normMap.latency !== null) activeWeightSum += baseWeights.latency
    if (normMap.cost !== null) activeWeightSum += baseWeights.cost

    let totalScore = 0
    const reasons = ['quality', 'latency', 'cost'].map((dim) => {
      const raw = rawMap[dim]

      if (item.insufficientSamples) {
        return {
          dimension: dim,
          raw,
          normalized: null,
          weight: 0,
          contribution: 0,
          note: 'insufficient samples',
        }
      }

      const normalized = normMap[dim]
      if (normalized === null || activeWeightSum === 0) {
        return {
          dimension: dim,
          raw,
          normalized,
          weight: 0,
          contribution: 0,
          note: 'no data',
        }
      }
      const weight = baseWeights[dim] / activeWeightSum
      const contribution = weight * normalized
      totalScore += contribution
      return {
        dimension: dim,
        raw,
        normalized,
        weight,
        contribution,
        note: null,
      }
    })

    const score = Math.min(Math.max(Math.round(totalScore * 10000) / 10000, 0), 1)
    return {
      entry: { ...item.candidate, score, reasons },
      index: item.index,
    }
  })

  scored.sort((a, b) => {
    if (b.entry.score !== a.entry.score) {
      return b.entry.score - a.entry.score
    }
    return a.index - b.index
  })

  return {
    ranking: scored.map((s) => s.entry),
    excluded,
  }
}

export const KNOWN_CHANNELS = new Set(['console', 'file', 'webhook'])
export const KNOWN_SEVERITIES = new Set(['info', 'warn', 'error'])

export const DEFAULT_POLICY = Object.freeze({
  'job.finished': Object.freeze({
    channels: Object.freeze(['console']),
    severity: 'info',
    dedupMs: 0,
  }),
  'job.failed': Object.freeze({
    channels: Object.freeze(['console', 'file']),
    severity: 'error',
    dedupMs: 0,
  }),
  'job.canceled': Object.freeze({
    channels: Object.freeze(['console']),
    severity: 'warn',
    dedupMs: 0,
  }),
  'jules.waiting': Object.freeze({
    channels: Object.freeze(['console', 'file']),
    severity: 'warn',
    dedupMs: 60000,
  }),
  'jules.attention_required': Object.freeze({
    channels: Object.freeze(['console', 'file', 'webhook']),
    severity: 'error',
    dedupMs: 300000,
  }),
  'workflow.completed': Object.freeze({
    channels: Object.freeze(['console', 'file']),
    severity: 'info',
    dedupMs: 0,
  }),
})

export function normalizePolicy(policy) {
  try {
    const merged = {}
    for (const [cat, def] of Object.entries(DEFAULT_POLICY)) {
      merged[cat] = {
        channels: [...def.channels],
        severity: def.severity,
        dedupMs: def.dedupMs,
      }
    }
    if (!policy || typeof policy !== 'object') {
      return merged
    }
    for (const [cat, override] of Object.entries(policy)) {
      if (!override || typeof override !== 'object') continue
      const base = merged[cat] ?? { channels: [], severity: 'info', dedupMs: 0 }
      let channels = base.channels
      if (Array.isArray(override.channels)) {
        channels = override.channels.filter((c) => typeof c === 'string' && KNOWN_CHANNELS.has(c))
      }
      let severity = base.severity
      if (typeof override.severity === 'string' && KNOWN_SEVERITIES.has(override.severity)) {
        severity = override.severity
      }
      let dedupMs = base.dedupMs
      if (typeof override.dedupMs === 'number' && Number.isFinite(override.dedupMs) && override.dedupMs >= 0) {
        dedupMs = override.dedupMs
      }
      merged[cat] = { channels, severity, dedupMs }
    }
    return merged
  } catch {
    const fallback = {}
    for (const [cat, def] of Object.entries(DEFAULT_POLICY)) {
      fallback[cat] = {
        channels: [...def.channels],
        severity: def.severity,
        dedupMs: def.dedupMs,
      }
    }
    return fallback
  }
}

export function decideNotification({ category, policy = DEFAULT_POLICY, history = {}, now = Date.now() } = {}) {
  try {
    if (!category || typeof category !== 'string') {
      return { deliver: false, channels: [], severity: 'info', reason: 'unknown category' }
    }
    const entry = policy?.[category]
    if (!entry || typeof entry !== 'object') {
      return { deliver: false, channels: [], severity: 'info', reason: 'unknown category' }
    }
    const channels = Array.isArray(entry.channels) ? [...entry.channels] : []
    const severity = typeof entry.severity === 'string' ? entry.severity : 'info'
    const dedupMs = typeof entry.dedupMs === 'number' && Number.isFinite(entry.dedupMs) && entry.dedupMs >= 0 ? entry.dedupMs : 0

    const lastTs = history?.[category]
    const isTimestamp = typeof lastTs === 'number' && Number.isFinite(lastTs)
    if (isTimestamp && (now - lastTs) < dedupMs) {
      return { deliver: false, channels: [], severity, reason: 'deduped' }
    }
    return { deliver: true, channels, severity, reason: 'delivered' }
  } catch {
    return { deliver: false, channels: [], severity: 'info', reason: 'unknown category' }
  }
}

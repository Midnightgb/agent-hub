/**
 * Error taxonomy for Fase A execution policies.
 * Categorizes errors to drive retry, backoff, and circuit breaker decisions.
 */

export const ERROR_TAXONOMY = {
  billing: { retry: false, immediate: true },
  auth: { retry: false },
  quota: { retry: 'afterReset' },
  timeout: { retry: true, kind: 'timeout' },
  transport: { retry: true },
  crash: { retry: false },
  quality: { retry: false },
  // T4 (opencode-live-catalog): an unsupported reasoning-effort variant
  // (opencode's provider.no-route / "Variant unavailable"). Retrying the
  // exact same model#variant would fail identically every time, and this
  // must never be mistaken for the model itself crashing.
  no_route: { retry: false },
}

/**
 * Classifies an error message / payload and metadata into an ERROR_TAXONOMY category.
 *
 * @param {string|Error|null} text Error text, message, or Error instance
 * @param {object} [meta={}] Metadata such as { timedOut, errorKind, kind, status, code, exitCode }
 * @returns {keyof typeof ERROR_TAXONOMY}
 */
export function classifyError(text, meta = {}) {
  if (meta?.category && meta.category in ERROR_TAXONOMY) {
    return meta.category
  }

  // Check explicit errorKind or kind if already categorized
  const kind = meta?.errorKind || meta?.kind
  if (kind && kind in ERROR_TAXONOMY) {
    return kind
  }
  if (kind === 'empty' || kind === 'incomplete' || kind === 'read_mode_violation') {
    return 'quality'
  }

  // Timeout signaled via meta
  if (meta?.timedOut) {
    return 'timeout'
  }

  // Numeric HTTP status or exit codes
  const status = Number(meta?.status || meta?.statusCode || meta?.httpStatus)
  if (status === 402) return 'billing'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'quota'
  if (status === 502 || status === 503 || status === 504) return 'transport'

  // System error codes
  const code = String(meta?.code || '').toUpperCase()
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout'
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'transport'

  // Inspect error string representation
  let raw = ''
  if (typeof text === 'string') {
    raw = text
  } else if (text instanceof Error) {
    raw = `${text.name || ''} ${text.message || ''} ${text.stack || ''}`
  } else if (text && typeof text === 'object') {
    raw = JSON.stringify(text)
  }

  // Text heuristics
  if (/402|insufficient[ _-]balance|payment[ _-]required|out of credits/i.test(raw)) {
    return 'billing'
  }
  if (/401|403|unauthenticated|unauthorized|not logged in|invalid[ _-]api[ _-]key|forbidden/i.test(raw)) {
    return 'auth'
  }
  if (/429|resource[ _-]exhausted|rate[ _-]limit|quota/i.test(raw)) {
    return 'quota'
  }
  if (/timeout|timed out|deadline exceeded|print timeout/i.test(raw)) {
    return 'timeout'
  }
  if (/econnreset|econnrefused|enotfound|socket hang up|network error|fetch failed|502|503|504|bad gateway|service unavailable|gateway timeout/i.test(raw)) {
    return 'transport'
  }
  if (/empty response|read[ _-]mode[ _-]violation|malformed/i.test(raw)) {
    return 'quality'
  }
  if (/sigsegv|sigabrt|crash|uncaughtexception|process terminated|exit code [1-9]/i.test(raw)) {
    return 'crash'
  }

  return 'crash'
}

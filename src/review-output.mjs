import { HANDOFF_LIMITS } from './handoff.mjs'

// same-tree-fanout (S5): `output: 'review'` on delegate/dispatch asks the agent
// to end its reply with one fenced JSON block of findings, and job_result
// returns it parsed and validated. A missing or invalid block never fails the
// job: it is reported as `reviewError` next to the plain text.

export const REVIEW_SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'info'])

export const REVIEW_OUTPUT_INSTRUCTION = [
  'Output format (required): after any prose, end your reply with exactly one fenced ```json block shaped like:',
  '```json',
  '{',
  '  "summary": "one paragraph verdict",',
  '  "findings": [',
  '    { "severity": "blocker|major|minor|info", "file": "path/relative/to/cwd or null", "line": 12, "title": "short claim", "detail": "evidence and why it matters" }',
  '  ]',
  '}',
  '```',
  `Use "findings": [] when you found nothing. At most ${HANDOFF_LIMITS.maxItems} findings, most severe first. "line" is a number or null.`,
].join('\n')

export function assertOutput(output) {
  if (output == null) return
  if (output !== 'review') throw new Error(`output must be "review" when given (got ${JSON.stringify(output)})`)
}

export function appendReviewInstruction(task) {
  return `${task}\n\n${REVIEW_OUTPUT_INSTRUCTION}`
}

const OPEN_FENCE = '```json'

/**
 * Parse the LAST fenced ```json block of `text` as a review. The block runs
 * from the last "```json" opener to the last closing fence after it, so a
 * finding detail that itself contains a ``` code sample cannot cut it short.
 * Returns `{ ok: true, review: { summary, findings } }` with optional finding
 * fields normalized (file/line -> null, detail -> ''), or `{ ok: false, error }`.
 */
export function parseReviewOutput(text) {
  const source = String(text ?? '')
  const open = source.lastIndexOf(OPEN_FENCE)
  const bodyStart = open === -1 ? -1 : source.indexOf('\n', open)
  const close = bodyStart === -1 ? -1 : source.lastIndexOf('```')
  if (open === -1 || bodyStart === -1 || close <= bodyStart) return { ok: false, error: 'no fenced ```json review block in the response' }
  let value
  try {
    value = JSON.parse(source.slice(bodyStart + 1, close))
  } catch (error) {
    return { ok: false, error: `the last \`\`\`json block is not valid JSON: ${error.message}` }
  }
  return validateReview(value)
}

function validateReview(value) {
  const { maxItems, maxItemChars, maxSummaryChars } = HANDOFF_LIMITS
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'review must be a JSON object' }
  if (typeof value.summary !== 'string' || value.summary.trim() === '') return { ok: false, error: 'summary must be a non-empty string' }
  if (value.summary.length > maxSummaryChars) return { ok: false, error: `summary exceeds ${maxSummaryChars} characters` }
  if (!Array.isArray(value.findings)) return { ok: false, error: 'findings must be an array' }
  if (value.findings.length > maxItems) return { ok: false, error: `at most ${maxItems} findings are allowed (got ${value.findings.length})` }

  const findings = []
  for (const [i, f] of value.findings.entries()) {
    const at = `findings[${i}]`
    if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: `${at} must be an object` }
    if (!REVIEW_SEVERITIES.includes(f.severity)) return { ok: false, error: `${at}.severity must be one of ${REVIEW_SEVERITIES.join(', ')}` }
    if (typeof f.title !== 'string' || f.title.trim() === '') return { ok: false, error: `${at}.title must be a non-empty string` }
    if (f.file != null && typeof f.file !== 'string') return { ok: false, error: `${at}.file must be a string or null` }
    if (f.line != null && !(Number.isInteger(f.line) && f.line > 0)) return { ok: false, error: `${at}.line must be a positive integer or null` }
    if (f.detail != null && typeof f.detail !== 'string') return { ok: false, error: `${at}.detail must be a string` }
    const detail = f.detail ?? ''
    if (f.title.length > maxItemChars || detail.length > maxItemChars) return { ok: false, error: `${at} exceeds ${maxItemChars} characters` }
    findings.push({ severity: f.severity, file: f.file ?? null, line: f.line ?? null, title: f.title, detail })
  }
  return { ok: true, review: { summary: value.summary, findings } }
}

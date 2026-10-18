import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TIMEOUTS_S,
  resolveTimeoutS,
  KILL_GRACE_S,
  MODEL_REGISTRY,
  resolveVariant,
  CIRCUIT_BREAKER,
  paths,
  ASSIGNMENT_DEFAULT_CONTEXT_TOKENS,
  ASSIGNMENT_CONTEXT_WARN_FRACTION,
  ASSIGNMENT_EXPORT_TIMEOUT_MS,
  assignmentExportTimeoutMs,
  assignmentDefaultContextTokens,
  assignmentContextWarnFraction,
} from '../src/config.mjs'

test('agy timeouts match observed real runs (278s/303s on medium/high were being cut by the old 90s/180s defaults)', () => {
  assert.equal(DEFAULT_TIMEOUTS_S.agy['gemini-3.8-flash-low'], 300)
  assert.equal(DEFAULT_TIMEOUTS_S.agy['gemini-3.8-flash-medium'], 600)
  assert.equal(DEFAULT_TIMEOUTS_S.agy['gemini-3.8-flash-high'], 900)
  assert.equal(DEFAULT_TIMEOUTS_S.agy.default, 900)
  assert.equal(resolveTimeoutS('agy', 'gemini-3.8-flash-medium'), 600)
})

test('opencode default timeout is 600s', () => {
  assert.equal(DEFAULT_TIMEOUTS_S.opencode.default, 600)
  assert.equal(resolveTimeoutS('opencode', 'anything'), 600)
})

test('jules default timeout is 21600s (6h) — sized for an unattended session that is walked away from, not one watched in real time', () => {
  assert.equal(DEFAULT_TIMEOUTS_S.jules.default, 21600)
  assert.equal(resolveTimeoutS('jules', 'jules'), 21600)
})

test('KILL_GRACE_S is exported and used as the buffer past the adapter timeout before the hub hard-kills', () => {
  assert.equal(KILL_GRACE_S, 30)
})

test('resolveVariant: explicit override beats the registry default', () => {
  assert.equal(resolveVariant('opencode', 'opencode/muse-spark-1.3-contributor-free', 'low'), 'low')
})

test('resolveVariant: falls back to the registry default when no override is given', () => {
  assert.equal(resolveVariant('opencode', 'opencode/muse-spark-1.3-contributor-free', undefined), 'high')
})

test('resolveVariant: null when neither an override nor a registry default exists', () => {
  assert.equal(resolveVariant('agy', 'gemini-3.8-flash-low', undefined), null)
})

test('the opencode Muse Spark 1.3 registry entry defaults to variant "high"', () => {
  assert.equal(MODEL_REGISTRY.opencode['opencode/muse-spark-1.3-contributor-free'].variant, 'high')
})

test('the circuit breaker treats billing as an immediate-open kind, distinct from the quota/canceled threshold', () => {
  assert.ok(CIRCUIT_BREAKER.failureKinds.has('billing'))
  assert.ok(CIRCUIT_BREAKER.immediateKinds.has('billing'))
  assert.ok(!CIRCUIT_BREAKER.immediateKinds.has('quota'))
})

test('paths() exposes discoveryFile and overridesFile under the state home', () => {
  const p = paths({ AGENT_HUB_HOME: '/tmp/fake-home' })
  assert.equal(p.discoveryFile, '/tmp/fake-home/discovery.json')
  assert.equal(p.overridesFile, '/tmp/fake-home/overrides.json')
})

test('paths() exposes accountsFile and sourcesCacheFile under the state home', () => {
  const p = paths({ AGENT_HUB_HOME: '/tmp/fake-home' })
  assert.equal(p.accountsFile, '/tmp/fake-home/accounts.json')
  assert.equal(p.sourcesCacheFile, '/tmp/fake-home/sources-cache.json')
})

test('assignment context budget defaults: 200k-token window, warn at 60%', () => {
  assert.equal(ASSIGNMENT_DEFAULT_CONTEXT_TOKENS, 200000)
  assert.equal(ASSIGNMENT_CONTEXT_WARN_FRACTION, 0.6)
  assert.equal(assignmentDefaultContextTokens({}), 200000)
  assert.equal(assignmentContextWarnFraction({}), 0.6)
})

test('assignment context budget is env-overridable; invalid values fall back to the defaults', () => {
  assert.equal(assignmentDefaultContextTokens({ AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS: '1000000' }), 1000000)
  assert.equal(assignmentContextWarnFraction({ AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION: '0.8' }), 0.8)
  for (const bad of ['', 'abc', '0', '-1']) {
    assert.equal(assignmentDefaultContextTokens({ AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS: bad }), 200000)
  }
  for (const bad of ['', 'abc', '0', '-0.1', '1.5']) {
    assert.equal(assignmentContextWarnFraction({ AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION: bad }), 0.6)
  }
})

test('assignment session export timeout defaults to 10s, is env-overridable, invalid values fall back', () => {
  assert.equal(ASSIGNMENT_EXPORT_TIMEOUT_MS, 10000)
  assert.equal(assignmentExportTimeoutMs({}), 10000)
  assert.equal(assignmentExportTimeoutMs({ AGENT_HUB_ASSIGNMENT_EXPORT_TIMEOUT_MS: '2500' }), 2500)
  for (const bad of ['', 'abc', '0', '-1', '1.5']) {
    assert.equal(assignmentExportTimeoutMs({ AGENT_HUB_ASSIGNMENT_EXPORT_TIMEOUT_MS: bad }), 10000)
  }
})

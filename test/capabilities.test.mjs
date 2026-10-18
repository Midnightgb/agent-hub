import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_KEYS,
  AGENT_CAPABILITIES,
  capabilitiesFor,
  hasCapabilities,
} from '../src/capabilities.mjs'

test('CAPABILITY_KEYS is frozen and contains exact capability list', () => {
  assert.ok(Object.isFrozen(CAPABILITY_KEYS))
  assert.deepEqual([...CAPABILITY_KEYS], [
    'read',
    'write',
    'git',
    'github',
    'web',
    'sessionResume',
    'largeContext',
    'messagingTurnBoundary',
    'messagingMidRun',
  ])
})

test('capabilitiesFor: agy with gemini-3.8-flash-high has sessionResume and largeContext', () => {
  const caps = capabilitiesFor('agy', 'gemini-3.8-flash-high')
  assert.equal(caps.sessionResume, true)
  assert.equal(caps.largeContext, true)
  assert.equal(caps.read, true)
  assert.equal(caps.write, true)
  assert.equal(caps.git, true)
  assert.equal(caps.github, false)
  assert.equal(caps.web, false)
})

test('capabilitiesFor: copilot auto has sessionResume false', () => {
  const caps = capabilitiesFor('copilot', 'auto')
  assert.equal(caps.sessionResume, false)
  assert.equal(caps.github, true)
  assert.equal(caps.largeContext, false)
})

test('capabilitiesFor: claude has sessionResume false because the hub has no claude CLI adapter to resume a session', () => {
  const caps = capabilitiesFor('claude', 'sonnet')
  assert.equal(caps.sessionResume, false)
  assert.equal(AGENT_CAPABILITIES.claude.sessionResume, false)
  assert.equal(hasCapabilities(caps, ['sessionResume']), false)
})

test('web is false for every agent in the AGENT_CAPABILITIES table', () => {
  const knownAgents = ['agy', 'opencode', 'codex', 'copilot', 'claude', 'jules']
  for (const agent of knownAgents) {
    const caps = capabilitiesFor(agent, 'some-model')
    assert.equal(caps.web, false, `agent ${agent} should have web: false`)
    assert.equal(AGENT_CAPABILITIES[agent].web, false)
  }
})

test('capabilitiesFor: unknown agent returns all keys false', () => {
  const caps = capabilitiesFor('unknown-agent', 'any-model')
  for (const key of CAPABILITY_KEYS) {
    assert.equal(caps[key], false, `unknown agent key ${key} must be false`)
  }
})

test('hasCapabilities: empty or missing required array returns true', () => {
  const caps = capabilitiesFor('agy', 'gemini-3.8-flash-low')
  assert.equal(hasCapabilities(caps), true)
  assert.equal(hasCapabilities(caps, []), true)
})

test('hasCapabilities: returns true when all required capabilities are satisfied', () => {
  const caps = capabilitiesFor('agy', 'gemini-3.8-flash-high')
  assert.equal(hasCapabilities(caps, ['read', 'write', 'sessionResume', 'largeContext']), true)
})

test('hasCapabilities: returns false when any required capability is missing', () => {
  const caps = capabilitiesFor('copilot', 'auto')
  assert.equal(hasCapabilities(caps, ['read', 'sessionResume']), false)
  assert.equal(hasCapabilities(caps, ['largeContext']), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resetSyncProfileCache } from '../src/providers/agys.mjs'
import { seedOpencodeCatalog } from './helpers/opencode-catalog.mjs'

function tmpHome() {
  return seedOpencodeCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-agys-')))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/router.mjs?t=' + Date.now() + Math.random())
}

test('with AGENT_HUB_AGYS set, agy candidates carry profiles[] and the primary/fallbacks ORDER is unchanged', async () => {
  resetSyncProfileCache()
  const home = tmpHome()
  const { route } = await fresh(home)

  const fakeResolver = () => ({
    profile: 'work',
    status: 'selected',
    profiles: [
      { name: 'work', status: 'selected' },
      { name: 'personal', status: 'fallback' },
    ],
  })

  // taskType 'recon': primary is agy gemini-3.8-flash-low, fallbacks are opencode, claude
  const baseline = await route({ taskType: 'recon', env: { AGENT_HUB_HOME: home } })
  assert.equal(baseline.primary.agent, 'agy')
  assert.equal('profiles' in baseline.primary, false)
  for (const fb of baseline.fallbacks) {
    assert.equal('profiles' in fb, false)
  }

  const result = await route({
    taskType: 'recon',
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
    _resolveAgyProfileSync: fakeResolver,
  })

  // agy candidates carry profiles[]
  assert.equal(result.primary.agent, 'agy')
  assert.ok(Array.isArray(result.primary.profiles))
  assert.deepEqual(result.primary.profiles, [
    { name: 'work', status: 'selected' },
    { name: 'personal', status: 'fallback' },
  ])

  // Non-agy fallbacks do NOT carry profiles
  for (const fb of result.fallbacks) {
    if (fb.agent !== 'agy') {
      assert.equal('profiles' in fb, false)
    }
  }

  // Primary and fallback ORDER is unchanged compared to baseline
  assert.equal(result.primary.agent, baseline.primary.agent)
  assert.equal(result.primary.model, baseline.primary.model)
  assert.equal(result.fallbacks.length, baseline.fallbacks.length)
  for (let i = 0; i < result.fallbacks.length; i++) {
    assert.equal(result.fallbacks[i].agent, baseline.fallbacks[i].agent)
    assert.equal(result.fallbacks[i].model, baseline.fallbacks[i].model)
  }
})

test('with AGENT_HUB_AGYS set, agy in fallbacks also carries profiles[]', async () => {
  resetSyncProfileCache()
  const home = tmpHome()
  const { route } = await fresh(home)

  const fakeResolver = () => ({
    profile: 'work',
    status: 'selected',
    profiles: [
      { name: 'work', status: 'selected' },
    ],
  })

  // research: opencode, opencode, agy
  const result = await route({
    taskType: 'research',
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
    _resolveAgyProfileSync: fakeResolver,
  })

  assert.equal(result.primary.agent, 'opencode')
  assert.equal('profiles' in result.primary, false)

  const agyFallback = result.fallbacks.find((f) => f.agent === 'agy')
  assert.ok(agyFallback)
  assert.deepEqual(agyFallback.profiles, [{ name: 'work', status: 'selected' }])
})

test('with AGENT_HUB_AGYS set, each agy candidate resolves profiles for its OWN model (quota is per model group)', async () => {
  resetSyncProfileCache()
  const home = tmpHome()
  const { route } = await fresh(home)

  const seenModels = []
  const fakeResolver = ({ model }) => {
    seenModels.push(model)
    return { profile: 'work', status: 'selected', profiles: [{ name: 'work', status: 'selected' }] }
  }

  // research: opencode, opencode, agy gemini-3.8-flash-medium (only one agy candidate)
  await route({
    taskType: 'research',
    env: { AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' },
    _resolveAgyProfileSync: fakeResolver,
  })

  assert.deepEqual(seenModels, ['gemini-3.8-flash-medium'])
})

test('without AGENT_HUB_AGYS set, output has no profiles key', async () => {
  resetSyncProfileCache()
  const home = tmpHome()
  const { route } = await fresh(home)

  const result = await route({
    taskType: 'recon',
    env: { AGENT_HUB_HOME: home },
  })

  assert.equal('profiles' in result.primary, false)
  for (const fb of result.fallbacks) {
    assert.equal('profiles' in fb, false)
  }
})

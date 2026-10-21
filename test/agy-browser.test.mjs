import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  agyBrowserAvailable,
  agyBrowserStatus,
  hasBrowserServer,
  mcpConfigPath,
  syncAgysMcpConfigs,
} from '../src/providers/agy-mcp.mjs'
import { capabilitiesFor, requirementsFor } from '../src/capabilities.mjs'
import { resolveAgyProfile, resetSyncProfileCache } from '../src/providers/agys.mjs'
import { route } from '../src/router.mjs'
import { runAgysCli } from '../src/agys-cli.mjs'
import { buildArgv, AGY_BROWSER_TOOLS_NOTE } from '../src/adapters/agy.mjs'
import { resolveEffectiveTimeoutS } from '../src/timeouts.mjs'

const PLAYWRIGHT = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--isolated'] }

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-agy-browser-'))
}

function writeConfig(home, content) {
  const file = mcpConfigPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

function profileHome(home, name) {
  const dir = path.join(home, '.agys', 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('config detection: missing, empty and invalid files mean no browser server', () => {
  const home = tmpHome()
  assert.equal(hasBrowserServer(mcpConfigPath(home)), false)
  assert.equal(hasBrowserServer(writeConfig(home, '')), false)
  assert.equal(hasBrowserServer(writeConfig(home, '{not json')), false)
})

test('config detection: @playwright/mcp in args or a server named playwright counts, disabled:true does not', () => {
  const home = tmpHome()
  assert.equal(hasBrowserServer(writeConfig(home, { mcpServers: { web: PLAYWRIGHT } })), true)
  assert.equal(hasBrowserServer(writeConfig(home, { mcpServers: { playwright: { command: '/opt/pw-mcp' } } })), true)
  assert.equal(hasBrowserServer(writeConfig(home, { mcpServers: { playwright: { ...PLAYWRIGHT, disabled: true } } })), false)
  assert.equal(hasBrowserServer(writeConfig(home, { mcpServers: { github: { command: 'gh-mcp' } } })), false)
})

test('agyBrowserStatus reports the base config and each agys profile; availability follows the agys mode', () => {
  const home = tmpHome()
  writeConfig(profileHome(home, 'work'), { mcpServers: { playwright: PLAYWRIGHT } })
  writeConfig(profileHome(home, 'personal'), '')
  const env = { HOME: home }

  assert.deepEqual(agyBrowserStatus(env), { base: false, profiles: { personal: false, work: true } })
  assert.equal(agyBrowserAvailable({ mode: 'auto' }, env), true)
  assert.equal(agyBrowserAvailable({ mode: 'profile', profile: 'personal' }, env), false)
  assert.equal(agyBrowserAvailable({ mode: 'profile', profile: 'work' }, env), true)
  assert.equal(agyBrowserAvailable({ mode: 'off' }, env), false)
})

test('capabilitiesFor: browser is false without env and for non-agy agents; detected for agy with env', () => {
  const home = tmpHome()
  writeConfig(home, { mcpServers: { playwright: PLAYWRIGHT } })
  const env = { HOME: home, AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'off' }
  assert.equal(capabilitiesFor('agy', 'gemini-3.8-flash-high').browser, false)
  assert.equal(capabilitiesFor('agy', 'gemini-3.8-flash-high', { env }).browser, true)
  assert.equal(capabilitiesFor('opencode', 'x', { env }).browser, false)
  assert.deepEqual(requirementsFor('ui-test', ['read', 'browser']), ['browser', 'read'])
})

test('route: ui-test skips agy candidates with missing_capabilities:browser until a profile has Playwright', async () => {
  resetSyncProfileCache()
  const home = tmpHome()
  profileHome(home, 'work')
  const env = { HOME: home, AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' }
  const deps = { _computeMetrics: () => ({ rows: [] }), _resolveAgyProfileSync: () => ({ profiles: [] }) }

  const without = await route({ taskType: 'ui-test', env, ...deps })
  assert.equal(without.primary, null)
  assert.ok(without.skipped.every((s) => s.reason === 'missing_capabilities:browser'), JSON.stringify(without.skipped))

  // An explicit browser requirement filters any other task type the same way.
  const recon = await route({ taskType: 'recon', requirements: ['browser'], env, ...deps })
  assert.ok(recon.skipped.some((s) => s.agent === 'agy' && s.reason === 'missing_capabilities:browser'))

  writeConfig(path.join(home, '.agys', 'profiles', 'work'), { mcpServers: { playwright: PLAYWRIGHT } })
  const withBrowser = await route({ taskType: 'ui-test', env, ...deps })
  assert.equal(withBrowser.primary.agent, 'agy')
  assert.equal(withBrowser.primary.model, 'gemini-3.8-flash-high')
  assert.equal(withBrowser.primary.mode, 'read')
})

test('resolveAgyProfile: requireBrowser prefers a profile with Playwright, otherwise keeps the normal pick', async () => {
  const home = tmpHome()
  writeConfig(profileHome(home, 'second'), { mcpServers: { playwright: PLAYWRIGHT } })
  profileHome(home, 'first')
  const env = { HOME: home, AGENT_HUB_HOME: home, AGENT_HUB_AGYS: 'auto' }
  const deps = {
    env,
    runCommandFn: async () => ({ code: 0, stdout: 'agys 1.0.0' }),
    listFn: async () => [
      { name: 'first', active: true, priority: 10 },
      { name: 'second', active: false, priority: 1 },
    ],
    quotaFn: async () => ({}),
    listJobsFn: () => [],
  }

  assert.equal((await resolveAgyProfile(deps)).profile, 'first')
  assert.equal((await resolveAgyProfile({ ...deps, requireBrowser: true })).profile, 'second')

  fs.rmSync(path.join(home, '.agys', 'profiles', 'second', '.gemini'), { recursive: true })
  assert.equal((await resolveAgyProfile({ ...deps, requireBrowser: true })).profile, 'first')
})

test('sync-mcp: merges base servers into every profile, keeps profile-only servers and writes a .bak', () => {
  const home = tmpHome()
  writeConfig(home, { mcpServers: { playwright: PLAYWRIGHT } })
  const workFile = writeConfig(profileHome(home, 'work'), {
    theme: 'dark',
    mcpServers: { local: { command: 'local-mcp' }, playwright: { command: 'old' } },
  })
  const emptyFile = writeConfig(profileHome(home, 'personal'), '')
  profileHome(home, 'fresh')
  const env = { HOME: home }

  const dry = syncAgysMcpConfigs({ env, apply: false })
  assert.deepEqual(
    dry.profiles.map((p) => [p.profile, p.added, p.updated, p.written]),
    [
      ['fresh', ['playwright'], [], false],
      ['personal', ['playwright'], [], false],
      ['work', [], ['playwright'], false],
    ]
  )
  assert.equal(fs.readFileSync(emptyFile, 'utf8'), '')

  syncAgysMcpConfigs({ env })
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'))
  assert.equal(work.theme, 'dark')
  assert.deepEqual(work.mcpServers, { local: { command: 'local-mcp' }, playwright: PLAYWRIGHT })
  assert.deepEqual(JSON.parse(fs.readFileSync(`${workFile}.bak`, 'utf8')).mcpServers.playwright, { command: 'old' })
  assert.equal(fs.readFileSync(`${emptyFile}.bak`, 'utf8'), '')
  assert.equal(hasBrowserServer(mcpConfigPath(path.join(home, '.agys', 'profiles', 'fresh'))), true)

  const again = syncAgysMcpConfigs({ env })
  assert.ok(again.profiles.every((p) => !p.changed))
})

test('agent-hub agys sync-mcp prints per-profile changes and rejects unknown commands', async () => {
  const home = tmpHome()
  writeConfig(home, { mcpServers: { playwright: PLAYWRIGHT } })
  profileHome(home, 'work')
  const lines = []
  const errors = []
  const io = { env: { HOME: home }, log: (l) => lines.push(l), error: (l) => errors.push(l) }

  assert.equal(await runAgysCli(['sync-mcp', '--dry-run'], io), 0)
  assert.match(lines.at(-1), /work: added playwright \(dry run, not written\)/)
  assert.equal(await runAgysCli(['sync-mcp'], io), 0)
  assert.match(lines.at(-1), /work: added playwright \(new file\)/)
  assert.equal(await runAgysCli(['nope'], io), 1)
  assert.equal(errors.length, 1)
})

test('ui-test jobs: agy guard allows MCP browser tools and the default timeout is raised', () => {
  const plain = buildArgv({ model: 'm', prompt: 'p', cwd: '/repo' })
  const browser = buildArgv({ model: 'm', prompt: 'p', cwd: '/repo', browserTools: true })
  assert.ok(!plain[1].includes(AGY_BROWSER_TOOLS_NOTE))
  assert.ok(browser[1].includes(AGY_BROWSER_TOOLS_NOTE))

  const noMetrics = () => null
  const recon = resolveEffectiveTimeoutS({ agent: 'agy', model: 'gemini-3.8-flash-high', taskType: 'recon', metricsForFn: noMetrics })
  const uiTest = resolveEffectiveTimeoutS({ agent: 'agy', model: 'gemini-3.8-flash-high', taskType: 'ui-test', metricsForFn: noMetrics })
  assert.equal(recon.timeoutS, 900)
  assert.equal(uiTest.timeoutS, 1800)
})

test('startJob records a warning when a browser-requiring agy job runs on a profile without Playwright', async () => {
  const { startJob } = await import('../src/jobrunner.mjs')
  const { readResult } = await import('../src/jobstore.mjs')
  const home = tmpHome()
  profileHome(home, 'plain')
  const env = { ...process.env, HOME: home, AGENT_HUB_HOME: home }
  delete env.AGENT_HUB_AGYS
  delete env.AGENT_HUB_AGYS_PROFILE
  const handle = startJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-high',
    task: 'open the page',
    cwd: home,
    taskType: 'ui-test',
    profile: 'plain',
    env,
    spawn: () => ({ pid: 1, on() {}, unref() {}, stdout: null, stderr: null }),
    runWithTimeout: () => ({ exitPromise: new Promise(() => {}) }),
  })
  const record = readResult(handle.job.jobId, env)
  assert.ok(record.warnings?.some((w) => w.includes('browser required') && w.includes('"plain"')), JSON.stringify(record.warnings))
})

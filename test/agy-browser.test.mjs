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
  syncAgysProfiles,
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

test('mcp merge: merges base servers into every profile, keeps profile-only servers and writes a .bak', () => {
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

function baseGemini(home) {
  const dir = path.join(home, '.gemini')
  fs.mkdirSync(path.join(dir, 'skills', 'one'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'antigravity', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), '# global\n')
  writeConfig(home, { mcpServers: { playwright: PLAYWRIGHT } })
  return dir
}

const actionsOf = (report, name) =>
  Object.fromEntries(report.profiles.find((p) => p.profile === name).links.map((l) => [l.path, l.action]))

test('agys sync: links base paths into every profile and skips missing base paths', () => {
  const home = tmpHome()
  const base = baseGemini(home)
  const work = profileHome(home, 'work')
  const env = { HOME: home }

  const report = syncAgysProfiles({ env })
  assert.deepEqual(actionsOf(report, 'work'), {
    'GEMINI.md': 'linked',
    skills: 'linked',
    'antigravity/skills': 'linked',
    'antigravity-cli/skills': 'skipped',
    'config/mcp_config.json': 'linked',
  })
  assert.equal(fs.readlinkSync(path.join(work, '.gemini', 'skills')), path.join(base, 'skills'))
  assert.equal(fs.readFileSync(path.join(work, '.gemini', 'GEMINI.md'), 'utf8'), '# global\n')
  assert.equal(fs.existsSync(path.join(work, '.gemini', 'antigravity-cli')), false)
  // Browser detection reads through the symlinked config.
  assert.equal(agyBrowserStatus(env).profiles.work, true)
  assert.equal(agyBrowserAvailable({ mode: 'profile', profile: 'work' }, env), true)

  const again = syncAgysProfiles({ env })
  assert.ok(again.profiles[0].links.every((l) => l.action === 'ok' || l.action === 'skipped'))
  assert.ok(again.profiles[0].links.every((l) => !l.written))
})

test('agys sync: backs up a non-empty real dir, replaces empty entries and relinks a stale symlink', () => {
  const home = tmpHome()
  const base = baseGemini(home)
  const gemini = path.join(profileHome(home, 'work'), '.gemini')
  fs.mkdirSync(path.join(gemini, 'skills', 'mine'), { recursive: true })
  fs.writeFileSync(path.join(gemini, 'skills', 'mine', 'SKILL.md'), 'x')
  fs.mkdirSync(path.join(gemini, 'antigravity', 'skills'), { recursive: true })
  writeConfig(path.dirname(gemini), '')
  fs.symlinkSync(path.join(home, 'elsewhere.md'), path.join(gemini, 'GEMINI.md'))

  const report = syncAgysProfiles({ env: { HOME: home }, now: () => 1_700_000_000_000 })
  const actions = actionsOf(report, 'work')
  assert.equal(actions.skills, 'backed-up')
  assert.equal(actions['antigravity/skills'], 'replaced-empty')
  assert.equal(actions['config/mcp_config.json'], 'replaced-empty')
  assert.equal(actions['GEMINI.md'], 'relinked')
  const backup = path.join(gemini, 'skills.bak-1700000000')
  assert.equal(fs.readFileSync(path.join(backup, 'mine', 'SKILL.md'), 'utf8'), 'x')
  for (const rel of ['skills', 'antigravity/skills', 'config/mcp_config.json', 'GEMINI.md']) {
    assert.equal(fs.readlinkSync(path.join(gemini, rel)), path.join(base, rel))
  }
})

test('agys sync --dry-run writes nothing and reports the same actions', () => {
  const home = tmpHome()
  baseGemini(home)
  const gemini = path.join(profileHome(home, 'work'), '.gemini')
  fs.mkdirSync(path.join(gemini, 'skills', 'mine'), { recursive: true })

  const report = syncAgysProfiles({ env: { HOME: home }, apply: false })
  assert.equal(actionsOf(report, 'work').skills, 'backed-up')
  assert.ok(report.profiles[0].links.every((l) => !l.written))
  assert.deepEqual(fs.readdirSync(gemini), ['skills'])
  assert.equal(fs.lstatSync(path.join(gemini, 'skills')).isDirectory(), true)
})

test('agys sync --mcp-merge keeps a per-profile MCP config, materializing a symlinked one', () => {
  const home = tmpHome()
  baseGemini(home)
  const work = profileHome(home, 'work')
  const env = { HOME: home }
  syncAgysProfiles({ env })
  const file = mcpConfigPath(work)
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true)

  const report = syncAgysProfiles({ env, mcpMerge: true })
  assert.ok(!report.profiles[0].links.some((l) => l.path === 'config/mcp_config.json'))
  assert.equal(report.mcp.profiles[0].unlinked, true)
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, { playwright: PLAYWRIGHT })
  assert.equal(hasBrowserServer(mcpConfigPath(home)), true)
})

test('agent-hub agys sync prints per-profile actions and rejects unknown commands and options', async () => {
  const home = tmpHome()
  baseGemini(home)
  profileHome(home, 'work')
  const lines = []
  const errors = []
  const io = { env: { HOME: home }, log: (l) => lines.push(l), error: (l) => errors.push(l) }

  assert.equal(await runAgysCli(['sync', '--dry-run'], io), 0)
  assert.ok(lines.some((l) => /skills: linked \(dry run, not written\)/.test(l)))
  assert.equal(await runAgysCli(['sync'], io), 0)
  assert.ok(lines.some((l) => /GEMINI\.md: linked$/.test(l)))
  assert.equal(await runAgysCli(['sync', '--mcp-merge'], io), 0)
  assert.ok(lines.some((l) => /mcp_config\.json: merged, replaced symlink with a copy/.test(l)))
  assert.equal(await runAgysCli(['sync-mcp'], io), 1)
  assert.equal(await runAgysCli(['sync', '--apply'], io), 1)
  assert.equal(errors.length, 2)
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

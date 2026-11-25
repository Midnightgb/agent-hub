import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import {
  TASK_TYPES,
  EVENT_KINDS,
  LEARNING_TEXT_MAX,
  TaskType,
  JobRecord,
  AgentStatusRow,
  HubEvent,
  StateResponse,
  ConfigResponse,
  MetricsResponse,
  ProposalsFile,
  LearningsFile,
  LearningInput,
  RouteResult,
  JobResultResponse,
  DelegateResponse,
  RemoteInfo,
  JulesCheckResponse,
  JulesSessionsResponse,
  JulesSourcesResponse,
  JulesAccountsResponse,
} from '../src/schemas.mjs'
import { DELEGATION_MAP } from '../src/router.mjs'
import { VALID_KINDS, appendEvent } from '../src/eventlog.mjs'
import { LEARNING_TEXT_MAX as CONFIG_LEARNING_TEXT_MAX } from '../src/config.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v2')
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))

test('TASK_TYPES matches the delegation map keys exactly', () => {
  assert.deepEqual([...TASK_TYPES].sort(), Object.keys(DELEGATION_MAP).sort())
})

test('EVENT_KINDS matches the event log kinds, including proposal and learning kinds', () => {
  assert.deepEqual([...EVENT_KINDS].sort(), [...VALID_KINDS].sort())
  for (const kind of ['proposal.created', 'proposal.decided', 'learning.proposed', 'learning.decided']) {
    assert.ok(EVENT_KINDS.includes(kind), kind)
  }
})

test('harness.wake and workflow.completed are declared in EVENT_KINDS and VALID_KINDS, and appendEvent accepts them without warning', () => {
  assert.ok(EVENT_KINDS.includes('harness.wake'), 'EVENT_KINDS includes harness.wake')
  assert.ok(EVENT_KINDS.includes('workflow.completed'), 'EVENT_KINDS includes workflow.completed')
  assert.ok(VALID_KINDS.has('harness.wake'), 'VALID_KINDS has harness.wake')
  assert.ok(VALID_KINDS.has('workflow.completed'), 'VALID_KINDS has workflow.completed')

  const warnings = []
  const origWarn = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-events-test-'))
    const appendedWake = appendEvent({ kind: 'harness.wake' }, { env: { AGENT_HUB_HOME: home } })
    const appendedWorkflow = appendEvent({ kind: 'workflow.completed' }, { env: { AGENT_HUB_HOME: home } })
    assert.equal(appendedWake.kind, 'harness.wake')
    assert.equal(appendedWorkflow.kind, 'workflow.completed')
    assert.equal(warnings.length, 0)
    fs.rmSync(home, { recursive: true, force: true })
  } finally {
    console.warn = origWarn
  }
})

test('LEARNING_TEXT_MAX is the same in the browser-safe schemas and the server config', () => {
  assert.equal(LEARNING_TEXT_MAX, CONFIG_LEARNING_TEXT_MAX)
})

test('schemas.mjs imports nothing but zod, so the dashboard can bundle it', () => {
  const source = fs.readFileSync(new URL('../src/schemas.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['zod'])
})

test('a live /api/state capture parses, and unknown extra fields are kept', () => {
  const state = fixture('state.json')
  const parsed = StateResponse.parse(state)
  assert.equal(parsed.jobs.length, state.jobs.length)
  assert.ok(parsed.jobs.some((j) => j.status === 'failed'))
  const withExtra = JobRecord.parse({ ...state.jobs[0], somethingNew: 1 })
  assert.equal(withExtra.somethingNew, 1)
})

test('a live /api/config capture parses', () => {
  const config = ConfigResponse.parse(fixture('config.json'))
  assert.ok(config.delegationMap.recon.chain.length > 0)
})

test('agent rows and events accept every status and kind seen live', () => {
  const state = fixture('state.json')
  for (const row of state.agents) AgentStatusRow.parse(row)
  for (const event of state.events) HubEvent.parse(event)
})

test('v2 job fields parse: taskType, turnDepth, timeoutSource, learningIds', () => {
  const base = fixture('state.json').jobs[0]
  const job = JobRecord.parse({ ...base, taskType: 'recon', turnDepth: 2, timeoutSource: 'adaptive', learningIds: ['l-1'] })
  assert.equal(job.taskType, 'recon')
  assert.throws(() => JobRecord.parse({ ...base, taskType: 'not-a-task' }))
  assert.throws(() => TaskType.parse('free text'))
})

test('metrics, proposals and learnings fixtures parse', () => {
  MetricsResponse.parse(fixture('metrics.json'))
  ProposalsFile.parse(fixture('proposals.json'))
  LearningsFile.parse(fixture('learnings.json'))
})

test('LearningInput rejects empty and over-long text', () => {
  assert.throws(() => LearningInput.parse({ text: '' }))
  assert.throws(() => LearningInput.parse({ text: 'x'.repeat(LEARNING_TEXT_MAX + 1) }))
  assert.equal(LearningInput.parse({ text: 'agy hangs on X', agent: 'agy' }).agent, 'agy')
})

test('RemoteInfo requires only provider and sessionId, everything else nullable/optional', () => {
  const remote = RemoteInfo.parse({ provider: 'jules', sessionId: 'sess-1' })
  assert.equal(remote.provider, 'jules')
  assert.equal(remote.sessionId, 'sess-1')

  const full = RemoteInfo.parse({
    provider: 'jules',
    accountId: null,
    sessionId: 'sess-1',
    sessionUrl: 'https://jules.google.com/session/sess-1',
    source: 'sources/github/acme/widgets',
    startingBranch: 'main',
    state: 'IN_PROGRESS',
    prUrl: null,
    activityCursor: 'tok-2',
    seenActivityIds: ['a1', 'a2'],
    lastPolledAt: '2026-09-15T00:00:00.000Z',
  })
  assert.equal(full.state, 'IN_PROGRESS')

  assert.throws(() => RemoteInfo.parse({ sessionId: 'sess-1' }), /provider/)
  assert.throws(() => RemoteInfo.parse({ provider: 'jules' }), /sessionId/)
})

test('RemoteInfo accepts the working branch and the jules tool response schemas parse', () => {
  assert.equal(RemoteInfo.parse({ provider: 'jules', sessionId: 'sess-1', branch: 'jules/fix-paginate' }).branch, 'jules/fix-paginate')

  JulesCheckResponse.parse({
    jobId: 'j-1',
    sessionId: 'sess-1',
    state: 'COMPLETED',
    prUrl: 'https://github.com/acme/widgets/pull/42',
    branch: 'jules/fix-paginate',
    sessionUrl: 'https://jules.google.com/session/sess-1',
    lastMessage: 'Done',
    finalized: true,
    terminal: true,
  })
  JulesCheckResponse.parse({ jobId: null, sessionId: null, state: 'UNKNOWN', prUrl: null, branch: null, sessionUrl: null, lastMessage: null, finalized: false, terminal: false })

  const parsed = JulesSessionsResponse.parse({
    sessions: [
      {
        sessionId: 'sess-1',
        title: 'Fix paginate',
        state: 'COMPLETED',
        prUrl: 'https://github.com/acme/widgets/pull/42',
        branch: 'jules/fix-paginate',
        sessionUrl: 'https://jules.google.com/session/sess-1',
        createTime: '2026-09-15T10:00:00Z',
        jobId: 'j-1',
      },
    ],
  })
  assert.equal(parsed.sessions[0].jobId, 'j-1')
  JulesSessionsResponse.parse({ sessions: [{ sessionId: null, state: 'UNKNOWN', jobId: null }] })
})

test('JobRecord accepts an optional remote block for a Jules job, and is unaffected for a local job', () => {
  const base = fixture('state.json').jobs[0]
  const remoteJob = JobRecord.parse({ ...base, agent: 'jules', model: 'jules', remote: { provider: 'jules', sessionId: 'sess-1' } })
  assert.equal(remoteJob.remote.sessionId, 'sess-1')

  const localJob = JobRecord.parse(base)
  assert.equal(localJob.remote, undefined)
})

test('jules_accounts and jules_sources account-aware schemas parse', () => {
  const parsed = JulesAccountsResponse.parse({
    policy: 'round_robin',
    accounts: [
      {
        id: 'acct-1',
        label: 'pro',
        enabled: true,
        priority: 0,
        dailyLimit: 100,
        concurrentLimit: 15,
        lastUsedAt: null,
        createdAt: '2026-09-15T00:00:00Z',
        updatedAt: '2026-09-15T00:00:00Z',
        keyPresent: true,
        keyLast4: '-aaa',
        usage: { running: 1, last24h: 3 },
        sourcesStatus: 'ok',
        sourcesFetchedAt: '2026-09-15T00:00:00Z',
      },
    ],
  })
  assert.equal(parsed.accounts[0].keyPresent, true)
  assert.equal(parsed.accounts[0].usage.last24h, 3)

  JulesSourcesResponse.parse({ sources: [], accountId: 'acct-1', noSourceAccess: true, note: 'no source access' })
  JulesSourcesResponse.parse({ sources: [] })
})

test('tool response schemas accept current outputs', () => {
  RouteResult.parse({
    primary: { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
    fallbacks: [{ agent: 'claude', model: 'haiku' }],
    skipped: [{ agent: 'copilot', model: 'auto', reason: 'breaker_open' }],
    discovery: { agy: { binPath: '/usr/bin/agy', version: '1.2.3', modelCount: 14, checkedAt: '2026-09-15T00:00:00.000Z', error: null }, opencode: null },
    reason: 'why',
  })
  RouteResult.parse({ primary: null, fallbacks: [], skipped: [], discovery: {}, reason: 'none', appliedProposal: { id: 'p-1' } })
  JobResultResponse.parse({ text: 'x', truncated: false, fullPath: '/tmp/r.txt', tokens: null, costUsd: null, sessionId: null, status: 'succeeded', errorKind: null })
  DelegateResponse.parse({ jobId: null, status: 'failed', errorKind: 'worktree_denied' })
  DelegateResponse.parse({ jobId: 'j', status: 'running', errorKind: null, parentJobId: 'p', turnDepth: 5, warning: 'deep' })
})

// A Jules job edits a remote GitHub branch and is started from an explicit
// source, so it legitimately has no local checkout. Requiring cwd made the
// shared schema reject /api/state as a whole: three such jobs took down every
// dashboard view that reads the job list, not just their own rows.
test('JobRecord accepts a remote job with no local cwd', () => {
  const record = {
    jobId: '2026-09-16T05-24-33-872Z-c1a5b68e',
    agent: 'jules',
    model: 'jules',
    mode: 'write',
    status: 'running',
    createdAt: '2026-09-16T05:24:33.872Z',
    updatedAt: '2026-09-16T05:24:33.872Z',
    remote: { provider: 'jules', sessionId: '2644030964203516032' },
  }
  assert.equal(JobRecord.safeParse(record).success, true)
  assert.equal(JobRecord.safeParse({ ...record, cwd: null }).success, true)
})

test('a token breakdown object in a stored event or job is read as its total, so /api/state still validates', () => {
  // Shape a gentle-shell job.finished event was written with before the
  // adapter reported a number: input already includes cachedInput, output
  // already includes reasoning.
  const breakdown = { input: 69939, cachedInput: 0, output: 44, reasoning: 0 }
  const event = { ts: '2026-11-02T00:20:20.561Z', source: 'hub', kind: 'job.finished', agent: 'gentle-shell', tokens: breakdown }
  assert.equal(HubEvent.parse(event).tokens, 69983)
  assert.equal(HubEvent.parse({ ...event, tokens: 12 }).tokens, 12)
  assert.equal(HubEvent.parse({ ...event, tokens: null }).tokens, null)
  assert.throws(() => HubEvent.parse({ ...event, tokens: 'many' }))

  const state = { agents: [], jobs: [], subagents: [], events: [event] }
  assert.equal(StateResponse.parse(state).events[0].tokens, 69983)
})

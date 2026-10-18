import { describe, test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resetDbInstances, _setSqliteDB } from '../src/storage/sqlite.mjs'
import { paths } from '../src/config.mjs'
import {
  createAssignment,
  getAssignment,
  listAssignments,
  beginTurn,
  completeTurn,
  abortTurn,
  closeAssignment,
  markRehydrated,
} from '../src/assignments.mjs'

let SqliteDB = null
try {
  SqliteDB = (await import('better-sqlite3')).default
} catch {
  // better-sqlite3 not installed — only the JSON backend is exercised
}

function tmpEnv() {
  return { AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-assignments-test-')) }
}

function baseInput(overrides = {}) {
  return {
    agent: 'opencode',
    model: 'opencode/big-pickle',
    title: 'Implement T1',
    brief: 'Build the assignment store with tests.',
    planRef: 'odd/tasks/task-assignments.md#T1',
    cwd: '/tmp/repo',
    mode: 'write',
    headJobId: 'job-0',
    sessionId: 'ses-0',
    ...overrides,
  }
}

// The assignments table as T1 created it, before context_tokens existed.
const T1_ASSIGNMENTS_SQL = `
CREATE TABLE assignments (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, model TEXT, title TEXT, brief TEXT NOT NULL,
  plan_ref TEXT, cwd TEXT, mode TEXT, status TEXT NOT NULL DEFAULT 'active', head_job_id TEXT,
  session_id TEXT, turns INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0,
  in_flight_job_id TEXT, rehydrated_at TEXT, close_verdict TEXT, close_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
)`

const T1_ROW = {
  id: 'asg-t1', agent: 'codex', model: 'default', title: 't', brief: 'b', plan_ref: null, cwd: '/tmp',
  mode: 'read', status: 'active', head_job_id: 'job-0', session_id: 'ses-0', turns: 1, tokens_used: 900,
  in_flight_job_id: null, rehydrated_at: null, close_verdict: null, close_note: null,
  created_at: '2026-10-08T00:00:00.000Z', updated_at: '2026-10-08T00:00:00.000Z', closed_at: null,
}

/** Seed a store exactly as T1 left it: no context_tokens column/field. */
function seedT1Store(backendName, env) {
  if (backendName === 'sqlite') {
    const db = new SqliteDB(paths(env).dbFile)
    db.exec(T1_ASSIGNMENTS_SQL)
    const cols = Object.keys(T1_ROW)
    db.prepare(`INSERT INTO assignments (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(T1_ROW)
    db.close()
  } else {
    fs.writeFileSync(path.join(env.AGENT_HUB_HOME, 'storage.json'), JSON.stringify({ assignments: { [T1_ROW.id]: { ...T1_ROW, _seq: 1 } } }))
  }
}

const backends = [{ name: 'json', impl: null }]
if (SqliteDB) backends.unshift({ name: 'sqlite', impl: SqliteDB })

after(() => {
  _setSqliteDB(SqliteDB)
  resetDbInstances()
})

for (const backend of backends) {
  describe(`assignments store (${backend.name} backend)`, () => {
    beforeEach(() => {
      resetDbInstances()
      _setSqliteDB(backend.impl)
    })

    test('createAssignment returns an active camelCase record with defaults', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)

      assert.match(created.id, /^asg-/)
      assert.equal(created.agent, 'opencode')
      assert.equal(created.model, 'opencode/big-pickle')
      assert.equal(created.title, 'Implement T1')
      assert.equal(created.brief, 'Build the assignment store with tests.')
      assert.equal(created.planRef, 'odd/tasks/task-assignments.md#T1')
      assert.equal(created.cwd, '/tmp/repo')
      assert.equal(created.mode, 'write')
      assert.equal(created.status, 'active')
      assert.equal(created.headJobId, 'job-0')
      assert.equal(created.sessionId, 'ses-0')
      assert.equal(created.turns, 0)
      assert.equal(created.tokensUsed, 0)
      assert.equal(created.inFlightJobId, null)
      assert.equal(created.rehydratedAt, null)
      assert.equal(created.closeVerdict, null)
      assert.equal(created.closeNote, null)
      assert.equal(created.closedAt, null)
      assert.ok(created.createdAt)
      assert.equal(created.updatedAt, created.createdAt)

      assert.deepEqual(getAssignment(created.id, env), created)
    })

    test('createAssignment requires agent and brief', () => {
      const env = tmpEnv()
      assert.throws(() => createAssignment(baseInput({ agent: '' }), env), /agent is required/)
      assert.throws(() => createAssignment(baseInput({ brief: '  ' }), env), /brief is required/)
    })

    test('getAssignment returns null for an unknown id', () => {
      const env = tmpEnv()
      assert.equal(getAssignment('asg-missing', env), null)
    })

    test('listAssignments filters by status and agent and honors limit', () => {
      const env = tmpEnv()
      const a = createAssignment(baseInput({ agent: 'opencode', title: 'a' }), env)
      const b = createAssignment(baseInput({ agent: 'codex', title: 'b' }), env)
      const c = createAssignment(baseInput({ agent: 'opencode', title: 'c' }), env)
      assert.equal(closeAssignment(c.id, { verdict: 'accepted' }, env).ok, true)

      const all = listAssignments({}, env)
      assert.deepEqual(all.map((r) => r.id).sort(), [a.id, b.id, c.id].sort())

      assert.deepEqual(listAssignments({ status: 'active' }, env).map((r) => r.id).sort(), [a.id, b.id].sort())
      assert.deepEqual(listAssignments({ status: 'closed' }, env).map((r) => r.id), [c.id])
      assert.deepEqual(listAssignments({ agent: 'codex' }, env).map((r) => r.id), [b.id])
      assert.deepEqual(listAssignments({ agent: 'opencode', status: 'active' }, env).map((r) => r.id), [a.id])
      assert.equal(listAssignments({ limit: 2 }, env).length, 2)
    })

    test('beginTurn takes the turn lock and refuses a second turn as busy', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)

      const first = beginTurn(created.id, 'job-1', env)
      assert.equal(first.ok, true)
      assert.equal(first.assignment.inFlightJobId, 'job-1')

      const second = beginTurn(created.id, 'job-2', env)
      assert.deepEqual(second, { ok: false, reason: 'busy', inFlightJobId: 'job-1' })
      assert.equal(getAssignment(created.id, env).inFlightJobId, 'job-1')
    })

    test('beginTurn on an unknown id returns not_found', () => {
      const env = tmpEnv()
      assert.deepEqual(beginTurn('asg-missing', 'job-1', env), { ok: false, reason: 'not_found' })
    })

    test('completeTurn advances head, turns, tokens and session and releases the lock', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)
      assert.equal(beginTurn(created.id, 'job-1', env).ok, true)

      const done = completeTurn(created.id, { jobId: 'job-1', sessionId: 'ses-1', tokens: 1200 }, env)
      assert.equal(done.ok, true)
      assert.equal(done.assignment.headJobId, 'job-1')
      assert.equal(done.assignment.sessionId, 'ses-1')
      assert.equal(done.assignment.turns, 1)
      assert.equal(done.assignment.tokensUsed, 1200)
      assert.equal(done.assignment.inFlightJobId, null)

      assert.equal(beginTurn(created.id, 'job-2', env).ok, true)
      const again = completeTurn(created.id, { jobId: 'job-2', tokens: 300 }, env)
      assert.equal(again.ok, true)
      assert.equal(again.assignment.headJobId, 'job-2')
      assert.equal(again.assignment.sessionId, 'ses-1', 'session is kept when not provided')
      assert.equal(again.assignment.turns, 2)
      assert.equal(again.assignment.tokensUsed, 1500)
    })

    test('completeTurn with a job that does not hold the lock changes nothing', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)
      assert.equal(beginTurn(created.id, 'job-1', env).ok, true)

      const res = completeTurn(created.id, { jobId: 'job-other', tokens: 50 }, env)
      assert.deepEqual(res, { ok: false, reason: 'lock_mismatch', inFlightJobId: 'job-1' })

      const current = getAssignment(created.id, env)
      assert.equal(current.headJobId, 'job-0')
      assert.equal(current.turns, 0)
      assert.equal(current.tokensUsed, 0)
      assert.equal(current.inFlightJobId, 'job-1')

      assert.deepEqual(completeTurn('asg-missing', { jobId: 'job-1' }, env), { ok: false, reason: 'not_found' })
    })

    test('abortTurn releases the lock without advancing the assignment', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)
      assert.equal(beginTurn(created.id, 'job-1', env).ok, true)

      assert.deepEqual(abortTurn(created.id, 'job-other', env), { ok: false, reason: 'lock_mismatch', inFlightJobId: 'job-1' })

      const aborted = abortTurn(created.id, 'job-1', env)
      assert.equal(aborted.ok, true)
      assert.equal(aborted.assignment.inFlightJobId, null)
      assert.equal(aborted.assignment.headJobId, 'job-0')
      assert.equal(aborted.assignment.turns, 0)

      assert.equal(beginTurn(created.id, 'job-2', env).ok, true)
      assert.deepEqual(abortTurn('asg-missing', 'job-1', env), { ok: false, reason: 'not_found' })
    })

    test('closeAssignment records accepted and abandoned verdicts', () => {
      const env = tmpEnv()
      const a = createAssignment(baseInput(), env)
      const b = createAssignment(baseInput(), env)

      const accepted = closeAssignment(a.id, { verdict: 'accepted', note: 'looks good' }, env)
      assert.equal(accepted.ok, true)
      assert.equal(accepted.assignment.status, 'closed')
      assert.equal(accepted.assignment.closeVerdict, 'accepted')
      assert.equal(accepted.assignment.closeNote, 'looks good')
      assert.ok(accepted.assignment.closedAt)

      const abandoned = closeAssignment(b.id, { verdict: 'abandoned' }, env)
      assert.equal(abandoned.ok, true)
      assert.equal(abandoned.assignment.closeVerdict, 'abandoned')
      assert.equal(abandoned.assignment.closeNote, null)
    })

    test('closeAssignment is refused while a turn is in flight', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)
      assert.equal(beginTurn(created.id, 'job-1', env).ok, true)

      assert.deepEqual(
        closeAssignment(created.id, { verdict: 'accepted' }, env),
        { ok: false, reason: 'busy', inFlightJobId: 'job-1' }
      )
      assert.equal(getAssignment(created.id, env).status, 'active')
    })

    test('a closed assignment refuses new turns and a second close', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)
      assert.equal(closeAssignment(created.id, { verdict: 'accepted' }, env).ok, true)

      assert.deepEqual(beginTurn(created.id, 'job-1', env), { ok: false, reason: 'closed' })

      const second = closeAssignment(created.id, { verdict: 'abandoned' }, env)
      assert.deepEqual(second, { ok: false, reason: 'closed' })
      assert.equal(getAssignment(created.id, env).closeVerdict, 'accepted')
    })

    test('closeAssignment rejects an invalid verdict and an unknown id', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)

      assert.throws(() => closeAssignment(created.id, { verdict: 'done' }, env), /invalid verdict/)
      assert.throws(() => closeAssignment(created.id, {}, env), /invalid verdict/)
      assert.equal(getAssignment(created.id, env).status, 'active')

      assert.deepEqual(closeAssignment('asg-missing', { verdict: 'accepted' }, env), { ok: false, reason: 'not_found' })
    })

    test('completeTurn records the last observed context occupancy, separate from the cumulative counter', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)
      assert.equal(created.contextTokens, null)

      assert.equal(beginTurn(created.id, 'job-1', env).ok, true)
      const first = completeTurn(created.id, { jobId: 'job-1', tokens: 1200, contextTokens: 1000 }, env)
      assert.equal(first.assignment.contextTokens, 1000)
      assert.equal(first.assignment.tokensUsed, 1200)

      assert.equal(beginTurn(created.id, 'job-2', env).ok, true)
      const second = completeTurn(created.id, { jobId: 'job-2', tokens: 1500, contextTokens: 1400 }, env)
      assert.equal(second.assignment.contextTokens, 1400, 'occupancy is replaced, not summed')
      assert.equal(second.assignment.tokensUsed, 2700)

      assert.equal(beginTurn(created.id, 'job-3', env).ok, true)
      const third = completeTurn(created.id, { jobId: 'job-3', tokens: 10 }, env)
      assert.equal(third.assignment.contextTokens, 1400, 'unchanged when the turn reports no occupancy')
      assert.deepEqual(getAssignment(created.id, env), third.assignment)
    })

    test('a store created by T1 without context_tokens still reads and records occupancy', () => {
      const env = tmpEnv()
      seedT1Store(backend.name, env)

      const legacy = getAssignment(T1_ROW.id, env)
      assert.equal(legacy.contextTokens, null)
      assert.equal(legacy.tokensUsed, 900)

      assert.equal(beginTurn(T1_ROW.id, 'job-1', env).ok, true)
      const done = completeTurn(T1_ROW.id, { jobId: 'job-1', tokens: 100, contextTokens: 5000 }, env)
      assert.equal(done.ok, true)
      assert.equal(done.assignment.contextTokens, 5000)
      assert.equal(getAssignment(T1_ROW.id, env).contextTokens, 5000)

      resetDbInstances()
      assert.equal(getAssignment(T1_ROW.id, env).contextTokens, 5000, 'reopening a migrated store is safe')
      assert.equal(createAssignment(baseInput(), env).contextTokens, null)
    })

    test('markRehydrated records the new session and timestamp', () => {
      const env = tmpEnv()
      const created = createAssignment(baseInput(), env)

      const res = markRehydrated(created.id, { sessionId: 'ses-new' }, env)
      assert.equal(res.ok, true)
      assert.equal(res.assignment.sessionId, 'ses-new')
      assert.ok(res.assignment.rehydratedAt)

      assert.deepEqual(markRehydrated('asg-missing', { sessionId: 'x' }, env), { ok: false, reason: 'not_found' })
    })
  })
}

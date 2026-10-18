import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { paths, readguardStrict } from './config.mjs'

// same-tree-fanout (S1, S2): how a read-mode job is isolated from the
// caller's working tree. Callers (Claude Code) fan out read jobs in their own
// checkout and never create worktrees; the hub decides per adapter:
//
// - readPolicy 'enforced' (the CLI itself refuses writes: copilot deny-tool,
//   codex read-only sandbox, opencode plan agent) -> run in place. The
//   whole-tree read guard cannot tell who changed a file, so a change seen
//   during the run (often the caller or a sibling job) is a warning.
// - readPolicy 'scratch' (agy: `--mode plan` is known to write anyway) -> run
//   in a hub-owned detached worktree carrying the caller's uncommitted state;
//   whatever the agent writes there is discarded with the copy.
// - no readPolicy (unknown/future adapter) -> in place, strict guard: the
//   pre-existing behavior.

export const ISOLATION_VALUES = Object.freeze(['auto', 'in-place', 'scratch'])

// Cap the untracked files copied into a scratch copy: past this the copy is
// refused (and the job falls back to in place) rather than silently partial.
const MAX_UNTRACKED_FILES = 2000

// A copy is removed when its job ends; one older than this was orphaned by a
// hub process that died mid-job (no job runs anywhere near this long).
const STALE_SCRATCH_MS = 24 * 60 * 60 * 1000

export function assertIsolation(isolation) {
  if (isolation == null) return
  if (!ISOLATION_VALUES.includes(isolation)) {
    throw new Error(`isolation must be one of ${ISOLATION_VALUES.join(', ')} (got ${JSON.stringify(isolation)})`)
  }
}

/**
 * Decide how a read job runs. Returns `{ mode: 'scratch'|'in-place', guard:
 * 'warn'|'strict' }`. AGENT_HUB_READGUARD=strict forces the strict guard
 * everywhere (the pre-feature behavior for in-place runs).
 */
export function resolveReadIsolation({ adapter, isolation = 'auto', env = process.env }) {
  const policy = adapter?.readPolicy ?? null
  const strictEnv = readguardStrict(env)
  const wantsScratch = isolation === 'scratch' || (isolation === 'auto' && policy === 'scratch')
  if (wantsScratch) return { mode: 'scratch', guard: strictEnv ? 'strict' : 'warn' }
  const inPlaceWarn = policy === 'enforced' && !strictEnv
  return { mode: 'in-place', guard: inPlaceWarn ? 'warn' : 'strict' }
}

function gitIn(cwd, args, exec, input) {
  return exec('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input != null ? { input } : {}),
  })
}

/**
 * Create a detached worktree of `cwd`'s repository under
 * AGENT_HUB_HOME/scratch/<id>, then replay the caller's uncommitted state
 * into it: tracked changes (staged + unstaged, as one binary diff against
 * HEAD) and untracked, non-ignored files. The caller's tree and index are
 * only read (`--no-optional-locks`), never written.
 *
 * Returns `{ ok: true, root, dir, cwd }` (cwd = the same subdirectory inside
 * the copy) or `{ ok: false, reason }`; a partial copy is always removed.
 */
export function createScratchCopy({ cwd, id = crypto.randomUUID(), env = process.env, exec = execFileSync }) {
  let root
  try {
    root = gitIn(cwd, ['rev-parse', '--show-toplevel'], exec).trim()
  } catch {
    return { ok: false, reason: 'not a git work tree' }
  }
  try {
    gitIn(root, ['rev-parse', '--verify', 'HEAD'], exec)
  } catch {
    return { ok: false, reason: 'repository has no commits' }
  }

  let untracked
  try {
    untracked = gitIn(root, ['ls-files', '--others', '--exclude-standard', '-z'], exec).split('\0').filter(Boolean)
  } catch (error) {
    return { ok: false, reason: `could not list untracked files: ${firstLine(error)}` }
  }
  if (untracked.length > MAX_UNTRACKED_FILES) {
    return { ok: false, reason: `too many untracked files to copy (${untracked.length} > ${MAX_UNTRACKED_FILES})` }
  }

  const scratchRoot = path.join(paths(env).home, 'scratch')
  const dir = path.join(scratchRoot, id)
  sweepStaleScratch(scratchRoot)
  try {
    fs.mkdirSync(scratchRoot, { recursive: true })
    gitIn(root, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD'], exec)
  } catch (error) {
    removeScratchCopy({ root, dir, exec })
    return { ok: false, reason: `git worktree add failed: ${firstLine(error)}` }
  }

  try {
    const patch = gitIn(root, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv'], exec)
    if (patch.length > 0) gitIn(dir, ['apply', '--binary', '--whitespace=nowarn'], exec, patch)
    for (const rel of untracked) {
      const target = path.join(dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(path.join(root, rel), target, { dereference: false, errorOnExist: false })
    }
  } catch (error) {
    removeScratchCopy({ root, dir, exec })
    return { ok: false, reason: `could not replay uncommitted changes: ${firstLine(error)}` }
  }

  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(cwd))
  return { ok: true, root, dir, cwd: rel ? path.join(dir, rel) : dir }
}

/** Remove a scratch copy and its worktree registration. Never throws. */
export function removeScratchCopy({ root, dir, exec = execFileSync }) {
  try {
    gitIn(root, ['worktree', 'remove', '--force', dir], exec)
  } catch {
    // fall through: remove the directory by hand and prune the registration
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
  try {
    gitIn(root, ['worktree', 'prune'], exec)
  } catch {
    // best-effort
  }
}

/**
 * Best-effort removal of scratch copies left behind by a crashed hub. Their
 * worktree registrations in the source repo are dropped by that repo's next
 * `git worktree prune` (run on every removeScratchCopy, and by git gc).
 */
function sweepStaleScratch(scratchRoot, now = Date.now()) {
  let names
  try {
    names = fs.readdirSync(scratchRoot)
  } catch {
    return
  }
  for (const name of names) {
    const dir = path.join(scratchRoot, name)
    try {
      if (now - fs.statSync(dir).mtimeMs > STALE_SCRATCH_MS) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error)
  return text.split('\n').find((line) => line.trim()) ?? text
}

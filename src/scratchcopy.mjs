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
//   in a hub-owned shared clone carrying the caller's uncommitted state;
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

function gitIn(cwd, args, exec, { input, encoding = 'utf8' } = {}) {
  return exec('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input != null ? { input } : {}),
  })
}

/**
 * Create a scratch copy of `cwd`'s repository under
 * AGENT_HUB_HOME/scratch/<id>, then replay the caller's uncommitted state
 * into it: tracked changes (staged + unstaged, as one binary diff against
 * HEAD, so the copy matches the caller's working tree) and untracked,
 * non-ignored files.
 *
 * The copy is a `git clone --shared` (objects borrowed read-only through
 * alternates), NOT a linked worktree: it has its own refs, config and index,
 * no `origin` remote, and nothing is registered in the caller's repository —
 * so even git commands the agent runs inside the copy (commit, branch,
 * config) never reach the caller. Hooks are disabled for the checkout. The
 * caller's tree and index are only read (`--no-optional-locks`).
 *
 * Returns `{ ok: true, root, dir, cwd }` (cwd = the same subdirectory inside
 * the copy) or `{ ok: false, reason }`; a partial copy is always removed.
 */
export function createScratchCopy({ cwd, id = crypto.randomUUID(), env = process.env, exec = execFileSync }) {
  let root
  let head
  try {
    root = gitIn(cwd, ['rev-parse', '--show-toplevel'], exec).trim()
  } catch {
    return { ok: false, reason: 'not a git work tree' }
  }
  try {
    head = gitIn(root, ['rev-parse', '--verify', 'HEAD'], exec).trim()
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
  // ls-files reports an untracked nested repository as one `dir/` entry.
  const nested = untracked.find((rel) => rel.endsWith('/'))
  if (nested) return { ok: false, reason: `untracked nested repository at ${nested} cannot be copied` }

  const scratchRoot = path.join(paths(env).home, 'scratch')
  const dir = path.join(scratchRoot, id)
  sweepStaleScratch(scratchRoot)
  try {
    fs.mkdirSync(scratchRoot, { recursive: true })
    gitIn(scratchRoot, ['clone', '--shared', '--no-checkout', '--quiet', '--', root, dir], exec)
    gitIn(dir, ['remote', 'remove', 'origin'], exec)
    gitIn(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', head], exec)
  } catch (error) {
    removeScratchCopy({ dir })
    return { ok: false, reason: `could not create the scratch clone: ${firstLine(error)}` }
  }

  try {
    // Buffers end to end: a text file that is not valid UTF-8 must reach the
    // copy byte for byte.
    // Explicit a/ b/ prefixes: a user's diff.noprefix / diff.mnemonicPrefix
    // would otherwise make `git apply` (-p1) strip the first path segment.
    const patch = gitIn(root, ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'], exec, { encoding: 'buffer' })
    if (patch.length > 0) gitIn(dir, ['apply', '--binary', '--whitespace=nowarn'], exec, { input: patch })
    for (const rel of untracked) {
      const target = path.join(dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      // verbatimSymlinks: keep a relative link relative, so it resolves inside
      // the copy instead of being rewritten to point back into the caller's tree.
      fs.cpSync(path.join(root, rel), target, { dereference: false, verbatimSymlinks: true, errorOnExist: false })
    }
  } catch (error) {
    removeScratchCopy({ dir })
    return { ok: false, reason: `could not replay uncommitted changes: ${firstLine(error)}` }
  }

  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(cwd))
  const copyCwd = rel ? path.join(dir, rel) : dir
  if (!fs.existsSync(copyCwd)) {
    removeScratchCopy({ dir })
    return { ok: false, reason: `cwd ${rel} does not exist in the scratch copy (ignored or empty untracked directory)` }
  }
  return { ok: true, root, dir, cwd: copyCwd }
}

/** Remove a scratch copy. Never throws. Nothing to unregister in the caller repo. */
export function removeScratchCopy({ dir }) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/**
 * Best-effort removal of scratch copies left behind by a crashed hub.
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

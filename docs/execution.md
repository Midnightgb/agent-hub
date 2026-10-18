# Execution model

## Circuit breaker

A per-agent+model breaker opens after `failureThreshold` (2) matching
failures (`quota`, `canceled`, `billing`) within a 30-minute window, or
immediately on a single `billing` failure (a billing failure such as an
insufficient-balance error does not clear on retry). A manual
`breakerReset` override (dashboard "Reset breaker" button, or `POST
/api/overrides`) makes earlier failures at or before that instant stop
counting.

Per-class breakers extend this without replacing it: `src/policy/taxonomy.mjs`
classifies failures (`billing`, `auth`, `quota`, `timeout`, `transport`,
`crash`, `quality`), `CIRCUIT_BREAKER_BY_CLASS` in `src/config.mjs` sets a
window/threshold per class, and `src/breakers.mjs` evaluates them
(`circuitBreakerOpenByClass`, `matchingFailuresByClass`, `breakerStatus`).
`src/policy/registry.mjs` (`POLICY_TABLE`, `policyFor`) then maps each class
to an explicit `{retry, resume, fallback, escalation}` policy executed by
`executeWithPolicy()` in `src/policy/executor.mjs` — one declarative loop,
not a chain of `if/else`. The table covers every taxonomy category
(`billing`/`auth` never retry and escalate to human; `quota` retries bounded
then falls back; `crash` gets one retry then an alternate adapter), and
`ctx.recoveryOrder` lets a remote adapter run resume/reconcile before any
retry that could duplicate a session (escalation always stays last).

## Execution contract

`docs/execution-contract.md` is the normative spec for job execution
(deadline, cancellation, retry/resume/fallback/escalation, idempotency, read
purity, write ownership, local-vs-remote state). The two invariants to
remember: a **local deadline is never a remote failure** (a timed-out watcher
stops polling with `pollingStoppedReason: local_deadline`; only the remote
session's own state finalizes the job), and **local cancel always wins**
while **remote cancel is never guaranteed**. Dispatch idempotency
(`dispatchKey = sha256(task + cwd + taskType + workflowStep [+ label])`,
`executionId`/`attempt`/`parentExecutionId`/`rootExecutionId`) is separate
from remote-creation reconciliation (fingerprint `repo/branch/task/title/window`
plus a `listSessions` search before creating).

## Workflow-ready job records

`JobRecord` carries nullable workflow columns from the start (`workflow_id`,
`step_id`, `parent_execution_id`, `root_execution_id`, `attempt`,
`remote_state`, `verified`, `judge_verdict`) so the later
workflow engine never needs a breaking migration.

## Execution graph

The `execution_graph` tool and `GET /api/execution-graph` construct a
deterministic DAG of agent executions across workflows, retries, and sessions:

- **Identity**: Nodes identify by `executionId` (falling back to `execution_id`
  or `jobId`). Each node records `id`, `jobId`, `agent`, `model`, `status`,
  `workflow_id`, `step_id`, `attempt`, `parent`, `root`, and `relation`.
- **Relation classification**:
  - `delegate`: standard dispatch invocation.
  - `retry`: when `attempt > 1`.
  - `resume`: when child `sessionId` matches the parent's `sessionId`.
- **Subtree querying**: passing `rootExecutionId` filters the graph to return
  only the directed subtree rooted at that execution.

## Harness profiles

Profiles model caller orchestration strategy without coupling the engine to any
specific client: `generic` (`waitMode: none`), `claude-code` (`attention`), and
`opencode` (`attention`).

- **Priority**: explicit `waitMode`/`harness` arg > `AGENT_HUB_HARNESS` env > MCP
  `clientInfo` handshake hint > `generic`.
- **Wait modes**: `none` returns immediately at create/start; `attention` returns
  on terminal status or interactive waiting (`AWAITING_*`/`PAUSED`); `terminal`
  waits for terminal status only.
- **Lifecycle bridge (`src/harness/bridge.mjs`, `lifecycle.mjs`, `opencode-bridge.mjs`)**:
  - Data-driven completion notification back to the originating caller session.
  - `recordDispatchOrigin()` captures incoming session metadata into the
    SQLite `harness_origins` table (`job_id`, `harness_session_id`, `harness`).
  - `deliverCompletion({ jobId, event, summary })` queries the resolved bridge
    for `supportsWake()`. When supported, it delivers completion payloads
    (bounded summary up to 300 chars) and emits `harness.wake` events.
  - `generic` and `claude-code` bridges declare `supportsWake: false`. When
    `AGENT_HUB_OPENCODE_BRIDGE=1` is enabled, the OpenCode lifecycle bridge
    (`opencode-bridge.mjs`) declares `supportsWake: true` and resumes the caller
    session with `POST /api/session/{id}/prompt` (`{ text, resume: true }`),
    reading service URL and credentials from `~/.local/state/opencode/service.json`
    (`AGENT_HUB_OPENCODE_SERVICE_FILE`). Delivery never throws.

## Task assignments

An assignment keeps one plan task in one agent's native CLI session across
many turns until a human closes it (`src/tools/assignments.mjs`, store in
`src/assignments.mjs`). Use it instead of `delegate` + `job_reply` when the
work will need rework: later turns resume the session, so the agent does not
re-read the codebase.

1. `task_assign` creates the assignment and starts turn 1 through the
   `delegate` path.
2. `task_continue` starts every later turn on the head job's `sessionId`
   through `job_reply`'s core. One turn runs at a time; a second call while a
   turn is running is refused with `busy`.
3. `task_close` records the human verdict (`accepted` or `abandoned`). The
   assignment becomes `closed` and further turns are refused with `closed`.

Only agy, opencode and codex are assignable. Jules keeps its own remote
multi-turn session through `jules_interact`.

| Topic | Behavior |
|---|---|
| Turn reconciliation | Lazy: `task_status`, `task_continue` and `task_close` fold the in-flight job's record into the assignment (head job, `sessionId`, `turns`, tokens). A failed or canceled turn still advances the head. No background watcher, so it survives a server restart. |
| Context budget | `contextBudget {contextTokens, contextWindow, fraction, source, warning?}` on `task_continue` and single `task_status`. `contextTokens` is the last turn's input-side tokens (codex `input`; agy/opencode report one total, used as a proxy that can overstate). `contextWindow` comes from the opencode live catalog (`limit.context`, `source: 'catalog'`), otherwise `AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS` (default 200000, `source: 'default'`). `warning` appears once `fraction` reaches `AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION` (default 0.6, range (0, 1]). Advisory only: it never blocks a turn, and it replaces `job_reply`'s turn-depth nudge inside an assignment. |
| Rehydration | `task_continue` starts a fresh session (same agent/model/cwd/mode) seeded with the brief, the tail of the last response (at most 8000 characters, with a truncation marker) and the new message when: the head has no `sessionId` (`no_session`); `job_reply` refuses the session with `no_session`/`unsupported` without spawning a job (`session_unusable`); or the caller passes `rehydrate: true` (`requested`). The result carries `rehydrated` and `rehydrationReason`; the old session and its occupancy are dropped. |

Known gap: a resumed run that **fails** because the native session expired is
not detected as such (no adapter `classifyError` recognizes it), so it does
not rehydrate automatically. It surfaces as a failed turn; call
`task_continue` with `rehydrate: true` to recover.

## Write-mode gate

Only write mode without a `writeScope` needs a worktree; read jobs run in the
caller's checkout (see "Read-mode isolation and guard" below) and scoped
writers in a scratch copy (see "Scratch writers" below). A
`delegate()`/`job_reply()` call with `mode: 'write'` and no `writeScope`
requires `cwd` to be
a secondary `git worktree add` checkout (see `src/worktree.mjs`), plus a
per-cwd single-writer lock — this keeps an agent CLI from editing the same
working tree Claude Code (or another job) is using, and keeps two write jobs
from racing on the same worktree.

## Scratch writers

`delegate`/`dispatch` with `mode: 'write'` and a `writeScope` (repo-relative
globs) run the agent in a scratch copy of the caller's repository (the same
private `git clone --shared` read jobs use), even when `cwd` is the primary
checkout. No worktree gate, write allowlist or per-cwd lock applies. The hub
commits the copy's starting state as a base; when the agent succeeds, every
change it made against that base (commits included) is split by the scope:

- in scope: applied to the caller's **working tree** with `git apply`
  (never the index, refs or config), recorded as
  `scratchWrite.appliedPaths`; diff stats count only these paths;
- out of scope: not applied, recorded as `scratchWrite.discardedPaths`.

Scope entries match as `:(top,glob)<entry>` from the repository root: `*`
stays within one directory level, `**` crosses levels, a bare directory name
matches everything below it. Absolute paths, `..`, empty entries and entries
starting with `:` are rejected before any job exists, as is a `writeScope` on a
read job or a remote agent.

The apply step is all or nothing and serialized per repository by a short lock
(`runs/.locks/apply-*`; a stale holder is reclaimed by dead pid or after 2
minutes; a wait over 30 s ends the job `errorKind: 'locked'`). The caller's own
edits to other files during the run are never touched, and two writers with
disjoint scopes both apply. When the in-scope patch does not apply to the
caller's current tree (the caller or another writer changed the same lines),
nothing is applied: the job ends `failed` with `errorKind: 'apply_conflict'`
naming `scratchWrite.conflictPaths`. The patch is always kept at
`runs/<jobId>/scope.patch` (`scratchWrite.patchPath`), also when the agent
itself failed, so the work can be applied by hand. No copy means
`errorKind: 'scratch_unavailable'`; a scoped writer never falls back to writing
in place. `job_reply` on a scoped writer inherits its `writeScope` (each turn
gets a fresh copy that already contains the previous turns' applied changes),
and `verify` checks run in the caller's `cwd` after the apply.

## Metrics and adaptive timeouts

`computeMetrics()` reads the job records under `runs/`, drops non-terminal jobs
and the operational `errorKind`s (`locked`, `worktree_denied`, `orphaned`,
`canceled_by_user`), and aggregates the rest per
`(agent, model, mode, taskType)`: sample count, succeeded/failed/canceled,
success rate, p50/p95 latency over **succeeded** runs, an `errorKind`
histogram and token totals. It backs the `agents_metrics` tool and
`GET /api/metrics`.

Each row also carries the quality/cost/latency intelligence:

- `costUsdTotal` / `costUsdAvg` — summed and averaged over the jobs that carry
  a finite `costUsd` (null when none do).
- `verifiedCount` / `verifiedSamples` / `verifiedRate` / `verificationFailures`
  — from the C3/C4 `verified` verdict on the job record. `verifiedSamples` is
  the denominator: only jobs with an actual boolean verdict count, so an agent
  that was never verified has `verifiedRate: null`, not 0.
- `judgeVerdicts` — histogram of the C4 `judge_verdict`
  (`accepted`/`needs_revision`/`rejected`/`blocked`), mirrored onto the job as
  soon as the judge decides.
- `revisionTotal` / `revisionAvg` and `retryCount` — how much rework a pair
  needed (integer `revision` values; jobs with `attempt > 1`).
- `qualityScore` — `10 * verifiedRate` rounded to one decimal, and `null` when
  there is no verification evidence. Quality is only claimed when it was
  measured; an unverified agent is shown as unknown (`unverified` in the
  dashboard), never as perfect.

Non-finite values are skipped exactly like tokens, so a malformed record can
never turn a row into `NaN`.

`resolveEffectiveTimeoutS()` picks the timeout for a job: an explicit
`timeoutS` always wins (`source: 'explicit'`). Otherwise the static default
from `config.mjs` is **raised, never lowered** — to `ceil(p95s x 1.5)`, capped
at 3600 s — once a row has at least `METRICS_MIN_SAMPLES` (10) samples; thin
`taskType` data falls back to the general (`taskType: null`) row. The job
record keeps the value used and its `timeoutSource` (`adaptive` or `default`).

## Read-mode isolation and guard

Read jobs need no worktree: a caller (Claude Code) can fan out several read
jobs in parallel in its own checkout. Each adapter declares a `readPolicy`
(see `src/scratchcopy.mjs`), and the `isolation` param on `delegate`/`dispatch`
(`auto` by default, `in-place`, `scratch`) overrides it:

| Adapter | `readPolicy` | `auto` runs | Read guard |
|---|---|---|---|
| copilot (`--deny-tool=write/shell`), codex (read-only sandbox), opencode (`plan` agent) | `enforced` | in the caller's tree | `warn` |
| agy (`--mode plan` writes anyway) | `scratch` | in a hub-managed scratch copy | `warn` on the caller's tree |
| any adapter without a policy | — | in the caller's tree | `strict` |

**Scratch copy.** The hub makes a `git clone --shared` of the caller's
repository under `AGENT_HUB_HOME/scratch/<jobId>`, checks out the caller's
`HEAD` detached (hooks disabled), then replays the caller's uncommitted state
into it: tracked changes (staged and unstaged as one binary diff against
`HEAD`, so the copy matches the caller's working tree byte for byte) and
untracked, non-ignored files (symlinks copied verbatim, so a relative link
resolves inside the copy). Ignored files (`.env`, `node_modules`, build output)
and the inside of submodules are not copied. The clone borrows objects
read-only through alternates but has its own refs, config and index and no
`origin` remote, and nothing is registered in the caller's repository: git
commands the agent runs in the copy (commit, branch, config) never reach the
caller. The CLI runs in the same subdirectory of the copy as the caller's
`cwd`, and the copy is removed when the job ends; what the agent wrote there is
reported as `isolation.discardedPaths` and thrown away. The caller's tree and
index are only read (`git --no-optional-locks`).

What the copy cannot stop: an agent that writes to an **absolute path** inside
the caller's tree. The warn guard on the caller's tree reports that as
`readGuard` (it cannot tell it from the caller's own concurrent edits);
`AGENT_HUB_READGUARD=strict` fails the job instead.

If no usable copy can be made (not a git work tree, no commits, more than 2000
untracked files, an untracked nested repository, a `cwd` that does not exist in
the copy such as an ignored directory, a failed clone or patch), the job runs in
place with the strict guard and a warning, and `isolation.fallbackReason` says
why. Copies orphaned by a crashed hub are swept after 24 hours. `isolation` is
recorded only when a run differs from the plain strict in-place behavior
(scratch copy, warn guard, or fallback).

**Read guard.** Before a read job starts, the hub snapshots the git-visible
state of `cwd` (`git status --porcelain=v1 -z` plus `HEAD`) and re-snapshots it
when the job reaches a terminal state. The guard is a whole-tree diff: it cannot
tell who changed a path, so it also sees edits by the caller or a sibling job
running at the same time.

- `strict`: a job the CLI reported as succeeded is failed with
  `errorKind: read_mode_violation` naming the changed paths; the response text
  and tokens are still kept.
- `warn`: the job keeps its status; the changed paths are recorded as
  `readGuard: { level: 'warn', changedPaths, headChanged }` and as a warning.

`AGENT_HUB_READGUARD=strict` forces the strict guard for every read job (the
behavior before per-adapter policies). `job_status` and `job_result` return
`isolation`, `readGuard` and `warnings` when a job has them. A `cwd` outside a
git work tree produces no snapshot and is reported unverifiable rather than
clean.

Files ignored by git (for example `.env` or build output) are skipped by default.
Setting `AGENT_HUB_READGUARD_IGNORED=1` enables snapshotting of ignored files
via `git status --ignored=matching`. Note the documented residual limits:
in-place edits to existing files inside an already-ignored directory without
altering directory mtime or entry count are not detected because `git status`
reports only `!! dir/`.

## Structured review output and fan-out

`output: 'review'` on `delegate`/`dispatch` appends an instruction to the
prompt (every turn, including `job_reply`): end the reply with one fenced
```` ```json ```` block `{summary, findings[{severity, file, line, title,
detail}]}`, severity one of `blocker | major | minor | info`, at most 20
findings (`HANDOFF_LIMITS`). `job_result` parses the last such block and
returns `review`, or `review: null` plus `reviewError` when the block is
missing or invalid. A bad block never fails the job.

A same-tree review fan-out from Claude Code looks like:

1. `dispatch({taskType: 'adversarial-review', cwd, mode: 'read', fanout: true,
   output: 'review', waitMode: 'none', task})` starts the routed primary and its
   `parallelWith` pair, returned as `jobId` and `parallelJobs[].jobId`. To run
   N identical reviewers without a declared pair, call `dispatch` N times with
   distinct `label`s, or `delegate` once per agent.
2. `job_wait({jobIds})` (`until: 'any'` to read each as it finishes).
3. `job_result` per job, then synthesize the findings.


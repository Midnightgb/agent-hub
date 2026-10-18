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
(`dispatchKey = sha256(task + cwd + taskType + workflowStep)`,
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

A `delegate()`/`job_reply()` call with `mode: 'write'` requires `cwd` to be
a secondary `git worktree add` checkout (see `src/worktree.mjs`), plus a
per-cwd single-writer lock — this keeps an agent CLI from editing the same
working tree Claude Code (or another job) is using, and keeps two write jobs
from racing on the same worktree.

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

## Read-mode guard

Before a `read`-mode job starts, the hub snapshots the git-visible state of
`cwd` (`git status --porcelain=v1 -z` plus `HEAD`) and re-snapshots it when the
job reaches a terminal state. If the tree changed, a job the CLI reported as
succeeded is failed with `errorKind: read_mode_violation` naming the changed
paths; the response text and tokens are still kept. The guard exists because
read mode is not actually enforced by the CLIs: verified, `agy --mode plan`
writes files with or without `--dangerously-skip-permissions` (opencode's plan
agent did respect read mode in testing). A `cwd` outside a git work tree
produces no snapshot and is reported unverifiable rather than clean, and
because the guard is a tree diff it also flags changes other processes make in
the same `cwd` while the job runs.

Files ignored by git (for example `.env` or build output) are skipped by default.
Setting `AGENT_HUB_READGUARD_IGNORED=1` enables snapshotting of ignored files
via `git status --ignored=matching`. Note the documented residual limits:
in-place edits to existing files inside an already-ignored directory without
altering directory mtime or entry count are not detected because `git status`
reports only `!! dir/`. Run read jobs from a disposable worktree when strict
isolation is required.


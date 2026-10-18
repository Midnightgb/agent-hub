# Task assignments (persistent multi-turn task sessions)

Locator: `odd/tasks/task-assignments.md` · Engram mirror: `odd/task-assignments/tasks` (project `agent-hub`)
Branch: `feat/task-assignments` (stacked on `feat/opencode-live-catalog` @ `509d65f`, which is unmerged and overlaps `src/jobrunner.mjs`, `src/index.mjs`, `src/schemas.mjs`)

## Objective

Let the orchestrator assign one plan task to one agent and keep that agent's native CLI session alive across many turns until the human explicitly closes the task, instead of treating each delegation as fire-and-forget and re-briefing a fresh agent on rework.

## Problem

- `job_reply` already resumes the CLI-native session (agy `--conversation`, opencode `-s`, codex `exec resume`) by spawning a new one-shot job with the parent's `sessionId` (`src/tools/jobs.mjs:201-338`). Jules keeps a live remote session.
- There is no entity grouping that reply chain: the caller must track the latest `jobId` by hand; the only link is `parentJobId`/`turnDepth` (`src/jobstore.mjs:159-203`).
- No owner, no open/done state, no explicit human close.
- `TURN_DEPTH_WARNING = 5` (`src/config.mjs:56-57`) nudges toward a fresh delegate, the opposite of the goal.
- If the native session is lost, nothing rehydrates it.
- `src/capabilities.mjs:31` claims `claude.sessionResume: true` but there is no claude CLI adapter.

## Why

Large-context models (up to 1M tokens) can carry a whole task. Keeping the same session avoids re-reading the codebase on every rework turn.

## Scope

- New SQLite-backed `assignments` entity (id, agent, model, title, brief, planRef, cwd, mode, status, headJobId, sessionId, turns, tokensUsed, createdAt, updatedAt, closedAt, closeVerdict, closeNote).
- MCP tools: `task_assign`, `task_continue`, `task_status` (single + list), `task_close`.
- One in-flight turn per assignment.
- Token-based context budget warning for assignments (replaces turn-count nudge inside an assignment).
- Rehydration fallback when the native session cannot be resumed.
- Fix the `claude.sessionResume` capability inconsistency; docs and CHANGELOG.

Out of scope: copilot resume, a claude CLI adapter, long-lived CLI processes, routing changes from the 2026-10-08 free-model benchmark (separate change).

## Constraints

- Reuse existing `startJob`/`job_reply` plumbing; do not fork the job lifecycle.
- Assignments only for replyable agents (agy, opencode, codex, jules); reject others with a typed error.
- `job_reply`/`delegate` behavior for non-assignment jobs must not change.
- Node `node:test` runner; no new dependencies.

## Acceptance criteria

1. `task_assign` creates an assignment and its first job; `task_status` shows it `active` with `headJobId` set.
2. `task_continue(assignmentId, message)` resumes the head job's native session without the caller passing a jobId, advances `headJobId`, increments `turns`.
3. A second `task_continue` while a turn is running is refused (`busy`).
4. `task_close(assignmentId, verdict)` with `accepted|abandoned` sets terminal state; further `task_continue` is refused (`closed`).
5. Budget warning appears when accumulated tokens cross a configurable fraction of the model's context; no turn-count nudge inside assignments.
6. When resume fails for a lost session, the assignment rehydrates with brief + last response summary into a new session and records it.
7. Full `npm test` green.

## Checks

- Focused: `node --test test/assignments.test.mjs test/tools-assignments.test.mjs` (new), `node --test test/tools-jobs*.test.mjs test/capabilities.test.mjs` when touched.
- Full: `npm test`.

## Delivery

- Forecast: ~1,100 authored changed lines (T1 ~250, T2 ~400, T3 ~150, T4 ~200, T5 ~100) — over the ~400 budget.
- Strategy: `ask-on-risk` (default); chain strategy `feature-branch-chain` (user choice 2026-10-08): slice PRs merge into `feat/task-assignments`, one final PR to `main`.
- Running count: ~654 (T1) + ~520 (T2).

## Tasks

- [x] **T1 — Assignment store.** `assignments` table in `src/storage/sqlite.mjs` (SQLite + JSON fallback) + `src/assignments.mjs` (create/get/list/beginTurn/completeTurn/abortTurn/closeAssignment/markRehydrated; CAS via `updateAssignmentAtomic`) with tests. Route: delegated (writer; preparation read of storage layer). RED: `ERR_MODULE_NOT_FOUND` on `src/assignments.mjs`. GREEN: `node --test test/assignments.test.mjs` 28/28 (writer + parent spot check); `npm test` 1621/1621 (writer). ~654 authored lines (dual backend doubles code and tests). Commit `2a5fdf5`. Assessed: medium, `review_due` (slice_budget_reached); consent **declined** by user for this candidate → ordinary policy (writer self-verification + parent spot check). Reviewed boundary advanced to `2a5fdf5`. Notes for T2: `beginTurn` needs the jobId before `startJob`; refusals are `{ok:false, reason}` incl. `lock_mismatch`; invalid input throws.
- [x] **T2 — MCP tools.** `task_assign`, `task_continue`, `task_status`, `task_close` in `src/tools/assignments.mjs`, registered in `src/index.mjs` + schemas in `src/schemas.mjs`, with tests. Turn completion is reconciled lazily (on status/continue/close, from the head job record) so it survives restarts. Local agents only (agy, opencode, codex); Jules stays on `jules_interact` (decision: its remote session already gives multi-turn; follow-up if needed). Route: delegated (writer, 2+ non-trivial files) + parent inline mechanical fix of `test/server.test.mjs` tool list. Deviations accepted: jobId cannot be pre-reserved (`createJob` owns it), so the lock takes a `reserve-*` placeholder rebound via new `rebindTurn` right after `startJob` returns (stale placeholder >60s released on reconcile); `src/tools/jobs.mjs` untouched (wraps `delegateTool`/`jobReplyTool`); `model` required; optional `timeoutS` on continue; failed first turn leaves assignment active without head; codex tokens counted as input+output. RED: `ERR_MODULE_NOT_FOUND` on `src/tools/assignments.mjs`. GREEN: focused 100/100 (server, server-v2, tools-assignments, assignments) and `npm test` 1649/1649 (parent-observed); live stdio smoke of 4 tools (writer).
- [ ] **T3 — Context budget.** Accumulate per-turn tokens into the assignment; warn at a configurable fraction of model context; suppress turn-depth nudge for assignment turns. Route: pending.
- [ ] **T4 — Rehydration fallback.** On `no_session`/resume failure, start a fresh session seeded with brief + last response; mark `rehydratedAt`. Route: pending.
- [ ] **T5 — Capability fix + docs.** Correct `claude.sessionResume`; document tools in `docs/reference/tools.md`, README, CHANGELOG. Route: pending.

## Progress

- 2026-10-08: Exploration done (job lifecycle, job_reply, adapters, Jules). User approved the plan in this session. Branch created.

## Next step

T3 — token-based context budget.

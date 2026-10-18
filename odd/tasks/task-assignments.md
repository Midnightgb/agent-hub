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
- Running count: ~654 (T1) + ~520 (T2) + ~375 (T3) + ~405 (T4) + ~79 (T5).
- Slices (2026-10-08), each PR holds one work-unit commit; prerequisite #111 (`feat/opencode-live-catalog` → `main`, single-pr/size:exception) lands first:
  - #112 `feat/task-assignments-01-store` → `feat/task-assignments` — `2a5fdf5` (T1, ~730, size:exception: dual backend)
  - #113 `feat/task-assignments-02-tools` → `-01-store` — `5adc91c` (T2, ~927, size:exception: one tool unit)
  - #114 `feat/task-assignments-03-budget` → `-02-tools` — `e983118` (T3, ~390)
  - #115 `feat/task-assignments-04-rehydration` → `-03-budget` — `2f83884` (T4, ~414)
  - #116 `feat/task-assignments-05-docs` → `-04-rehydration` — `cec5876` + this delivery record (T5)
  - Tracker `feat/task-assignments` was reset to `509d65f` (base); its draft PR to `main` opens after #112 merges into it (an empty tracker PR cannot be opened).

## Tasks

- [x] **T1 — Assignment store.** `assignments` table in `src/storage/sqlite.mjs` (SQLite + JSON fallback) + `src/assignments.mjs` (create/get/list/beginTurn/completeTurn/abortTurn/closeAssignment/markRehydrated; CAS via `updateAssignmentAtomic`) with tests. Route: delegated (writer; preparation read of storage layer). RED: `ERR_MODULE_NOT_FOUND` on `src/assignments.mjs`. GREEN: `node --test test/assignments.test.mjs` 28/28 (writer + parent spot check); `npm test` 1621/1621 (writer). ~654 authored lines (dual backend doubles code and tests). Commit `2a5fdf5`. Assessed: medium, `review_due` (slice_budget_reached); consent **declined** by user for this candidate → ordinary policy (writer self-verification + parent spot check). Reviewed boundary advanced to `2a5fdf5`. Notes for T2: `beginTurn` needs the jobId before `startJob`; refusals are `{ok:false, reason}` incl. `lock_mismatch`; invalid input throws.
- [x] **T2 — MCP tools.** `task_assign`, `task_continue`, `task_status`, `task_close` in `src/tools/assignments.mjs`, registered in `src/index.mjs` + schemas in `src/schemas.mjs`, with tests. Turn completion is reconciled lazily (on status/continue/close, from the head job record) so it survives restarts. Local agents only (agy, opencode, codex); Jules stays on `jules_interact` (decision: its remote session already gives multi-turn; follow-up if needed). Route: delegated (writer, 2+ non-trivial files) + parent inline mechanical fix of `test/server.test.mjs` tool list. Deviations accepted: jobId cannot be pre-reserved (`createJob` owns it), so the lock takes a `reserve-*` placeholder rebound via new `rebindTurn` right after `startJob` returns (stale placeholder >60s released on reconcile); `src/tools/jobs.mjs` untouched (wraps `delegateTool`/`jobReplyTool`); `model` required; optional `timeoutS` on continue; failed first turn leaves assignment active without head; codex tokens counted as input+output. RED: `ERR_MODULE_NOT_FOUND` on `src/tools/assignments.mjs`. GREEN: focused 100/100 (server, server-v2, tools-assignments, assignments) and `npm test` 1649/1649 (parent-observed); live stdio smoke of 4 tools (writer). Commit `5adc91c`. Assessed: medium, `review_due` (slice_budget_reached); consent **declined** by user (relayed after a PC shutdown interrupted the session) → ordinary policy. Reviewed boundary advanced to `5adc91c`.
- [x] **T3 — Context budget.** Occupancy = last turn's input-side tokens stored as `context_tokens` (guarded `ALTER TABLE` migration for T1 DBs; JSON rows read back `null`); `tokens_used` stays cumulative cost. Window from opencode live catalog (`discovery.json` `models[].limit.context`, read in `src/tools/assignments.mjs` `catalogContextWindow`), else `ASSIGNMENT_DEFAULT_CONTEXT_TOKENS` 200000; warn fraction `ASSIGNMENT_CONTEXT_WARN_FRACTION` 0.6 (both `AGENT_HUB_*` env-overridable). `contextBudget {contextTokens, contextWindow, fraction, source, warning?}` on `task_continue` and single `task_status`; advisory only. Route: delegated (writer). Deviations accepted: codex occupancy = `input` only (cachedInput is a subset); agy/opencode expose a single total used as proxy (may overstate, fraction can exceed 1); budget not on list form; warning only under `contextBudget.warning`. RED: 4 store failures + 2 module load failures. GREEN: focused 126/126 (parent-observed); `npm test` 1664/1664 (writer). ~375 authored lines (~220 tests).
- [x] **T4 — Rehydration fallback.** `task_continue` starts a fresh session via `delegateTool` when: (a) no head job / no `sessionId` → `no_session`; (b) `jobReplyTool` refuses with `no_session`/`unsupported` and spawned nothing → `session_unusable`; (c) `rehydrate: true` → `requested`. Pure `buildRehydrationPrompt` (brief + tail of head `response.txt` capped by `REHYDRATION_RESPONSE_MAX_CHARS` 8000 with truncation marker + new message). Same turn lock across refusal and fallback; `markRehydrated` only after a successful spawn (sets `rehydratedAt`, clears session, resets `contextTokens`). Result adds `rehydrated`/`rehydrationReason`; T3 warning mentions `rehydrate: true`. Route: delegated (writer). Deviations accepted: variant/taskType read from head job; failed spawn → `rehydrated:false` + reason; no `rehydrations` counter; injectable `jobReplyFn`. Follow-up: no adapter `classifyError` (`src/adapters/agy.mjs:91`, `codex.mjs:101`, `opencode.mjs:119`) recognizes an expired session, so a resumed run that fails on an expired session does not auto-rehydrate. RED: store `markRehydrated` assertion + missing `REHYDRATION_RESPONSE_MAX_CHARS` export. GREEN: focused 127/127 (parent-observed); `npm test` 1678/1678 (writer). ~405 authored lines (~245 tests). Commit `2f83884`. T3 (`e983118`) assessed medium/under_budget; T3+T4 slice assessed medium, `review_due` (slice_budget_reached); consent **declined** by user → ordinary policy. Reviewed boundary advanced to `2f83884`.
- [x] **T5 — Capability fix + docs.** `claude.sessionResume` → `false` in `src/capabilities.mjs` (hub has no claude CLI adapter; host may continue its own subagents). Behavior change: `requirements: ['sessionResume']` now skips claude candidates (recorded in CHANGELOG). Docs: 4 rows in `docs/reference/tools.md`, "Task assignments" section in `docs/execution.md`, README mention, CHANGELOG `[Unreleased]` (3 Added, 1 Fixed); every documented name verified against source. Route: delegated (writer). RED: `capabilities.test.mjs` 8/9. GREEN: 9/9; capabilities + routing tests 29/29 (parent-observed); `npm test` 1679/1679 (writer). Follow-up: `claude.messagingTurnBoundary: true` has the same inconsistency (`job_reply` never replies to claude, `src/tools/jobs.mjs:127`).

## Progress

- 2026-10-08: Exploration done (job lifecycle, job_reply, adapters, Jules). User approved the plan in this session. Branch created.

## Next step

All tasks done. Follow-ups (not authorized yet): auto-detect expired sessions in adapter `classifyError`; `claude.messagingTurnBoundary`; Jules assignments; routing fallbacks from the 2026-10-08 free-model benchmark. Delivery: PRs #111–#116 open; merge order #111 → #112 → … → #116, then open the tracker PR `feat/task-assignments` → `main`. Merges are the user's decision.

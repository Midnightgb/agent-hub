# ODD Feature: scratch-writers (same-tree-fanout phase 2)

Objective: let Claude Code delegate write jobs that run in parallel against its own checkout without a caller-managed worktree. Each writer works in a hub-managed scratch copy, and the hub applies only the diff inside the writer's declared `writeScope` back to the caller's tree.
Branch: `feat/scratch-writers` (from `main` 6589bb1). Delivery: `ask-on-risk`; forecast ~700 authored lines; chain strategy `feature-branch-chain` reused from phase 1 (L4 of `odd/tasks/same-tree-fanout.md`). Runner: `npm test` (node --test).

## Specs

User decision, quoted verbatim from the chosen option (L2): "Copia + aplicar (Recommended)" — "El escritor trabaja en una copia temporal como agy en la fase 1. Al terminar, el hub aplica a tu árbol solo el diff dentro de su writeScope. Atribución exacta, tus ediciones en paralelo no lo afectan y lo que escriba fuera del scope se descarta. Si tú y el escritor tocan el mismo archivo, el job termina en conflicto y el parche queda guardado para que lo resuelvas."

- **S1 — Opt-in scratch writer.** "El escritor trabaja en una copia temporal como agy en la fase 1."
  - Acceptance: `delegate`/`dispatch` with `mode:'write'` and a non-empty `writeScope` (repo-relative globs) run in a scratch copy of the caller's repo, created with the phase-1 `createScratchCopy`, even when `cwd` is the primary checkout.
  - The agent runs in the same subdirectory of the copy as the caller's `cwd`.
  - `mode:'write'` without `writeScope` is unchanged: the worktree gate, the per-cwd lock and in-place writes behave as before.
  - An invalid `writeScope` (absolute path, `..`, empty string) is rejected before any job record exists.
  - If no copy can be made, the job fails with `errorKind:'scratch_unavailable'` and the reason. It never falls back to writing in place.
- **S2 — Apply only the in-scope diff.** "Al terminar, el hub aplica a tu árbol solo el diff dentro de su writeScope."
  - Acceptance: when the agent succeeds, the hub computes the agent's own changes in the copy against the copy's starting state, including commits the agent made.
  - Paths matching `writeScope` are applied to the caller's working tree (never its index, refs or config) and recorded as `scratchWrite.appliedPaths`.
  - Paths outside the scope are not applied and are recorded as `scratchWrite.discardedPaths`.
  - Diff stats report only the applied paths.
  - An agent that changed nothing in scope ends `succeeded` with `noChanges:true`.
- **S3 — Parallel caller edits do not interfere.** "Atribución exacta, tus ediciones en paralelo no lo afectan."
  - Acceptance: the caller (or a sibling job) editing other files in the caller's tree during the run never fails the writer and is never reverted.
  - Two scratch writers on the same repo with disjoint scopes both apply.
  - Applying is serialized per repository by a short lock.
- **S4 — Conflicts keep the patch.** "Si tú y el escritor tocan el mismo archivo, el job termina en conflicto y el parche queda guardado para que lo resuelvas."
  - Acceptance: when the in-scope patch does not apply cleanly to the caller's current tree, nothing is applied (all or nothing). The job ends `failed` with `errorKind:'apply_conflict'`, naming the conflicting paths.
  - The full in-scope patch is saved as `runs/<jobId>/scope.patch` and its path is returned as `scratchWrite.patchPath`.
- **S5 — Docs, tools and skills.** Assumption (from the phase-1 proposal, not re-quoted): the MCP params, help text, `docs/execution.md`, `docs/reference/tools.md`, CHANGELOG and `skills/multi-agent-orchestrator/SKILL.md` "Parallel writes" describe scratch writers as the default way to parallelize writes, and keep worktrees for writers without a scope.

Assumptions:
- `job_reply` on a scratch-writer parent inherits its `writeScope`; each turn gets a fresh copy, which already contains the previous turns' applied changes.
- `verify` checks keep running in the caller's `cwd`, after the apply.

Out of scope: changing the existing worktree gate, the write allowlist or the per-cwd lock for scope-less writers; the `dispatch` chain-mode override; rollback of an applied patch.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1-S4 | delegated writer (context backstop: long parent session) | pending | |
| T2 | S5 + MCP params | inline | pending | |
| T3 | S1-S5 | delegated verifier (high risk: write path, concurrency) | pending | |

Route evidence: T1 goes to a writer under the long-session backstop. The parent context is past ~150k after phase 1. Risk items 1 (writes to the caller's tree), 2 (write guard semantics) and 4 (concurrent apply) fire the Verification trigger.

## Log

- L1 (2026-10-18, user, verbatim): "ya reconecte ,entones seguimos con la siguiente fase o pr primero tu la aceotas y sigues ?" then "si dale" (to: merge phase 1 PRs, reinstall from main, start phase 2).
- L2 (2026-10-18, user choice, verbatim option): "Copia + aplicar (Recommended)".
- L3: Design inputs from phase 1. `createScratchCopy` (`src/scratchcopy.mjs`) makes a `git clone --shared` with no origin and hooks disabled, replaying uncommitted and untracked state. The whole-tree read guard cannot attribute changes, which is why writers must not run in place. `src/worktree.mjs` holds the existing gate and per-cwd lock. `src/diffstats.mjs` `computeDiffStats({cwd, baseCommit})`.

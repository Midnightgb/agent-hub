# Feature: model-autodiscover

Branch: `feat/router-agy-mechanical-and-model-autodiscover`
Engram mirror: `odd/model-autodiscover/tasks` (project `agent-hub`)

## Objective

When agent CLIs ship new models, surface them as human-reviewed routing
proposals instead of leaving `DELEGATION_MAP` silently stale. Also route
`mechanical-edit` to agy before the paid deepseek candidate.

## Problem / why

- `discovery.mjs` already stores each CLI's model catalog in `discovery.json`,
  but nothing diffs that catalog against `DELEGATION_MAP` / `MODEL_REGISTRY`.
- `proposals.mjs` can only reorder pairs that already exist in a static chain:
  `acceptedOrderFor` maps `toOrder` back onto existing chain steps, so a new
  model can never enter routing through the proposal flow.

## Scope

- Detect catalog models absent from `DELEGATION_MAP` and `MODEL_REGISTRY`.
- Detect version bumps of models already used in chains (same family, higher
  version, same effort suffix, e.g. `gemini-3.8-flash-low` -> `gemini-3.9-flash-low`).
- Emit `add_candidate` proposals for version bumps, one per chain that uses
  the older family model; accepted candidates are appended at the TAIL of the
  chain, never first. Promotion only through existing metric-based reorder
  proposals.
- Models with no family match are listed as "unmapped" (no taskType can be
  inferred safely), not proposed.
- Dashboard renders `add_candidate` proposals distinctly.

## Constraints

- Never auto-insert or auto-promote an unevaluated model.
  Exception (2026-11-25, see Log): substituting a VANISHED pin with its
  same-family, same-effort successor at route() time is deliberate; held
  pins and pool steps (`@free`/`@go`) are excluded. Any other new model
  still enters a chain only through an accepted `add_candidate` proposal.
- Skip catalogs that are not authoritative: copilot (only `auto` is reliable)
  and codex (no real listing).
- Existing reorder proposals keep working; `chainHash` staleness semantics
  must stay correct once a chain has accepted additions (hash the effective
  chain).
- `pruneCacheForMap` must treat accepted added candidates as reachable.
- Strict TDD: RED before implementation, then GREEN, then REFACTOR.
- Planning heuristic ~400 authored changed lines per task (advisory only).

## TDD

- Mode: enabled (source: session configuration, "Strict TDD Mode: enabled").
- Runner: `npm test` (`node --test` over `test/**/*.test.mjs`, excluding
  `test/live`); dashboard workspace uses its own test script.

## Tasks

- [x] T1 — agy `gemini-3.8-flash-medium` (write) first in `mechanical-edit`,
  before deepseek. Route: inline (1 src file + 1 test + 2 doc rows).
  Evidence: RED observed (chain[0] was opencode/deepseek), GREEN `npm test`
  1440/1440. Commit `a445ecf`. RDD assess: medium, `under_budget` (pending in slice).
- [x] T2 — Pure gap detection: `computeModelGaps({ discovery, map, registry })`
  returning `{ versionBumps: [{agent, fromModel, toModel, taskTypes}], unmapped:
  [{agent, model}] }`, with family/version/effort parsing. Tests in
  `test/discovery.test.mjs` (or a new `test/model-gaps.test.mjs`).
  Evidence: RED observed (`ERR_MODULE_NOT_FOUND src/model-gaps.mjs`), GREEN
  `node --test test/model-gaps.test.mjs` 10/10, full `npm test` 1450/1450.
  Commit `404726a`.
- [x] T3 — `add_candidate` proposals: schema (`src/schemas.mjs`), creation in
  `refreshProposals` from `discovery.json`, dedupe/cooldown, effective-chain
  splice at tail in `route()`, `chainHash` on effective chain, and
  `pruneCacheForMap` reachability. Tests in `test/proposals.test.mjs` and
  `test/router.test.mjs`.
  Evidence: RED observed per new test (proposals: 8 failing incl.
  `effectiveChainFor is not a function`; router: fallback-count assertion
  failed 2!==3; discovery: prune-keep assertion failed; dashboard-api-v2:
  `unmapped` assertion failed after stashing the dashboard.mjs wiring).
  GREEN: `node --test test/proposals.test.mjs test/router.test.mjs
  test/discovery.test.mjs` 49/49; `node --test test/dashboard-api-v2.test.mjs`
  all passing; full `npm test` 1459/1459; `npm run -w dashboard typecheck`
  clean (fixed one pre-existing `ProposalT` fixture in
  `dashboard/src/views/config/config.test.tsx` missing the new required
  `kind` field); `npm run -w dashboard test` 179/179. Commit `f664d0a`.
- [x] T4 — Dashboard: render `add_candidate` proposals (new pair + tail
  position + "newer version of X"), accept copy, and list unmapped models.
  Tests in the dashboard workspace. Docs: `docs/routing.md` section.
  Evidence: RED observed (`dashboard/src/views/approvals/index.test.tsx`
  run against the pre-change component: 2 new tests failed — missing "New
  candidate"/"adds"/"unmapped" text — 8 pre-existing tests still passed).
  GREEN: `npx vitest run src/views/approvals/index.test.tsx` 10/10; full
  `npm run -w dashboard test` 181/181; `npm run -w dashboard typecheck`
  clean; `npm run build` succeeded; `grep -rn '<style\|style="\|data:font'
  dashboard/dist` printed nothing (CSP-safe); full `npm test` 1459/1459
  (unchanged, T4 is dashboard-only). Commit `17acc1f`.

Route declaration: T2–T4 delegated to one writer (preparation trigger: 4+
files across discovery, proposals, router, schemas, dashboard).

## Acceptance criteria

- A catalog containing `gemini-3.9-flash-low` while `recon` uses
  `gemini-3.8-flash-low` yields a pending `add_candidate` proposal for `recon`.
- Accepting it makes `route({taskType:'recon'})` include the new model as the
  last candidate; the primary is unchanged.
- Rejecting it suppresses re-creation during the existing cooldown.
- copilot/codex catalogs never produce proposals.
- `npm test` and dashboard tests pass.

## Progress / next step

- T2, T3, T4 (this writer's scope) are all done and verified. T1 was already
  done before this writer started.
- Parent spot check: `npm test` 1458/1459; the single failure is the
  timing-sensitive `test/process.test.mjs` SIGINT/SIGTERM test (untouched by
  this branch), 5/5 green in isolation -> pre-existing load flake.
- RDD: slice assess medium, `slice_budget_reached` (19 files, 1011 lines);
  candidate consent relayed, user chose "skip this time" -> declined
  (`declined_this_candidate`). Off-path tier medium: writer self-verification
  + parent spot check.
- Delivery: single PR to main, merged at the user's request.
- Next: none for this feature. Follow-ups tracked separately: C (per-job
  diff stats in dashboard), D (hub-side verification for agy jobs).

## Log

- 2026-11-25: PR #141 (vanished-pin substitution) relaxes the constraint
  "Never auto-insert or auto-promote an unevaluated model." for one case
  only: a pinned id its CLI catalog no longer lists is replaced, in the same
  chain slot, by its same-family, same-effort successor (never lower version,
  never a dated snapshot over a non-dated id, never paid for a free pin).
  Rationale: a vanished pin cannot run at all, so keeping it only breaks
  routing. Excluded: a pinned id with a hold (still skipped as `held`) and
  pool steps `@free`/`@go` (expanded by the opencode model policy, which also
  gates any substituted opencode id). New models otherwise still enter only
  via `add_candidate` proposals.

# Feature: opencode-live-catalog

Branch: `feat/opencode-live-catalog` (from `dev` @ `fd010aa`)
Engram mirror: `odd/opencode-live-catalog/tasks` (project `agent-hub`)

Rebased onto `main` @ `1f42aa0` (21 new upstream commits) between T3 and T4.
New SHAs after the rebase: `a27f52d` (T1), `2538cae` (T2), `0e1c1a8` (docs),
`c11aeec` (T1 correction), `942eada` (docs), `a6767d2` (T3), `fee108c`
(docs). The only conflict was additive, in the `JobRecord` schema
(`src/schemas.mjs`): upstream added a `repo` field, this branch added
`warnings` — both kept. Every hash below is the post-rebase SHA.

## Objective

Make agent-hub detect opencode models, especially free ones, from the live
opencode v2.0.18 catalog instead of a hand-written registry, and validate
reasoning variants against that catalog. This implements the open T11/T12
items of `odd/tasks/opencode-v2-migration.md`.

## Problem / why

Verified live on 2026-09-26 against opencode v2.0.18:

- Free detection is only `tier: 'free'` in `MODEL_REGISTRY.opencode`
  (`src/config.mjs`). It has drifted: `opencode/mimo-v2.5-free` no longer exists
  (the catalog now has `opencode/mimo-v2.6-flash-free`), and live free models
  such as `space-bunny-free`, `longcat-2.5-preview-free` and
  `ling-3.0-flash-fin-free` are not recognized. `opencode/big-pickle` is free
  but has no `-free` suffix, so cost is the only reliable signal.
- `discovery.json` already stores each model's `cost` (array of
  `{input, output, cache}`) and `variants` (array of `{id, settings}`) from
  `opencode api model.list`, but nothing consumes them.
- `resolveVariant` (`src/config.mjs`) never checks a requested variant against
  the model's catalog `variants[]`. Job `2cf805fa` failed with
  `provider.no-route: Variant unavailable for opencode/nemotron-3-ultra-free: high`.
- `src/discovery.mjs` reports an empty exit-0 model list (cold background
  service) as "model list timed out".
- `classifyError` in `src/adapters/opencode.mjs` collapses `provider.no-route`
  and transport errors (`socket connection was closed`) into a generic
  non-retriable `crash`.
- `TESTED_VERSIONS.opencode` is `2.0.10`; installed is `2.0.18`.

Out of scope (reported to the user, not acted on): the opencode startup
warnings come from user plugins (engram, rtk, skill-registry, ...) that are
incompatible with the opencode v2 plugin API. They are not agent-hub code.

## Scope

- Derive the opencode pricing tier (`free` / `paid`) from catalog `cost`,
  with the registry as fallback when the catalog is unavailable.
- Report drift between the catalog and `MODEL_REGISTRY` / `DELEGATION_MAP`
  (pinned id vanished, registry says free but catalog cost > 0, new free
  catalog model not in the registry). Report only.
- Surface the derived tier and drift in `agents_status` and the dashboard.
- Validate variants against catalog `variants[]` before spawning.
- Fix the empty-list error label, classify the two observed error kinds, and
  bump the tested version.

## Constraints

- Never auto-insert or auto-promote a model in `DELEGATION_MAP`. Routing
  changes stay in the human-reviewed proposal flow (`model-autodiscover`).
- Do not select models by predicate in the router (keeps jobs reproducible).
- `dataPolicy` and `strengths` stay hand-written.
- Strict TDD: RED before implementation, then GREEN, then REFACTOR.
- Planning heuristic ~400 authored changed lines per task (advisory only).

## TDD

- Mode: enabled (source: session configuration, "Strict TDD Mode: enabled").
- Runner: `npm test` (`node --test` over `test/**/*.test.mjs`, excluding
  `test/live`); dashboard: `npm run -w dashboard test` and
  `npm run -w dashboard typecheck`.

## Delivery

- Forecast: ~350-450 authored changed lines across 4 tasks (actual: see
  Progress — the T1 correction pushed the running total well past this).
- Strategy: **`single-pr` with `size:exception`** (user decision, made after
  the ~574-line checkpoint reached at the end of T1+T2, replacing the
  original `ask-on-risk` default). No further line-budget stop applies to
  this feature; the ~400-line-per-task heuristic remains advisory only —
  work is not split or trimmed to fit it.

## Tasks

- [x] T1 — Live pricing tier + drift for opencode. Pure helpers (e.g.
  `catalogTier(model)` from `cost`, `effectiveTier(agent, modelId, discovery)`
  with registry fallback, `computeCatalogDrift(...)`), exposed in the
  `agents_status` output (`tier`, `tierSource`) and in the model-gaps /
  discovery data the dashboard reads. Route: delegated writer (2+ non-trivial
  files).
  - New `src/catalog.mjs`: `catalogTier(entry)`, `effectiveTier({agent,
    model, discovery, registry})` -> `{tier, tierSource}`,
    `computeCatalogDrift({discovery, map, registry, agent='opencode'})` ->
    `[{type: 'vanished'|'now_paid'|'new_free'|'variant_unavailable', agent,
    model, variant?}]`. Drift only computed when the agent's discovery row is
    fresh (`PREFLIGHT_TTL_MS`) and has no `error`.
    **Superseded by the T1 correction below** — see there for the actual
    freshness rule shipped.
  - Wired `tier`/`tierSource` into `agentsStatusTool` (`src/tools/agents.mjs`)
    and `buildState()` (`src/dashboard.mjs`, the `/api/state` agents array).
    Wired `drift` into `GET /api/proposals` and `POST /api/proposals/refresh`
    (`src/dashboard.mjs`), alongside the existing `unmapped` field from
    `computeModelGaps`.
  - Schema (`src/schemas.mjs`): added `tier`/`tierSource` to
    `AgentStatusRow`; added `CatalogDriftItem` and a `drift` field on
    `ProposalsResponse`.
  - TDD: RED observed for `test/catalog.test.mjs`
    (`ERR_MODULE_NOT_FOUND src/catalog.mjs`); GREEN
    `node --test test/catalog.test.mjs` 18/18. RED observed for the 4
    integration tests (agentsStatusTool x2, buildState x1, dashboard-api-v2
    x1) by stashing the `src/dashboard.mjs`/`src/tools/agents.mjs` wiring and
    re-running — `not ok` on exactly those 4; GREEN after popping the stash:
    `node --test test/tools-agents.test.mjs test/dashboard.test.mjs
    test/dashboard-api-v2.test.mjs test/catalog.test.mjs` 106/106. Full
    `npm test`: 1548/1548 (baseline 1526 + 22 new).
  - Route: delegated writer (touched `src/catalog.mjs`, `src/schemas.mjs`,
    `src/tools/agents.mjs`, `src/dashboard.mjs` — 4+ files). Commit `a27f52d`.

  **T1 correction (real defect found by parent review of commit `a27f52d`):**
  `isFreshRow` gated `effectiveTier`/`computeCatalogDrift` on
  `PREFLIGHT_TTL_MS` (15 minutes). `discovery.json` is only refreshed at MCP
  startup (`src/startup.mjs`) and by the dashboard's explicit "Rediscover
  CLIs" action (`src/dashboard.mjs`, `force: true`) — never on a fixed
  interval — so after 15 minutes the live tier/drift silently and
  permanently fell back to the registry, defeating the feature almost all of
  the time. Confirmed live: at 22:04Z against a discovery row checked at
  21:31Z (33 minutes old, `error: null`, 99 models),
  `effectiveTier('opencode', 'opencode/space-bunny-free', ...)` incorrectly
  returned `{tier: null, tierSource: 'registry'}` and `computeCatalogDrift`
  incorrectly returned `[]`.
  - Verified `runDiscovery` (`src/discovery.mjs`) does **NOT** overwrite a
    previously good row with an errored/empty one on its own — it only
    re-probes an agent when `force` is true or the existing row is not
    fresh, and even then `discoverCli` itself returns `error: null` only on
    an actual successful `models-list` call. **However**, once it DOES
    re-probe (after 15 minutes, or on an explicit refresh), the merge in
    `runDiscovery` (`merged[agent] = outcome.value.entry`) unconditionally
    replaces the existing row with whatever the new probe returned, with no
    "keep the last good row if this probe failed" guard. A transient
    `discoverCli` failure (e.g. one 60s models-list timeout) *would*
    overwrite a previously-good row with an errored one at that point. This
    is a pre-existing, separate gap in `discovery.mjs`'s merge policy, not
    something introduced by `src/catalog.mjs` — reported here per
    instruction rather than fixed, since fixing it is out of this
    correction's scope (it touches `discoverCli`/`runDiscovery` merge
    semantics used by every consumer of `discovery.json`, not just tier/
    drift).
  - Fix: replaced the TTL-based `isFreshRow` with `isGoodCatalogRow(entry)` =
    `!entry.error && Array.isArray(entry.models) && entry.models.length > 0`
    — no age bound. `effectiveTier`/`computeCatalogDrift` now use the last
    successful catalog fetch regardless of its age; only "never fetched
    successfully" (error, or empty `models`) falls back to the registry /
    reports no drift. No new max-age bound was added — none of the evidence
    gathered here shows discovery.json ever going meaningfully stale in a
    way a bound would catch (it's either a fresh startup/refresh row, or an
    hours/days-old one that is still the best evidence available); not
    flagging this as an open decision gap since no concrete need for one was
    found.
  - Added `catalogCheckedAt` (the source discovery row's `checkedAt`, `null`
    when `tierSource` is `'registry'`) next to `tierSource`: in
    `effectiveTier`'s return shape, `agentsStatusTool`, `buildState()`'s
    `/api/state` agents array, and `AgentStatusRow` (`src/schemas.mjs`).
    Added `checkedAt` to every `computeCatalogDrift` item and to
    `CatalogDriftItem` (`src/schemas.mjs`). The dashboard's Tier badge title
    (`dashboard/src/views/agents/index.tsx`) now reads
    `"source: catalog · checked <age>"` (via the existing `formatAge`
    helper) instead of just `"source: catalog"`, so an hours-old catalog
    reading is visibly not a live one.
  - TDD: RED observed in `test/catalog.test.mjs` — a new test with
    `checkedAt` 2 hours old (`OLD`) and good catalog data asserted catalog
    tier/drift and failed against the pre-fix code (9 of 20 tests failed:
    the new/updated `catalogCheckedAt`-asserting tests, the old-row tests,
    and one that exposed a second latent bug — a fresh-but-`error:null`-and-
    `models:[]` row was NOT gated by the old code and incorrectly produced a
    `'vanished'` drift item; `isGoodCatalogRow`'s `models.length > 0` check
    fixes that too). GREEN: `node --test test/catalog.test.mjs` 20/20. RED
    observed in `dashboard/src/views/agents/agents.test.tsx` (new test
    asserting the badge title matches `/checked.*ago/`, failed with
    `"source: catalog"` before the UI change). GREEN after the UI fix:
    `npx vitest run src/views/agents/agents.test.tsx
    src/views/approvals/index.test.tsx` 17/17. Full `npm test`: 1550/1550
    (was 1548; +2 net from the two extra catalog.test.mjs cases). Full
    `npm run -w dashboard test`: 201/201 (unchanged count; one test
    strengthened). `npm run -w dashboard typecheck`: clean. `npm run build`:
    succeeded. `grep -rn '<style\|style="\|data:font' dashboard/dist`:
    nothing (CSP-safe).
  - Route: delegated writer (touched `src/catalog.mjs`, `src/schemas.mjs`,
    `src/tools/agents.mjs`, `src/dashboard.mjs`,
    `dashboard/src/views/agents/index.tsx` — 5 files). Commit `c11aeec`.

- [x] T2 — Dashboard: show the free/paid badge for opencode catalog models and
  list drift items. Route: delegated writer.
  - `dashboard/src/views/agents/index.tsx`: new "Tier" column, a `Badge`
    (`variant="outline"`, `title="source: catalog|registry"`) reading
    `row.tier`/`row.tierSource`; `tier === 'free'` gets the existing
    `TONE_BADGE_CLASS.ready` tone (no new colors/styles, CSP-safe).
  - `dashboard/src/views/approvals/proposals-panel.tsx`: new `DriftCard`
    (same shape as the existing `UnmappedModelsCard`) rendering
    `data.drift` with a per-item type badge and a human-readable summary
    per drift `type`.
  - `dashboard/src/lib/types.ts`: exported `CatalogDriftItemT` from the
    shared `CatalogDriftItem` zod schema (no hand-rolled type).
  - TDD: RED observed — `npx vitest run src/views/agents/agents.test.tsx
    src/views/approvals/index.test.tsx` before the UI changes: 3 failed
    (`renders a free tier badge...`, `renders a paid tier badge...`,
    `lists catalog drift items reported for opencode`), 14 passed. GREEN
    after implementing: same command 17/17. Full `npm run -w dashboard
    test` 201/201; `npm run -w dashboard typecheck` clean; `npm run build`
    succeeded; `grep -rn '<style\|style="\|data:font' dashboard/dist`
    printed nothing (CSP-safe). Full `npm test` 1548/1548 (unchanged, T2 is
    dashboard-only).
  - Route: delegated writer (5 dashboard files). Commit `2538cae`.

- [x] T3 — Variant validation: when the last good catalog row knows the
  model, an unsupported variant is dropped before spawning (the job runs at
  the model default) and the job records a warning; missing/errored catalog
  or unknown model keeps current behavior. Route: delegated writer.
  - New `validateVariant({agent, model, variant, discovery})` in
    `src/catalog.mjs`, reusing `isGoodCatalogRow` (no TTL, same semantics as
    the T1 correction) — not a new freshness rule. Handles an explicit
    `model#variant` id the same way as a separately-passed `variant`, with
    the embedded one taking precedence (matches
    `src/adapters/opencode.mjs`'s `buildArgv` convention exactly, so
    validation can never diverge from what actually gets sent). Returns
    `{model, variant, warning}`; `model` has an invalid embedded variant
    stripped back to the bare id.
  - Wired into `startJob` (`src/jobrunner.mjs`): right where
    `resolveVariant` used to directly become `effectiveVariant`, it now goes
    through `validateVariantFn` (default `validateVariant`) against
    `readDiscoveryFn(env)` (default `readDiscovery`), both injectable for
    tests. `model`/`effectiveVariant` are reassigned to the validated
    result before `createJob`/`buildArgv`, so the (possibly normalized)
    model and the (possibly nulled) variant are what actually gets spawned
    and persisted.
  - Added `warnings: string[]` to `JobRecord` (`src/schemas.mjs`) — no
    existing warnings/notes field on the job record — and record the
    dropped-variant message via `updateResult(job.jobId, {warnings: [...]},
    env)` right after `createJob`.
  - TDD: RED observed for `validateVariant` — `SyntaxError: ... does not
    provide an export named 'validateVariant'`; GREEN
    `node --test test/catalog.test.mjs` 29/29 (9 new `validateVariant`
    cases). RED observed for the `startJob` wiring by stashing
    `src/jobrunner.mjs` and re-running — exactly the 2 "drops the variant"
    integration tests failed (`not ok`), the 3 "keeps today's behavior"
    tests already passed unchanged (as expected, since those paths were
    never broken); GREEN after popping the stash:
    `node --test test/jobrunner.test.mjs` 36/36. Focused
    `node --test test/catalog.test.mjs test/jobrunner.test.mjs
    test/jobrunner-diffstats.test.mjs test/jobrunner-verify.test.mjs
    test/config.test.mjs` 96/96. Full `npm test`: 1564/1564 (was 1550; +14
    new). No dashboard files touched, so no dashboard verification required
    for this task.
  - Route: delegated writer (`src/catalog.mjs`, `src/jobrunner.mjs`,
    `src/schemas.mjs` — 3+ files). Commit `a6767d2`.

- [x] T4 — Hygiene: empty model list labelled distinctly from a timeout;
  `classifyError` gets retriable `transport` and non-retriable
  `invalid_variant`/`no_route` kinds; `TESTED_VERSIONS.opencode` bumped to
  `2.0.18`. Route: delegated writer.
  - `src/discovery.mjs`: `discoverCli` now distinguishes `modelsResult.timedOut`
    (`error: 'model list timed out'`) from an exit-0 empty stdout
    (`error: 'model list empty (service starting?)'`) — previously both
    collapsed into the same "timed out" label.
  - `src/adapters/opencode.mjs` `classifyError`: extended the upstream
    `transport` regex (added on `main` after this branch was cut, commits
    `661a999`/`b489ec7`) from `/^transport$|econnreset|econnrefused|socket
    hang up|fetch failed/` to
    `/^transport(:|$)|econnreset|econnrefused|socket hang up|socket
    connection was closed|fetch failed/` — the real captured message
    (job `0ebdbb0a`) was `"Transport: The socket connection was closed
    unexpectedly. For more information, pass \`verbose: true\` ..."`, which
    the narrower upstream pattern did not match (anchored `^transport$`, and
    "socket connection was closed" reads differently from "socket hang
    up"). Extended the existing pattern in place, not a parallel branch.
  - Added a new `no_route` kind: `errorEvent.error?.type ===
    'provider.no-route'` OR the lowercased message matching
    `/provider\.no-route|variant unavailable/` → `{kind: 'no_route',
    retriable: false, message: <original error.message, preserved
    verbatim>}`.
  - Checked and updated the policy layer so `no_route` is never
    mis-bucketed as `crash`: added `no_route: {retry: false}` to
    `ERROR_TAXONOMY` (`src/policy/taxonomy.mjs`) and `no_route: {retry:
    false, resume: false, fallback: true, escalation: 'human'}` to
    `POLICY_TABLE` (`src/policy/registry.mjs`) — without an explicit
    taxonomy entry, `classifyError`'s text heuristics would have fallen
    through to the generic `crash` category. Checked
    `CIRCUIT_BREAKER_BY_CLASS` (`src/config.mjs`): it already falls back to
    its `default` entry for any class not explicitly listed
    (`src/breakers.mjs`: `CIRCUIT_BREAKER_BY_CLASS[klass] ||
    CIRCUIT_BREAKER_BY_CLASS.default || CIRCUIT_BREAKER`), so `no_route`
    degrades safely with no code change needed there. `errorKind` in
    `src/schemas.mjs` is `nullableString` (free string, no enum), and the
    dashboard's `errorKindSeverity` (`dashboard/src/lib/badges.ts`) already
    defaults an unrecognized kind to the `warning` tone — both verified
    safe for a new kind with no dashboard changes required (not touched;
    no dashboard verification run for this task).
  - `TESTED_VERSIONS.opencode` (`src/index.mjs:50`) bumped `'2.0.10'` ->
    `'2.0.18'`. No test asserts this literal (it only drives a `selftest`
    CLI warning message), so no RED/GREEN cycle applies to it.
  - TDD: RED for the discovery empty-list label was re-established this
    session (the WIP predated a session interruption) by stashing
    `src/discovery.mjs` and re-running `node --test test/discovery.test.mjs`
    — exactly 1 failure (`discoverCli reports a distinct "model list
    empty"...`); GREEN after popping the stash: 14/14. RED observed for the
    3 new `classifyError` tests in `test/adapters/opencode.test.mjs`
    (real-message transport, no_route x2) — `not ok` on exactly those 3,
    35/38 passing; GREEN after implementing: 38/38. RED observed for the 2
    new policy tests in `test/policy.test.mjs` — `not ok` on both; GREEN
    after adding the taxonomy/policy entries: 13/13. Focused
    `node --test test/discovery.test.mjs test/adapters/opencode.test.mjs
    test/policy.test.mjs` 65/65. Full `npm test`: 1593/1593 (rebased-branch
    baseline, WIP included, was 1588/1588 before any T4 edits this session
    — confirmed clean before starting, no upstream-rebase fix needed; +5
    new this session).
  - Route: delegated writer (`src/discovery.mjs`, `src/adapters/opencode.mjs`,
    `src/policy/taxonomy.mjs`, `src/policy/registry.mjs`, `src/index.mjs` —
    5 files). Commit `fc1682c`.

## Acceptance criteria

- With the live catalog, every opencode model with zero input and output cost
  reports `tier: 'free'`, including `opencode/big-pickle`.
- A registry id missing from the catalog shows up as drift, not as free.
- A job requesting `variant: 'high'` on a model without that variant runs
  without `provider.no-route` and carries a warning.
- `npm test`, dashboard tests and typecheck pass.

## Progress

- Branch created.
- T1 done. Commit `a27f52d`. Authored changed lines: 450 (src 425+/-25 test
  included; see T1 entry above for the per-file breakdown).
- T2 done. Commit `2538cae`. Authored changed
  lines: dashboard 123 insertions / 1 deletion (`dashboard/src/lib/types.ts`
  +2, `dashboard/src/views/agents/agents.test.tsx` +38,
  `dashboard/src/views/agents/index.tsx` +17,
  `dashboard/src/views/approvals/index.test.tsx` +17,
  `dashboard/src/views/approvals/proposals-panel.tsx` +49/-1).
- T1 correction done (real defect the parent found via live evidence against
  commit `a27f52d`: TTL-gated tier/drift, inert almost all the time —
  fixed to use the last good catalog regardless of age; see the T1 entry
  above for full detail). Commit `c11aeec`. Authored changed
  lines: 176 (additions 120 / deletions 56) across `src/catalog.mjs`
  (+44/-26), `src/schemas.mjs` (+12/-5), `src/tools/agents.mjs` (+6/-4),
  `src/dashboard.mjs` (+2/-1), `test/catalog.test.mjs` (+38/-17),
  `dashboard/src/views/agents/index.tsx` (+11/-2),
  `dashboard/src/views/agents/agents.test.tsx` (+7/-1). Also reported (not
  fixed, out of this correction's scope): `runDiscovery`
  (`src/discovery.mjs`) unconditionally overwrites a row with whatever a
  re-probe returns, with no "keep the last good row on a failed re-probe"
  guard — a transient `discoverCli` failure after the (now irrelevant to
  catalog.mjs, but still real for CLI-readiness callers) 15-minute TTL could
  still replace a good catalog row with an errored one.
- User delivery decision recorded (see Delivery section): **`single-pr` with
  `size:exception`**, replacing `ask-on-risk`, made after the ~574-line
  checkpoint at the end of T1+T2. No further line-budget stop applies to
  this feature — implementation continues through T3 and T4 to completion.
- T3 done. Commit `a6767d2`. Authored changed lines: 248 (additions 246 /
  deletions 2) across `src/catalog.mjs` (+47), `src/jobrunner.mjs` (+24/-1),
  `src/schemas.mjs` (+5), `test/catalog.test.mjs` (+66/-1),
  `test/jobrunner.test.mjs` (+104).
- Branch rebased onto `main` @ `1f42aa0` (see header) between T3 and T4;
  commit hashes above updated to their post-rebase SHAs. Verified clean
  before starting T4: full `npm test` on the rebased branch (T4 WIP
  present) was 1588/1588 — no upstream-rebase fix needed.
- T4 done. Commit `fc1682c`. Authored changed lines: 110 (additions 107 /
  deletions 3) across `src/discovery.mjs` (+9/-1),
  `src/adapters/opencode.mjs` (+23/-1), `src/index.mjs` (+1/-1),
  `src/policy/registry.mjs` (+4), `src/policy/taxonomy.mjs` (+5),
  `test/discovery.test.mjs` (+17), `test/adapters/opencode.test.mjs` (+33),
  `test/policy.test.mjs` (+15).
- **All 4 tasks done.** Running authored-changed-lines total: 450 (T1) + 124
  (T2) + 176 (T1 correction) + 248 (T3) + 110 (T4) ≈ 1108 (git diff
  --numstat vs `main`, excluding lockfiles, `dashboard/dist`, and this doc
  file itself). Delivered as a single PR under `size:exception`, per the
  recorded delivery decision — not a stop condition. `.gitignore`'s
  pre-existing unrelated change was left unstaged throughout, every task.
- Not fixed (reported only, out of scope both times it was reported): the
  `runDiscovery` (`src/discovery.mjs`) merge-overwrite gap noted in the T1
  correction above.
- Next: none — all 4 tasks (T1-T4) are complete. Remaining decision for the
  user: open the PR (`single-pr`/`size:exception`) whenever ready; this
  writer does not push or open PRs.
- Parent verification after T4 (rebased branch): `npm test` 1593/1593;
  `npm run -w dashboard test` 236/236; `npm run -w dashboard typecheck`
  clean; `npm run build` succeeded; CSP grep on `dashboard/dist` empty.
- Native review (RDD): `review assess --base-ref main --committed-only` →
  risk `medium`, `review_due` (`slice_budget_reached`). User granted consent.
  Lineage `review-4f4a2eb692f3055d`, one lens (`review-reliability`):
  **approved**, acknowledged (authority burned). Reviewed boundary advances
  to `bf6d9dd`. Non-blocking advisory findings, left as follow-up work:
  - R3-001 (WARNING) `effectiveTier` returns `tier: null` from the catalog
    when the entry lists the model but has no usable cost, instead of
    falling back to the registry tier; untested path.
  - R3-002 (WARNING) `computeCatalogDrift` ignores a per-step variant on
    `DELEGATION_MAP` chain steps, so map-only pins never yield
    `variant_unavailable`.
  - R3-003 (SUGGESTION) `/api/proposals` reads `discovery.json` twice per
    request.
  - R3-004 (SUGGESTION) Tier badge title assumes `catalogCheckedAt` is
    non-null when `tierSource` is `catalog`.
  - R3-005 (SUGGESTION) `buildState` test does not assert
    `catalogCheckedAt`.
  - R3-006 (SUGGESTION) this document's rebase header omits the T4 SHA.

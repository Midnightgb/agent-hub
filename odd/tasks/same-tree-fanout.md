# ODD Feature: same-tree-fanout (phase 1)

Objective: let Claude Code fan out read-only agent-hub jobs (reviews, exploration, second opinions) in parallel in the caller's own checkout, without the caller creating or managing git worktrees.
Branch: `feat/same-tree-fanout` (from `main` a2819b7). Delivery strategy: `ask-on-risk` -> chain strategy `feature-branch-chain` (forecast ~1000 authored lines): one task branch `feat/same-tree-fanout-0N-*` per task, each PR into `feat/same-tree-fanout`, then one PR to `main`. Test runner: `npm test` (node --test).

## Specs

Approved proposal items, quoted verbatim from the phase-1 proposal the user accepted ("Vale si inicia con la fase 1"):

- **S1 — Read guard per adapter.** "**Control de lectura por adaptador:** solo avisar (`warn`) en los adaptadores que la CLI ya pone en solo lectura (copilot, codex, opencode)."
  - Acceptance: a `mode:'read'` job on copilot/codex/opencode whose working tree changes during the run ends `succeeded` (not `read_mode_violation`), with the changed paths reported as a warning and on a `readGuard` record field. `AGENT_HUB_READGUARD=strict` restores the previous failing behavior. Write mode is unchanged.
- **S2 — Hub-managed scratch copy for agy.** "Para agy, que el hub cree y borre por su cuenta una copia temporal: tú nunca ves ni gestionas worktrees, pero tu árbol queda protegido."
  - Acceptance: a `mode:'read'` agy job runs in a hub-owned detached worktree under `AGENT_HUB_HOME/scratch/` that carries the caller's uncommitted tracked changes and untracked non-ignored files. Agy's writes land only in the copy, which is removed when the job ends. The caller's tree is never modified. If the copy cannot be created, the job falls back to in-place with the strict guard and a warning. An explicit `isolation` param (`auto` | `in-place` | `scratch`, default `auto`) overrides the choice.
- **S3 — Wait for several jobs.** "**Esperar varios jobs:** `job_wait({ jobIds: [...] })`, que devuelva cada resultado a medida que termina."
  - Acceptance: `job_wait` accepts `jobIds` (array). It returns each job's status view, which ones are done, and which are still pending when the bounded timeout (<= 60 s) expires. The single-`jobId` behavior is unchanged.
- **S4 — Fan-out without dedup.** "**Fan-out sin deduplicar:** un `label` por llamada para que N revisores no se colapsen en uno."
  - Acceptance: `dispatch` accepts `label`. Two dispatches with the same task/cwd/taskType but different labels get different jobs. The legacy dispatchKey hash is unchanged when `label` is omitted.
- **S5 — Structured review output.** "**Salida estructurada en `delegate`:** `output: 'review'`, con hallazgos en JSON validados con el esquema que ya existe."
  - Acceptance: `delegate` (and `dispatch`) accept `output:'review'`. The hub appends an instruction asking for a final JSON block `{summary, findings[]}`. `job_result` returns the parsed and validated `review` (bounded by `HANDOFF_LIMITS`), or `reviewError` when it is missing or invalid, without failing the job.
- **S6 — Execute `parallelWith`.** "**Ejecutar `parallelWith`:** que `dispatch` lance los revisores que declara y devuelva sus `jobIds`."
  - Acceptance (assumption: opt-in, so existing callers don't silently spend extra quota): `dispatch({..., fanout:true})` also starts each `parallelWith` reviewer declared on the launched chain step and returns them as `parallelJobs[]`. Without `fanout`, the output is unchanged.
- **S7 — Skills.** "**Skills:** un patrón "fan-out en el mismo árbol". Los revisores corren en paralelo en tu checkout, Claude se queda con git y los worktrees pasan a ser opcionales."
  - Acceptance: `skills/multi-agent-orchestrator/SKILL.md` and `skills/agy-delegate/SKILL.md` describe same-tree read fan-out as the default for reads. Worktrees remain required only for `mode:'write'`. Docs (`docs/execution.md`, README tool params, CHANGELOG) match S1-S6.

Out of scope (phase 2): any change to the write gate, write allowlist, write lock, or `dispatch` mode override.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1, S2 | inline | pending | |
| T2 | S3, S4 | inline | pending | |
| T3 | S5, S6 | inline | pending | |
| T4 | S7 | inline | pending | |
| T5 | S1-S7 | delegated verifier (high risk: guard + concurrency) | pending | |

Route evidence: no Writer-trigger reason (the units share `src/index.mjs` and `src/jobrunner.mjs`), so the parent writes inline. The Verification trigger fires on Risk items 2 (read guard / isolation) and 4 (concurrent scratch copies).

## Log

- L1 (2026-10-17, user, verbatim): "aun no reinstalemos quiero algo ,tu sueles usar agentes en claude code a los que les delegas de forma automatica tareas em paralelo,sin worktrees y demas ,el.agent-hub creo que condiciona y la skill a crrar worktrees ,pero si quisiera que ej con clsude code pueda usar esos agentes deo agenthub para review y demas asignacions que sueles usar oara agentes que crees que podriamos ajustar en el mcp y skills para oermitir esa opcion de trabajo ?"
- L2 (2026-10-17, user, verbatim): "Vale si inicia con la fase 1"
- L3: Exploration evidence: write gate `src/worktree.mjs:52`; hardcoded `WRITE_ALLOWLIST = []` `src/config.mjs:149`; whole-tree readguard `src/readguard.mjs`, failing at `src/jobrunner.mjs:651,726`; agy `--mode plan` writes anyway (`src/adapters/agy.mjs:38`); `job_wait` single job, 60 s (`src/tools/jobs.mjs:340`); dispatchKey dedup (`src/dispatch.mjs:141`); `parallelWith` declared but unused (`src/router.mjs:75`); skill worktree lines `skills/multi-agent-orchestrator/SKILL.md:305-319`, `skills/agy-delegate/SKILL.md:26-30`.
- L4 (2026-10-17, user choice): chain strategy `feature-branch-chain`.

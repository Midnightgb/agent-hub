# ODD Feature: learning-probes

Objective: prototype contrastive validation of pending learnings, idea 1 of the harness2 review. A probe runs the same read task twice in parallel, as a control (the currently approved learnings) and a treatment (those plus the pending learning). It then stores the comparison as evidence on the learning, so the human approves with evidence. The approval itself stays human.
Branch: `feat/learning-probes` (from `main` 72ed4fe). Delivery: single PR (forecast ~450 authored lines; prototype). Runner: `npm test` (node --test).

## Specs

User request (L1): "si vale la idea 1 prototipala". Idea 1, as proposed and accepted:

> Validar aprendizajes con evidencia, antes de que los apruebes. Hoy `learning_propose` guarda un gotcha como pendiente hasta que lo apruebas a mano en el dashboard (`src/learnings.mjs`). Se le podría aplicar su *probe contrastivo* a escala mínima:
> - correr la misma tarea con y sin el aprendizaje, dos jobs en paralelo con la fan-out que ya existe;
> - adjuntar la comparación al pendiente (tiempo, si falló, diff y hallazgos).
>
> Así apruebas con evidencia y no a ojo. Cuesta 2 jobs por aprendizaje, no 2 por cada delegación.

- **S1: Start a probe.** `learning_probe({ learningId, task?, cwd?, agent?, model?, taskType?, output? })` starts two read-mode jobs in parallel with the same task, cwd, agent and model.
  - The control gets the normal learning selection.
  - The treatment gets that selection plus the probed learning (even though it is pending).
  - Defaults: agent, model and taskType come from the learning's scope, and task and cwd come from the job named by `learning.sourceJobId` when present. Anything still missing is a clear error raised before any job starts.
  - Only `pending` learnings can be probed, and only in read mode.
  - Returns `{ probeId, controlJobId, treatmentJobId }`.
- **S2: Compare and store evidence.** `learning_probe_result({ probeId })` reads both jobs.
  - While either job is non-terminal, it returns `done:false` with their statuses.
  - Once both are terminal, it builds a comparison per arm: status, errorKind, durationMs, response size in characters, and the review findings count by severity when `output:'review'` was used. It also adds a short verdict hint, `treatment_better | control_better | no_difference | inconclusive`, from deterministic rules.
  - The comparison is persisted on the learning as `probes[]` (idempotent per probeId), and `learning.probed` events are recorded.
- **S3: Human approval unchanged.** Probing never changes a learning's status. `selectLearnings` keeps returning only approved learnings for normal jobs. The treatment injection applies only to the probe's own treatment job.
- **S4: Visible to the approver.** The dashboard learnings API includes `probes`, and the approvals learnings tab shows a compact per-probe summary. The MCP tools, docs (`docs/routing.md` "Learnings", `docs/reference/tools.md`), CHANGELOG and the orchestrator skill describe probes.

Out of scope: auto-approval; write-mode probes; LLM judging of the two responses; probing approved learnings.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1-S4 | delegated writer (context backstop: long parent session) + parent completion | done | writer `079f69b` (RED 15/16 -> GREEN 16/16); parent `test/server.test.mjs` tool list, `learning.probed` event kind, `LearningProbe` schema, dashboard Evidence column; suite 1792/1792; dashboard tsc/eslint clean, vitest 236/236 |
| T2 | S1-S3 | parent live probe through installed MCP | done | installed `0b11f26` (`--allow-branch`); probe `probe-1792378824232-14aaf451`, see L5 |

Risk tier: medium. The change adds a tool and an optional persisted field, and the human approval guard must stay untouched (a test pins it).

## Log

- L1 (2026-10-18, user, verbatim): "si vale la idea 1 prototipala".
- L2: Design inputs. Learnings are stored by `src/learnings.mjs` (`proposeLearning`, `decideLearning`, `selectLearnings`, `augmentTask`) and injected in `src/jobrunner.mjs` ~256-266, on root turns only. Approval goes through `src/dashboard.mjs` ~775-797. `learning_propose` lives in `src/tools/learnings.mjs` and `src/index.mjs` ~1025.
- L3 (2026-10-18, T1 writer): `startJob` gained an internal `extraLearnings` option (root turn of a local agent only) that appends the probed learning after the normal selection; normal jobs are byte-identical (pinned). `src/learning-probes.mjs` holds `startLearningProbe`, `learningProbeResult` and the documented `probeVerdictHint` rules; probes persist on the learning as `probes[]`. Source-job task defaults come from its `prompt.txt` with the hub's `<hub-learnings>` prefix and review instruction stripped. `learning.probed` is emitted but not added to `EVENT_KINDS`/`VALID_KINDS` (`src/eventlog.mjs` is outside the surface; the parity test needs both). Open: add `learning_probe`, `learning_probe_result` to `test/server.test.mjs`; add the approvals UI summary in `dashboard/src/views/approvals/learnings-panel.tsx`.
- L4: Parent completed the three items the writer left outside its surfaces. (1) The exact MCP tool list in `test/server.test.mjs`. (2) `learning.probed` added to both `EVENT_KINDS` and `VALID_KINDS`, which a parity test keeps equal. (3) A typed optional `probes` on the shared `Learning` schema, plus an "Evidence" column in `dashboard/src/views/approvals/learnings-panel.tsx` showing the latest hint, the reason and the two job ids. Accepted writer deviations: it calls `startJob`/`readResult` directly because `delegateTool` ignores `env`; duration is `updatedAt - createdAt`; the source task is read from `prompt.txt` with hub blocks stripped. Open risks: if the treatment fails to start, the control keeps running with no probe record; caller agent/model may fall outside the learning scope.
- L5 (2026-10-18, T2 live probe through the installed MCP): pending learning `learn-1792378818807-5e3fa92d` (agy / `gemini-3.8-flash-medium` / adversarial-review, "check loop bounds and input validation/clamping of numeric parameters before style issues"), task "Review src/cart.js for bugs" on a throwaway repo with an off-by-one `<=` and an unclamped `pct`, `output:'review'`. A probe with no task/cwd was rejected before any job ("missing task, cwd"). Control `prompt.txt` had no `<hub-learnings>` block; treatment had the learning. Both arms succeeded (68 s / 60 s) and found the off-by-one as a blocker. Findings: control 1 blocker, 1 major, 2 minor; treatment 1 blocker, 1 major, 1 minor, 1 info -> `no_difference` ("both succeeded with no decisive findings or duration gap"). Qualitative difference not captured by counts: the control's major assumed `pct` is a 0-100 percentage ("not divided by 100"), the treatment's major was the unclamped range the learning points at. A second `learning_probe_result` call did not duplicate: `probes.length` 1, one `learning.probed` event. The learning stayed `pending`, `decidedAt` null. `/api/learnings` on the running dashboard serves the probe. Limitation for follow-up: the hint compares severity counts only, so it cannot tell which findings are right; a human still reads both job results.

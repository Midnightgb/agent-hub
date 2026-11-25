import crypto from 'node:crypto'
import { paths, METRICS_MIN_SAMPLES, PROPOSAL_REJECT_COOLDOWN_MS, MODEL_REGISTRY } from './config.mjs'
import { readJsonSafe, updateJsonLocked } from './fsutil.mjs'
import { appendEvent } from './eventlog.mjs'
import { computeMetrics } from './metrics.mjs'
import { computeModelGaps } from './model-gaps.mjs'
import { isPoolModel, poolOf, modelPool } from './model-policy.mjs'

/**
 * Routing proposals: evidence-backed reorders of a DELEGATION_MAP chain,
 * persisted in proposals.json ({version:1, proposals:[...]}) and applied by
 * route() only after a human accepts them in the dashboard.
 *
 * Deliberately does NOT import router.mjs: router.mjs imports this module to
 * apply an accepted proposal, so the reverse import would be a cycle. Callers
 * pass the delegation map / chain in explicitly instead.
 */

const DEFAULT_PROPOSALS_FILE = { version: 1, proposals: [] }

function pairKey(pair) {
  return `${pair.agent}:${pair.model}`
}

/**
 * sha1 of the JSON-normalized chain (first 12 hex chars). Used to detect
 * whether DELEGATION_MAP changed underneath a stored proposal.
 */
export function chainHash(chain) {
  const normalized = chain.map((step) => {
    const out = { agent: step.agent, model: step.model, mode: step.mode }
    if (step.parallelWith) out.parallelWith = step.parallelWith
    return out
  })
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 12)
}

/** Accepted add_candidate proposals for `taskType` whose chainHash matches `chain` (in-memory, no fs access). */
function acceptedAddCandidates(taskType, chain, data) {
  const hash = chainHash(chain)
  return data.proposals.filter((p) => p.taskType === taskType && p.status === 'accepted' && p.kind === 'add_candidate' && p.chainHash === hash)
}

/**
 * The effective chain for `taskType`: `chain` plus every accepted
 * add_candidate step appended at the TAIL, in the order they were decided —
 * never at index 0, and never reordering existing steps. Returns `chain`
 * itself (no copy) when there is nothing to append, so callers that skip
 * work on an unchanged reference stay cheap.
 */
export function effectiveChainFor(taskType, chain, env = process.env) {
  const { proposalsFile } = paths(env)
  const data = readJsonSafe(proposalsFile, DEFAULT_PROPOSALS_FILE)
  const additions = acceptedAddCandidates(taskType, chain, data)
  if (additions.length === 0) return chain
  const extra = additions.map((p) => ({ agent: p.addCandidate.agent, model: p.addCandidate.model, mode: p.addCandidate.mode }))
  return [...chain, ...extra]
}

/**
 * 95% Wilson score interval for `successes` out of `n` trials. With n=0
 * there is no evidence either way, so the interval is the widest possible.
 */
export function wilson(successes, n, z = 1.96) {
  if (n === 0) return { low: 0, high: 1 }
  const phat = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = phat + z2 / (2 * n)
  const margin = z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))
  return { low: (center - margin) / denom, high: (center + margin) / denom }
}

function findRow(rows, candidate, taskType, poolOfModel = null) {
  const mode = candidate.mode ?? 'read'
  if (isPoolModel(candidate.model)) return poolRow(rows, candidate, taskType, mode, poolOfModel)
  return (
    rows.find((r) => r.agent === candidate.agent && r.model === candidate.model && r.mode === mode && r.taskType === taskType) ?? null
  )
}

/**
 * Metrics rows store the concrete model that ran, never a pool placeholder,
 * so a pool step (`@free`) is measured by summing the rows of the models
 * `poolOfModel(agent, model)` assigns to that pool. null without a classifier
 * or without matching rows.
 */
function poolRow(rows, candidate, taskType, mode, poolOfModel) {
  if (typeof poolOfModel !== 'function') return null
  const pool = poolOf(candidate.model)
  const members = rows.filter(
    (r) => r.agent === candidate.agent && r.mode === mode && r.taskType === taskType && poolOfModel(r.agent, r.model) === pool
  )
  if (members.length === 0) return null
  const samples = members.reduce((n, r) => n + (r.samples ?? 0), 0)
  const succeeded = members.reduce((n, r) => n + (r.succeeded ?? 0), 0)
  return { agent: candidate.agent, model: candidate.model, mode, taskType, samples, succeeded, successRate: samples ? succeeded / samples : 0, p50Ms: null }
}

/** poolOfModel for computeProposals from a discovery.json catalog (model-policy.mjs pools). */
export function poolClassifier(discovery = {}) {
  return (agent, model) => {
    const entry = discovery?.[agent]?.models?.find?.((m) => m?.id === model)
    return entry ? modelPool(entry) : null
  }
}

/**
 * Pure: proposals suggested by `metrics` ({rows}) for `map` (DELEGATION_MAP
 * shape: {taskType: {why, chain}}). For each taskType, compares the current
 * primary CLI candidate (first non-claude step) against the other CLI
 * candidates and proposes promoting whichever one has a strictly better,
 * non-overlapping Wilson lower bound once both have enough samples.
 */
export function computeProposals({ metrics, map, minSamples = METRICS_MIN_SAMPLES, now = new Date(), poolOfModel = null } = {}) {
  void now
  const rows = metrics?.rows ?? []
  const proposals = []

  for (const [taskType, entry] of Object.entries(map ?? {})) {
    const chain = entry.chain ?? []
    const cliCandidates = chain.filter((step) => step.agent !== 'claude')
    if (cliCandidates.length < 2) continue

    const primary = cliCandidates[0]
    const others = cliCandidates.slice(1)

    const primaryRow = findRow(rows, primary, taskType, poolOfModel)
    if (!primaryRow || primaryRow.samples < minSamples) continue

    const eligible = []
    for (const candidate of others) {
      const row = findRow(rows, candidate, taskType, poolOfModel)
      if (row && row.samples >= minSamples) eligible.push({ candidate, row })
    }
    if (eligible.length === 0) continue

    const primaryWilson = wilson(primaryRow.succeeded, primaryRow.samples)

    let best = null
    for (const { candidate, row } of eligible) {
      const w = wilson(row.succeeded, row.samples)
      if (!best || w.low > best.wilson.low) best = { candidate, row, wilson: w }
    }

    if (best.wilson.low <= primaryWilson.high) continue

    const toOrder = [best.candidate, ...cliCandidates.filter((c) => c !== best.candidate)]

    const evidence = {}
    for (const candidate of cliCandidates) {
      const row = findRow(rows, candidate, taskType, poolOfModel)
      if (!row) continue
      evidence[pairKey(candidate)] = {
        samples: row.samples,
        successRate: row.successRate,
        wilsonLow: wilson(row.succeeded, row.samples).low,
        wilsonHigh: wilson(row.succeeded, row.samples).high,
        p50Ms: row.p50Ms,
      }
    }

    const reason = `${pairKey(best.candidate)} succeeded ${best.row.succeeded}/${best.row.samples} (wilson low ${best.wilson.low.toFixed(2)}) vs ${pairKey(primary)} ${primaryRow.succeeded}/${primaryRow.samples} (wilson high ${primaryWilson.high.toFixed(2)}) for ${taskType}`

    proposals.push({
      taskType,
      kind: 'reorder',
      chainHash: chainHash(chain),
      fromOrder: cliCandidates.map((c) => ({ agent: c.agent, model: c.model })),
      toOrder: toOrder.map((c) => ({ agent: c.agent, model: c.model })),
      evidence,
      reason,
    })
  }

  return proposals
}

function sameToOrder(a, b) {
  if (a.length !== b.length) return false
  return a.every((pair, i) => pair.agent === b[i].agent && pair.model === b[i].model)
}

/**
 * Recompute from current metrics AND discovery.json, persist new pending
 * proposals, return every stored proposal. `discovery` (readDiscovery(env)
 * shape) and `registry` (MODEL_REGISTRY shape) drive add_candidate proposal
 * creation via computeModelGaps — both default to "nothing new to add" so
 * every existing caller/test that only passes `map` keeps its old (reorder
 * -only) behavior.
 */
export function refreshProposals({ env = process.env, map = {}, discovery = {}, registry = MODEL_REGISTRY, now = new Date() } = {}) {
  const { proposalsFile } = paths(env)
  const metrics = computeMetrics({ env })
  const gaps = computeModelGaps({ discovery, map, registry })
  const created = []

  const result = updateJsonLocked(
    proposalsFile,
    (data) => {
      // 1. Supersede add_candidate proposals whose chainHash no longer
      // matches the CURRENT static chain (they always target the static
      // chain, never a previously-extended effective chain).
      for (const proposal of data.proposals) {
        if (proposal.kind !== 'add_candidate') continue
        if (proposal.status !== 'pending' && proposal.status !== 'accepted') continue
        const entry = map[proposal.taskType]
        if (!entry) continue
        if (proposal.chainHash !== chainHash(entry.chain)) {
          proposal.status = 'superseded'
          proposal.decidedAt = now.toISOString()
        }
      }

      // 2. Build the effective chain per taskType from the (now consistent)
      // accepted add_candidate proposals, and supersede reorder proposals
      // whose chainHash no longer matches THAT effective chain.
      const effectiveMap = {}
      for (const [taskType, entry] of Object.entries(map)) {
        const extra = acceptedAddCandidates(taskType, entry.chain, data).map((p) => ({
          agent: p.addCandidate.agent,
          model: p.addCandidate.model,
          mode: p.addCandidate.mode,
        }))
        effectiveMap[taskType] = extra.length === 0 ? entry : { ...entry, chain: [...entry.chain, ...extra] }
      }

      for (const proposal of data.proposals) {
        if (proposal.kind === 'add_candidate') continue // handled above
        if (proposal.status !== 'pending' && proposal.status !== 'accepted') continue
        const entry = effectiveMap[proposal.taskType]
        if (!entry) continue
        if (proposal.chainHash !== chainHash(entry.chain)) {
          proposal.status = 'superseded'
          proposal.decidedAt = now.toISOString()
        }
      }

      // 3. Reorder proposals, computed over the effective chain so a newly
      // added candidate becomes eligible for promotion once it has metrics.
      const computedReorders = computeProposals({ metrics, map: effectiveMap, now, poolOfModel: poolClassifier(discovery) })
      for (const candidate of computedReorders) {
        const hasPending = data.proposals.some(
          (p) => p.taskType === candidate.taskType && (p.kind ?? 'reorder') === 'reorder' && p.status === 'pending'
        )
        if (hasPending) continue

        const recentlyRejected = data.proposals.some(
          (p) =>
            p.taskType === candidate.taskType &&
            (p.kind ?? 'reorder') === 'reorder' &&
            p.status === 'rejected' &&
            p.decidedAt &&
            now.getTime() - new Date(p.decidedAt).getTime() < PROPOSAL_REJECT_COOLDOWN_MS
        )
        if (recentlyRejected) continue

        const alreadyAccepted = data.proposals.some(
          (p) =>
            p.taskType === candidate.taskType &&
            (p.kind ?? 'reorder') === 'reorder' &&
            p.status === 'accepted' &&
            p.chainHash === candidate.chainHash &&
            sameToOrder(p.toOrder, candidate.toOrder)
        )
        if (alreadyAccepted) continue

        const proposal = {
          id: `prop-${candidate.taskType}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
          taskType: candidate.taskType,
          kind: 'reorder',
          chainHash: candidate.chainHash,
          fromOrder: candidate.fromOrder,
          toOrder: candidate.toOrder,
          evidence: candidate.evidence,
          reason: candidate.reason,
          status: 'pending',
          createdAt: now.toISOString(),
          decidedAt: null,
        }
        data.proposals.push(proposal)
        created.push(proposal)
      }

      // 4. add_candidate proposals from discovery-vs-map/registry gaps, one
      // per taskType per bump, deduped against any pending/accepted proposal
      // for the same taskType+toModel and respecting the reject cooldown.
      for (const bump of gaps.versionBumps) {
        for (const taskType of bump.taskTypes) {
          const entry = map[taskType]
          if (!entry) continue

          const exists = data.proposals.some(
            (p) =>
              p.taskType === taskType &&
              p.kind === 'add_candidate' &&
              p.addCandidate?.model === bump.toModel &&
              (p.status === 'pending' || p.status === 'accepted')
          )
          if (exists) continue

          const recentlyRejected = data.proposals.some(
            (p) =>
              p.taskType === taskType &&
              p.kind === 'add_candidate' &&
              p.addCandidate?.model === bump.toModel &&
              p.status === 'rejected' &&
              p.decidedAt &&
              now.getTime() - new Date(p.decidedAt).getTime() < PROPOSAL_REJECT_COOLDOWN_MS
          )
          if (recentlyRejected) continue

          const cli = entry.chain.filter((c) => c.agent !== 'claude').map((c) => ({ agent: c.agent, model: c.model }))
          const proposal = {
            id: `prop-add-${taskType}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
            taskType,
            kind: 'add_candidate',
            chainHash: chainHash(entry.chain),
            fromOrder: cli,
            toOrder: cli,
            addCandidate: { agent: bump.agent, model: bump.toModel, mode: bump.mode },
            replaces: bump.fromModel,
            evidence: {},
            reason: `${bump.agent}:${bump.toModel} looks like a newer version of ${bump.fromModel}, already used for ${taskType}`,
            status: 'pending',
            createdAt: now.toISOString(),
            decidedAt: null,
          }
          data.proposals.push(proposal)
          created.push(proposal)
        }
      }

      return data
    },
    { defaultValue: DEFAULT_PROPOSALS_FILE }
  )

  for (const proposal of created) {
    appendEvent({ kind: 'proposal.created', taskType: proposal.taskType, summary: proposal.reason }, { env })
  }

  return result.proposals
}

/** Stored proposals, optionally filtered by status. */
export function listProposals({ status } = {}, env = process.env) {
  const { proposalsFile } = paths(env)
  const data = readJsonSafe(proposalsFile, DEFAULT_PROPOSALS_FILE)
  return status ? data.proposals.filter((p) => p.status === status) : data.proposals
}

/** Accept or reject a pending proposal. Throws `proposal not found: <id>` or `proposal not pending: <id>`. */
export function decideProposal(id, status, env = process.env) {
  if (status !== 'accepted' && status !== 'rejected') {
    throw new Error(`invalid proposal status: ${status}`)
  }

  const { proposalsFile } = paths(env)
  const decidedAt = new Date().toISOString()
  let decided

  updateJsonLocked(
    proposalsFile,
    (data) => {
      const proposal = data.proposals.find((p) => p.id === id)
      if (!proposal) throw new Error(`proposal not found: ${id}`)
      if (proposal.status !== 'pending') throw new Error(`proposal not pending: ${id}`)

      proposal.status = status
      proposal.decidedAt = decidedAt

      if (status === 'accepted') {
        // Reorder and add_candidate proposals are independent axes for the
        // same taskType (one promotes among existing candidates, the other
        // appends a new one) — only supersede an older accepted proposal of
        // the SAME kind, never across kinds. For add_candidate specifically,
        // also scope to the same addCandidate.model: two different version
        // bumps for the same taskType can both stay accepted at once.
        const kind = proposal.kind ?? 'reorder'
        for (const other of data.proposals) {
          if (other === proposal || other.taskType !== proposal.taskType || other.status !== 'accepted') continue
          if ((other.kind ?? 'reorder') !== kind) continue
          if (kind === 'add_candidate' && other.addCandidate?.model !== proposal.addCandidate?.model) continue
          other.status = 'superseded'
          other.decidedAt = decidedAt
        }
      }

      decided = proposal
      return data
    },
    { defaultValue: DEFAULT_PROPOSALS_FILE }
  )

  appendEvent({ kind: 'proposal.decided', taskType: decided.taskType, summary: `${status} ${id}` }, { env })
  return decided
}

/**
 * The accepted chain order for a task type, or null when no chain was passed
 * or no accepted proposal matches this exact chain (by chainHash). Claude
 * steps keep their original indexes; CLI step slots are filled in toOrder
 * order using the original step objects (preserving mode/parallelWith); any
 * CLI step missing from toOrder keeps its relative order after the listed ones.
 */
export function acceptedOrderFor(taskType, env = process.env, { chain } = {}) {
  if (!chain) return null

  const hash = chainHash(chain)
  const { proposalsFile } = paths(env)
  const data = readJsonSafe(proposalsFile, DEFAULT_PROPOSALS_FILE)
  const accepted = data.proposals.find(
    (p) => p.taskType === taskType && p.status === 'accepted' && p.chainHash === hash && (p.kind ?? 'reorder') === 'reorder'
  )
  if (!accepted) return null

  const cliOriginal = chain.filter((s) => s.agent !== 'claude')
  const byKey = new Map(cliOriginal.map((s) => [pairKey(s), s]))
  const usedKeys = new Set()
  const orderedCli = []

  for (const pair of accepted.toOrder) {
    const key = pairKey(pair)
    const step = byKey.get(key)
    if (step && !usedKeys.has(key)) {
      orderedCli.push(step)
      usedKeys.add(key)
    }
  }
  for (const step of cliOriginal) {
    const key = pairKey(step)
    if (!usedKeys.has(key)) {
      orderedCli.push(step)
      usedKeys.add(key)
    }
  }

  let cliIndex = 0
  const reorderedChain = chain.map((step) => (step.agent === 'claude' ? step : orderedCli[cliIndex++]))

  return { chain: reorderedChain, proposalId: accepted.id }
}

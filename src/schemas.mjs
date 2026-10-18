import { z } from 'zod'

/**
 * Shared API contracts. The MCP server uses these for tool outputSchema and
 * tests; the dashboard imports them for compiler-checked types (z.infer).
 *
 * Browser-safe on purpose: import nothing but zod (no node:*, no router.mjs),
 * so Vite can bundle this file. Constants duplicated from server modules
 * (TASK_TYPES, EVENT_KINDS, LEARNING_TEXT_MAX) are pinned by parity tests.
 *
 * Schemas are permissive (.passthrough(), optional/nullable fields): an MCP
 * outputSchema mismatch throws for the whole tool call, so a new server field
 * must never break a response.
 */

export const TASK_TYPES = [
  'recon',
  'call-chain-trace',
  'research',
  'triage',
  'second-opinion',
  'adversarial-review',
  'github-context',
  'mechanical-edit',
  'implementation-with-repo-rules',
  'architecture',
  'structured-mechanical',
]

export const EVENT_KINDS = [
  'preflight',
  'job.queued',
  'job.started',
  'job.finished',
  'job.failed',
  'job.canceled',
  'job.interrupted',
  'subagent.start',
  'subagent.stop',
  'proposal.created',
  'proposal.decided',
  'learning.proposed',
  'learning.decided',
  'harness.wake',
  'workflow.completed',
]

export const LEARNING_TEXT_MAX = 300

const nullableString = z.string().nullable().optional()
const nullableNumber = z.number().nullable().optional()

export const TaskType = z.enum(TASK_TYPES)
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
export const AgentStatus = z.enum(['ready', 'degraded', 'unavailable', 'skipped'])
export const TimeoutSource = z.enum(['explicit', 'adaptive', 'default'])

/**
 * A remote agent's session tracking block (currently only Jules). Attached to
 * JobRecord as an optional field so a local job's record is byte-for-byte
 * unchanged. Only provider and sessionId are required — everything else is
 * either not known yet (state, prUrl before the first poll) or genuinely
 * optional (accountId — accounts are a later phase).
 */
export const RemoteInfo = z
  .object({
    provider: z.string(),
    accountId: nullableString,
    sessionId: z.string(),
    sessionUrl: nullableString,
    source: nullableString,
    startingBranch: nullableString,
    state: nullableString,
    // When the current state was first observed (ISO timestamp). Set by the
    // poller on a state transition; lets callers tell "waiting 30s" apart
    // from "waiting 3h" without scanning the event log.
    stateSince: nullableString,
    // Last time new remote activity (not just a poll tick) was observed.
    lastActivityAt: nullableString,
    branch: nullableString,
    prUrl: nullableString,
    activityCursor: nullableString,
    seenActivityIds: z.array(z.string()).optional(),
    lastPolledAt: nullableString,
    // Why the local watcher stopped polling a still-live session, e.g.
    // 'awaiting_interaction' while the remote state is AWAITING_*/PAUSED.
    // Null while polling is active. Descriptive only — the state machine in
    // pollUntilTerminal is what actually returns on waiting states.
    pollingStoppedReason: nullableString,
    // Legacy interaction counter, kept for existing records. New code uses
    // the split counters below; attempts stays incremented for compatibility.
    attempts: nullableNumber,
    // Intervention counters (P0.3): turnDepth is conversation depth and must
    // not be conflated with these. A plan approval must not consume the
    // auto-reply budget (maxAutoReplies) and vice versa.
    interventionCount: nullableNumber,
    autoReplyCount: nullableNumber,
    safeContinueCount: nullableNumber,
    planApprovalCount: nullableNumber,
    // B4 watch lease: observation ownership so a supervisor and a concurrent
    // jules_wait never drive the same session (see §7 execution-contract.md).
    watch: z.object({ owner: z.string().nullable().optional(), generation: z.number().int().nonnegative().nullable().optional() }).nullable().optional(),
    watchGenerationCounter: nullableNumber,
  })
  .passthrough()

/** One entry in a computed DiffStats.files list. */
export const DiffFileEntry = z
  .object({
    path: z.string(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    binary: z.boolean(),
  })
  .passthrough()

/** Informational comparison between a handoff's declared changedFiles and the measured diff (src/diffstats.mjs). */
export const ChangedFilesMismatch = z
  .object({
    matches: z.boolean(),
    onlyDeclared: z.array(z.string()),
    onlyMeasured: z.array(z.string()),
  })
  .passthrough()

/**
 * computeDiffStats' output shape (src/diffstats.mjs): a write-mode job's
 * measured change against its recorded `diffBase`. Every numeric field is
 * null and `error` is set when the underlying git call failed — a stats
 * failure degrades gracefully and never fails the job it was computed for.
 */
export const DiffStats = z
  .object({
    baseCommit: z.string().nullable(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    filesChanged: z.number().int().nonnegative().nullable(),
    files: z.array(DiffFileEntry),
    truncated: z.boolean(),
    computedAt: z.string(),
    error: z.string().nullable().optional(),
    changedFilesMismatch: ChangedFilesMismatch.nullable().optional(),
  })
  .passthrough()

/** GET /api/jobs/:id/diff-stats response — live for a running write job, persisted for a terminal one. */
export const DiffStatsResponse = z.object({ diffStats: DiffStats.nullable() }).passthrough()

/**
 * D2 (agy-hub-verification): input shape for delegate/dispatch's optional
 * `verify` array — mirrors src/verify.mjs's normalizeVerifyCheck (argv kind
 * at minimum; artifact/diff/schema also accepted). The MCP tool validates
 * against this shape, then normalizeVerifyCheck validates again (fails fast,
 * before the job is ever created) so the two never drift.
 */
export const VerifyCheckInput = z
  .object({
    name: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1).optional(),
    expectExitCode: z.number().int().optional(),
    cwd: z.string().optional(),
    timeoutS: z.number().int().positive().optional(),
    artifact: z.string().optional(),
    from: z.string().optional(),
    forbid: z.array(z.string().min(1)).min(1).optional(),
    base: z.string().optional(),
    schema: z.string().optional(),
  })
  .passthrough()

/** One check result inside Verification.checks — runJobVerification's output shape (src/verify.mjs). */
export const VerificationCheckResult = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    durationMs: nullableNumber,
    outputTail: nullableString,
  })
  .passthrough()

/**
 * Hub-run verification for a delegate/dispatch job, recorded on the job
 * record once it reaches `succeeded` (docs/verification.md). A job that ends
 * `incomplete`/`failed`/`canceled` with `verify` checks configured still
 * gets this field, with `ok: null` and `skipped: true` — verification never
 * ran, and that is recorded, not silently dropped.
 */
export const Verification = z
  .object({
    ok: z.boolean().nullable(),
    checks: z.array(VerificationCheckResult),
    skipped: z.boolean().optional(),
    reason: nullableString,
  })
  .passthrough()

export const JobRecord = z
  .object({
    jobId: z.string(),
    agent: z.string(),
    model: z.string(),
    title: nullableString,
    // A remote (Jules) job is started from an explicit GitHub source and never
    // touches a local checkout, so it has no cwd. Requiring one made a single
    // such record fail /api/state validation and blank every job-list view.
    cwd: nullableString,
    mode: z.string(),
    status: JobStatus,
    errorKind: nullableString,
    error: nullableString,
    timeoutS: nullableNumber,
    variant: nullableString,
    sessionId: nullableString,
    parentJobId: nullableString,
    tokens: nullableNumber,
    costUsd: nullableNumber,
    pid: nullableNumber,
    pgid: nullableNumber,
    createdAt: z.string(),
    updatedAt: z.string(),
    taskType: TaskType.nullable().optional(),
    turnDepth: z.number().int().nonnegative().optional(),
    timeoutSource: TimeoutSource.optional(),
    learningIds: z.array(z.string()).optional(),
    remote: RemoteInfo.optional(),
    // C0 workflow/provenance fields — nullable optional so they don't break existing records.
    workflow_id: z.string().nullable().optional(),
    step_id: z.string().nullable().optional(),
    parent_execution_id: z.string().nullable().optional(),
    root_execution_id: z.string().nullable().optional(),
    attempt: z.number().int().nullable().optional(),
    remote_state: z.string().nullable().optional(),
    verified: z.boolean().nullable().optional(),
    judge_verdict: z.string().nullable().optional(),
    revision: z.number().int().nonnegative().nullable().optional(),
    // A1 dispatch provenance fields
    execution_id: z.string().nullable().optional(),
    executionId: z.string().nullable().optional(),
    dispatch_key: z.string().nullable().optional(),
    dispatchKey: z.string().nullable().optional(),
    // Harness profile id + dispatch waitMode (informational only: never
    // gates, locks, or routes — see src/harness/registry.mjs).
    harness: z.string().nullable().optional(),
    waitMode: z.enum(['none', 'attention', 'terminal']).nullable().optional(),
    profile: z.string().nullable().optional(),
    profileStatus: z.string().nullable().optional(),
    noChanges: z.boolean().optional(),
    // job-diff-stats: baseline HEAD captured at start for a write-mode job in
    // a git work tree (null/absent otherwise — never an error), and the
    // final measured snapshot persisted at terminal status.
    diffBase: z.string().nullable().optional(),
    diffStats: DiffStats.nullable().optional(),
    // D2 (agy-hub-verification): hub-run verification result, present only
    // when the job/dispatch call was given a `verify` array.
    verification: Verification.nullable().optional(),
    // job-project-branch: the git repo a local-cwd job runs in (any mode,
    // unlike diffBase which is write-only) — root/name/branch for the
    // dashboard's "Project" column. Null/absent for a non-git cwd or a
    // remote (Jules) job that has no local cwd at all.
    repo: z
      .object({
        root: z.string(),
        name: z.string(),
        branch: z.string().nullable(),
      })
      .nullable()
      .optional(),
    // T3 (opencode-live-catalog): non-fatal warnings recorded on a job, e.g.
    // a requested reasoning-effort variant dropped because the live catalog
    // no longer offers it (src/catalog.mjs validateVariant). Absent/empty
    // when nothing was worth flagging.
    warnings: z.array(z.string()).optional(),
  })
  .passthrough()

export const QuotaWindow = z
  .object({
    id: z.string(),
    label: z.string(),
    usedPercent: nullableNumber,
    usageKnown: z.boolean(),
    resetsAt: nullableString,
    windowMinutes: nullableNumber,
  })
  .passthrough()

export const QuotaInfo = z
  .object({
    provider: z.string().optional(),
    windows: z.array(QuotaWindow).optional(),
    exhausted: z.boolean().optional(),
    nextResetAt: nullableString,
    dataConfidence: z.string().optional(),
    fetchedAt: z.string().optional(),
    note: nullableString,
    quotaUnavailableReason: nullableString,
    // Present only for a quota read served from the cache (route()/agents_status,
    // which read quota in 'cached' mode and never await the network): whether
    // the cache entry is past its 5-minute TTL, and when it was cached.
    stale: z.boolean().optional(),
    cachedAt: z.string().optional(),
  })
  .passthrough()

export const AgentQuotaRow = z
  .object({
    agent: z.string(),
    model: z.string(),
    quota: QuotaInfo.nullable().optional(),
  })
  .passthrough()

export const AgentsQuotaResponse = z
  .object({
    agents: z.array(AgentQuotaRow),
  })
  .passthrough()

export const AgentStatusRow = z
  .object({
    agent: z.string(),
    model: z.string(),
    status: AgentStatus,
    reason: nullableString,
    ladderLevel: nullableString,
    quotaSignal: nullableString,
    latencyMs: nullableNumber,
    checkedAt: nullableString,
    dataPolicy: nullableString,
    binPath: nullableString,
    cliVersion: nullableString,
    quota: QuotaInfo.nullable().optional(),
    // Live-catalog pricing tier (src/catalog.mjs effectiveTier): 'free'/'paid'
    // from the last successful catalog fetch when it lists this model
    // (regardless of its age -- discovery.json is only refreshed at startup
    // or on an explicit dashboard refresh, never on a fixed interval), else
    // MODEL_REGISTRY's hand-written tier, or null when neither knows the
    // model. tierSource says which one it is, so the UI never presents a
    // stale registry value as a live fact. catalogCheckedAt is the catalog
    // row's checkedAt when tierSource is 'catalog' (null otherwise), so the
    // UI can show how old that evidence is.
    tier: nullableString,
    tierSource: z.enum(['catalog', 'registry']).nullable().optional(),
    catalogCheckedAt: nullableString,
  })
  .passthrough()

/** One events.jsonl line. `kind` stays a free string so an unknown kind never breaks a client. */
export const HubEvent = z
  .object({
    ts: z.string(),
    source: z.string(),
    kind: z.string(),
    agent: nullableString,
    model: nullableString,
    title: nullableString,
    summary: nullableString,
    jobId: nullableString,
    cwd: nullableString,
    errorKind: nullableString,
    taskType: nullableString,
    tokens: nullableNumber,
    costUsd: nullableNumber,
    // Harness profile id + dispatch waitMode on job.* events (informational).
    harness: nullableString,
    waitMode: nullableString,
    profile: nullableString,
    profileStatus: nullableString,
    // D2: the job.finished event carries the overall pass/fail only (the
    // full checks array stays on the job record, not the append-only log).
    verificationOk: z.boolean().nullable().optional(),
  })
  .passthrough()

export const StateResponse = z
  .object({
    agents: z.array(AgentStatusRow),
    jobs: z.array(JobRecord),
    subagents: z.array(HubEvent),
    events: z.array(HubEvent),
  })
  .passthrough()

export const ChainStep = z.lazy(() =>
  z
    .object({
      agent: z.string(),
      model: z.string(),
      mode: z.string().optional(),
      parallelWith: ChainStep.optional(),
      quota: QuotaInfo.nullable().optional(),
    })
    .passthrough()
)

export const DelegationEntry = z.object({ why: z.string(), chain: z.array(ChainStep) }).passthrough()

export const DiscoveryEntry = z
  .object({
    agent: z.string(),
    cmd: nullableString,
    binPath: nullableString,
    version: nullableString,
    models: z.array(z.object({ id: z.string(), label: z.string().optional() }).passthrough()).default([]),
    checkedAt: nullableString,
    error: nullableString,
  })
  .passthrough()

export const BreakerState = z
  .object({
    agent: z.string(),
    model: z.string(),
    open: z.boolean(),
    failureCount: z.number(),
    lastFailureAt: nullableString,
  })
  .passthrough()

export const Override = z
  .object({ hold: z.boolean().optional(), breakerReset: z.string().optional(), reason: z.string().optional(), setAt: z.string().optional() })
  .passthrough()

export const ConfigResponse = z
  .object({
    delegationMap: z.record(DelegationEntry),
    discovery: z.record(DiscoveryEntry),
    timeouts: z.record(z.record(z.number())),
    breaker: z
      .object({
        windowMs: z.number(),
        failureThreshold: z.number(),
        failureKinds: z.array(z.string()),
        immediateKinds: z.array(z.string()),
      })
      .passthrough(),
    ttlMs: z.number(),
    agentHubHome: z.string(),
    writeAllowlist: z.array(z.string()),
    breakerState: z.array(BreakerState),
    // readOverrides() returns {} but a hand-edited file may hold [].
    overrides: z.union([z.record(Override), z.array(z.unknown())]),
    process: z
      .object({
        pid: z.number(),
        nodeVersion: z.string(),
        platform: z.string(),
        pathEntries: z.array(z.string()),
        resolvedBins: z.record(z.string().nullable()),
      })
      .passthrough(),
  })
  .passthrough()

export const MetricsRow = z
  .object({
    agent: z.string(),
    model: z.string(),
    mode: z.string(),
    taskType: TaskType.nullable(),
    samples: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1).nullable(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    errorKinds: z.record(z.number()),
    tokensTotal: z.number(),
    tokensAvg: z.number().nullable(),
    costUsdTotal: z.number().nullable().optional(),
    costUsdAvg: z.number().nullable().optional(),
    verifiedCount: z.number().int().nonnegative().optional(),
    verifiedSamples: z.number().int().nonnegative().optional(),
    verifiedRate: z.number().min(0).max(1).nullable().optional(),
    verificationFailures: z.number().int().nonnegative().optional(),
    judgeVerdicts: z.record(z.number()).optional(),
    revisionTotal: z.number().optional(),
    revisionAvg: z.number().nullable().optional(),
    retryCount: z.number().int().nonnegative().optional(),
    qualityScore: z.number().nullable().optional(),
  })
  .passthrough()

export const MetricsResponse = z
  .object({ generatedAt: z.string(), groupBy: z.array(z.string()), rows: z.array(MetricsRow) })
  .passthrough()

/** One MCP tool registered in buildServer() — the {name, title, description} snapshot listMcpTools() returns. */
export const McpToolInfo = z
  .object({ name: z.string(), title: z.string(), description: z.string() })
  .passthrough()

export const McpToolsResponse = z
  .object({ tools: z.array(McpToolInfo) })
  .passthrough()

export const PairRef = z.object({ agent: z.string(), model: z.string() }).passthrough()

export const ProposalStatus = z.enum(['pending', 'accepted', 'rejected', 'superseded'])

// 'reorder' (default, back-compat with every stored/fixture proposal that
// predates this field): promotes among candidates already in the chain.
// 'add_candidate': appends a brand-new agent:model at the TAIL of the chain
// (see acceptedOrderFor/effectiveChainFor in proposals.mjs) — never reorders
// on its own; promotion of the new candidate only happens through a later
// 'reorder' proposal computed over the resulting effective chain.
export const ProposalKind = z.enum(['reorder', 'add_candidate'])

export const AddCandidate = z.object({ agent: z.string(), model: z.string(), mode: z.string().optional() }).passthrough()

export const Proposal = z
  .object({
    id: z.string(),
    taskType: TaskType,
    chainHash: z.string(),
    kind: ProposalKind.default('reorder'),
    fromOrder: z.array(PairRef),
    toOrder: z.array(PairRef),
    // Only set when kind is 'add_candidate': the new agent:model to append,
    // and the older model id (already in the chain) it is a newer version of.
    addCandidate: AddCandidate.nullable().optional(),
    replaces: z.string().nullable().optional(),
    evidence: z.record(
      z
        .object({
          samples: z.number(),
          successRate: z.number().nullable(),
          wilsonLow: z.number().nullable(),
          wilsonHigh: z.number().nullable().optional(),
          p50Ms: z.number().nullable(),
        })
        .passthrough()
    ),
    reason: z.string(),
    status: ProposalStatus,
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .passthrough()

export const ProposalsFile = z.object({ version: z.literal(1), proposals: z.array(Proposal) }).passthrough()

/** A catalog model computeModelGaps() could not safely map to any taskType (no family/registry match). */
export const UnmappedModel = z.object({ agent: z.string(), model: z.string() }).passthrough()

/**
 * One catalog-vs-registry drift item (src/catalog.mjs computeCatalogDrift):
 * report-only, never mutates routing. `variant` is present only for
 * `variant_unavailable`. `checkedAt` is the source discovery row's
 * checkedAt, so the UI can show the age of the catalog evidence.
 */
export const CatalogDriftItem = z
  .object({
    type: z.enum(['vanished', 'now_paid', 'new_free', 'variant_unavailable']),
    agent: z.string(),
    model: z.string(),
    variant: z.string().optional(),
    checkedAt: nullableString,
  })
  .passthrough()

/** GET /api/proposals and POST /api/proposals/refresh response shape. */
export const ProposalsResponse = z
  .object({ proposals: z.array(Proposal), unmapped: z.array(UnmappedModel).optional(), drift: z.array(CatalogDriftItem).optional() })
  .passthrough()

export const LearningStatus = z.enum(['pending', 'approved', 'rejected'])

export const Learning = z
  .object({
    id: z.string(),
    agent: z.string().nullable(),
    model: z.string().nullable(),
    taskType: TaskType.nullable(),
    text: z.string().min(1).max(LEARNING_TEXT_MAX),
    status: LearningStatus,
    source: z.enum(['mcp', 'dashboard']),
    sourceJobId: z.string().nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .passthrough()

export const LearningsFile = z.object({ version: z.literal(1), learnings: z.array(Learning) }).passthrough()

/** Input for learning_propose (MCP) and the dashboard create form. Always stored as pending. */
export const LearningInput = z.object({
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  taskType: TaskType.optional(),
  text: z.string().trim().min(1).max(LEARNING_TEXT_MAX),
  sourceJobId: z.string().min(1).optional(),
})

export const DiscoverySummary = z
  .object({
    binPath: nullableString,
    version: nullableString,
    modelCount: z.number(),
    checkedAt: nullableString,
    error: nullableString,
  })
  .passthrough()

export const RouteResult = z
  .object({
    primary: ChainStep.nullable(),
    fallbacks: z.array(ChainStep),
    skipped: z.array(z.object({ agent: z.string(), model: z.string(), reason: z.string() }).passthrough()),
    discovery: z.record(z.union([DiscoverySummary, DiscoveryEntry]).nullable()),
    reason: z.string(),
    appliedProposal: z.object({ id: z.string() }).passthrough().nullable().optional(),
  })
  .passthrough()

export const DelegateResponse = z
  .object({
    jobId: z.string().nullable(),
    status: z.string(),
    errorKind: nullableString,
    parentJobId: nullableString,
    turnDepth: z.number().int().nonnegative().optional(),
    warning: nullableString,
  })
  .passthrough()

export const DispatchResponse = z
  .object({
    job: JobRecord,
    dispatchKey: z.string(),
    executionId: z.string(),
    candidate: z
      .object({
        agent: z.string(),
        model: z.string(),
        mode: z.string().optional(),
      })
      .passthrough(),
    // Resolved harness profile id + effective waitMode for this dispatch.
    harness: z.string().optional(),
    waitMode: z.enum(['none', 'attention', 'terminal']).optional(),
  })
  .passthrough()

export const JobResultResponse = z
  .object({
    text: z.string(),
    truncated: z.boolean(),
    tail: z.string().optional(),
    tailTruncated: z.boolean().optional(),
    totalLines: z.number().int().nonnegative().optional(),
    fullPath: z.string(),
    tokens: nullableNumber,
    costUsd: nullableNumber,
    sessionId: nullableString,
    status: z.string(),
    errorKind: nullableString,
    verification: Verification.nullable().optional(),
  })
  .passthrough()

/** The live answer from jules_check: the session's current state plus what the local job did with it. */
export const JulesCheckResponse = z
  .object({
    jobId: nullableString,
    sessionId: z.string().nullable(),
    state: z.string(),
    prUrl: nullableString,
    branch: nullableString,
    sessionUrl: nullableString,
    lastMessage: nullableString,
    finalized: z.boolean(),
    // True when a remote job wrongly marked failed/orphaned was reopened.
    recovered: z.boolean().optional(),
    terminal: z.boolean(),
    attentionRequired: z.boolean().optional(),
    attentionReason: z.enum(['user_feedback', 'plan_approval', 'paused']).nullable().optional(),
    recommendedAction: z.enum(['send_message', 'approve_plan']).nullable().optional(),
    canAutoResolve: z.boolean().optional(),
    attempts: z.number().int().nonnegative().optional(),
  })
  .passthrough()

export const JulesInteractResponse = z
  .object({
    jobId: nullableString,
    sessionId: z.string().nullable(),
    action: z.enum(['reply', 'approve_plan']),
    status: z.string().optional(),
    success: z.boolean().optional(),
  })
  .passthrough()

/**
 * Local orchestration result from jules_wait (NOT a remote capability — the
 * Jules API has no wait endpoint). Same live check fields as jules_check
 * plus the local outcome: done+terminal (session ended), done+waiting
 * (session needs interaction — act via jules_interact), or !done+timedOut
 * (local budget elapsed, session still working).
 */
export const JulesWaitResponse = z
  .object({
    jobId: nullableString,
    sessionId: z.string().nullable(),
    state: z.string(),
    prUrl: nullableString,
    branch: nullableString,
    sessionUrl: nullableString,
    lastMessage: nullableString,
    finalized: z.boolean().optional(),
    terminal: z.boolean(),
    attentionRequired: z.boolean().optional(),
    attentionReason: z.enum(['user_feedback', 'plan_approval', 'paused']).nullable().optional(),
    recommendedAction: z.enum(['send_message', 'approve_plan']).nullable().optional(),
    canAutoResolve: z.boolean().optional(),
    attempts: z.number().int().nonnegative().optional(),
    done: z.boolean(),
    waiting: z.boolean(),
    timedOut: z.boolean(),
  })
  .passthrough()

/**
 * Result from jules_supervise: the supervisor's final observation after its
 * watch cycle ends. `outcome` says WHY it stopped: 'terminal' (session ended),
 * 'attention' (needs human), 'paused' (PAUSED state — never auto-resumed),
 * 'timeout' (local budget elapsed), or 'budget_exhausted' (maxAutoReplies hit).
 */
export const JulesSuperviseResponse = z
  .object({
    jobId: nullableString,
    sessionId: z.string().nullable(),
    state: z.string(),
    prUrl: nullableString,
    branch: nullableString,
    sessionUrl: nullableString,
    lastMessage: nullableString,
    terminal: z.boolean(),
    outcome: z.enum(['terminal', 'attention', 'paused', 'timeout', 'budget_exhausted']),
    attentionRequired: z.boolean().optional(),
    attentionReason: z.enum(['user_feedback', 'plan_approval', 'paused']).nullable().optional(),
    recommendedAction: z.enum(['send_message', 'approve_plan']).nullable().optional(),
    autoReplyCount: z.number().int().nonnegative().optional(),
    safeContinueCount: z.number().int().nonnegative().optional(),
    planApprovalCount: z.number().int().nonnegative().optional(),
  })
  .passthrough()

/** One row from jules_sessions: a live API session annotated with the local jobId that matches it. */
export const JulesSessionRow = z
  .object({
    sessionId: z.string().nullable(),
    title: nullableString,
    state: z.string(),
    prUrl: nullableString,
    branch: nullableString,
    sessionUrl: nullableString,
    createTime: nullableString,
    jobId: nullableString,
    // Set only when rows were merged from configured accounts: sessions are per
    // account, so each row says which one it came from.
    accountId: nullableString,
  })
  .passthrough()

export const JulesSessionsResponse = z
  .object({
    sessions: z.array(JulesSessionRow),
    // One entry per account whose query failed while the others succeeded —
    // partial failure is reported, never swallowed into an empty list.
    accountErrors: z.array(z.object({ accountId: z.string(), error: z.string() }).passthrough()).optional(),
  })
  .passthrough()

/**
 * One row from jules_sources: a GitHub repo connected to the Jules account.
 * `defaultBranch` and `branches` come from githubRepo.defaultBranch.displayName
 * and githubRepo.branches[].displayName — what a caller needs to pick a
 * startingBranch for jules_delegate.
 */
export const JulesSourceRow = z
  .object({
    name: nullableString,
    owner: nullableString,
    repo: nullableString,
    defaultBranch: nullableString,
    branches: z.array(z.string()),
  })
  .passthrough()

export const JulesSourcesResponse = z
  .object({
    sources: z.array(JulesSourceRow),
    // Present only when the read was scoped to a configured account. A
    // noSourceAccess row means /sources refused this account (401) — it is NOT
    // a rejected key, so `note` explains the web-UI connection step.
    accountId: nullableString,
    noSourceAccess: z.boolean().optional(),
    note: nullableString,
  })
  .passthrough()

/** Rolling quota usage for one account, computed from local job history. */
export const JulesAccountUsage = z
  .object({ running: z.number().int().nonnegative(), last24h: z.number().int().nonnegative() })
  .passthrough()

/**
 * A MASKED Jules account: keyPresent/keyLast4 replace the raw apiKey, which
 * never leaves src/accounts.mjs. `usage` and `sourcesStatus` are joined in by
 * jules_accounts from job history and the per-account /sources cache.
 */
export const JulesAccountRow = z
  .object({
    id: z.string(),
    label: nullableString,
    enabled: z.boolean(),
    priority: z.number(),
    dailyLimit: z.number(),
    concurrentLimit: z.number(),
    lastUsedAt: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
    keyPresent: z.boolean(),
    keyLast4: nullableString,
    usage: JulesAccountUsage.optional(),
    sourcesStatus: nullableString,
    sourcesFetchedAt: nullableString,
  })
  .passthrough()

export const JulesAccountsResponse = z
  .object({ policy: z.string(), accounts: z.array(JulesAccountRow) })
  .passthrough()

/**
 * One recurring Jules task (schedules.json). `schedule` is an interval or a
 * daily time; `lastResult` is a compact view of the job the schedule started
 * last time (null when it has never run, or its record was pruned).
 */
export const JulesScheduleResult = z
  .object({
    jobId: z.string(),
    status: z.string(),
    errorKind: nullableString,
    sessionId: nullableString,
    prUrl: nullableString,
  })
  .passthrough()

export const JulesScheduleRow = z
  .object({
    id: z.string(),
    label: nullableString,
    enabled: z.boolean(),
    schedule: z.object({ kind: z.string() }).passthrough(),
    prompt: z.string(),
    source: z.string(),
    startingBranch: nullableString,
    automationMode: nullableString,
    requirePlanApproval: z.boolean(),
    accountId: nullableString,
    lastRunAt: nullableString,
    lastJobId: nullableString,
    lastStatus: nullableString,
    nextRunAt: nullableString,
    createdAt: z.string(),
    updatedAt: z.string(),
    lastResult: JulesScheduleResult.nullable().optional(),
  })
  .passthrough()

export const JulesSchedulesResponse = z.object({ schedules: z.array(JulesScheduleRow) }).passthrough()

/**
 * Dashboard Cloud-view contracts (src/dashboard.mjs /api/accounts,
 * /api/sources, /api/schedules, /api/cloud/*). These reuse the jules_* tool
 * response shapes above where the route already delegates to that tool
 * (accounts, schedules, sessions) rather than redeclaring them — the two are
 * the same wire shape by construction.
 */
export const CloudAccountsResponse = JulesAccountsResponse
export const CloudAccountRow = JulesAccountRow
export const CloudSchedulesResponse = JulesSchedulesResponse
export const CloudScheduleRow = JulesScheduleRow
export const CloudSessionsResponse = JulesSessionsResponse
export const CloudSessionRow = JulesSessionRow

/** POST /api/accounts/:id/refresh-sources returns exactly this cache entry (src/cloud/sources.mjs refreshSources). */
export const CloudSourceCacheEntry = z
  .object({
    fetchedAt: z.string(),
    status: z.string(),
    sources: z.array(
      z
        .object({ name: z.string(), owner: nullableString, repo: nullableString, defaultBranch: nullableString, branches: z.array(z.string()) })
        .passthrough()
    ),
    error: z.string().optional(),
  })
  .passthrough()

/**
 * One row of GET /api/sources: a source name plus every account KNOWN to
 * have it (from the per-account /sources cache — see src/cloud/sources.mjs),
 * each with that account's cached status. A 'no_source_access' account is
 * healthy; it simply cannot list sources (see cloud/sources.mjs).
 */
export const CloudSourceRow = z
  .object({
    name: z.string(),
    owner: nullableString,
    repo: nullableString,
    defaultBranch: nullableString,
    branches: z.array(z.string()),
    accounts: z.array(z.object({ accountId: z.string(), status: nullableString }).passthrough()),
  })
  .passthrough()

export const CloudSourceAccountSummary = z
  .object({ accountId: z.string(), label: nullableString, status: nullableString, fetchedAt: nullableString })
  .passthrough()

export const CloudSourcesResponse = z
  .object({ sources: z.array(CloudSourceRow), accounts: z.array(CloudSourceAccountSummary) })
  .passthrough()

/** GET /api/cloud/jobs/:id/activities: raw stdout lines, one per remote activity. */
export const CloudActivitiesResponse = z.object({ activities: z.array(z.string()) }).passthrough()

/**
 * GET /api/work-graph (src/workGraph.mjs): where each agent is working,
 * derived only from git (repos/worktrees/branch ancestry) plus existing job
 * records — zero new delegation parameters or job fields. Nodes and edges
 * stay permissive (.passthrough()) like the rest of this file: each node
 * kind carries different extra fields (a worktree node has branch/head, a
 * job node has status/mode/..., a remoteBranch node has source/branch/...),
 * and a discriminated union would only make a future field addition riskier.
 */
export const WorkGraphWorktree = z
  .object({
    path: z.string(),
    branch: nullableString,
    head: nullableString,
    isMain: z.boolean(),
    parentBranch: nullableString,
  })
  .passthrough()

export const WorkGraphRepo = z
  .object({
    root: z.string(),
    mainBranch: nullableString,
    worktrees: z.array(WorkGraphWorktree),
  })
  .passthrough()

export const WorkGraphNodeKind = z.enum(['repo', 'worktree', 'job', 'remoteBranch', 'outside'])

export const WorkGraphNode = z
  .object({
    id: z.string(),
    kind: WorkGraphNodeKind,
    // Additive, kind-specific fields (passthrough already accepted these; declared
    // here for a documented, typed contract): a removed worktree node
    // (kind 'worktree') carries `removed`+`label`; a pending/unstarted Cloud
    // node (kind 'remoteBranch') carries `label`, and the dashboard's own
    // per-kind types add `pending`/`unstarted`.
    removed: z.boolean().optional(),
    label: nullableString,
  })
  .passthrough()

export const WorkGraphEdgeKind = z.enum(['branchesFrom', 'runsIn', 'continues', 'waitsOn', 'remote'])

export const WorkGraphEdge = z
  .object({
    kind: WorkGraphEdgeKind,
    from: z.string(),
    to: z.string(),
  })
  .passthrough()

export const WorkGraphResponse = z
  .object({
    generatedAt: z.string(),
    repos: z.array(WorkGraphRepo),
    nodes: z.array(WorkGraphNode),
    edges: z.array(WorkGraphEdge),
  })
  .passthrough()

export const AgysBucket = z
  .object({
    id: z.string(),
    label: z.string(),
    window: nullableString,
    resetTime: nullableString,
    usedPercent: nullableNumber,
    remainingPercent: nullableNumber,
    description: nullableString,
  })
  .passthrough()

export const AgysProfileQuota = z
  .object({
    buckets: z.array(AgysBucket),
  })
  .passthrough()

export const AgysProfile = z
  .object({
    name: z.string(),
    email: nullableString,
    active: z.boolean(),
    priority: z.number(),
    state: z.enum(['selected', 'fallback', 'exhausted', 'unavailable']),
    quota: AgysProfileQuota,
  })
  .passthrough()

export const AgysSnapshotResponse = z
  .object({
    available: z.boolean(),
    reason: z.string().optional(),
    mode: z.enum(['off', 'profile', 'auto']),
    source: z.enum(['env', 'setting', 'default']).optional(),
    pinnedProfile: nullableString,
    selected: z
      .object({
        name: z.string(),
      })
      .nullable(),
    profiles: z.array(AgysProfile),
  })
  .passthrough()


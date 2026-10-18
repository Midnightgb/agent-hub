import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { ApprovalsSearch } from "@/routes/search"
import { ApprovalsView } from "./index"

const api = vi.hoisted(() => ({
  getProposals: vi.fn(),
  getLearnings: vi.fn(),
  getConfig: vi.fn(),
  refreshProposals: vi.fn(),
  decideProposal: vi.fn(),
  decideLearning: vi.fn(),
  deleteLearning: vi.fn(),
  createLearning: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

const CONFIG = {
  delegationMap: {},
  discovery: {
    agy: { agent: "agy", cmd: null, binPath: null, version: null, models: [], checkedAt: null, error: null },
    opencode: {
      agent: "opencode",
      cmd: null,
      binPath: null,
      version: null,
      models: [],
      checkedAt: null,
      error: null,
    },
  },
  timeouts: {},
  breaker: { windowMs: 60000, failureThreshold: 3, failureKinds: [], immediateKinds: [] },
  ttlMs: 60000,
  agentHubHome: "/tmp",
  writeAllowlist: [],
  breakerState: [],
  overrides: {},
  process: { pid: 1, nodeVersion: "v22", platform: "linux", pathEntries: [], resolvedBins: {} },
}

const PENDING_PROPOSAL = {
  id: "prop-1",
  taskType: "recon",
  chainHash: "abc",
  fromOrder: [
    { agent: "agy", model: "gemini-3.8-flash-low" },
    { agent: "opencode", model: "opencode/muse-spark" },
  ],
  toOrder: [
    { agent: "opencode", model: "opencode/muse-spark" },
    { agent: "agy", model: "gemini-3.8-flash-low" },
  ],
  evidence: {
    "agy:gemini-3.8-flash-low": {
      samples: 14,
      successRate: 0.57,
      wilsonLow: 0.33,
      wilsonHigh: 0.78,
      p50Ms: 36000,
    },
    "opencode:opencode/muse-spark": {
      samples: 18,
      successRate: 1,
      wilsonLow: 0.82,
      wilsonHigh: 1,
      p50Ms: 95000,
    },
  },
  reason: "PROPOSAL_REASON_PENDING",
  status: "pending",
  createdAt: "2026-09-15T04:00:00.000Z",
  decidedAt: null,
}

const REJECTED_PROPOSAL = {
  ...PENDING_PROPOSAL,
  id: "prop-2",
  reason: "PROPOSAL_REASON_REJECTED",
  status: "rejected",
  createdAt: "2026-09-01T04:00:00.000Z",
  decidedAt: "2026-09-02T04:00:00.000Z",
}

const ADD_CANDIDATE_PROPOSAL = {
  id: "prop-3",
  taskType: "recon",
  chainHash: "def",
  kind: "add_candidate",
  fromOrder: [{ agent: "agy", model: "gemini-3.8-flash-low" }],
  toOrder: [{ agent: "agy", model: "gemini-3.8-flash-low" }],
  addCandidate: { agent: "agy", model: "gemini-3.9-flash-low", mode: "read" },
  replaces: "gemini-3.8-flash-low",
  evidence: {},
  reason: "agy:gemini-3.9-flash-low looks like a newer version of gemini-3.8-flash-low, already used for recon",
  status: "pending",
  createdAt: "2026-09-18T04:00:00.000Z",
  decidedAt: null,
}

const PENDING_LEARNING = {
  id: "learn-pending",
  agent: "agy",
  model: null,
  taskType: "recon",
  text: "PENDING_MARKER",
  status: "pending",
  source: "dashboard",
  sourceJobId: null,
  createdAt: "2026-09-01T04:00:00.000Z",
  decidedAt: null,
}

const APPROVED_LEARNING = {
  id: "learn-approved",
  agent: "opencode",
  model: "opencode/muse-spark",
  taskType: null,
  text: "APPROVED_MARKER",
  status: "approved",
  source: "mcp",
  sourceJobId: null,
  createdAt: "2026-09-15T04:00:00.000Z",
  decidedAt: "2026-09-16T04:00:00.000Z",
}

function renderApprovals(initialEntry = "/approvals") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute()
  const approvalsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals",
    validateSearch: ApprovalsSearch,
    component: ApprovalsView,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([approvalsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { ...utils, router, queryClient }
}

describe("ApprovalsView", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.getConfig.mockResolvedValue(CONFIG)
    api.getProposals.mockResolvedValue({ proposals: [PENDING_PROPOSAL, REJECTED_PROPOSAL] })
    api.getLearnings.mockResolvedValue({ learnings: [APPROVED_LEARNING, PENDING_LEARNING] })
    api.refreshProposals.mockResolvedValue({ proposals: [] })
    api.decideProposal.mockResolvedValue(PENDING_PROPOSAL)
    api.decideLearning.mockResolvedValue(PENDING_LEARNING)
    api.deleteLearning.mockResolvedValue({ deleted: true })
    api.createLearning.mockResolvedValue(PENDING_LEARNING)
  })

  it("reads the active tab from the search param", async () => {
    renderApprovals("/approvals?tab=learnings")

    expect(await screen.findByText("PENDING_MARKER")).toBeTruthy()
    expect(screen.queryByText("PROPOSAL_REASON_PENDING")).toBeNull()
    expect(screen.getByText("Propose a learning")).toBeTruthy()
  })

  it("shows proposals by default", async () => {
    renderApprovals("/approvals")

    expect(await screen.findByText("PROPOSAL_REASON_PENDING")).toBeTruthy()
    expect(screen.queryByText("Propose a learning")).toBeNull()
  })

  it("requires confirmation before accepting a proposal", async () => {
    renderApprovals("/approvals")
    await screen.findByText("PROPOSAL_REASON_PENDING")

    fireEvent.click(screen.getByRole("button", { name: "Accept" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/route\(\) will use this order/i)).toBeTruthy()
    expect(api.decideProposal).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: /accept/i }))

    await waitFor(() =>
      expect(api.decideProposal).toHaveBeenCalledWith("prop-1", "accept")
    )
  })

  it("renders proposal evidence with success rate, Wilson bounds and p50", async () => {
    renderApprovals("/approvals")
    await screen.findByText("PROPOSAL_REASON_PENDING")

    expect(screen.getByText("agy:gemini-3.8-flash-low")).toBeTruthy()
    expect(screen.getByText("57%")).toBeTruthy()
    expect(screen.getByText("33%–78%")).toBeTruthy()
    expect(screen.getByText("36s")).toBeTruthy()
  })

  it("disables the learning form until text is entered and counts characters live", async () => {
    renderApprovals("/approvals?tab=learnings")
    await screen.findByText("PENDING_MARKER")

    const textarea = await screen.findByLabelText("Text")
    const submit = screen.getByRole("button", { name: /propose learning/i })

    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("0/300")).toBeTruthy()

    fireEvent.change(textarea, { target: { value: "abc" } })

    expect(screen.getByText("3/300")).toBeTruthy()
    expect((submit as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(textarea, { target: { value: "" } })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  it("lists pending learnings before decided ones", async () => {
    renderApprovals("/approvals?tab=learnings")
    await screen.findByText("PENDING_MARKER")

    const rows = screen.getAllByRole("row")
    expect(within(rows[1]).getByText("PENDING_MARKER")).toBeTruthy()
  })

  // The shadcn TableCell primitive sets whitespace-nowrap, and white-space is
  // inherited, so a long learning used to run out of its cell and across the
  // Status/Actions columns — which put the Approve/Reject buttons out of reach.
  it("wraps a long learning inside its own cell instead of overflowing the row", async () => {
    renderApprovals("/approvals?tab=learnings")
    const text = await screen.findByText("PENDING_MARKER")

    expect(text.className).toContain("whitespace-normal")
    expect(text.className).toContain("break-words")
  })

  it("keeps the Approve and Reject buttons on one line next to a wrapped learning", async () => {
    renderApprovals("/approvals?tab=learnings")
    await screen.findByText("PENDING_MARKER")

    const rows = screen.getAllByRole("row")
    const actions = within(rows[1]).getByRole("button", { name: /approve/i })
    expect(actions).toBeTruthy()
    expect(within(rows[1]).getByRole("button", { name: /reject/i })).toBeTruthy()
  })

  it("renders an add_candidate proposal distinctly and scopes its accept dialog to the addition", async () => {
    api.getProposals.mockResolvedValue({ proposals: [ADD_CANDIDATE_PROPOSAL], unmapped: [] })
    renderApprovals("/approvals")

    await screen.findByText("New candidate")
    expect(screen.getByText(/adds/i)).toBeTruthy()
    expect(screen.getByText("gemini-3.9-flash-low")).toBeTruthy()
    expect(screen.getAllByText(/newer version of gemini-3\.8-flash-low/i).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("button", { name: "Accept" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/added as a new fallback/i)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole("button", { name: /accept/i }))
    await waitFor(() => expect(api.decideProposal).toHaveBeenCalledWith("prop-3", "accept"))
  })

  it("lists unmapped catalog models with no safe routing match", async () => {
    api.getProposals.mockResolvedValue({
      proposals: [],
      unmapped: [{ agent: "agy", model: "gpt-oss-999-low" }],
    })
    renderApprovals("/approvals")

    expect(await screen.findByText("Unmapped models")).toBeTruthy()
    expect(screen.getByText("gpt-oss-999-low")).toBeTruthy()
  })

  it("lists catalog drift items reported for opencode", async () => {
    api.getProposals.mockResolvedValue({
      proposals: [],
      unmapped: [],
      drift: [
        { type: "vanished", agent: "opencode", model: "opencode/mimo-v2.5-free" },
        { type: "variant_unavailable", agent: "opencode", model: "opencode/nemotron-3-ultra-free", variant: "high" },
      ],
    })
    renderApprovals("/approvals")

    expect(await screen.findByText("Catalog drift")).toBeTruthy()
    expect(screen.getByText(/opencode\/mimo-v2\.5-free/)).toBeTruthy()
    expect(screen.getByText(/opencode\/nemotron-3-ultra-free/)).toBeTruthy()
    expect(screen.getByText(/high/)).toBeTruthy()
  })
})

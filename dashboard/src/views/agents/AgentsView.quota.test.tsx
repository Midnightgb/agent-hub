import { describe, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { AgentsView } from "./index"
import { AgentsSearch } from "@/routes/search"
import * as api from "@/lib/api"
import type { AgentRow, ConfigResponseT } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getState: vi.fn(),
  getConfig: vi.fn(),
  getMetrics: vi.fn(),
  getProposals: vi.fn(),
  getLearnings: vi.fn(),
  getQuota: vi.fn(),
  refreshAgents: vi.fn(),
  refreshDiscovery: vi.fn(),
  setOverride: vi.fn(),
  clearOverride: vi.fn(),
  cancelJob: vi.fn(),
  refreshProposals: vi.fn(),
  decideProposal: vi.fn(),
  decideLearning: vi.fn(),
  deleteLearning: vi.fn(),
  createLearning: vi.fn(),
  getModelPolicy: vi.fn(() => Promise.resolve({ agent: "opencode", catalogAvailable: false, catalogCheckedAt: null, models: [] })),
  setModelDecision: vi.fn(),
  setModelOrder: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agent: "agy",
    model: "alpha-model",
    status: "ready",
    reason: null,
    ladderLevel: "L2",
    quotaSignal: "unknown",
    latencyMs: 500,
    checkedAt: "2026-09-15T02:56:19.457Z",
    dataPolicy: "unknown",
    binPath: "/home/user/.local/bin/agy",
    cliVersion: "1.2.3",
    ...overrides,
  }
}

function config(): ConfigResponseT {
  return {
    delegationMap: {}, discovery: {}, timeouts: {}, breaker: { windowMs: 60000, failureThreshold: 3, failureKinds: [], immediateKinds: [] },
    ttlMs: 60000, agentHubHome: "/home/user/.local/share/agent-hub", writeAllowlist: [], breakerState: [], overrides: {},
    process: { pid: 4242, nodeVersion: "v22.0.0", platform: "linux", pathEntries: [], resolvedBins: {} },
  }
}

function renderAgents() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const rootRoute = createRootRoute()
  const agentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents", validateSearch: AgentsSearch, component: AgentsView })
  const router = createRouter({ routeTree: rootRoute.addChildren([agentsRoute]), history: createMemoryHistory({ initialEntries: ["/agents"] }) })
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
}

describe("AgentsView Quota", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getConfig).mockResolvedValue(config())
  })

  it("handles not metered and quota unavailable states gracefully", async () => {
    vi.mocked(api.getState).mockResolvedValue({
      agents: [
        agent({ agent: 'opencode', model: 'opencode/big-pickle', quota: { note: 'not metered by CodexBar' } }),
        agent({ agent: 'agy', model: 'gemini-3.8-flash-low', quota: { quotaUnavailableReason: 'codexbar_unreachable' } })
      ],
      jobs: [], subagents: [], events: []
    })
    vi.mocked(api.getQuota).mockResolvedValue({ agents: [] })

    renderAgents()

    await screen.findByText("opencode/big-pickle")
    
    // Open sheet for opencode
    const rowOpencode = await screen.findByText("opencode/big-pickle")
    rowOpencode.click()
    
    await screen.findByText("not metered by CodexBar")
    
    // Close and open agy
    // In actual app we'd close it, but let's just click the agy row
    const rowAgy = await screen.findByText("gemini-3.8-flash-low")
    rowAgy.click()
    
    await screen.findByText(/Unavailable: codexbar_unreachable/)
  })
})

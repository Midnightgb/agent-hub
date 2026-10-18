import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { AgentsView } from "./index"
import { AgentsSearch } from "@/routes/search"
import * as api from "@/lib/api"
import type { AgentRow, ConfigResponseT, StateResponseT } from "@/lib/types"

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

function config(overrides: Partial<ConfigResponseT> = {}): ConfigResponseT {
  return {
    delegationMap: {},
    discovery: {},
    timeouts: {},
    breaker: { windowMs: 60000, failureThreshold: 3, failureKinds: [], immediateKinds: [] },
    ttlMs: 60000,
    agentHubHome: "/home/user/.local/share/agent-hub",
    writeAllowlist: [],
    breakerState: [],
    overrides: {},
    process: {
      pid: 4242,
      nodeVersion: "v22.0.0",
      platform: "linux",
      pathEntries: [],
      resolvedBins: { agy: "/home/user/.local/bin/agy", opencode: "/home/user/.opencode/bin/opencode" },
    },
    ...overrides,
  }
}

function state(agents: AgentRow[]): StateResponseT {
  return { agents, jobs: [], subagents: [], events: [] }
}

function renderAgents(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
    validateSearch: AgentsSearch,
    component: AgentsView,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([agentsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { router }
}

async function openRowMenu(name: string) {
  const trigger = await screen.findByRole("button", { name: `More actions for ${name}` })
  fireEvent.click(trigger)
  return trigger
}

describe("AgentsView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.refreshAgents).mockResolvedValue({ results: [] })
    vi.mocked(api.refreshDiscovery).mockResolvedValue({})
    vi.mocked(api.setOverride).mockResolvedValue({})
    vi.mocked(api.getQuota).mockResolvedValue({ agents: [] })
  })

  it("with filter=unhealthy hides ready rows and keeps unhealthy ones", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      state([
        agent({ model: "ready-model", status: "ready" }),
        agent({ model: "degraded-model", status: "degraded", reason: "auth failed" }),
      ])
    )
    vi.mocked(api.getConfig).mockResolvedValue(config())

    renderAgents("/agents?filter=unhealthy")

    await screen.findByText("degraded-model")
    expect(screen.queryByText("ready-model")).toBeNull()
  })

  it("reads the search term from the q search param", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      state([
        agent({ model: "alpha-model" }),
        agent({ agent: "opencode", model: "beta-model", status: "ready" }),
      ])
    )
    vi.mocked(api.getConfig).mockResolvedValue(config())

    renderAgents("/agents?q=alpha")

    await screen.findByText("alpha-model")
    expect(screen.queryByText("beta-model")).toBeNull()
  })

  it("disables row actions and warns when the CLI is not resolved", async () => {
    vi.mocked(api.getState).mockResolvedValue(state([agent({ model: "alpha-model" })]))
    vi.mocked(api.getConfig).mockResolvedValue(
      config({
        process: {
          pid: 4242,
          nodeVersion: "v22.0.0",
          platform: "linux",
          pathEntries: [],
          resolvedBins: { agy: null },
        },
      })
    )

    renderAgents("/agents")

    await screen.findByText("alpha-model")
    expect(screen.getAllByText(/dashboard process cannot find/i).length).toBeGreaterThan(0)

    await openRowMenu("agy alpha-model")
    const revalidate = await screen.findByRole("menuitem", { name: "Revalidate" })
    expect(revalidate.getAttribute("aria-disabled") ?? revalidate.getAttribute("data-disabled")).toBeTruthy()
  })

  it("asks for confirmation before a Ping calls the API with ping:true", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      state([agent({ model: "degraded-model", status: "degraded", reason: "quota" })])
    )
    vi.mocked(api.getConfig).mockResolvedValue(config())

    renderAgents("/agents")

    await screen.findByText("degraded-model")
    await openRowMenu("agy degraded-model")

    fireEvent.click(await screen.findByRole("menuitem", { name: /ping/i }))

    await screen.findByText(/spends quota/i)
    expect(api.refreshAgents).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Ping", hidden: true }))

    await waitFor(() =>
      expect(vi.mocked(api.refreshAgents).mock.calls[0]?.[0]).toEqual({
        agent: "agy",
        model: "degraded-model",
        ping: true,
      })
    )
  })

  it("renders a free tier badge sourced from the live catalog, with its checked-at age in the title", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      state([
        agent({
          agent: "opencode",
          model: "opencode/big-pickle",
          tier: "free",
          tierSource: "catalog",
          catalogCheckedAt: new Date(Date.now() - 5000).toISOString(),
        }),
      ])
    )
    vi.mocked(api.getConfig).mockResolvedValue(config())

    renderAgents("/agents")

    const badge = await screen.findByText("free")
    expect(badge.getAttribute("title")).toMatch(/catalog/)
    // Proves the badge surfaces catalogCheckedAt (not just tierSource) -- an
    // hours-old catalog row must be visible to the user, not silently
    // presented as if it were a live read (see the T1 correction: tier/drift
    // no longer gate on the 15-minute preflight TTL).
    expect(badge.getAttribute("title")).toMatch(/checked.*ago/)
  })

  it("renders a paid tier badge falling back to the registry when there is no live catalog source", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      state([
        agent({
          agent: "opencode",
          model: "deepseek/deepseek-v4-pro",
          tier: "paid",
          tierSource: "registry",
        }),
      ])
    )
    vi.mocked(api.getConfig).mockResolvedValue(config())

    renderAgents("/agents")

    const badge = await screen.findByText("paid")
    expect(badge.getAttribute("title")).toMatch(/registry/)
  })
})

import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ModelPolicyPanel } from "./model-policy-panel"
import * as api from "@/lib/api"
import type { ModelPolicyResponseT } from "@/lib/types"

// opencode-model-policy T4 (S1): choose which opencode models agent-hub may use.

vi.mock("@/lib/api", () => ({
  getModelPolicy: vi.fn(),
  setModelDecision: vi.fn(),
  setModelOrder: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

function policy(overrides: Partial<ModelPolicyResponseT> = {}): ModelPolicyResponseT {
  return {
    agent: "opencode",
    catalogAvailable: true,
    catalogCheckedAt: "2026-10-25T00:00:00.000Z",
    models: [
      { id: "opencode/glm-5.3-flash-free", pool: "free", allowed: true, source: "default", isNew: true },
      { id: "opencode-go/kimi-k3", pool: "go", allowed: false, source: "default", isNew: true },
      { id: "opencode/claude-sonnet-5-5", pool: "paid", allowed: false, source: "user", isNew: false },
    ],
    ...overrides,
  }
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ModelPolicyPanel />
    </QueryClientProvider>
  )
}

function row(id: string) {
  return screen.getByText(id).closest("tr") as HTMLElement
}

beforeEach(() => {
  vi.mocked(api.getModelPolicy).mockReset().mockResolvedValue(policy())
  vi.mocked(api.setModelDecision).mockReset().mockResolvedValue({})
  vi.mocked(api.setModelOrder).mockReset().mockResolvedValue({})
})

describe("ModelPolicyPanel", () => {
  it("lists every catalog model with its pool, its status as text and a New marker for undecided models", async () => {
    renderPanel()
    const free = within(await waitFor(() => row("opencode/glm-5.3-flash-free")))
    expect(free.getByText("Free")).toBeTruthy()
    expect(free.getByText("Allowed")).toBeTruthy()
    expect(free.getByText("New")).toBeTruthy()

    const go = within(row("opencode-go/kimi-k3"))
    expect(go.getByText("Go")).toBeTruthy()
    expect(go.getByText("Blocked")).toBeTruthy()

    const paid = within(row("opencode/claude-sonnet-5-5"))
    expect(paid.getByText("Paid")).toBeTruthy()
    expect(paid.queryByText("New")).toBeNull()
  })

  it("blocks a model at once, without a confirmation", async () => {
    renderPanel()
    const free = within(await waitFor(() => row("opencode/glm-5.3-flash-free")))
    fireEvent.click(free.getByRole("button", { name: "Block opencode/glm-5.3-flash-free" }))
    await waitFor(() =>
      expect(api.setModelDecision).toHaveBeenCalledWith(
        { agent: "opencode", model: "opencode/glm-5.3-flash-free", allowed: false },
        expect.anything()
      )
    )
  })

  it("asks for confirmation before allowing a Go model, which spends quota", async () => {
    renderPanel()
    const go = within(await waitFor(() => row("opencode-go/kimi-k3")))
    fireEvent.click(go.getByRole("button", { name: "Allow opencode-go/kimi-k3" }))
    expect(api.setModelDecision).not.toHaveBeenCalled()

    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/spend your OpenCode Go quota/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(api.setModelDecision).toHaveBeenCalledWith(
        { agent: "opencode", model: "opencode-go/kimi-k3", allowed: true },
        expect.anything()
      )
    )
  })

  it("moves a model down in the priority order and saves the whole order", async () => {
    renderPanel()
    const free = within(await waitFor(() => row("opencode/glm-5.3-flash-free")))
    fireEvent.click(free.getByRole("button", { name: "Move opencode/glm-5.3-flash-free down" }))
    await waitFor(() =>
      expect(api.setModelOrder).toHaveBeenCalledWith(
        { agent: "opencode", order: ["opencode-go/kimi-k3", "opencode/glm-5.3-flash-free", "opencode/claude-sonnet-5-5"] },
        expect.anything()
      )
    )
  })

  it("explains when the opencode catalog is unavailable", async () => {
    vi.mocked(api.getModelPolicy).mockResolvedValue(policy({ catalogAvailable: false, catalogCheckedAt: null, models: [] }))
    renderPanel()
    expect(await screen.findByText(/opencode catalog is unavailable/)).toBeTruthy()
  })
})

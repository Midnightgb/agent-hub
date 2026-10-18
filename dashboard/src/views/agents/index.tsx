import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Bot, Info, MoreHorizontal, RefreshCw, RotateCw } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { StatusBadge } from "@/components/StatusBadge"
import { ProviderMark } from "@/components/ProviderMark"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { RelativeTime } from "@/components/RelativeTime"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Field, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Toaster, toast } from "@/components/ui/toast"
import {
  useConfigQuery,
  useRefreshAgentsMutation,
  useRefreshDiscoveryMutation,
  useSetOverrideMutation,
  useStateQuery,
  useQuotaQuery,
} from "@/lib/queries"
import { breakerFor, overrideFor } from "@/lib/badges"
import { formatAge, formatLatency, formatModel } from "@/lib/format"
import { TONE_BADGE_CLASS } from "@/lib/tone"
import { cn } from "@/lib/utils"
import type { AgentRow, DerivedState } from "@/lib/types"
import { AgentDetailSheet } from "./agent-detail-sheet"
import {
  UNRESOLVED_HELP,
  groupByCli,
  groupParts,
  isUnresolved,
  matchesFilter,
  matchesSearch,
  type AgentFilter,
} from "./lib"

const FILTERS: { value: AgentFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unhealthy", label: "Unhealthy" },
  { value: "held", label: "Held" },
  { value: "breaker", label: "Breaker open" },
]

type ConfirmSpec = {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: () => void
}

export function AgentsView() {
  const search = useSearch({ from: "/agents" })
  const navigate = useNavigate()

  const stateQuery = useStateQuery()
  const configQuery = useConfigQuery()
  const quotaQuery = useQuotaQuery()
  const refreshAgents = useRefreshAgentsMutation()
  const refreshDiscovery = useRefreshDiscoveryMutation()
  const setOverride = useSetOverrideMutation()

  const [selected, setSelected] = React.useState<AgentRow | null>(null)
  const [confirm, setConfirm] = React.useState<ConfirmSpec | null>(null)

  const state: DerivedState = {
    agents: stateQuery.data?.agents ?? [],
    jobs: stateQuery.data?.jobs ?? [],
    events: stateQuery.data?.events ?? [],
    config: configQuery.data ?? null,
    quota: quotaQuery.data?.agents ?? [],
  }

  const setSearchParams = React.useCallback(
    (patch: Partial<{ filter: AgentFilter; q: string }>) => {
      void navigate({
        to: "/agents",
        search: (prev) => ({ ...prev, ...patch }),
        replace: true,
      })
    },
    [navigate]
  )

  const handleFilterChange = (values: string[]) => {
    const next = values[0]
    if (next) setSearchParams({ filter: next as AgentFilter })
  }

  const handleRevalidateAll = () => {
    refreshAgents.mutate(
      {},
      {
        onSuccess: () => toast.add({ title: "Revalidated all agents", type: "success" }),
        onError: (error) => toast.add({ title: "Revalidate failed", description: String(error), type: "error" }),
      }
    )
  }

  const handleRediscover = () => {
    refreshDiscovery.mutate(undefined, {
      onSuccess: () => toast.add({ title: "Rediscovered CLIs", type: "success" }),
      onError: (error) => toast.add({ title: "Rediscover failed", description: String(error), type: "error" }),
    })
  }

  const handleRevalidateRow = (row: AgentRow) => {
    refreshAgents.mutate(
      { agent: row.agent, model: row.model },
      {
        onSuccess: () =>
          toast.add({ title: `Revalidated ${row.agent} / ${formatModel(row.model)}`, type: "success" }),
        onError: (error) => toast.add({ title: "Revalidate failed", description: String(error), type: "error" }),
      }
    )
  }

  const handlePing = (row: AgentRow) => {
    setConfirm({
      title: "Ping this agent?",
      description: `This sends a real prompt to ${row.agent} / ${formatModel(row.model)} and spends quota (L3).`,
      confirmLabel: "Ping",
      destructive: true,
      onConfirm: () =>
        refreshAgents.mutate(
          { agent: row.agent, model: row.model, ping: true },
          {
            onSuccess: () =>
              toast.add({ title: `Pinged ${row.agent} / ${formatModel(row.model)}`, type: "success" }),
            onError: (error) => toast.add({ title: "Ping failed", description: String(error), type: "error" }),
          }
        ),
    })
  }

  const handleToggleHold = (row: AgentRow) => {
    const held = overrideFor(state, row.agent, row.model)?.hold === true
    setOverride.mutate(
      { agent: row.agent, model: row.model, hold: !held },
      {
        onSuccess: () =>
          toast.add({
            title: held ? `Released ${row.agent} / ${formatModel(row.model)}` : `Held ${row.agent} / ${formatModel(row.model)}`,
            type: "success",
          }),
        onError: (error) => toast.add({ title: "Override failed", description: String(error), type: "error" }),
      }
    )
  }

  const handleResetBreaker = (row: AgentRow) => {
    setConfirm({
      title: "Reset breaker?",
      description: `Clears the open breaker for ${row.agent} / ${formatModel(row.model)}.`,
      confirmLabel: "Reset breaker",
      destructive: true,
      onConfirm: () =>
        setOverride.mutate(
          { agent: row.agent, model: row.model, breakerReset: new Date().toISOString() } as unknown as {
            agent: string
            model: string
          },
          {
            onSuccess: () => toast.add({ title: "Breaker reset", type: "success" }),
            onError: (error) => toast.add({ title: "Reset failed", description: String(error), type: "error" }),
          }
        ),
    })
  }

  const rows = state.agents.filter(
    (row) => matchesFilter(state, row, search.filter) && matchesSearch(row, search.q)
  )
  const groups = groupByCli(rows)

  const columns: DataTableColumn<AgentRow>[] = [
    {
      key: "model",
      header: "Model",
      cell: (row) => (
        <span className="font-medium" title={row.model}>
          {formatModel(row.model)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => <StatusBadge kind="status" value={row.status} />,
    },
    {
      key: "reason",
      header: "Reason",
      cell: (row) => (
        <span className="block max-w-xs truncate text-muted-foreground" title={row.reason ?? undefined}>
          {row.reason || "—"}
        </span>
      ),
    },
    {
      key: "latency",
      header: "Latency",
      className: "text-right tabular-nums",
      cell: (row) => formatLatency(row.latencyMs),
    },
    {
      key: "tier",
      header: "Tier",
      cell: (row) => {
        if (!row.tier) return <span className="text-muted-foreground">—</span>
        // A catalog-sourced tier can be based on a discovery row that is
        // hours old (discovery.json is only refreshed at startup or an
        // explicit dashboard refresh, never on a fixed interval) -- show
        // that age instead of presenting it as a live read.
        const title =
          row.tierSource === "catalog"
            ? `source: catalog · checked ${formatAge(row.catalogCheckedAt)}`
            : row.tierSource
              ? `source: ${row.tierSource}`
              : undefined
        return (
          <Badge
            variant="outline"
            title={title}
            className={row.tier === "free" ? cn("border-transparent", TONE_BADGE_CLASS.ready) : undefined}
          >
            {row.tier}
          </Badge>
        )
      },
    },
    {
      key: "dataPolicy",
      header: "Data policy",
      cell: (row) => <Badge variant="outline">{row.dataPolicy || "—"}</Badge>,
    },
    {
      key: "checked",
      header: "Checked",
      cell: (row) => <RelativeTime iso={row.checkedAt} className="text-muted-foreground" />,
    },
    {
      key: "tags",
      header: "Tags",
      cell: (row) => {
        const breaker = breakerFor(state, row.agent, row.model)
        const held = overrideFor(state, row.agent, row.model)?.hold === true
        if (!(breaker?.open || held)) return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {breaker?.open ? (
              <Badge
                variant="outline"
                title={`${breaker.failureCount} failure(s)`}
                className={cn("border-transparent", TONE_BADGE_CLASS.destructive)}
              >
                breaker open
              </Badge>
            ) : null}
            {held ? (
              <Badge variant="outline" className={cn("border-transparent", TONE_BADGE_CLASS.warning)}>
                held
              </Badge>
            ) : null}
          </div>
        )
      },
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10",
      cell: (row) => {
        const unresolved = isUnresolved(state, row.agent)
        const breaker = breakerFor(state, row.agent, row.model)
        const held = overrideFor(state, row.agent, row.model)?.hold === true
        const pingable = row.status === "degraded" || row.status === "unavailable"
        return (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${row.agent} ${row.model}`}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  disabled={unresolved}
                  title={unresolved ? UNRESOLVED_HELP : undefined}
                  onClick={() => handleRevalidateRow(row)}
                >
                  Revalidate
                </DropdownMenuItem>
                {pingable ? (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={unresolved}
                    title={unresolved ? UNRESOLVED_HELP : "sends a real prompt and spends quota"}
                    onClick={() => handlePing(row)}
                  >
                    Ping (L3)
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => handleToggleHold(row)}>
                  {held ? "Release" : "Hold"}
                </DropdownMenuItem>
                {breaker?.open ? (
                  <DropdownMenuItem variant="destructive" onClick={() => handleResetBreaker(row)}>
                    Reset breaker
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    },
  ]

  return (
    <TooltipProvider>
      <PageHeader
        title="Agents"
        description="CLI agents this dashboard can delegate to."
        actions={
          <>
            <Button id="btn-revalidate-all" onClick={handleRevalidateAll} disabled={refreshAgents.isPending}>
              {refreshAgents.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              Revalidate all
            </Button>
            <Button
              id="btn-rediscover"
              variant="outline"
              onClick={handleRediscover}
              disabled={refreshDiscovery.isPending}
            >
              {refreshDiscovery.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RotateCw data-icon="inline-start" />
              )}
              Rediscover CLIs
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <ToggleGroup value={[search.filter]} onValueChange={handleFilterChange}>
          {FILTERS.map((filter) => (
            <ToggleGroupItem key={filter.value} value={filter.value}>
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Field className="w-full max-w-xs">
          <FieldLabel htmlFor="agents-search" className="sr-only">
            Search agents
          </FieldLabel>
          <Input
            id="agents-search"
            type="search"
            placeholder="Search agent, model or reason"
            value={search.q}
            onChange={(event) => setSearchParams({ q: event.target.value })}
          />
        </Field>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No matching agents"
          description="Adjust the filter or search, or run Revalidate all / Rediscover CLIs above."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => {
            const first = group.rows[0]
            const unresolved = isUnresolved(state, group.agent)
            const parts = groupParts(state, group.agent, first, group.rows.length)
            return (
              <section key={group.agent} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ProviderMark agent={group.agent} size="md" />
                  <h2 className="text-sm font-semibold">{group.agent}</h2>
                  <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>
                  {unresolved ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Why ${group.agent} actions are disabled`}
                          />
                        }
                      >
                        <Info className="text-destructive" />
                      </TooltipTrigger>
                      <TooltipContent>{UNRESOLVED_HELP}</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
                {unresolved ? (
                  <Alert variant="destructive">
                    <AlertTitle>The dashboard process cannot find “{group.agent}”.</AlertTitle>
                    <AlertDescription>{UNRESOLVED_HELP}</AlertDescription>
                  </Alert>
                ) : null}
                <DataTable
                  columns={columns}
                  rows={group.rows}
                  getRowId={(row) => `${row.agent}:${row.model}`}
                  onRowClick={(row) => setSelected(row)}
                />
              </section>
            )
          })}
        </div>
      )}

      <AgentDetailSheet row={selected} state={state} onOpenChange={(open) => !open && setSelected(null)} />

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmLabel={confirm?.confirmLabel ?? ""}
        destructive={confirm?.destructive}
        onConfirm={() => {
          const run = confirm?.onConfirm
          setConfirm(null)
          run?.()
        }}
      />

      <Toaster />
    </TooltipProvider>
  )
}

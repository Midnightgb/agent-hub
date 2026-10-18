import * as React from "react"
import { CheckSquare, RefreshCw } from "lucide-react"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { EmptyState } from "@/components/EmptyState"
import { RelativeTime } from "@/components/RelativeTime"
import { StatusBadge } from "@/components/StatusBadge"
import { formatDuration } from "@/lib/format"
import {
  useDecideProposalMutation,
  useProposalsQuery,
  useRefreshProposalsMutation,
} from "@/lib/queries"
import type { CatalogDriftItemT, ProposalT, UnmappedModelT } from "@/lib/types"

type Pair = ProposalT["fromOrder"][number]

type StatusFilter = "pending" | "all"

type EvidenceRow = {
  pair: string
  samples: number
  successRate: number | null
  wilsonLow: number | null
  wilsonHigh: number | null
  p50Ms: number | null
}

const STATUS_ITEMS = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All statuses" },
]

function percent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return "—"
  return `${Math.round(Number(value) * 100)}%`
}

function wilsonRange(low: number | null | undefined, high: number | null | undefined): string {
  if (low == null || high == null) return "—"
  return `${percent(low)}–${percent(high)}`
}

function samePair(a: Pair | undefined, b: Pair | undefined): boolean {
  return Boolean(a && b && a.agent === b.agent && a.model === b.model)
}

function evidenceRows(proposal: ProposalT): EvidenceRow[] {
  return Object.entries(proposal.evidence).map(([pair, stats]) => ({
    pair,
    samples: stats.samples,
    successRate: stats.successRate ?? null,
    wilsonLow: stats.wilsonLow ?? null,
    wilsonHigh: stats.wilsonHigh ?? null,
    p50Ms: stats.p50Ms ?? null,
  }))
}

const EVIDENCE_COLUMNS: DataTableColumn<EvidenceRow>[] = [
  { key: "pair", header: "Pair", cell: (row) => <span className="truncate">{row.pair}</span> },
  { key: "samples", header: "Samples", cell: (row) => row.samples },
  { key: "successRate", header: "Success", cell: (row) => percent(row.successRate) },
  {
    key: "wilson",
    header: "Wilson 95%",
    cell: (row) => wilsonRange(row.wilsonLow, row.wilsonHigh),
  },
  {
    key: "p50",
    header: "p50",
    cell: (row) => (row.p50Ms == null ? "—" : formatDuration(row.p50Ms / 1000)),
  },
]

function OrderList({
  title,
  order,
  other,
}: {
  title: string
  order: Pair[]
  other: Pair[]
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ol className="flex flex-col gap-1">
        {order.map((pair, index) => {
          const changed = !samePair(pair, other[index])
          return (
            <li key={`${pair.agent}:${pair.model}:${index}`} className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">{index + 1}.</span>
              <span className="truncate">{pair.agent}</span>
              <span className="truncate text-muted-foreground">{pair.model}</span>
              {changed ? <Badge variant="secondary">changed</Badge> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function isAddCandidate(proposal: ProposalT): boolean {
  return proposal.kind === "add_candidate"
}

/** Distinct summary for an add_candidate proposal: fromOrder/toOrder are identical for these (see proposals.mjs), so the two-column reorder view would show nothing useful. */
function AddCandidateSummary({ proposal }: { proposal: ProposalT }) {
  const candidate = proposal.addCandidate
  if (!candidate) return null
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        Adds <span className="font-medium">{candidate.agent}</span>{" "}
        <span className="truncate text-muted-foreground">{candidate.model}</span> at the end of{" "}
        <span className="font-medium capitalize">{proposal.taskType}</span>.
      </p>
      {proposal.replaces ? (
        <p className="text-muted-foreground">Newer version of {proposal.replaces}.</p>
      ) : null}
    </div>
  )
}

function ProposalCard({
  proposal,
  onAccept,
  onReject,
  rejecting,
}: {
  proposal: ProposalT
  onAccept: (proposal: ProposalT) => void
  onReject: (proposal: ProposalT) => void
  rejecting: boolean
}) {
  const rows = evidenceRows(proposal)
  const addCandidate = isAddCandidate(proposal)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="capitalize">{proposal.taskType}</CardTitle>
        <CardAction className="flex items-center gap-2">
          {addCandidate ? <Badge variant="outline">New candidate</Badge> : null}
          <StatusBadge kind="status" value={proposal.status} />
        </CardAction>
        <CardDescription>{proposal.reason}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {addCandidate ? (
          <AddCandidateSummary proposal={proposal} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <OrderList title="Current order" order={proposal.fromOrder} other={proposal.toOrder} />
            <OrderList title="Proposed order" order={proposal.toOrder} other={proposal.fromOrder} />
          </div>
        )}
        <DataTable
          columns={EVIDENCE_COLUMNS}
          rows={rows}
          getRowId={(row) => row.pair}
          emptyMessage="No evidence yet."
        />
      </CardContent>
      <CardFooter className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted-foreground">
          Created <RelativeTime iso={proposal.createdAt} />
          {proposal.decidedAt ? (
            <>
              {" · decided "}
              <RelativeTime iso={proposal.decidedAt} />
            </>
          ) : null}
        </span>
        {proposal.status === "pending" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => onReject(proposal)} disabled={rejecting}>
              Reject
            </Button>
            <Button onClick={() => onAccept(proposal)}>Accept</Button>
          </div>
        ) : null}
      </CardFooter>
    </Card>
  )
}

/** ConfirmDialog copy for a pending proposal, scoped to its kind. */
function acceptDescription(proposal: ProposalT | null): string {
  if (!proposal) return ""
  if (isAddCandidate(proposal) && proposal.addCandidate) {
    return `${proposal.addCandidate.agent}:${proposal.addCandidate.model} will be added as a new fallback at the end of ${proposal.taskType}. It never becomes primary on its own — only a later reorder proposal can promote it once it has evidence.`
  }
  return `route() will use this order for ${proposal.taskType} tasks once you accept. Nothing changes before you accept.`
}

function UnmappedModelsCard({ models }: { models: UnmappedModelT[] }) {
  if (models.length === 0) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Unmapped models</CardTitle>
        <CardDescription>
          Discovered models that don&apos;t look like a newer version of anything already routed, and
          aren&apos;t in the model registry either. No taskType can be inferred safely — review manually.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1 text-sm">
          {models.map((m) => (
            <li key={`${m.agent}:${m.model}`} className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">{m.agent}</span>
              <span className="truncate">{m.model}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** Human-readable summary for one catalog-vs-registry drift item (src/catalog.mjs computeCatalogDrift). Report only -- never changes routing. */
function driftSummary(item: CatalogDriftItemT): string {
  switch (item.type) {
    case "vanished":
      return `${item.model} is pinned in the registry but no longer in the live catalog.`
    case "now_paid":
      return `${item.model} is marked free in the registry, but the live catalog now charges for it.`
    case "new_free":
      return `${item.model} is free in the live catalog but not yet in the registry.`
    case "variant_unavailable":
      return `${item.model} variant "${item.variant}" is pinned but no longer offered by the live catalog.`
    default:
      return item.model
  }
}

function DriftCard({ items }: { items: CatalogDriftItemT[] }) {
  if (items.length === 0) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Catalog drift</CardTitle>
        <CardDescription>
          Differences between the live opencode catalog and the model registry/routing map.
          Report only — nothing here changes routing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-sm">
          {items.map((item, index) => (
            <li
              key={`${item.agent}:${item.model}:${item.type}:${index}`}
              className="flex min-w-0 items-start gap-2"
            >
              <Badge variant="outline" className="shrink-0">
                {item.type}
              </Badge>
              <span className="truncate">{driftSummary(item)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export function ProposalsPanel() {
  const { data, isLoading } = useProposalsQuery()
  const refresh = useRefreshProposalsMutation()
  const decide = useDecideProposalMutation()
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("pending")
  const [accepting, setAccepting] = React.useState<ProposalT | null>(null)

  const proposals = data?.proposals ?? []
  const unmapped = data?.unmapped ?? []
  const drift = data?.drift ?? []
  const filtered =
    statusFilter === "pending" ? proposals.filter((p) => p.status === "pending") : proposals

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Refresh proposals
        </Button>
        <Select
          items={STATUS_ITEMS}
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as StatusFilter)}
        >
          <SelectTrigger aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardDescription>
            Proposals only suggest a different routing order. Nothing changes until you accept one —
            accepting makes route() use the proposed order for that task type.
          </CardDescription>
        </CardHeader>
      </Card>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="No proposals"
          description="There is nothing waiting for a routing decision."
        />
      ) : (
        filtered.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            onAccept={setAccepting}
            onReject={(target) => decide.mutate({ id: target.id, decision: "reject" })}
            rejecting={decide.isPending && decide.variables?.decision === "reject"}
          />
        ))
      )}

      <UnmappedModelsCard models={unmapped} />
      <DriftCard items={drift} />

      <ConfirmDialog
        open={accepting !== null}
        onOpenChange={(open) => {
          if (!open) setAccepting(null)
        }}
        title={`Accept proposal for ${accepting?.taskType ?? ""}`}
        description={acceptDescription(accepting)}
        confirmLabel="Accept order"
        onConfirm={() => {
          if (accepting) decide.mutate({ id: accepting.id, decision: "accept" })
        }}
      />
    </div>
  )
}

import * as React from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { StatusBadge } from "@/components/StatusBadge"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { RelativeTime } from "@/components/RelativeTime"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/components/ui/toast"
import { useModelPolicyQuery, useSetModelDecisionMutation, useSetModelOrderMutation } from "@/lib/queries"
import type { ModelPolicyModelT } from "@/lib/types"

const POOL_LABEL: Record<ModelPolicyModelT["pool"], string> = {
  free: "Free",
  go: "Go",
  paid: "Paid",
  unknown: "Unknown",
}

const QUOTA_NOTE: Record<ModelPolicyModelT["pool"], string> = {
  free: "",
  go: "Jobs routed to this model spend your OpenCode Go quota.",
  paid: "Jobs routed to this model are billed per token.",
  unknown: "The catalog has no pricing for this model, so it may spend quota.",
}

/**
 * opencode model policy (model-policy.json): which catalog models agent-hub
 * may use and in what priority. Free models are allowed by default; Go and
 * paid models stay blocked until allowed here, behind a confirmation.
 */
export function ModelPolicyPanel({ agent = "opencode" }: { agent?: string }) {
  const query = useModelPolicyQuery(agent)
  const decide = useSetModelDecisionMutation()
  const reorder = useSetModelOrderMutation()
  const [pending, setPending] = React.useState<ModelPolicyModelT | null>(null)

  const models = React.useMemo(() => query.data?.models ?? [], [query.data])

  const setAllowed = (model: ModelPolicyModelT, allowed: boolean) =>
    decide.mutate(
      { agent, model: model.id, allowed },
      { onError: (error) => toast.add({ title: `Could not update ${model.id}`, description: error.message, type: "error" }) }
    )

  const onToggle = (model: ModelPolicyModelT) => {
    if (model.allowed) return setAllowed(model, false)
    if (model.pool === "free") return setAllowed(model, true)
    setPending(model)
  }

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= models.length) return
    const order = models.map((m) => m.id)
    ;[order[index], order[target]] = [order[target], order[index]]
    reorder.mutate(
      { agent, order },
      { onError: (error) => toast.add({ title: "Could not save the order", description: error.message, type: "error" }) }
    )
  }

  const columns: DataTableColumn<ModelPolicyModelT>[] = [
    {
      key: "priority",
      header: "Priority",
      cell: (row) => {
        const index = models.indexOf(row)
        return (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon-xs" aria-label={`Move ${row.id} up`} disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${row.id} down`}
              disabled={index === models.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown />
            </Button>
          </div>
        )
      },
    },
    {
      key: "model",
      header: "Model",
      cell: (row) => (
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-xs">{row.id}</span>
          {row.isNew ? <Badge variant="outline">New</Badge> : null}
        </div>
      ),
    },
    { key: "pool", header: "Pool", cell: (row) => <Badge variant="secondary">{POOL_LABEL[row.pool]}</Badge> },
    { key: "status", header: "Status", cell: (row) => <StatusBadge kind="status" value={row.allowed ? "allowed" : "blocked"} /> },
    {
      key: "action",
      header: "",
      cell: (row) => (
        <Button
          variant={row.allowed ? "outline" : "default"}
          size="sm"
          aria-label={`${row.allowed ? "Block" : "Allow"} ${row.id}`}
          disabled={decide.isPending}
          onClick={() => onToggle(row)}
        >
          {row.allowed ? "Block" : "Allow"}
        </Button>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{agent} models</CardTitle>
        <CardDescription>
          Choose which {agent} models agent-hub may use. Free models are allowed by default; Go and paid models stay
          blocked until you allow them. Within a pool, models higher in the list are tried first.
          {query.data?.catalogCheckedAt ? (
            <>
              {" "}
              Catalog checked <RelativeTime iso={query.data.catalogCheckedAt} />.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load the model policy.</AlertTitle>
            <AlertDescription>{query.error.message}</AlertDescription>
          </Alert>
        ) : !query.data.catalogAvailable ? (
          <Alert>
            <AlertTitle>The {agent} catalog is unavailable.</AlertTitle>
            <AlertDescription>
              Rediscover CLIs to load it. Until then only models you allowed explicitly can run.
            </AlertDescription>
          </Alert>
        ) : (
          <DataTable columns={columns} rows={models} getRowId={(row) => row.id} />
        )}
      </CardContent>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? `Allow ${pending.id}?` : "Allow model?"}
        description={pending ? `${QUOTA_NOTE[pending.pool]} agent-hub may route delegated jobs to it.` : ""}
        confirmLabel="Allow"
        onConfirm={() => pending && setAllowed(pending, true)}
      />
    </Card>
  )
}

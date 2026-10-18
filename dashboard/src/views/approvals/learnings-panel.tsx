import * as React from "react"
import { BookOpen, Check, Info, Trash2, X } from "lucide-react"
import { LEARNING_TEXT_MAX, TASK_TYPES } from "@shared"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
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
import { toast } from "@/components/ui/toast"
import {
  useConfigQuery,
  useCreateLearningMutation,
  useDecideLearningMutation,
  useDeleteLearningMutation,
  useLearningsQuery,
} from "@/lib/queries"
import type { LearningInputT, LearningT } from "@/lib/types"

const ANY = "__any__"

const TASK_TYPE_ITEMS = [
  { value: ANY, label: "Any task type" },
  ...TASK_TYPES.map((taskType) => ({ value: taskType, label: taskType })),
]

function scopeLabel(learning: LearningT): string {
  const parts = [learning.agent, learning.model, learning.taskType].filter(
    (part): part is string => Boolean(part)
  )
  return parts.length > 0 ? parts.join(" · ") : "any"
}

const HINT_LABEL: Record<string, string> = {
  treatment_better: "helps",
  control_better: "hurts",
  no_difference: "no difference",
  inconclusive: "inconclusive",
}

// Contrastive probe evidence (learning_probe): the latest probe's verdict hint
// plus its two jobs, so the approver decides with evidence.
function ProbeSummary({ learning }: { learning: LearningT }) {
  const probes = learning.probes ?? []
  if (probes.length === 0) return <span className="text-muted-foreground">—</span>
  const latest = probes[probes.length - 1]
  const hint = latest.comparison?.verdictHint
  return (
    <div className="flex flex-col gap-1 whitespace-normal">
      <div className="flex items-center gap-1">
        <Badge variant={hint === "treatment_better" ? "default" : "outline"}>
          {hint ? HINT_LABEL[hint] : "running"}
        </Badge>
        {probes.length > 1 ? (
          <span className="text-muted-foreground text-xs">{probes.length} probes</span>
        ) : null}
      </div>
      {latest.comparison?.reason ? (
        <span className="text-muted-foreground block max-w-xs break-words text-xs">
          {latest.comparison.reason}
        </span>
      ) : null}
      <span className="text-muted-foreground font-mono text-xs">
        control {latest.controlJobId} · treatment {latest.treatmentJobId}
      </span>
    </div>
  )
}

function sortLearnings(learnings: LearningT[]): LearningT[] {
  return [...learnings].sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1
    const bPending = b.status === "pending" ? 0 : 1
    if (aPending !== bPending) return aPending - bPending
    return b.createdAt.localeCompare(a.createdAt)
  })
}

export function LearningsPanel() {
  const { data: config } = useConfigQuery()
  const { data, isLoading } = useLearningsQuery()
  const create = useCreateLearningMutation()
  const decide = useDecideLearningMutation()
  const remove = useDeleteLearningMutation()

  const [agent, setAgent] = React.useState(ANY)
  const [model, setModel] = React.useState("")
  const [taskType, setTaskType] = React.useState(ANY)
  const [text, setText] = React.useState("")
  const [deleteTarget, setDeleteTarget] = React.useState<LearningT | null>(null)

  const agents = Object.keys(config?.discovery ?? {}).sort()
  const agentItems = [{ value: ANY, label: "Any agent" }, ...agents.map((name) => ({ value: name, label: name }))]

  const learnings = sortLearnings(data?.learnings ?? [])
  const canSubmit = text.trim().length > 0 && !create.isPending

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    const input: LearningInputT = { text }
    if (agent !== ANY) input.agent = agent
    if (model.trim()) input.model = model.trim()
    if (taskType !== ANY) input.taskType = taskType as LearningInputT["taskType"]
    create.mutate(input, {
      onSuccess: () => {
        setAgent(ANY)
        setModel("")
        setTaskType(ANY)
        setText("")
        toast.add({
          title: "Learning proposed",
          description: "Stored as pending until approved.",
          type: "success",
        })
      },
    })
  }

  const columns: DataTableColumn<LearningT>[] = [
    { key: "scope", header: "Scope", cell: (learning) => scopeLabel(learning) },
    {
      key: "text",
      // The TableCell primitive sets whitespace-nowrap and white-space is
      // inherited, so the span must re-enable wrapping for itself: without it
      // a long learning runs across the Status and Actions columns and pushes
      // Approve/Reject out of reach.
      header: "Text",
      className: "align-top",
      cell: (learning) => (
        <span className="block max-w-md whitespace-normal break-words">{learning.text}</span>
      ),
    },
    {
      key: "source",
      header: "Source",
      cell: (learning) => (
        <Badge variant="outline">{learning.source === "mcp" ? "MCP" : "Dashboard"}</Badge>
      ),
    },
    {
      key: "evidence",
      header: "Evidence",
      className: "align-top",
      cell: (learning) => <ProbeSummary learning={learning} />,
    },
    {
      key: "status",
      header: "Status",
      cell: (learning) => <StatusBadge kind="status" value={learning.status} />,
    },
    {
      key: "created",
      header: "Created",
      cell: (learning) => <RelativeTime iso={learning.createdAt} />,
    },
    {
      key: "actions",
      header: "Actions",
      cell: (learning) => (
        <div className="flex items-center gap-1">
          {learning.status === "pending" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => decide.mutate({ id: learning.id, decision: "approve" })}
              >
                <Check data-icon="inline-start" />
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => decide.mutate({ id: learning.id, decision: "reject" })}
              >
                <X data-icon="inline-start" />
                Reject
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete learning ${learning.id}`}
            onClick={() => setDeleteTarget(learning)}
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <Info />
        <AlertTitle>Approved learnings steer future delegations</AlertTitle>
        <AlertDescription>
          Approved learnings are prepended to future delegate prompts (max 3 per job).
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Propose a learning</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="learning-agent">Agent</FieldLabel>
                <Select items={agentItems} value={agent} onValueChange={(value) => setAgent(String(value))}>
                  <SelectTrigger id="learning-agent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {agentItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="learning-model">Model</FieldLabel>
                <Input
                  id="learning-model"
                  value={model}
                  placeholder="Any model"
                  onChange={(event) => setModel(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="learning-task-type">Task type</FieldLabel>
                <Select
                  items={TASK_TYPE_ITEMS}
                  value={taskType}
                  onValueChange={(value) => setTaskType(String(value))}
                >
                  <SelectTrigger id="learning-task-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TASK_TYPE_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="learning-text">Text</FieldLabel>
              <Textarea
                id="learning-text"
                value={text}
                maxLength={LEARNING_TEXT_MAX}
                placeholder="What did you learn about an agent, model or task type?"
                onChange={(event) => setText(event.target.value)}
              />
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Stored as pending until approved.</span>
                <span>
                  {text.length}/{LEARNING_TEXT_MAX}
                </span>
              </div>
            </Field>

            <div className="flex justify-end">
              <Button type="submit" disabled={!canSubmit}>
                Propose learning
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : learnings.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No learnings"
          description="Approved and pending learnings will show up here."
        />
      ) : (
        <DataTable columns={columns} rows={learnings} getRowId={(learning) => learning.id} />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="Delete learning"
        description="This permanently removes the learning. It cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id)
        }}
      />
    </div>
  )
}

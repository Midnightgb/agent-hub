import * as React from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, ChevronLeft, ChevronRight, History } from "lucide-react"
import { JobResultResponse } from "@shared"
import { fetchJson } from "@/lib/api"
import { useStateQuery } from "@/lib/queries"
import { HISTORY_PAGE_SIZES, HistorySearch, type HistorySearchT } from "@/routes/search"
import type { Job } from "@/lib/types"
import { JobProfileBadge } from "@/views/providers"
import { formatModel, formatNumber, formatDuration } from "@/lib/format"
import { PageHeader } from "@/components/PageHeader"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { DiffStatsSummary } from "@/components/DiffStatsSummary"
import { DiffStatsTable } from "@/components/DiffStatsTable"
import { StatusBadge } from "@/components/StatusBadge"
import { RelativeTime } from "@/components/RelativeTime"
import { EmptyState } from "@/components/EmptyState"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled"
}

type JobWithViolation = Job & { readModeViolation?: string | null }

function JobResultSection({ jobId }: { jobId: string }) {
  const resultQuery = useQuery({
    queryKey: ["jobs", jobId, "result"],
    queryFn: () =>
      fetchJson(
        JobResultResponse,
        `/api/jobs/${encodeURIComponent(jobId)}/result?maxLines=60&tailLines=20`
      ),
  })

  if (resultQuery.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Result</span>
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (resultQuery.isError) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">Result</span>
        <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
          Failed to load result
        </div>
      </div>
    )
  }

  const data = resultQuery.data
  if (!data) return null

  const headLines = data.text ? data.text.split("\n").length : 0
  const tailLines = data.tail ? data.tail.split("\n").length : 0
  const omitted =
    data.totalLines != null ? Math.max(0, data.totalLines - headLines - tailLines) : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Result</span>
        {data.totalLines != null ? (
          <span className="text-xs text-muted-foreground">{data.totalLines} lines</span>
        ) : null}
      </div>
      <ScrollArea className="h-64 rounded-md border bg-muted/30 p-3">
        <pre className="font-mono text-xs whitespace-pre-wrap break-all">
          {data.text || "(empty response)"}
        </pre>
        {data.tailTruncated ? (
          <div className="my-2 rounded border border-dashed border-border py-1.5 text-center font-mono text-xs text-muted-foreground">
            … {omitted} lines omitted …
          </div>
        ) : null}
        {data.tail ? (
          <pre className="font-mono text-xs whitespace-pre-wrap break-all">{data.tail}</pre>
        ) : null}
      </ScrollArea>
    </div>
  )
}

export function HistoryView() {
  const navigate = useNavigate()
  const rawSearch = useSearch({ strict: false })
  const search = React.useMemo(() => HistorySearch.parse(rawSearch), [rawSearch])

  const updateSearch = React.useCallback(
    (updater: (prev: HistorySearchT) => Partial<HistorySearchT>) => {
      navigate({
        to: "/history",
        search: (prev: Record<string, unknown>) => {
          const current = HistorySearch.parse(prev)
          const diff = updater(current)
          return { ...current, ...diff }
        },
        replace: true,
      })
    },
    [navigate]
  )

  const { data: state, isLoading, error } = useStateQuery()
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null)

  const terminalJobs = React.useMemo(() => {
    return (state?.jobs ?? [])
      .filter((j) => isTerminal(j.status))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
  }, [state?.jobs])

  const agents = React.useMemo(() => {
    const set = new Set((state?.jobs ?? []).map((j) => j.agent).filter(Boolean))
    return Array.from(set).sort()
  }, [state?.jobs])

  const agentOptions = React.useMemo(() => {
    if (search.agent && !agents.includes(search.agent)) {
      return [search.agent, ...agents].sort()
    }
    return agents
  }, [agents, search.agent])

  const filteredJobs = React.useMemo(() => {
    return terminalJobs.filter((job) => {
      if (search.status !== "all" && job.status !== search.status) return false
      if (search.agent && job.agent !== search.agent) return false
      if (search.q) {
        const q = search.q.toLowerCase()
        const haystack = [job.title || "", job.jobId || "", job.model || "", job.error || ""]
          .join(" ")
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [terminalJobs, search.status, search.agent, search.q])

  // Jobs are sorted newest first, so page 1 holds the most recent ones. A page
  // past the end (e.g. after a filter shrinks the list) shows the last page.
  const pageCount = Math.max(1, Math.ceil(filteredJobs.length / search.pageSize))
  const page = Math.min(search.page, pageCount)
  const pageStart = (page - 1) * search.pageSize
  const pageJobs = React.useMemo(
    () => filteredJobs.slice(pageStart, pageStart + search.pageSize),
    [filteredJobs, pageStart, search.pageSize]
  )

  const selectedJob = React.useMemo(() => {
    if (!selectedJobId) return null
    return (state?.jobs as JobWithViolation[] | undefined)?.find((j) => j.jobId === selectedJobId) ?? null
  }, [state?.jobs, selectedJobId])

  const columns = React.useMemo<DataTableColumn<Job>[]>(
    () => [
      {
        key: "finished",
        header: "Finished",
        cell: (job) => (
          <RelativeTime
            iso={job.updatedAt}
            className="text-xs text-muted-foreground whitespace-nowrap"
          />
        ),
      },
      {
        key: "agentModel",
        header: "Agent & model",
        cell: (job) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-sm">{job.agent}</span>
            <span className="text-xs text-muted-foreground truncate max-w-[140px]" title={job.model}>
              {formatModel(job.model)}
            </span>
          </div>
        ),
      },
      {
        key: "title",
        header: "Title",
        cell: (job) => (
          <div className="flex flex-col gap-0.5 max-w-[280px]">
            <span className="truncate font-medium text-sm" title={job.title || "Untitled job"}>
              {job.title || "Untitled job"}
            </span>
            {job.parentJobId ? (
              <span
                className="text-xs text-muted-foreground truncate"
                title={`Reply to job ${job.parentJobId}`}
              >
                ↳ reply of …{String(job.parentJobId).slice(-8)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "taskType",
        header: "Task type",
        cell: (job) =>
          job.taskType ? (
            <Badge variant="outline" className="font-mono text-xs">
              {job.taskType}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: "profile",
        header: "Profile",
        cell: (job) =>
          job.profile ? (
            <JobProfileBadge profile={job.profile} status={job.profileStatus} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: "status",
        header: "Status",
        cell: (job) => <StatusBadge kind="status" value={job.status} />,
      },
      {
        key: "errorKind",
        header: "Error kind",
        cell: (job) =>
          job.errorKind ? (
            <StatusBadge kind="errorKind" value={job.errorKind} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: "duration",
        header: "Duration",
        cell: (job) => {
          if (!job.createdAt || !job.updatedAt) return <span className="text-muted-foreground">—</span>
          const start = new Date(job.createdAt).getTime()
          const end = new Date(job.updatedAt).getTime()
          if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
            return <span className="text-muted-foreground">—</span>
          }
          const seconds = Math.round((end - start) / 1000)
          return <span className="font-mono text-xs">{formatDuration(seconds)}</span>
        },
      },
      {
        key: "changes",
        header: "Changes",
        cell: (job) => <DiffStatsSummary stats={job.diffStats ?? null} />,
      },
      {
        key: "tokens",
        header: "Tokens",
        className: "text-right",
        cell: (job) => (
          <span className="font-mono text-xs text-right block">
            {formatNumber(job.tokens)}
          </span>
        ),
      },
    ],
    []
  )

  const emptyTitle =
    search.status === "failed"
      ? "No failed jobs"
      : search.status === "succeeded"
        ? "No succeeded jobs"
        : search.status === "canceled"
          ? "No canceled jobs"
          : search.q || search.agent
            ? "No matching jobs"
            : "No finished jobs yet"

  const emptyDescription =
    search.status === "failed"
      ? "No failed jobs match the current filter."
      : search.status === "succeeded"
        ? "No succeeded jobs match the current filter."
        : search.status === "canceled"
          ? "No canceled jobs match the current filter."
          : search.q || search.agent
            ? "Try adjusting your search query or agent filter."
            : "Succeeded, failed and canceled jobs will show up here."

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Job history" description="Completed, failed, and canceled jobs." />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-8 w-44" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Job history" description="Completed, failed, and canceled jobs." />
        <Alert variant="destructive">
          <AlertTriangle data-icon="inline-start" />
          <AlertTitle>Error loading state</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Job history" description="Completed, failed, and canceled jobs." />

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          value={[search.status]}
          onValueChange={(val) => {
            const next = (val[val.length - 1] ?? "all") as HistorySearchT["status"]
            updateSearch(() => ({ status: next, page: 1 }))
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="all" aria-label="Show all jobs">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="failed" aria-label="Show failed jobs">
            Failed
          </ToggleGroupItem>
          <ToggleGroupItem value="succeeded" aria-label="Show succeeded jobs">
            Succeeded
          </ToggleGroupItem>
          <ToggleGroupItem value="canceled" aria-label="Show canceled jobs">
            Canceled
          </ToggleGroupItem>
        </ToggleGroup>

        <Select
          value={search.agent || "all"}
          onValueChange={(val) => {
            updateSearch(() => ({ agent: val === "all" ? "" : (val as string), page: 1 }))
          }}
        >
          <SelectTrigger aria-label="Filter by agent" className="w-[180px]">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All agents</SelectItem>
              {agentOptions.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {agent}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Input
          type="search"
          value={search.q}
          onChange={(e) => updateSearch(() => ({ q: e.target.value, page: 1 }))}
          placeholder="Search title, jobId, model, error…"
          aria-label="Search history"
          className="w-64"
        />
      </div>

      <DataTable
        columns={columns}
        rows={pageJobs}
        getRowId={(job) => job.jobId}
        onRowClick={(job) => setSelectedJobId(job.jobId)}
        emptyMessage={
          <EmptyState icon={History} title={emptyTitle} description={emptyDescription} />
        }
      />

      {filteredJobs.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {`Showing ${pageStart + 1}–${pageStart + pageJobs.length} of ${filteredJobs.length}`}
          </span>
          <div className="flex items-center gap-2">
            <Select
              value={String(search.pageSize)}
              onValueChange={(val) => {
                updateSearch(() => ({ pageSize: Number(val), page: 1 }))
              }}
            >
              <SelectTrigger aria-label="Jobs per page" size="sm" className="w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {HISTORY_PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} / page
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {pageCount > 1 ? (
              <>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() => updateSearch(() => ({ page: page - 1 }))}
                >
                  <ChevronLeft />
                </Button>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {`Page ${page} of ${pageCount}`}
                </span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next page"
                  disabled={page >= pageCount}
                  onClick={() => updateSearch(() => ({ page: page + 1 }))}
                >
                  <ChevronRight />
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <Sheet open={Boolean(selectedJob)} onOpenChange={(open) => { if (!open) setSelectedJobId(null) }}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selectedJob?.title || "Job details"}</SheetTitle>
            <SheetDescription className="font-mono text-xs">{selectedJob?.jobId}</SheetDescription>
          </SheetHeader>

          {selectedJob ? (
            <div className="flex flex-col gap-4 py-2">
              {selectedJob.readModeViolation ? (
                <Alert variant="destructive">
                  <AlertTriangle data-icon="inline-start" />
                  <AlertTitle>Read-mode violation</AlertTitle>
                  <AlertDescription>{selectedJob.readModeViolation}</AlertDescription>
                </Alert>
              ) : null}

              {selectedJob.error ? (
                <div className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                  <span className="text-xs font-semibold text-destructive">Error</span>
                  <pre className="font-mono text-xs text-destructive whitespace-pre-wrap break-all">
                    {selectedJob.error}
                  </pre>
                </div>
              ) : null}

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Status</dt>
                  <dd className="mt-0.5">
                    <StatusBadge kind="status" value={selectedJob.status} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Error kind</dt>
                  <dd className="mt-0.5">
                    {selectedJob.errorKind ? (
                      <StatusBadge kind="errorKind" value={selectedJob.errorKind} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Agent & Model</dt>
                  <dd className="mt-0.5 font-medium">
                    {selectedJob.agent}{" "}
                    <span className="text-xs text-muted-foreground font-normal">
                      ({formatModel(selectedJob.model)})
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Task type</dt>
                  <dd className="mt-0.5">
                    {selectedJob.taskType ? (
                      <Badge variant="outline" className="font-mono text-xs">
                        {selectedJob.taskType}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Session ID</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all">
                    {selectedJob.sessionId || <span className="text-muted-foreground">—</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Parent job</dt>
                  <dd className="mt-0.5">
                    {selectedJob.parentJobId ? (
                      <button
                        type="button"
                        className="cursor-pointer font-mono text-xs text-primary underline underline-offset-2 hover:text-primary/80"
                        onClick={() => {
                          updateSearch(() => ({ q: selectedJob.parentJobId!, page: 1 }))
                        }}
                      >
                        {selectedJob.parentJobId}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Turn depth</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {selectedJob.turnDepth != null ? (
                      selectedJob.turnDepth
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Timeout</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {selectedJob.timeoutS != null ? (
                      `${selectedJob.timeoutS}s${selectedJob.timeoutSource ? ` (${selectedJob.timeoutSource})` : ""}`
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Tokens</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatNumber(selectedJob.tokens)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Cost (USD)</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {selectedJob.costUsd != null ? (
                      `$${selectedJob.costUsd.toFixed(4)}`
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Learnings</dt>
                  <dd className="mt-0.5 text-xs">
                    {selectedJob.learningIds && selectedJob.learningIds.length > 0 ? (
                      <span>{selectedJob.learningIds.join(", ")}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Created</dt>
                  <dd className="mt-0.5 text-xs text-muted-foreground">
                    {selectedJob.createdAt ? new Date(selectedJob.createdAt).toLocaleString() : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 text-xs text-muted-foreground">
                    {selectedJob.updatedAt ? new Date(selectedJob.updatedAt).toLocaleString() : "—"}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">Cwd</dt>
                  <dd className="mt-0.5 font-mono text-xs break-all text-muted-foreground">
                    {selectedJob.cwd || "—"}
                  </dd>
                </div>
              </dl>

              {selectedJob.diffStats ? (
                <>
                  <Separator />
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium">Changes</h3>
                      <DiffStatsSummary stats={selectedJob.diffStats} />
                    </div>
                    <DiffStatsTable
                      files={selectedJob.diffStats.files}
                      truncated={selectedJob.diffStats.truncated}
                    />
                  </div>
                </>
              ) : null}

              <Separator />

              <JobResultSection jobId={selectedJob.jobId} />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

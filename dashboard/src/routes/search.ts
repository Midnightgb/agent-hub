/**
 * Search-param schemas for every route. Every field uses zod's `.catch()` so
 * an invalid or missing value falls back to its default instead of throwing
 * — TanStack Router calls `validateSearch` on every navigation, and a throw
 * there would break a deep link instead of just ignoring the bad param.
 */
import { z } from "zod"

/**
 * zod 4 types the input of a `.catch()` field as `unknown`, which TanStack
 * Router reads as "this search param is required". Every field here falls
 * back, so none is: expose the object with optional input.
 */
const search = <S extends z.ZodObject>(schema: S) =>
  schema as unknown as z.ZodType<z.output<S>, Partial<z.output<S>>>

export const AgentsSearch = search(
  z.object({
    filter: z.enum(["all", "unhealthy", "held", "breaker"]).catch("all"),
    q: z.string().catch(""),
  })
)
export type AgentsSearchT = z.infer<typeof AgentsSearch>

export const HISTORY_PAGE_SIZES = [10, 25, 50, 100] as const

export const HistorySearch = search(
  z.object({
    status: z.enum(["all", "failed", "succeeded", "canceled"]).catch("all"),
    agent: z.string().catch(""),
    q: z.string().catch(""),
    page: z.coerce.number().int().min(1).catch(1),
    pageSize: z.coerce
      .number()
      .int()
      .refine((size) =>
        (HISTORY_PAGE_SIZES as readonly number[]).includes(size)
      )
      .catch(HISTORY_PAGE_SIZES[0]),
  })
)
export type HistorySearchT = z.infer<typeof HistorySearch>

export const MetricsSearch = search(
  z.object({
    taskType: z.string().catch(""),
  })
)
export type MetricsSearchT = z.infer<typeof MetricsSearch>

export const TimelineSearch = search(
  z.object({
    source: z.string().catch(""),
    q: z.string().catch(""),
  })
)
export type TimelineSearchT = z.infer<typeof TimelineSearch>

export const ApprovalsSearch = search(
  z.object({
    tab: z.enum(["proposals", "learnings"]).catch("proposals"),
  })
)
export type ApprovalsSearchT = z.infer<typeof ApprovalsSearch>

export const ConfigSearch = search(
  z.object({
    section: z
      .enum(["delegation", "process", "breaker", "overrides", "paths", "tools"])
      .catch("delegation"),
  })
)
export type ConfigSearchT = z.infer<typeof ConfigSearch>

export const CloudSearch = search(
  z.object({
    tab: z
      .enum(["accounts", "sources", "schedules", "sessions"])
      .catch("accounts"),
  })
)
export type CloudSearchT = z.infer<typeof CloudSearch>

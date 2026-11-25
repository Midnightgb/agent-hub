/**
 * Search-param schemas for every route. Every field uses zod's `.catch()` so
 * an invalid or missing value falls back to its default instead of throwing
 * — TanStack Router calls `validateSearch` on every navigation, and a throw
 * there would break a deep link instead of just ignoring the bad param.
 */
import { z } from "zod"

export const AgentsSearch = z.object({
  filter: z.enum(["all", "unhealthy", "held", "breaker"]).catch("all"),
  q: z.string().catch(""),
})
export type AgentsSearchT = z.infer<typeof AgentsSearch>

export const HISTORY_PAGE_SIZES = [10, 25, 50, 100] as const

export const HistorySearch = z.object({
  status: z.enum(["all", "failed", "succeeded", "canceled"]).catch("all"),
  agent: z.string().catch(""),
  q: z.string().catch(""),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((size) => (HISTORY_PAGE_SIZES as readonly number[]).includes(size))
    .catch(HISTORY_PAGE_SIZES[0]),
})
export type HistorySearchT = z.infer<typeof HistorySearch>

export const MetricsSearch = z.object({
  taskType: z.string().catch(""),
})
export type MetricsSearchT = z.infer<typeof MetricsSearch>

export const TimelineSearch = z.object({
  source: z.string().catch(""),
  q: z.string().catch(""),
})
export type TimelineSearchT = z.infer<typeof TimelineSearch>

export const ApprovalsSearch = z.object({
  tab: z.enum(["proposals", "learnings"]).catch("proposals"),
})
export type ApprovalsSearchT = z.infer<typeof ApprovalsSearch>

export const ConfigSearch = z.object({
  section: z.enum(["delegation", "process", "breaker", "overrides", "paths", "tools"]).catch("delegation"),
})
export type ConfigSearchT = z.infer<typeof ConfigSearch>

export const CloudSearch = z.object({
  tab: z.enum(["accounts", "sources", "schedules", "sessions"]).catch("accounts"),
})
export type CloudSearchT = z.infer<typeof CloudSearch>

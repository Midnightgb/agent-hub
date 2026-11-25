/** Central query-key registry so every consumer (queries.ts, sse.ts, views) invalidates the same keys. */
export const qk = {
  state: ["state"] as const,
  config: ["config"] as const,
  metrics: ["metrics"] as const,
  proposals: ["proposals"] as const,
  learnings: ["learnings"] as const,
  accounts: ["accounts"] as const,
  sources: ["sources"] as const,
  schedules: ["schedules"] as const,
  sessions: ["sessions"] as const,
  activities: (id: string) => ["activities", id] as const,
  workGraph: ["work-graph"] as const,
  tools: ["tools"] as const,
  providers: ["providers"] as const,
  modelPolicy: (agent: string) => ["model-policy", agent] as const,
  providersMode: ["providers", "mode"] as const,
  executionGraph: (root?: string | null) => (root ? (['execution-graph', root] as const) : (['execution-graph'] as const)),
}

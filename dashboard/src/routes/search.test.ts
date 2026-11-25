import { describe, expect, it } from "vitest"
import {
  AgentsSearch,
  HistorySearch,
  MetricsSearch,
  TimelineSearch,
  ApprovalsSearch,
  ConfigSearch,
} from "./search"

describe("AgentsSearch", () => {
  it("defaults filter and q when missing", () => {
    expect(AgentsSearch.parse({})).toEqual({ filter: "all", q: "" })
  })

  it("falls back to 'all' for an invalid filter instead of throwing", () => {
    expect(() => AgentsSearch.parse({ filter: "bogus" })).not.toThrow()
    expect(AgentsSearch.parse({ filter: "bogus" })).toEqual({ filter: "all", q: "" })
  })

  it("keeps a valid filter and q", () => {
    expect(AgentsSearch.parse({ filter: "unhealthy", q: "agy" })).toEqual({ filter: "unhealthy", q: "agy" })
  })
})

describe("HistorySearch", () => {
  it("defaults every field", () => {
    expect(HistorySearch.parse({})).toEqual({ status: "all", agent: "", q: "", page: 1, pageSize: 10 })
  })

  it("reads page and pageSize from the URL and falls back on invalid values", () => {
    expect(HistorySearch.parse({ page: "3", pageSize: "25" })).toMatchObject({ page: 3, pageSize: 25 })
    expect(HistorySearch.parse({ page: 0, pageSize: 7 })).toMatchObject({ page: 1, pageSize: 10 })
    expect(HistorySearch.parse({ page: "x", pageSize: "x" })).toMatchObject({ page: 1, pageSize: 10 })
  })

  it("falls back on an invalid status", () => {
    expect(HistorySearch.parse({ status: "not-a-status" })).toMatchObject({ status: "all" })
  })
})

describe("MetricsSearch", () => {
  it("defaults taskType to an empty string", () => {
    expect(MetricsSearch.parse({})).toEqual({ taskType: "" })
  })
})

describe("TimelineSearch", () => {
  it("defaults source and q", () => {
    expect(TimelineSearch.parse({})).toEqual({ source: "", q: "" })
  })
})

describe("ApprovalsSearch", () => {
  it("defaults tab to proposals", () => {
    expect(ApprovalsSearch.parse({})).toEqual({ tab: "proposals" })
  })

  it("falls back to proposals for an invalid tab", () => {
    expect(ApprovalsSearch.parse({ tab: "bogus" })).toEqual({ tab: "proposals" })
  })
})

describe("ConfigSearch", () => {
  it("defaults section to delegation", () => {
    expect(ConfigSearch.parse({})).toEqual({ section: "delegation" })
  })

  it("falls back to delegation for an invalid section", () => {
    expect(ConfigSearch.parse({ section: "bogus" })).toEqual({ section: "delegation" })
  })

  it("keeps a valid tools section", () => {
    expect(ConfigSearch.parse({ section: "tools" })).toEqual({ section: "tools" })
  })
})

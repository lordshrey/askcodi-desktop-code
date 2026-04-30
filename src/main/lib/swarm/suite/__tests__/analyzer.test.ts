/**
 * Analyzer tests — verify the markdown report structure on a small
 * fixture suite and on the empty-suite edge case.
 */
import { describe, expect, it } from "vitest"
import type { CellSummary } from "../cell"
import { renderReport } from "../analyzer"

function fixture(
  algorithm: string,
  queryId: string,
  overrides: Partial<CellSummary> = {},
): CellSummary {
  return {
    version: 1,
    algorithm,
    queryId,
    query: `query ${queryId}`,
    durationMs: 1000,
    errored: false,
    rawLogPath: `/tmp/${algorithm}-${queryId}.jsonl`,
    finishedAt: "2026-04-27T00:00:00Z",
    parentMessages: 5,
    delegations: {},
    toolCalls: {},
    swarmFailures: 0,
    modelTokens: {
      "claude-haiku-4-5-20251001": {
        calls: 3,
        input: 1000,
        output: 200,
        cacheCreate: 0,
        cacheRead: 500,
      },
    },
    algorithmStats: {},
    ...overrides,
  }
}

describe("renderReport", () => {
  it("returns a no-cells notice for an empty suite", () => {
    const md = renderReport([], { title: "Empty" })
    expect(md).toContain("# Empty")
    expect(md).toContain("No cells in this suite")
  })

  it("renders sections for latency, tokens, haiku-share, failures, verdicts", () => {
    const cells: CellSummary[] = [
      fixture("aco", "Q1", { durationMs: 1500 }),
      fixture("none", "Q1", { durationMs: 2500 }),
      fixture("aco", "Q2", { durationMs: 800 }),
      fixture("none", "Q2", { durationMs: 1200 }),
    ]
    const md = renderReport(cells, { title: "Test", suiteId: "abc123" })
    expect(md).toContain("# Test")
    expect(md).toContain("Suite: `abc123`")
    expect(md).toContain("## Wall-clock latency")
    expect(md).toContain("## Token usage")
    expect(md).toContain("## Haiku share")
    expect(md).toContain("## Failures")
    expect(md).toContain("## Algorithm verdicts")
    // Latency table should have both algos as columns and Q1/Q2 as rows.
    expect(md).toMatch(/\| Query \| aco \| none \|/)
    expect(md).toMatch(/\| Q1 \| 1.5s \| 2.5s \|/)
    expect(md).toMatch(/\| Q2 \| 800ms \| 1.2s \|/)
  })

  it("sorts queries Q1 < Q2 < Q10 numerically", () => {
    const cells: CellSummary[] = [
      fixture("a", "Q10"),
      fixture("a", "Q2"),
      fixture("a", "Q1"),
    ]
    const md = renderReport(cells)
    const q1Idx = md.indexOf("| Q1 |")
    const q2Idx = md.indexOf("| Q2 |")
    const q10Idx = md.indexOf("| Q10 |")
    expect(q1Idx).toBeLessThan(q2Idx)
    expect(q2Idx).toBeLessThan(q10Idx)
  })

  it("shows ERR in tables for errored cells", () => {
    const cells: CellSummary[] = [
      fixture("aco", "Q1"),
      fixture("none", "Q1", { errored: true, errorMessage: "boom" }),
    ]
    const md = renderReport(cells)
    expect(md).toMatch(/\| Q1 \| 1.0s \| ERR \|/)
    expect(md).toContain("ERROR — boom")
  })

  it("shows em-dash for missing algorithm × query cells", () => {
    const cells: CellSummary[] = [
      fixture("aco", "Q1"),
      fixture("none", "Q2"), // none didn't run on Q1, aco didn't run on Q2
    ]
    const md = renderReport(cells)
    // Latency row: Q1 has aco but not none.
    const latencySection = md.split("## Token")[0]
    expect(latencySection).toMatch(/\| Q1 \| 1.0s \| — \|/)
    expect(latencySection).toMatch(/\| Q2 \| — \| 1.0s \|/)
  })

  it("computes haiku share as % of (input+output) tokens", () => {
    const cells: CellSummary[] = [
      fixture("haiku-only", "Q1", {
        modelTokens: {
          "claude-haiku-4-5-20251001": {
            calls: 1,
            input: 100,
            output: 100,
            cacheCreate: 0,
            cacheRead: 0,
          },
        },
      }),
      fixture("mixed", "Q1", {
        modelTokens: {
          "claude-opus-4-7": {
            calls: 1,
            input: 100,
            output: 100,
            cacheCreate: 0,
            cacheRead: 0,
          },
          "claude-haiku-4-5-20251001": {
            calls: 1,
            input: 50,
            output: 50,
            cacheCreate: 0,
            cacheRead: 0,
          },
        },
      }),
    ]
    const md = renderReport(cells)
    expect(md).toMatch(/\| Q1 \| 100% \| 33% \|/)
  })

  it("notes 'all cells succeeded' when no failures present", () => {
    const cells: CellSummary[] = [fixture("a", "Q1")]
    const md = renderReport(cells)
    expect(md).toContain("All cells succeeded with no minion-failure sentinels")
  })

  it("flags non-zero swarm failures in the failures table", () => {
    const cells: CellSummary[] = [
      fixture("aco", "Q1", { swarmFailures: 3 }),
      fixture("none", "Q1"),
    ]
    const md = renderReport(cells)
    const failuresSection = md.split("## Algorithm verdicts")[0]
    expect(failuresSection).toMatch(/\| Q1 \| 3 \| 0 \|/)
  })

  it("renders one verdict bullet per algorithm × query, with compact algorithmStats", () => {
    const cells: CellSummary[] = [
      fixture("aco", "Q1", {
        algorithmStats: { warm_start: false, files_bumped: 7 },
      }),
    ]
    const md = renderReport(cells)
    expect(md).toContain("### Q1")
    expect(md).toContain("> query Q1")
    expect(md).toContain("**aco**:")
    expect(md).toMatch(/warm_start.*files_bumped.*7/)
  })
})

/**
 * Async suite runner tests. Cover concurrency capping, error isolation,
 * cell ordering preservation, and StreamStats aggregation from the
 * raw event stream.
 */
import { describe, expect, it, vi } from "vitest"
import { runCell, runSuite, type SuiteCell } from "../runner"
import { summarizeStream } from "../cell"
import type {
  AlgorithmAugmentation,
  SwarmAlgorithm,
} from "../../algorithms/algorithm"

/**
 * The new architecture: the suite runner uses simulateAlgorithmRun which
 * calls algorithm.prepare() then drives the SDK stream. The algorithm
 * doesn't produce messages — sdkQuery does. So the fake algorithm just
 * needs a prepare() that produces an augmentation; the canned messages
 * come from a fake sdkQuery.
 */
function makeFakeAlgorithm(
  name: string,
  augOverride?: Partial<AlgorithmAugmentation>,
  shouldThrow = false,
): SwarmAlgorithm {
  return {
    name,
    description: `fake ${name}`,
    prepare: vi.fn(() => {
      if (shouldThrow) throw new Error(`${name} blew up`)
      return {
        skip: false,
        async finalize() {
          return { name }
        },
        ...augOverride,
      }
    }),
  }
}

function makeFakeSdkQuery(messages: unknown[], delayMs = 0): typeof sdkQuery {
  return vi.fn(({ options }: { options?: { canUseTool?: unknown } }) => {
    void options // Touch options so the param isn't flagged unused.
    return (async function* () {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      for (const m of messages) yield m
    })()
  }) as unknown as typeof sdkQuery
}

const sdkQuery = vi.fn() as unknown as Parameters<
  typeof runCell
>[1]["sdkQuery"]

const baseCtx = {
  cwd: "/repo",
  sdkQuery,
  pathToClaudeCodeExecutable: "/fake/claude",
  onMessage: vi.fn(),
}

describe("summarizeStream", () => {
  it("counts assistant messages, tool calls, delegations, sentinels", () => {
    const stats = summarizeStream([
      {
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "x" } },
            { type: "tool_use", name: "Task", input: { subagent_type: "Explore" } },
            { type: "text", text: "MINION_FAILED: nope" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
          usage: { input_tokens: 50, output_tokens: 10 },
          content: [],
        },
      },
    ])

    expect(stats.parentMessages).toBe(2)
    expect(stats.toolCalls).toEqual({ Read: 1, Task: 1 })
    expect(stats.delegations).toEqual({ Explore: 1 })
    expect(stats.swarmFailures).toBe(1)
    expect(stats.modelTokens["claude-haiku-4-5-20251001"]).toEqual({
      calls: 1,
      input: 100,
      output: 20,
      cacheCreate: 0,
      cacheRead: 0,
    })
    expect(stats.modelTokens["claude-opus-4-7"].calls).toBe(1)
  })

  it("treats SWARM_FAILED and MINION_FAILED both as swarmFailures", () => {
    const stats = summarizeStream([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "SWARM_FAILED: legacy" },
            { type: "text", text: "MINION_FAILED: new" },
          ],
        },
      },
    ])
    expect(stats.swarmFailures).toBe(2)
  })

  it("ignores non-assistant messages", () => {
    const stats = summarizeStream([
      { type: "system", subtype: "init" },
      { type: "user", message: { content: [] } },
      { type: "result", usage: {} },
    ])
    expect(stats.parentMessages).toBe(0)
  })
})

function makeCell(
  algorithm: SwarmAlgorithm,
  queryId: string,
  queryText = `query ${queryId}`,
): SuiteCell {
  return {
    algorithm,
    queryId,
    queryText,
    rawLogPath: `/tmp/${algorithm.name}-${queryId}.jsonl`,
  }
}

describe("runCell", () => {
  it("returns a happy-path summary with stats from finalize()", async () => {
    let t = 1000
    const now = () => (t += 100)
    const algo = makeFakeAlgorithm("noop")
    const fakeSdk = makeFakeSdkQuery([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: {} }],
        },
      },
    ])

    const summary = await runCell(
      makeCell(algo, "Q1"),
      { ...baseCtx, sdkQuery: fakeSdk },
      now,
    )

    expect(summary.errored).toBe(false)
    expect(summary.algorithm).toBe("noop")
    expect(summary.queryId).toBe("Q1")
    expect(summary.parentMessages).toBe(1)
    expect(summary.toolCalls.Read).toBe(1)
    expect(summary.algorithmStats).toEqual({ name: "noop" })
    expect(summary.durationMs).toBeGreaterThan(0)
  })

  it("captures cell errors without throwing — errored=true, partial stats", async () => {
    const algo = makeFakeAlgorithm("crashy", undefined, true)
    const summary = await runCell(makeCell(algo, "Q1"), baseCtx)

    expect(summary.errored).toBe(true)
    expect(summary.errorMessage).toContain("crashy blew up")
    expect(summary.algorithmStats).toEqual({})
  })

  it("forwards messages through ctx.onMessage with queryId + algorithm name", async () => {
    const algo = makeFakeAlgorithm("a1")
    const fakeSdk = makeFakeSdkQuery([
      { type: "assistant", message: { content: [] } },
    ])
    const onMessage = vi.fn()
    await runCell(makeCell(algo, "Q1"), {
      ...baseCtx,
      sdkQuery: fakeSdk,
      onMessage,
    })

    expect(onMessage).toHaveBeenCalledWith(
      "Q1",
      "a1",
      expect.objectContaining({ type: "assistant" }),
    )
  })
})

describe("runSuite", () => {
  it("runs all cells and preserves submission order in results", async () => {
    const a = makeFakeAlgorithm("a")
    const b = makeFakeAlgorithm("b")
    const fakeSdk = makeFakeSdkQuery([], 1)
    const cells = [
      makeCell(a, "Q1"),
      makeCell(b, "Q1"),
      makeCell(a, "Q2"),
      makeCell(b, "Q2"),
    ]

    const results = await runSuite(
      cells,
      { ...baseCtx, sdkQuery: fakeSdk },
      { concurrency: 2 },
    )

    expect(results.length).toBe(4)
    expect(results.map((r) => `${r.algorithm}-${r.queryId}`)).toEqual([
      "a-Q1",
      "b-Q1",
      "a-Q2",
      "b-Q2",
    ])
  })

  it("respects concurrency cap (count concurrent in-flight algorithm runs)", async () => {
    let inFlight = 0
    let peak = 0
    const tracker: SwarmAlgorithm = {
      name: "tracked",
      description: "tracker",
      prepare: () => ({
        skip: false,
        async finalize() {
          inFlight--
          return {}
        },
      }),
    }
    // Use a slow SDK query — that's where the concurrent in-flight time spends.
    const slowSdk = vi.fn(() => {
      inFlight++
      peak = Math.max(peak, inFlight)
      return (async function* () {
        await new Promise((r) => setTimeout(r, 10))
      })()
    }) as unknown as typeof sdkQuery
    const cells: SuiteCell[] = Array.from({ length: 8 }, (_, i) => ({
      algorithm: tracker,
      queryId: `Q${i + 1}`,
      queryText: "x",
      rawLogPath: `/tmp/x${i}.jsonl`,
    }))

    await runSuite(
      cells,
      { ...baseCtx, sdkQuery: slowSdk },
      { concurrency: 3 },
    )

    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it("calls onCellFinish for each cell as it completes", async () => {
    const algo = makeFakeAlgorithm("a")
    const fakeSdk = makeFakeSdkQuery([], 1)
    const finished: string[] = []
    await runSuite(
      [makeCell(algo, "Q1"), makeCell(algo, "Q2"), makeCell(algo, "Q3")],
      { ...baseCtx, sdkQuery: fakeSdk },
      {
        concurrency: 2,
        onCellFinish: (s) => {
          finished.push(s.queryId)
        },
      },
    )

    expect(finished.sort()).toEqual(["Q1", "Q2", "Q3"])
  })
})

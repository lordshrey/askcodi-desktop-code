/**
 * Tests for the finalize lifecycle — always runs (success / error /
 * abort), errors swallowed.
 *
 * The contract verified here:
 *   - simulateAlgorithmRun runs finalize() on a clean stream end.
 *   - simulateAlgorithmRun runs finalize() when the stream throws mid-iteration.
 *   - finalize() exceptions don't propagate; result.stats becomes null.
 *   - The augmentation's observeMessage exception disables the observer
 *     for the rest of the run but doesn't prevent finalize().
 */
import { describe, expect, it, vi } from "vitest"
import { simulateAlgorithmRun } from "../simulate"
import type {
  AlgorithmAugmentation,
  AlgorithmContext,
  SdkQueryFn,
  SwarmAlgorithm,
} from "../algorithms/algorithm"

function fakeSdk(
  messagesOrError: unknown[] | { throwAfter: number; messages: unknown[] },
): SdkQueryFn {
  return ((_args: unknown) => {
    return (async function* () {
      if (Array.isArray(messagesOrError)) {
        for (const m of messagesOrError) yield m
        return
      }
      let i = 0
      for (const m of messagesOrError.messages) {
        if (i >= messagesOrError.throwAfter) throw new Error("stream boom")
        yield m
        i++
      }
    })()
  }) as unknown as SdkQueryFn
}

function makeAlgo(aug: AlgorithmAugmentation): SwarmAlgorithm {
  return {
    name: "test",
    description: "test algo",
    prepare: () => aug,
  }
}

const baseOpts = {
  cwd: "/repo",
  pathToClaudeCodeExecutable: "/fake/claude",
}

describe("finalize lifecycle", () => {
  it("runs finalize on clean stream end", async () => {
    const finalize = vi.fn(async () => ({ ran: true }))
    const algo = makeAlgo({ finalize })
    const result = await simulateAlgorithmRun(algo, "q", {
      ...baseOpts,
      sdkQuery: fakeSdk([{ type: "system", subtype: "init" }]),
    })
    expect(finalize).toHaveBeenCalledOnce()
    expect(result.stats).toEqual({ ran: true })
    expect(result.skipped).toBe(false)
  })

  it("runs finalize when the stream throws mid-iteration (try/finally)", async () => {
    const finalize = vi.fn(async () => ({ ran: true }))
    const observed: unknown[] = []
    const algo = makeAlgo({
      finalize,
      observeMessage: (m) => observed.push(m),
    })
    await expect(
      simulateAlgorithmRun(algo, "q", {
        ...baseOpts,
        sdkQuery: fakeSdk({
          throwAfter: 2,
          messages: [
            { type: "system", subtype: "init" },
            { type: "assistant", message: { content: [] } },
            { type: "assistant", message: { content: [] } },
          ],
        }),
      }),
    ).rejects.toThrow(/stream boom/)
    expect(finalize).toHaveBeenCalledOnce()
    // Observer saw the messages emitted before the throw.
    expect(observed.length).toBe(2)
  })

  it("finalize exceptions are swallowed and stats become null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const algo = makeAlgo({
      finalize() {
        throw new Error("finalize boom")
      },
    })
    const result = await simulateAlgorithmRun(algo, "q", {
      ...baseOpts,
      sdkQuery: fakeSdk([]),
    })
    expect(result.stats).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("does not run finalize when augmentation skips", async () => {
    const finalize = vi.fn()
    const algo: SwarmAlgorithm = {
      name: "skip-algo",
      description: "skips",
      prepare: () => ({ skip: true, skipReason: "test", finalize }),
    }
    const result = await simulateAlgorithmRun(algo, "q", {
      ...baseOpts,
      sdkQuery: fakeSdk([]),
    })
    expect(finalize).not.toHaveBeenCalled()
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe("test")
  })

  it("observer exceptions disable observer mid-run but don't block finalize", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    let observeCalls = 0
    const finalize = vi.fn(async () => ({ done: true }))
    const algo = makeAlgo({
      observeMessage: () => {
        observeCalls++
        if (observeCalls === 2) throw new Error("observer boom")
      },
      finalize,
    })
    const result = await simulateAlgorithmRun(algo, "q", {
      ...baseOpts,
      sdkQuery: fakeSdk([
        { type: "system", subtype: "init" },
        { type: "assistant", message: { content: [] } },
        { type: "assistant", message: { content: [] } },
        { type: "assistant", message: { content: [] } },
      ]),
    })
    // Observer ran twice (until it threw), then disabled for the rest.
    expect(observeCalls).toBe(2)
    expect(finalize).toHaveBeenCalledOnce()
    expect(result.stats).toEqual({ done: true })
    warn.mockRestore()
  })
})

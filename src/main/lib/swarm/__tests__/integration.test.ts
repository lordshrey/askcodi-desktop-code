/**
 * Tests for the integration glue (swarm/integration.ts) that composes
 * an algorithm's AlgorithmAugmentation onto the runtime's queryOptions.
 *
 * Covers:
 *   - systemPrompt.append concatenation (with and without an existing append)
 *   - agents merge with existing agents winning on key collision
 *   - canUseTool composition: algorithm guard first, then fallback
 *   - canUseToolGuard exception handling: throws → treated as allow
 *   - observeMessage / finalize wrapped with try/catch isolation
 */
import { describe, expect, it, vi } from "vitest"
import {
  applyAlgorithmToQueryOptions,
  type ComposableQueryOptions,
} from "../integration"
import type { AlgorithmAugmentation } from "../algorithms/algorithm"

function buildAug(overrides: Partial<AlgorithmAugmentation> = {}): AlgorithmAugmentation {
  return { ...overrides }
}

describe("applyAlgorithmToQueryOptions", () => {
  it("appends to existing systemPrompt.append with a blank-line separator", () => {
    const base: ComposableQueryOptions = {
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "## existing",
      },
    }
    const result = applyAlgorithmToQueryOptions(
      base,
      buildAug({ systemPromptAppend: "## algorithm" }),
      { algorithmName: "test" },
    )
    expect(result.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "## existing\n\n## algorithm",
    })
  })

  it("creates the systemPrompt preset when base has none", () => {
    const base: ComposableQueryOptions = {}
    const result = applyAlgorithmToQueryOptions(
      base,
      buildAug({ systemPromptAppend: "## from-algo" }),
      { algorithmName: "test" },
    )
    expect(result.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "## from-algo",
    })
  })

  it("leaves systemPrompt untouched when augmentation has no append", () => {
    const base: ComposableQueryOptions = {
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "## existing",
      },
    }
    const result = applyAlgorithmToQueryOptions(base, buildAug({}), {
      algorithmName: "test",
    })
    expect(result.options.systemPrompt).toEqual(base.systemPrompt)
  })

  it("merges agents — existing agents win on key collision (plugin override)", () => {
    const fromPlugin = { Explore: { description: "user override" } as any }
    const result = applyAlgorithmToQueryOptions(
      { agents: fromPlugin },
      buildAug({
        agents: {
          Explore: { description: "algo default" } as any,
          Voter: { description: "from algo" } as any,
        },
      }),
      { algorithmName: "test", existingAgents: fromPlugin },
    )
    expect(result.options.agents?.Explore).toEqual({ description: "user override" })
    expect(result.options.agents?.Voter).toEqual({ description: "from algo" })
  })

  it("composes canUseTool: algorithm guard first, returns deny", async () => {
    const algoGuard = vi.fn(() => ({ behavior: "deny" as const, message: "no" }))
    const baseGuard = vi.fn(async () => ({ behavior: "allow" as const }))
    const result = applyAlgorithmToQueryOptions(
      { canUseTool: baseGuard },
      buildAug({ canUseToolGuard: algoGuard }),
      { algorithmName: "test" },
    )
    const verdict = await result.options.canUseTool!("Task", { x: 1 }, {
      toolUseID: "u1",
    })
    expect(algoGuard).toHaveBeenCalled()
    expect(baseGuard).not.toHaveBeenCalled()
    expect(verdict).toEqual({ behavior: "deny", message: "no" })
  })

  it("composes canUseTool: algorithm guard returns null → falls through to base", async () => {
    const algoGuard = vi.fn(() => null)
    const baseGuard = vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: { from: "base" },
    }))
    const result = applyAlgorithmToQueryOptions(
      { canUseTool: baseGuard },
      buildAug({ canUseToolGuard: algoGuard }),
      { algorithmName: "test" },
    )
    const verdict = await result.options.canUseTool!("Read", {}, {
      toolUseID: "u1",
    })
    expect(algoGuard).toHaveBeenCalled()
    expect(baseGuard).toHaveBeenCalled()
    expect(verdict).toEqual({ behavior: "allow", updatedInput: { from: "base" } })
  })

  it("canUseToolGuard throws → swallowed, falls through to base as allow", async () => {
    const algoGuard = vi.fn(() => {
      throw new Error("boom")
    })
    const baseGuard = vi.fn(async () => ({
      behavior: "allow" as const,
    }))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = applyAlgorithmToQueryOptions(
      { canUseTool: baseGuard },
      buildAug({ canUseToolGuard: algoGuard }),
      { algorithmName: "test" },
    )
    const verdict = await result.options.canUseTool!("Read", {}, {
      toolUseID: "u1",
    })
    expect(verdict).toEqual({ behavior: "allow" })
    expect(baseGuard).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("handleMessage isolates observer exceptions and disables for the rest of the turn", () => {
    const observe = vi.fn((msg: unknown) => {
      const m = msg as { explode?: boolean }
      if (m.explode) throw new Error("observer boom")
    })
    const result = applyAlgorithmToQueryOptions(
      {},
      buildAug({ observeMessage: observe }),
      { algorithmName: "test" },
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    result.handleMessage({ ok: true })
    result.handleMessage({ explode: true })
    result.handleMessage({ ok: true }) // should be skipped
    expect(observe).toHaveBeenCalledTimes(2) // 1st + the throwing one
    expect(result.observerDisabled()).toBe(true)
    warn.mockRestore()
  })

  it("finalize swallows exceptions and returns null", async () => {
    const finalize = vi.fn(async () => {
      throw new Error("finalize boom")
    })
    const result = applyAlgorithmToQueryOptions(
      {},
      buildAug({ finalize }),
      { algorithmName: "test" },
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const stats = await result.finalize()
    expect(stats).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("finalize returns stats from the augmentation", async () => {
    const result = applyAlgorithmToQueryOptions(
      {},
      buildAug({
        async finalize() {
          return { ok: true, count: 7 }
        },
      }),
      { algorithmName: "test" },
    )
    const stats = await result.finalize()
    expect(stats).toEqual({ ok: true, count: 7 })
  })
})

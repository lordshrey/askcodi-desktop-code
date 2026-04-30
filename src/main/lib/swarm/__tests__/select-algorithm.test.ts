/**
 * Tests for the env-based algorithm selector.
 *
 * Covers:
 *   - empty env → "none" baseline (no warn)
 *   - valid env value → that algorithm
 *   - unknown env value → "none" with a warning
 *   - whitespace handling
 */
import { describe, expect, it, vi } from "vitest"
import { getConfiguredAlgorithm } from "../select-algorithm"
import { algorithmNames } from "../algorithms/registry"

describe("getConfiguredAlgorithm", () => {
  it("returns 'none' when env is undefined (no warning)", () => {
    const onWarn = vi.fn()
    const algo = getConfiguredAlgorithm(undefined, onWarn)
    expect(algo.name).toBe("none")
    expect(onWarn).not.toHaveBeenCalled()
  })

  it("returns 'none' when env is empty string", () => {
    const onWarn = vi.fn()
    const algo = getConfiguredAlgorithm("", onWarn)
    expect(algo.name).toBe("none")
    expect(onWarn).not.toHaveBeenCalled()
  })

  it("returns 'none' when env is whitespace", () => {
    const onWarn = vi.fn()
    const algo = getConfiguredAlgorithm("   ", onWarn)
    expect(algo.name).toBe("none")
    expect(onWarn).not.toHaveBeenCalled()
  })

  it("returns the matching algorithm for a valid name", () => {
    expect(getConfiguredAlgorithm("aco").name).toBe("aco")
    expect(getConfiguredAlgorithm("aco-frontier").name).toBe("aco-frontier")
    expect(getConfiguredAlgorithm("none").name).toBe("none")
  })

  it("trims whitespace before lookup", () => {
    expect(getConfiguredAlgorithm("  aco  ").name).toBe("aco")
  })

  it("returns 'none' and warns on unknown algorithm name", () => {
    const onWarn = vi.fn()
    const algo = getConfiguredAlgorithm("totally-not-real", onWarn)
    expect(algo.name).toBe("none")
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("totally-not-real"),
    )
  })

  it("warns include the list of valid algorithm names", () => {
    const onWarn = vi.fn()
    getConfiguredAlgorithm("bogus", onWarn)
    const message = onWarn.mock.calls[0][0] as string
    for (const name of algorithmNames()) {
      expect(message).toContain(name)
    }
  })
})

/**
 * Tests for the legacy SWARM_FAILED sentinel detector.
 *
 * The v0.1 swarm_explore subagent (and its helpers buildSwarmExploreAgent,
 * mergeWithPluginAgents) was deleted when the runtime migrated to
 * algorithm.prepare()-based augmentation. The sentinel string itself is
 * kept for backward compatibility with historical raw-event logs.
 */
import { describe, it, expect } from "vitest"
import { isSwarmFailure } from "../subagent-registry"

describe("isSwarmFailure", () => {
  it("detects the sentinel at the start of the message", () => {
    expect(isSwarmFailure("SWARM_FAILED: timeout reading repo")).toBe(true)
  })

  it("detects the sentinel after leading whitespace", () => {
    expect(isSwarmFailure("\n  SWARM_FAILED: bad scope")).toBe(true)
  })

  it("does NOT detect the sentinel mid-message", () => {
    expect(isSwarmFailure("Here is a summary. SWARM_FAILED: not really")).toBe(
      false,
    )
  })

  it("returns false for normal summaries", () => {
    expect(isSwarmFailure("Summary: I found 3 files")).toBe(false)
    expect(isSwarmFailure("")).toBe(false)
  })
})

/**
 * Tests for the swarm_explore subagent definition + merge helpers.
 */
import { describe, it, expect } from "vitest"
import {
  buildSwarmExploreAgent,
  mergeWithPluginAgents,
  isSwarmFailure,
  SWARM_FAILED_SENTINEL,
} from "../subagent-registry"
import type { CodebaseFingerprint } from "../types"

const fingerprint: CodebaseFingerprint = {
  project_id: "p1",
  scanned_at: "2026-04-27T12:00:00Z",
  language_breakdown: { ".ts": 240, ".py": 18, ".md": 5 },
  top_level_dirs: ["src", "tests", "docs"],
  package_manifests: [{ path: "package.json", type: "npm" }],
  frameworks_detected: ["react", "electron"],
  total_files: 263,
  total_size_bytes: 1234567,
}

describe("buildSwarmExploreAgent", () => {
  it("returns an AgentDefinition with model: haiku and read-only tools", () => {
    const a = buildSwarmExploreAgent(null)
    expect(a.model).toBe("haiku")
    expect(a.tools).toEqual(["Read", "Glob", "Grep"])
    // Description should make swarm_explore feel default-preferred, not niche.
    expect(a.description.toLowerCase()).toMatch(/default|prefer/)
    expect(a.description).toContain("SWARM_FAILED")
  })

  it("uses cold-start prompt when no fingerprint is provided", () => {
    const a = buildSwarmExploreAgent(null)
    expect(a.prompt).toContain("code-search subagent")
    expect(a.prompt).toContain(SWARM_FAILED_SENTINEL)
    expect(a.prompt).not.toContain("Codebase context")
  })

  it("injects codebase hints into the prompt when fingerprint is provided", () => {
    const a = buildSwarmExploreAgent(fingerprint)
    expect(a.prompt).toContain("Codebase context")
    expect(a.prompt).toContain(".ts (240 files)")
    expect(a.prompt).toContain("react, electron")
    expect(a.prompt).toContain("src, tests, docs")
    expect(a.prompt).toContain("Total files: 263")
  })

  it("handles fingerprints with no detected frameworks gracefully", () => {
    const fp: CodebaseFingerprint = { ...fingerprint, frameworks_detected: [] }
    const a = buildSwarmExploreAgent(fp)
    expect(a.prompt).toContain("Frameworks: none detected")
  })

  it("truncates top-level dirs to first 8", () => {
    const fp: CodebaseFingerprint = {
      ...fingerprint,
      top_level_dirs: Array.from({ length: 12 }, (_, i) => `dir${i}`),
    }
    const a = buildSwarmExploreAgent(fp)
    expect(a.prompt).toContain("dir0, dir1, dir2, dir3, dir4, dir5, dir6, dir7")
    expect(a.prompt).not.toContain("dir8")
  })
})

describe("mergeWithPluginAgents", () => {
  const swarm = buildSwarmExploreAgent(null)

  it("returns just swarm_explore when parent agents are undefined", () => {
    const r = mergeWithPluginAgents(swarm, undefined)
    expect(r).toEqual({ swarm_explore: swarm })
  })

  it("returns just swarm_explore when parent agents are empty", () => {
    const r = mergeWithPluginAgents(swarm, {})
    expect(r).toEqual({ swarm_explore: swarm })
  })

  it("merges swarm alongside other plugin agents", () => {
    const r = mergeWithPluginAgents(swarm, {
      reviewer: { description: "x", prompt: "y", tools: [], model: "sonnet" },
    })
    expect(r).toBeDefined()
    expect(Object.keys(r ?? {}).sort()).toEqual(["reviewer", "swarm_explore"])
    expect((r as Record<string, unknown>).swarm_explore).toBe(swarm)
  })

  it("yields to parent override when parent already defines swarm_explore", () => {
    const userOverride = {
      description: "user override",
      prompt: "user prompt",
      tools: ["Read"],
      model: "sonnet" as const,
    }
    const r = mergeWithPluginAgents(swarm, { swarm_explore: userOverride })
    expect(r).toEqual({ swarm_explore: userOverride })
  })

  it("does not mutate the input parent map", () => {
    const parent = { reviewer: { x: 1 } }
    const before = JSON.stringify(parent)
    mergeWithPluginAgents(swarm, parent)
    expect(JSON.stringify(parent)).toBe(before)
  })
})

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

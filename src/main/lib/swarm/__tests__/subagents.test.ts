/**
 * Subagent palette tests. Verify each role has the right toolset, model,
 * and discipline content; that the convenience builders compose; and that
 * the failure sentinel detector works.
 */
import { describe, expect, it } from "vitest"
import {
  buildAgentsMap,
  buildExplore,
  buildPartitionWorker,
  buildRecruit,
  buildScout,
  buildSynthesizer,
  buildVoter,
  isMinionFailure,
  MINION_FAILED_SENTINEL,
  READ_ONLY_TOOLS,
  SUBAGENT_BUILDERS,
} from "../subagents"

describe("subagent builders", () => {
  it("Explore is read-only Haiku with the canonical search-discipline prompt", () => {
    const a = buildExplore()
    expect(a.model).toBe("haiku")
    expect(a.tools).toEqual([...READ_ONLY_TOOLS])
    expect(a.prompt).toContain("Explore minion")
    expect(a.prompt).toContain("Glob")
    expect(a.prompt).toContain("MINION_FAILED")
  })

  it("Scout returns numbered candidates, not deep analysis", () => {
    const a = buildScout()
    expect(a.tools).toEqual([...READ_ONLY_TOOLS])
    expect(a.prompt).toContain("Candidates:")
    expect(a.description).toContain("Do NOT deep-dive")
    expect(a.description).toContain("3-5")
  })

  it("Recruit deep-dives a single assigned target", () => {
    const a = buildRecruit()
    expect(a.tools).toEqual([...READ_ONLY_TOOLS])
    expect(a.prompt).toContain("ONE target")
    expect(a.prompt).toContain("Stay there")
  })

  it("Voter is independent and cite-driven for tally aggregation", () => {
    const a = buildVoter()
    expect(a.tools).toEqual([...READ_ONLY_TOOLS])
    expect(a.prompt).toContain("Voters")
    expect(a.prompt).toContain("cannot see")
    expect(a.description.toLowerCase()).toContain("multiple")
  })

  it("PartitionWorker is region-scoped with disjoint-coverage discipline", () => {
    const a = buildPartitionWorker()
    expect(a.tools).toEqual([...READ_ONLY_TOOLS])
    expect(a.prompt).toContain("PartitionWorker")
    expect(a.description).toContain("YOUR region")
  })

  it("Synthesizer has no tools (pure text-fold)", () => {
    const a = buildSynthesizer()
    expect(a.tools).toEqual([])
    expect(a.model).toBe("haiku")
    expect(a.prompt).toContain("Do NOT invoke tools")
  })

  it("every builder enforces the compactness footer (≤500 tokens)", () => {
    for (const builder of Object.values(SUBAGENT_BUILDERS)) {
      const def = builder()
      expect(def.prompt).toContain("≤500 tokens")
      expect(def.prompt).toContain("MINION_FAILED:")
    }
  })

  it("every builder pins to Haiku model", () => {
    for (const builder of Object.values(SUBAGENT_BUILDERS)) {
      expect(builder().model).toBe("haiku")
    }
  })
})

describe("buildAgentsMap", () => {
  it("composes a subset of the palette by name", () => {
    const map = buildAgentsMap(["Scout", "Recruit", "Synthesizer"])
    expect(Object.keys(map).sort()).toEqual(["Recruit", "Scout", "Synthesizer"])
    expect(map.Scout.model).toBe("haiku")
  })

  it("throws on unknown subagent name", () => {
    expect(() => buildAgentsMap(["Doesnotexist"])).toThrow(
      /Unknown subagent type/,
    )
  })

  it("returns empty object for empty input", () => {
    expect(buildAgentsMap([])).toEqual({})
  })
})

describe("isMinionFailure", () => {
  it("matches sentinel at start", () => {
    expect(isMinionFailure("MINION_FAILED: nope")).toBe(true)
  })

  it("matches sentinel after leading whitespace", () => {
    expect(isMinionFailure("\n  MINION_FAILED: lost")).toBe(true)
  })

  it("does not match when sentinel is mid-string", () => {
    expect(isMinionFailure("Found something. MINION_FAILED in some module")).toBe(false)
  })

  it("does not match unrelated text", () => {
    expect(isMinionFailure("everything went fine")).toBe(false)
  })

  it("MINION_FAILED_SENTINEL constant matches what isMinionFailure checks", () => {
    expect(isMinionFailure(`${MINION_FAILED_SENTINEL} reason`)).toBe(true)
  })
})

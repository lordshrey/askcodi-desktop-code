/**
 * Stigmergic Frontier (ACO+Frontier hybrid) tests.
 * Covers: per-region pheromones, region attribution, decay, priors,
 * partition cache (reuse + create + parsing), system-prompt wiring,
 * warm/cold-start.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  addCachedPartition,
  applyRegionDecay,
  attributeFileToRegion,
  bumpFileInRegion,
  bumpReusedPartition,
  buildPriorsByRegion,
  detectNewPartitionTag,
  detectReuseTag,
  detectSelectedCandidate,
  extractWorkerScope,
  findCachedByQuery,
  findCachedByScope,
  findCachedPartition,
  getRegionPriors,
  jaccardSim,
  loadAcoFrontierState,
  parseCandidates,
  renderPartitionCache,
  runAcoFrontier,
  tokenizeQuery,
  tokenizeScope,
  workerScopeSimilarity,
  type AcoFrontierState,
} from "../aco-frontier"
import {
  loadLedger,
  newLedger,
  saveLedger,
  setAlgorithmState,
} from "../../ledger"

const tempRoots: string[] = []
function makeRepo(layout: Record<string, "dir" | "file">): string {
  const root = mkdtempSync(join(tmpdir(), "aco-frontier-test-"))
  tempRoots.push(root)
  const entries = Object.entries(layout).sort(
    (a, b) => a[0].split("/").length - b[0].split("/").length,
  )
  for (const [path, kind] of entries) {
    const abs = join(root, path)
    if (kind === "dir") mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, ".."), { recursive: true })
      writeFileSync(abs, "")
    }
  }
  return root
}

function newState(): AcoFrontierState {
  return { version: 2, region_memory: {}, cached_partitions: [] }
}

afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop()!
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe("attributeFileToRegion", () => {
  it("matches longest prefix first", () => {
    const inv = ["apps", "apps/web", "packages/shared"]
    expect(attributeFileToRegion("apps/web/index.js", inv)).toBe("apps/web")
    expect(attributeFileToRegion("apps/api/server.js", inv)).toBe("apps")
    expect(attributeFileToRegion("packages/shared/util.ts", inv)).toBe(
      "packages/shared",
    )
  })

  it("returns null when no region matches", () => {
    expect(attributeFileToRegion("README.md", ["src", "lib"])).toBeNull()
  })

  it("matches exact equal paths", () => {
    expect(attributeFileToRegion("src", ["src"])).toBe("src")
  })

  it("does not partial-match a non-segment prefix", () => {
    expect(attributeFileToRegion("srcfoo/x.ts", ["src"])).toBeNull()
  })
})

describe("bumpFileInRegion + getRegionPriors", () => {
  it("creates a region on first bump", () => {
    const s = newState()
    bumpFileInRegion(s, "src/main", "src/main/index.ts", 0.3, "PartitionWorker")
    expect(s.region_memory["src/main"]?.files["src/main/index.ts"]?.priority).toBeCloseTo(0.3)
    expect(s.region_memory["src/main"]?.files["src/main/index.ts"]?.hits).toBe(1)
  })

  it("accumulates bumps within a region", () => {
    const s = newState()
    bumpFileInRegion(s, "src", "src/a.ts", 0.2)
    bumpFileInRegion(s, "src", "src/a.ts", 0.3)
    expect(s.region_memory["src"].files["src/a.ts"].priority).toBeCloseTo(0.5)
    expect(s.region_memory["src"].files["src/a.ts"].hits).toBe(2)
  })

  it("isolates pheromones across regions", () => {
    const s = newState()
    bumpFileInRegion(s, "src/main", "shared.ts", 0.5)
    bumpFileInRegion(s, "src/renderer", "shared.ts", 0.4)
    expect(s.region_memory["src/main"].files["shared.ts"].priority).toBeCloseTo(0.5)
    expect(s.region_memory["src/renderer"].files["shared.ts"].priority).toBeCloseTo(0.4)
  })

  it("getRegionPriors returns top N sorted by priority", () => {
    const s = newState()
    bumpFileInRegion(s, "src", "low.ts", 0.1)
    bumpFileInRegion(s, "src", "high.ts", 0.9)
    bumpFileInRegion(s, "src", "mid.ts", 0.5)
    const top = getRegionPriors(s, "src", 2)
    expect(top.map((e) => e.path)).toEqual(["high.ts", "mid.ts"])
  })

  it("getRegionPriors returns empty for unknown region", () => {
    expect(getRegionPriors(newState(), "nonexistent", 5)).toEqual([])
  })
})

describe("applyRegionDecay", () => {
  it("decays priorities only in specified regions", () => {
    const s = newState()
    bumpFileInRegion(s, "src", "a.ts", 0.4)
    bumpFileInRegion(s, "lib", "b.ts", 0.4)
    applyRegionDecay(s, ["src"], 0.5)
    expect(s.region_memory["src"].files["a.ts"].priority).toBeCloseTo(0.2)
    expect(s.region_memory["lib"].files["b.ts"].priority).toBeCloseTo(0.4)
  })

  it("drops files below floor", () => {
    const s = newState()
    bumpFileInRegion(s, "src", "tiny.ts", 0.06)
    bumpFileInRegion(s, "src", "big.ts", 0.5)
    applyRegionDecay(s, ["src"], 0.5)
    expect(s.region_memory["src"].files["tiny.ts"]).toBeUndefined()
    expect(s.region_memory["src"].files["big.ts"]).toBeDefined()
  })

  it("ignores unknown regions", () => {
    expect(() => applyRegionDecay(newState(), ["nonexistent"], 0.5)).not.toThrow()
  })
})

describe("loadAcoFrontierState", () => {
  it("returns empty v2 state when no algorithm_state set", () => {
    const l = newLedger("/tmp/x")
    expect(loadAcoFrontierState(l)).toEqual({
      version: 2,
      region_memory: {},
      cached_partitions: [],
    })
  })

  it("round-trips through ledger algorithm_state", () => {
    const l = newLedger("/tmp/x")
    const s: AcoFrontierState = {
      version: 2,
      region_memory: {
        "src/main": {
          files: {
            "src/main/x.ts": {
              path: "src/main/x.ts",
              priority: 0.7,
              hits: 3,
              last_hit: "2026-04-28T00:00:00Z",
              last_subagent: "PartitionWorker",
            },
          },
          region_sessions: 2,
          last_touched: "2026-04-28T00:00:00Z",
        },
      },
      cached_partitions: [],
    }
    setAlgorithmState(l, "aco-frontier", s)
    const loaded = loadAcoFrontierState(l)
    expect(loaded.region_memory["src/main"]?.files["src/main/x.ts"]?.priority).toBeCloseTo(0.7)
    expect(loaded.region_memory["src/main"]?.region_sessions).toBe(2)
  })

  it("migrates v1 state to v2 (adds empty cached_partitions)", () => {
    const l = newLedger("/tmp/x")
    setAlgorithmState(l, "aco-frontier", {
      version: 1,
      region_memory: {
        "src": {
          files: {},
          region_sessions: 0,
          last_touched: "2026-04-27T00:00:00Z",
        },
      },
    })
    const loaded = loadAcoFrontierState(l)
    expect(loaded.version).toBe(2)
    expect(loaded.cached_partitions).toEqual([])
    expect(loaded.region_memory["src"]).toBeDefined()
  })

  it("returns empty v2 state on unknown version", () => {
    const l = newLedger("/tmp/x")
    setAlgorithmState(l, "aco-frontier", { version: 999, region_memory: {} })
    expect(loadAcoFrontierState(l)).toEqual({
      version: 2,
      region_memory: {},
      cached_partitions: [],
    })
  })
})

describe("buildPriorsByRegion", () => {
  it("returns top-N for each inventory region", () => {
    const s = newState()
    bumpFileInRegion(s, "src/main", "a.ts", 0.5)
    bumpFileInRegion(s, "src/main", "b.ts", 0.3)
    bumpFileInRegion(s, "src/renderer", "App.tsx", 0.7)
    const result = buildPriorsByRegion(s, ["src/main", "src/renderer", "scripts"], 5)
    expect(result["src/main"].length).toBe(2)
    expect(result["src/renderer"].length).toBe(1)
    expect(result["scripts"]).toEqual([])
  })

  it("respects topN cap", () => {
    const s = newState()
    for (let i = 0; i < 10; i++) bumpFileInRegion(s, "src", `f${i}.ts`, 0.9 - i * 0.05)
    const result = buildPriorsByRegion(s, ["src"], 3)
    expect(result["src"].length).toBe(3)
  })
})

describe("partition cache helpers", () => {
  it("addCachedPartition stores entry with id, default counters, timestamps", () => {
    const s = newState()
    const entry = addCachedPartition(s, {
      id: "abcd",
      query_pattern: "auth-related",
      workers: [{ label: "providers", scope: "contexts/Auth*" }],
      last_overlap_count: 0,
    })
    expect(entry.id).toBe("abcd")
    expect(entry.reuse_count).toBe(0)
    expect(entry.total_overlap).toBe(0)
    expect(entry.created_at).toBeTruthy()
    expect(s.cached_partitions.length).toBe(1)
  })

  it("findCachedPartition retrieves by id", () => {
    const s = newState()
    addCachedPartition(s, {
      id: "x1ab",
      query_pattern: "p",
      workers: [{ label: "w1", scope: "src" }],
      last_overlap_count: 0,
    })
    expect(findCachedPartition(s, "x1ab")?.query_pattern).toBe("p")
    expect(findCachedPartition(s, "missing")).toBeUndefined()
  })

  it("bumpReusedPartition increments reuse_count + accumulates overlap", () => {
    const s = newState()
    addCachedPartition(s, {
      id: "y2zz",
      query_pattern: "p",
      workers: [{ label: "w1", scope: "src" }],
      last_overlap_count: 0,
    })
    expect(bumpReusedPartition(s, "y2zz", 3)).toBe(true)
    expect(bumpReusedPartition(s, "y2zz", 1)).toBe(true)
    const p = findCachedPartition(s, "y2zz")
    expect(p?.reuse_count).toBe(2)
    expect(p?.total_overlap).toBe(0 + 3 + 1)
    expect(p?.last_overlap_count).toBe(1)
  })

  it("bumpReusedPartition returns false for unknown id", () => {
    expect(bumpReusedPartition(newState(), "ghost", 0)).toBe(false)
  })

  it("renderPartitionCache returns empty string when cache is cold", () => {
    expect(renderPartitionCache(newState())).toBe("")
  })

  it("renderPartitionCache produces a system-prompt block when cache has entries", () => {
    const s = newState()
    addCachedPartition(s, {
      id: "k7p9",
      query_pattern: "auth-related",
      workers: [
        { label: "providers", scope: "contexts/Auth*" },
        { label: "consumers", scope: "components/**" },
      ],
      last_overlap_count: 0,
    })
    const block = renderPartitionCache(s)
    expect(block).toContain("Cached partitions")
    expect(block).toContain("[k7p9]")
    expect(block).toContain("auth-related")
    expect(block).toContain("[reuse:XXXX]")
    expect(block).toContain("[new-partition:")
  })
})

describe("tag detection", () => {
  it("detectReuseTag finds [reuse:XXXX]", () => {
    expect(detectReuseTag("[reuse:abcd] some answer text")).toBe("abcd")
    expect(detectReuseTag("nothing tagged")).toBeNull()
    expect(detectReuseTag("prose [reuse:9X2k] mid-sentence")).toBe("9x2k")
  })

  it("detectNewPartitionTag finds [new-partition: pattern]", () => {
    expect(
      detectNewPartitionTag("[new-partition: auth flow tracing] now answering"),
    ).toBe("auth flow tracing")
    expect(detectNewPartitionTag("nothing")).toBeNull()
  })

  it("ignores tags with wrong shape", () => {
    expect(detectReuseTag("[reuse:abc]")).toBeNull() // 3 chars
    expect(detectReuseTag("[reuse: abcd]")).toBeNull() // space
  })
})

describe("beam partitioning helpers", () => {
  it("detectSelectedCandidate finds [selected:N]", () => {
    expect(detectSelectedCandidate("blah [selected:2] blah")).toBe(2)
    expect(detectSelectedCandidate("[selected: 1 ]")).toBe(1)
    expect(detectSelectedCandidate("nothing")).toBeNull()
    expect(detectSelectedCandidate("[selected:abc]")).toBeNull()
  })

  it("parseCandidates extracts CANDIDATE blocks", () => {
    const text = `
[CANDIDATE 1] split by tier
  W1: src/main
  W2: src/renderer
  Rationale: clean tier split

[CANDIDATE 2] split by feature
  W1: auth
  W2: billing
  Rationale: feature parallelism

[CANDIDATE 3] hybrid
  W1: src/main
  W2: src/renderer/components
  Rationale: balance

[selected:1]
`
    const cands = parseCandidates(text)
    expect(cands.length).toBe(3)
    expect(cands[0].index).toBe(1)
    expect(cands[0].body).toContain("split by tier")
    expect(cands[1].body).toContain("feature parallelism")
    expect(cands[2].body).toContain("balance")
  })

  it("parseCandidates handles 0 candidates gracefully", () => {
    expect(parseCandidates("just prose, no structured candidates")).toEqual([])
  })

  it("parseCandidates handles malformed but recoverable input (different spacing/casing)", () => {
    const text = `
[candidate 1] foo
  W1: x
  Rationale: a

[CANDIDATE 2] bar
  W1: y
  Rationale: b
`
    const cands = parseCandidates(text)
    expect(cands.length).toBe(2)
  })
})

describe("extractWorkerScope", () => {
  it("pulls 'YOUR REGION:' block out of a worker prompt", () => {
    const prompt =
      "User's original query (verbatim): trace auth | YOUR REGION: contexts/Auth*, lib/Neon* | OTHER WORKERS: routing, components"
    const scope = extractWorkerScope(prompt)
    expect(scope).toContain("contexts/Auth")
    expect(scope).toContain("Neon")
  })

  it("falls back to prompt prefix when no region heading found", () => {
    const prompt = "Just some text without region heading"
    expect(extractWorkerScope(prompt)).toContain("Just some text")
  })
})

describe("query/scope similarity", () => {
  it("tokenizeQuery strips stopwords + short words + lowercases", () => {
    const tokens = tokenizeQuery("How is authentication handled in this app?")
    expect(tokens.has("authentication")).toBe(true)
    expect(tokens.has("app")).toBe(true)
    expect(tokens.has("how")).toBe(false)
    expect(tokens.has("is")).toBe(false)
    expect(tokens.has("in")).toBe(false)
  })

  it("tokenizeScope splits on path separators + drops short tokens", () => {
    const tokens = tokenizeScope("apps/api backend authentication")
    expect(tokens.has("apps")).toBe(true)
    expect(tokens.has("api")).toBe(true)
    expect(tokens.has("backend")).toBe(true)
    expect(tokens.has("authentication")).toBe(true)
  })

  it("jaccardSim measures set overlap", () => {
    expect(jaccardSim(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
    expect(jaccardSim(new Set(["a"]), new Set(["b"]))).toBe(0)
    expect(jaccardSim(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3)
    expect(jaccardSim(new Set(), new Set(["a"]))).toBe(0)
  })

  it("workerScopeSimilarity matches on union of tokens across workers", () => {
    const cached = {
      id: "p1xx",
      query_pattern: "p",
      workers: [
        { label: "w1", scope: "apps/api backend" },
        { label: "w2", scope: "apps/web frontend" },
      ],
      reuse_count: 0,
      created_at: "",
      last_used: "",
      last_overlap_count: 0,
      total_overlap: 0,
    }
    const sim = workerScopeSimilarity(
      ["apps/api backend authentication", "apps/web frontend ui"],
      cached,
    )
    // Heavy overlap on apps/api/web/backend/frontend tokens.
    expect(sim).toBeGreaterThan(0.5)
  })

  it("findCachedByQuery returns highest-similarity match above threshold", () => {
    const s = newState()
    addCachedPartition(s, {
      id: "auth",
      query_pattern: "authentication providers and routing",
      workers: [{ label: "w", scope: "src" }],
      last_overlap_count: 0,
    })
    addCachedPartition(s, {
      id: "bill",
      query_pattern: "billing system trace",
      workers: [{ label: "w", scope: "src" }],
      last_overlap_count: 0,
    })
    const match = findCachedByQuery(s, "How is authentication handled in this app?", 0.1)
    expect(match?.partition.id).toBe("auth")
  })

  it("findCachedByScope returns null when nothing crosses threshold", () => {
    const s = newState()
    addCachedPartition(s, {
      id: "abcd",
      query_pattern: "p",
      workers: [{ label: "w1", scope: "totally unrelated topic" }],
      last_overlap_count: 0,
    })
    const match = findCachedByScope(s, ["apps/api backend"], 0.6)
    expect(match).toBeNull()
  })
})

describe("runAcoFrontier — wiring", () => {
  function makeMockSdk(messages: unknown[]) {
    const captured: { params?: Record<string, unknown> } = {}
    const sdkQuery = vi.fn(async function* (params: unknown) {
      captured.params = params as Record<string, unknown>
      for (const m of messages) yield m
    })
    return { sdkQuery, captured }
  }

  function makeMonorepo(): string {
    return makeRepo({
      "apps/web": "dir",
      "apps/web/index.js": "file",
      "apps/api": "dir",
      "apps/api/server.js": "file",
      "packages/shared": "dir",
      "packages/shared/util.ts": "file",
    })
  }

  function makeStream(
    workerCites: { id: string; cites: string[]; promptPrefix?: string }[],
    openingText?: string,
  ): unknown[] {
    const messages: unknown[] = [
      { type: "system", subtype: "init", session_id: "h-sess" },
    ]
    if (openingText) {
      messages.push({
        type: "assistant",
        message: { content: [{ type: "text", text: openingText }] },
      })
    }
    messages.push({
      type: "assistant",
      message: {
        content: workerCites.map((w) => ({
          type: "tool_use",
          name: "Task",
          id: w.id,
          input: {
            subagent_type: "PartitionWorker",
            prompt:
              w.promptPrefix ??
              `User's original query (verbatim): test | YOUR REGION: ${w.cites.join(", ")}`,
          },
        })),
      },
    })
    messages.push({
      type: "user",
      message: {
        role: "user",
        content: workerCites.map((w) => ({
          type: "tool_result",
          tool_use_id: w.id,
          content: `Findings:\n${w.cites.map((c, i) => `- ${c}:${i + 1}: cite`).join("\n")}`,
        })),
      },
    })
    return messages
  }

  it("system prompt mentions hybrid + per-region priors", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk(
      makeStream([{ id: "w1", cites: ["apps/web/index.js"] }]),
    )
    await runAcoFrontier("trace", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const append = (
      captured.params as { options: { systemPrompt: { append: string } } }
    ).options.systemPrompt.append
    expect(append).toContain("Stigmergic Frontier protocol")
    expect(append).toContain("per-region priors")
    expect(append).toContain("apps/web")
  })

  it("bumps per-region pheromones based on worker file_touched + region attribution", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream([
        { id: "w1", cites: ["apps/web/index.js", "apps/web/main.js"] },
        { id: "w2", cites: ["packages/shared/util.ts"] },
      ]),
    )
    await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const state = loadAcoFrontierState(loadLedger(root))
    expect(state.region_memory["apps/web"]?.files["apps/web/index.js"]).toBeDefined()
    expect(state.region_memory["apps/web"]?.files["apps/web/main.js"]).toBeDefined()
    expect(state.region_memory["packages/shared"]?.files["packages/shared/util.ts"]).toBeDefined()
    expect(state.region_memory["apps/web"]?.files["packages/shared/util.ts"]).toBeUndefined()
  })

  it("compounds pheromones across multiple sessions", async () => {
    const root = makeMonorepo()
    {
      const { sdkQuery } = makeMockSdk(
        makeStream([{ id: "w1", cites: ["apps/web/index.js"] }]),
      )
      await runAcoFrontier("q1", {
        cwd: root,
        sdkQuery,
        pathToClaudeCodeExecutable: "/fake/claude",
      })
    }
    {
      const { sdkQuery } = makeMockSdk(
        makeStream([{ id: "w1", cites: ["apps/web/index.js"] }]),
      )
      await runAcoFrontier("q2", {
        cwd: root,
        sdkQuery,
        pathToClaudeCodeExecutable: "/fake/claude",
      })
    }
    const state = loadAcoFrontierState(loadLedger(root))
    const e = state.region_memory["apps/web"]?.files["apps/web/index.js"]
    expect(e?.hits).toBe(2)
  })

  it("creates a new cached partition when Opus emits [new-partition: ...]", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          {
            id: "w1",
            cites: ["apps/api/server.js"],
            promptPrefix:
              "User's original query (verbatim): trace auth | YOUR REGION: apps/api backend",
          },
          {
            id: "w2",
            cites: ["apps/web/index.js"],
            promptPrefix:
              "User's original query (verbatim): trace auth | YOUR REGION: apps/web frontend",
          },
        ],
        "[new-partition: backend-vs-frontend split] partitioning the codebase by tier...",
      ),
    )
    const result = await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoFrontierStats.cache_action).toBe("created")
    expect(result.acoFrontierStats.cache_size).toBe(1)

    const state = loadAcoFrontierState(loadLedger(root))
    expect(state.cached_partitions.length).toBe(1)
    const cached = state.cached_partitions[0]
    expect(cached.query_pattern).toBe("backend-vs-frontend split")
    expect(cached.workers.length).toBe(2)
    expect(cached.workers[0].scope).toContain("apps/api")
  })

  it("reuses a cached partition when Opus emits [reuse:XXXX]", async () => {
    const root = makeMonorepo()
    const ledger = loadLedger(root)
    const seed: AcoFrontierState = {
      version: 2,
      region_memory: {},
      cached_partitions: [
        {
          id: "k7p9",
          query_pattern: "auth-related",
          workers: [{ label: "providers", scope: "contexts/Auth*" }],
          reuse_count: 0,
          created_at: "2026-04-28T00:00:00Z",
          last_used: "2026-04-28T00:00:00Z",
          last_overlap_count: 0,
          total_overlap: 0,
        },
      ],
    }
    setAlgorithmState(ledger, "aco-frontier", seed)
    saveLedger(ledger)

    const { sdkQuery } = makeMockSdk(
      makeStream(
        [{ id: "w1", cites: ["apps/web/index.js"] }],
        "[reuse:k7p9] reusing the auth-related partition...",
      ),
    )
    const result = await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoFrontierStats.cache_action).toBe("reused")
    expect(result.acoFrontierStats.cache_action_id).toBe("k7p9")

    const state = loadAcoFrontierState(loadLedger(root))
    const cached = findCachedPartition(state, "k7p9")
    expect(cached?.reuse_count).toBe(1)
  })

  it("captures beam candidates + selection from Opus's text", async () => {
    const root = makeMonorepo()
    const opusOpening = `
I'll consider three partition shapes for this query.

[CANDIDATE 1] split by tier (main vs renderer vs preload)
  W1: src/main
  W2: src/renderer
  Rationale: clean architectural cut

[CANDIDATE 2] split by feature (auth vs billing vs misc)
  W1: auth-related
  W2: billing-related
  Rationale: feature isolation, but feature scopes may bleed

[CANDIDATE 3] hybrid (main + renderer/components vs renderer/lib)
  W1: src/main + components
  W2: src/renderer/lib
  Rationale: pragmatic mix

[selected:1] going with the tier split — cleanest disjoint coverage.

[new-partition: tier split (main vs renderer)]
`
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          {
            id: "w1",
            cites: ["apps/web/index.js"],
            promptPrefix:
              "User's original query (verbatim): test | YOUR REGION: src/main",
          },
          {
            id: "w2",
            cites: ["apps/api/server.js"],
            promptPrefix:
              "User's original query (verbatim): test | YOUR REGION: src/renderer",
          },
        ],
        opusOpening,
      ),
    )
    const result = await runAcoFrontier("trace tiers", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoFrontierStats.beam_candidates_emitted).toBe(3)
    expect(result.acoFrontierStats.beam_selected_candidate).toBe(1)
    // Cache should still have created an entry (the workers were dispatched).
    expect(result.acoFrontierStats.cache_action).toBe("created")
  })

  it("records 0 candidates when Opus skips beam thinking", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [{ id: "w1", cites: ["apps/web/index.js"] }],
        "I'll just dispatch workers without listing candidates.",
      ),
    )
    const result = await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoFrontierStats.beam_candidates_emitted).toBe(0)
    expect(result.acoFrontierStats.beam_selected_candidate).toBeNull()
  })

  it("auto-creates a cached partition when Opus skips tagging but dispatches workers", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          {
            id: "w1",
            cites: ["apps/api/server.js"],
            promptPrefix:
              "User's original query (verbatim): trace billing flow | YOUR REGION: apps/api backend",
          },
          {
            id: "w2",
            cites: ["apps/web/index.js"],
            promptPrefix:
              "User's original query (verbatim): trace billing flow | YOUR REGION: apps/web frontend",
          },
        ],
        "Just answering without tagging anything.",
      ),
    )
    const result = await runAcoFrontier("trace billing flow", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    // Auto-created from the untagged session.
    expect(result.acoFrontierStats.cache_action).toBe("created")
    expect(result.acoFrontierStats.cache_size).toBe(1)
    const state = loadAcoFrontierState(loadLedger(root))
    // Pattern uses the user's query verbatim (truncated).
    expect(state.cached_partitions[0].query_pattern).toContain("trace billing flow")
    expect(state.cached_partitions[0].workers.length).toBe(2)
  })

  it("untagged when no PartitionWorkers were dispatched", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "I'll just answer directly." }] },
      },
    ])
    const result = await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    // No workers, nothing to cache.
    expect(result.acoFrontierStats.cache_action).toBe("untagged")
    expect(result.acoFrontierStats.cache_size).toBe(0)
  })

  it("auto-reuses a cached partition when current worker scopes match an existing one", async () => {
    const root = makeMonorepo()
    // Pre-seed a cached partition matching the scope shape we'll dispatch.
    const ledger = loadLedger(root)
    const seed: AcoFrontierState = {
      version: 2,
      region_memory: {},
      cached_partitions: [
        {
          id: "abcd",
          query_pattern: "auth-related: providers/routing/consumers",
          workers: [
            { label: "providers", scope: "apps/api backend authentication" },
            { label: "frontend", scope: "apps/web frontend ui" },
          ],
          reuse_count: 0,
          created_at: "2026-04-28T00:00:00Z",
          last_used: "2026-04-28T00:00:00Z",
          last_overlap_count: 0,
          total_overlap: 0,
        },
      ],
    }
    setAlgorithmState(ledger, "aco-frontier", seed)
    saveLedger(ledger)

    // Dispatch workers with the same scope shape (no explicit reuse tag).
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          {
            id: "w1",
            cites: ["apps/api/server.js"],
            promptPrefix:
              "User's original query (verbatim): how does the api work | YOUR REGION: apps/api backend authentication",
          },
          {
            id: "w2",
            cites: ["apps/web/index.js"],
            promptPrefix:
              "User's original query (verbatim): how does the api work | YOUR REGION: apps/web frontend ui",
          },
        ],
        "Looking into this question without tags.",
      ),
    )
    const result = await runAcoFrontier("how does the api work", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    // Auto-reuse fires because scope similarity > 0.6.
    expect(result.acoFrontierStats.cache_action).toBe("reused")
    expect(result.acoFrontierStats.cache_action_id).toBe("abcd")

    const state = loadAcoFrontierState(loadLedger(root))
    expect(findCachedPartition(state, "abcd")?.reuse_count).toBe(1)
  })

  it("computes overlap from observed PartitionWorker delegations", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream([
        { id: "w1", cites: ["shared.ts", "apps/web/x.ts"] },
        { id: "w2", cites: ["shared.ts", "apps/api/y.ts"] },
      ]),
    )
    const result = await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoFrontierStats.overlap_count).toBe(1)
    expect(result.acoFrontierStats.overlap_files).toEqual(["shared.ts"])
  })

  it("denies off-allowlist subagent_type", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    await runAcoFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const canUseTool = (
      captured.params as {
        options: {
          canUseTool: (
            n: string,
            i: Record<string, unknown>,
          ) => Promise<{ behavior: string }>
        }
      }
    ).options.canUseTool
    expect(
      (await canUseTool("Task", { subagent_type: "Voter" })).behavior,
    ).toBe("deny")
    expect(
      (await canUseTool("Task", { subagent_type: "PartitionWorker" })).behavior,
    ).toBe("allow")
  })
})

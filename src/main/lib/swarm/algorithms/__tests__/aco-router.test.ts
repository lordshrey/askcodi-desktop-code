/**
 * ACO/Frontier router tests. Verify routing tag detection, inferred
 * routing from delegation counts, system-prompt wiring, and end-to-end
 * routing across explore/partition/mixed shapes.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  detectRouteTag,
  inferRoutingFromCounts,
  runAcoRouter,
} from "../aco-router"
import { loadAcoFrontierState } from "../aco-frontier"
import { loadLedger } from "../../ledger"

const tempRoots: string[] = []
function makeRepo(layout: Record<string, "dir" | "file">): string {
  const root = mkdtempSync(join(tmpdir(), "aco-router-test-"))
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

function makeMockSdk(messages: unknown[]) {
  const captured: { params?: Record<string, unknown> } = {}
  const sdkQuery = vi.fn(async function* (params: unknown) {
    captured.params = params as Record<string, unknown>
    for (const m of messages) yield m
  })
  return { sdkQuery, captured }
}

/** Build a stream simulating a delegation pattern. */
function makeStream(
  delegations: { id: string; subagent: string; cites: string[]; promptPrefix?: string }[],
  openingText?: string,
): unknown[] {
  const messages: unknown[] = [
    { type: "system", subtype: "init", session_id: "router-sess" },
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
      content: delegations.map((d) => ({
        type: "tool_use",
        name: "Task",
        id: d.id,
        input: {
          subagent_type: d.subagent,
          prompt:
            d.promptPrefix ??
            `User's original query (verbatim): test | YOUR REGION: ${d.cites.join(", ")}`,
        },
      })),
    },
  })
  messages.push({
    type: "user",
    message: {
      role: "user",
      content: delegations.map((d) => ({
        type: "tool_result",
        tool_use_id: d.id,
        content: `Findings:\n${d.cites.map((c, i) => `- ${c}:${i + 1}: cite`).join("\n")}`,
      })),
    },
  })
  return messages
}

describe("detectRouteTag", () => {
  it("detects [route:explore]", () => {
    expect(detectRouteTag("[route:explore] answer follows")).toBe("explore")
  })

  it("detects [route:partition]", () => {
    expect(detectRouteTag("Reading [route:partition] now spawning workers")).toBe(
      "partition",
    )
  })

  it("detects [route:mixed]", () => {
    expect(detectRouteTag("[route:mixed] I'll use both")).toBe("mixed")
  })

  it("returns null on missing tag", () => {
    expect(detectRouteTag("nothing tagged here")).toBeNull()
  })

  it("is case-insensitive", () => {
    expect(detectRouteTag("[Route:Explore]")).toBe("explore")
  })

  it("ignores invalid route values", () => {
    expect(detectRouteTag("[route:something]")).toBeNull()
  })
})

describe("inferRoutingFromCounts", () => {
  it("explore-only → explore", () => {
    expect(inferRoutingFromCounts(1, 0)).toBe("explore")
    expect(inferRoutingFromCounts(3, 0)).toBe("explore")
  })

  it("partition-only → partition", () => {
    expect(inferRoutingFromCounts(0, 3)).toBe("partition")
  })

  it("both → mixed", () => {
    expect(inferRoutingFromCounts(1, 2)).toBe("mixed")
  })

  it("none → none", () => {
    expect(inferRoutingFromCounts(0, 0)).toBe("none")
  })
})

describe("runAcoRouter", () => {
  it("registers Explore + PartitionWorker + Synthesizer agents", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk(
      makeStream([
        { id: "w1", subagent: "Explore", cites: ["apps/web/index.js"] },
      ]),
    )
    await runAcoRouter("show me x", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const params = captured.params as {
      options: { agents: Record<string, unknown>; systemPrompt: { append: string } }
    }
    expect(Object.keys(params.options.agents).sort()).toEqual([
      "Explore",
      "PartitionWorker",
      "Synthesizer",
    ])
    expect(params.options.systemPrompt.append).toContain("Adaptive Swarm protocol")
    expect(params.options.systemPrompt.append).toContain("Routing decision")
  })

  it("explore-only delegation → routing_decision='explore', files bumped to global ledger", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          { id: "e1", subagent: "Explore", cites: ["apps/web/index.js"] },
        ],
        "[route:explore] reading the file directly",
      ),
    )
    const result = await runAcoRouter("show me apps/web", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoRouterStats.routing_decision).toBe("explore")
    expect(result.acoRouterStats.routing_explicit).toBe(true)
    expect(result.acoRouterStats.explore_count).toBe(1)
    expect(result.acoRouterStats.partition_worker_count).toBe(0)
    // Cache untouched on explore-only.
    expect(result.acoRouterStats.cache_action).toBe("untagged")
    expect(result.acoRouterStats.cache_size).toBe(0)
  })

  it("partition delegation → bumps per-region pheromones + caches partition", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          { id: "w1", subagent: "PartitionWorker", cites: ["apps/web/index.js"] },
          { id: "w2", subagent: "PartitionWorker", cites: ["apps/api/server.js"] },
        ],
        "[route:partition] [new-partition: web vs api split] partitioning by tier",
      ),
    )
    const result = await runAcoRouter("trace the tiers", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoRouterStats.routing_decision).toBe("partition")
    expect(result.acoRouterStats.partition_worker_count).toBe(2)
    expect(result.acoRouterStats.cache_action).toBe("created")

    const state = loadAcoFrontierState(loadLedger(root))
    expect(state.region_memory["apps/web"]?.files["apps/web/index.js"]).toBeDefined()
    expect(state.region_memory["apps/api"]?.files["apps/api/server.js"]).toBeDefined()
    expect(state.cached_partitions.length).toBe(1)
  })

  it("mixed delegation (Explore + PartitionWorker) → routing_decision='mixed'", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          { id: "e1", subagent: "Explore", cites: ["apps/web/index.js"] },
          { id: "w1", subagent: "PartitionWorker", cites: ["apps/api/server.js"] },
          { id: "w2", subagent: "PartitionWorker", cites: ["packages/shared/util.ts"] },
        ],
        "[route:mixed] using both for this query",
      ),
    )
    const result = await runAcoRouter("complex query", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoRouterStats.routing_decision).toBe("mixed")
    expect(result.acoRouterStats.explore_count).toBe(1)
    expect(result.acoRouterStats.partition_worker_count).toBe(2)
  })

  it("untagged routing → inferred from delegation counts", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          { id: "w1", subagent: "PartitionWorker", cites: ["apps/web/index.js"] },
          { id: "w2", subagent: "PartitionWorker", cites: ["apps/api/server.js"] },
        ],
        "Just answering, no route tag.",
      ),
    )
    const result = await runAcoRouter("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoRouterStats.routing_decision).toBe("partition")
    expect(result.acoRouterStats.routing_explicit).toBe(false)
  })

  it("denies off-allowlist subagent_type", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    await runAcoRouter("q", {
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
    expect((await canUseTool("Task", { subagent_type: "Voter" })).behavior).toBe(
      "deny",
    )
    expect((await canUseTool("Task", { subagent_type: "Explore" })).behavior).toBe(
      "allow",
    )
    expect(
      (await canUseTool("Task", { subagent_type: "PartitionWorker" })).behavior,
    ).toBe("allow")
  })

  it("system prompt includes per-region priors + cache block + routing rule", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk(
      makeStream([
        { id: "e1", subagent: "Explore", cites: ["apps/web/index.js"] },
      ]),
    )
    await runAcoRouter("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const append = (
      captured.params as { options: { systemPrompt: { append: string } } }
    ).options.systemPrompt.append
    expect(append).toContain("Adaptive Swarm protocol")
    expect(append).toContain("Codebase inventory + per-region priors")
    expect(append).toContain("Narrow / single-area / specific")
    expect(append).toContain("Broad / cross-cutting / spans regions")
    expect(append).toContain("[route:explore]")
    expect(append).toContain("[route:partition]")
    // Cache section is empty on cold start.
    expect(append).toContain("apps/web")
  })

  it("captures beam candidates + selection on the partition path", async () => {
    const root = makeMonorepo()
    const opening = `[route:partition]

[CANDIDATE 1] tier split
  W1: apps/api
  W2: apps/web
  Rationale: clean tiers

[CANDIDATE 2] feature split
  W1: auth
  W2: billing
  Rationale: feature parallel

[CANDIDATE 3] hybrid
  W1: apps/api auth
  W2: apps/web ui
  Rationale: mixed

[selected:1]`
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [
          {
            id: "w1",
            subagent: "PartitionWorker",
            cites: ["apps/api/server.js"],
            promptPrefix:
              "User's original query (verbatim): trace tiers | YOUR REGION: apps/api",
          },
          {
            id: "w2",
            subagent: "PartitionWorker",
            cites: ["apps/web/index.js"],
            promptPrefix:
              "User's original query (verbatim): trace tiers | YOUR REGION: apps/web",
          },
        ],
        opening,
      ),
    )
    const result = await runAcoRouter("trace tiers", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoRouterStats.routing_decision).toBe("partition")
    expect(result.acoRouterStats.beam_candidates_emitted).toBe(3)
    expect(result.acoRouterStats.beam_selected_candidate).toBe(1)
  })

  it("beam stats are 0/null when route=explore", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeStream(
        [{ id: "e1", subagent: "Explore", cites: ["apps/web/index.js"] }],
        "[route:explore] reading directly",
      ),
    )
    const result = await runAcoRouter("show me x", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.acoRouterStats.routing_decision).toBe("explore")
    expect(result.acoRouterStats.beam_candidates_emitted).toBe(0)
    expect(result.acoRouterStats.beam_selected_candidate).toBeNull()
  })

  it("compounds across sessions: two partition cells grow region_memory", async () => {
    const root = makeMonorepo()
    {
      const { sdkQuery } = makeMockSdk(
        makeStream(
          [
            { id: "w1", subagent: "PartitionWorker", cites: ["apps/web/index.js"] },
          ],
          "[route:partition]",
        ),
      )
      await runAcoRouter("q1", {
        cwd: root,
        sdkQuery,
        pathToClaudeCodeExecutable: "/fake/claude",
      })
    }
    {
      const { sdkQuery } = makeMockSdk(
        makeStream(
          [
            { id: "w1", subagent: "PartitionWorker", cites: ["apps/web/index.js"] },
          ],
          "[route:partition]",
        ),
      )
      await runAcoRouter("q2", {
        cwd: root,
        sdkQuery,
        pathToClaudeCodeExecutable: "/fake/claude",
      })
    }
    const state = loadAcoFrontierState(loadLedger(root))
    expect(state.region_memory["apps/web"]?.files["apps/web/index.js"]?.hits).toBe(2)
  })
})

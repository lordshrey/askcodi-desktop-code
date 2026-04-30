/**
 * Frontier tests, post-Opus-decides-partition refactor. Three concerns:
 *   - listPartitionableDirs (monorepo-aware enumeration) — pure, on disk
 *   - computeOverlap — pure helper for measuring partition cleanliness
 *   - runFrontier — wiring (agents, system prompt with inventory) and
 *     overlap measurement on observed PartitionWorker delegations
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  computeOverlap,
  listPartitionableDirs,
  runFrontier,
} from "../frontier"
import { loadLedger } from "../../ledger"

const tempRoots: string[] = []
function makeRepo(layout: Record<string, "dir" | "file">): string {
  const root = mkdtempSync(join(tmpdir(), "frontier-test-"))
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

describe("listPartitionableDirs", () => {
  it("returns top-level dirs unchanged for a flat repo", () => {
    const root = makeRepo({
      src: "dir",
      "src/App.js": "file",
      tests: "dir",
      "tests/app.test.js": "file",
      "package.json": "file",
    })
    expect(listPartitionableDirs(root)).toEqual(["src", "tests"])
  })

  it("descends into named container dirs (apps/, packages/)", () => {
    const root = makeRepo({
      "apps/web": "dir",
      "apps/web/index.js": "file",
      "apps/api": "dir",
      "apps/api/server.js": "file",
      "packages/shared": "dir",
      "packages/shared/util.ts": "file",
      "packages/ui": "dir",
      "packages/ui/index.ts": "file",
    })
    expect(listPartitionableDirs(root)).toEqual([
      "apps/api",
      "apps/web",
      "packages/shared",
      "packages/ui",
    ])
  })

  it("descends into unnamed dirs that are mostly subdirs (≥80% rule)", () => {
    const root = makeRepo({
      "modules-custom/m1": "dir",
      "modules-custom/m2": "dir",
      "modules-custom/m3": "dir",
    })
    expect(listPartitionableDirs(root)).toEqual([
      "modules-custom/m1",
      "modules-custom/m2",
      "modules-custom/m3",
    ])
  })

  it("does NOT descend into a regular source dir even with subdirs", () => {
    const root = makeRepo({
      src: "dir",
      "src/App.js": "file",
      "src/util.js": "file",
      "src/components": "dir",
    })
    expect(listPartitionableDirs(root)).toEqual(["src"])
  })

  it("respects maxDepth=1 (legacy flat behavior)", () => {
    const root = makeRepo({
      "apps/web": "dir",
      "apps/api": "dir",
      src: "dir",
      "src/a.js": "file",
    })
    expect(listPartitionableDirs(root, { maxDepth: 1 })).toEqual(["apps", "src"])
  })

  it("returns empty for non-existent path without throwing", () => {
    expect(listPartitionableDirs("/tmp/this-path-does-not-exist-xyz")).toEqual(
      [],
    )
  })

  it("supports user-supplied container names", () => {
    const root = makeRepo({
      "myrepos/a": "dir",
      "myrepos/b": "dir",
      "myrepos/a/main.go": "file",
      "myrepos/b/main.go": "file",
    })
    const got = listPartitionableDirs(root, {
      containerNames: new Set(["myrepos"]),
    })
    expect(got).toEqual(["myrepos/a", "myrepos/b"])
  })
})

describe("computeOverlap", () => {
  it("identifies files touched by ≥2 workers", () => {
    const overlap = computeOverlap([
      new Set(["a", "b"]),
      new Set(["b", "c"]),
      new Set(["c", "d"]),
    ])
    expect(overlap.count).toBe(2)
    expect(overlap.files).toEqual(["b", "c"])
  })

  it("returns 0 overlap when partitions are disjoint", () => {
    expect(
      computeOverlap([new Set(["a", "b"]), new Set(["c", "d"])]),
    ).toEqual({ count: 0, files: [] })
  })

  it("counts a file as overlap once even when ≥3 workers cite it", () => {
    expect(
      computeOverlap([new Set(["x"]), new Set(["x"]), new Set(["x"])]),
    ).toEqual({ count: 1, files: ["x"] })
  })

  it("handles empty input", () => {
    expect(computeOverlap([])).toEqual({ count: 0, files: [] })
  })
})

describe("runFrontier", () => {
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

  /** Stream simulating Opus dispatching N PartitionWorkers in one turn. */
  function makeWorkerStream(
    workerCites: { id: string; cites: string[] }[],
  ): unknown[] {
    return [
      { type: "system", subtype: "init", session_id: "frontier-sess" },
      {
        type: "assistant",
        message: {
          content: workerCites.map((w) => ({
            type: "tool_use",
            name: "Task",
            id: w.id,
            input: {
              subagent_type: "PartitionWorker",
              prompt: "investigate region X",
            },
          })),
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: workerCites.map((w) => ({
            type: "tool_result",
            tool_use_id: w.id,
            content: `Findings:\n${w.cites.map((c, i) => `- ${c}:${i + 1}: cite`).join("\n")}`,
          })),
        },
      },
    ]
  }

  it("registers PartitionWorker + Synthesizer + system prompt with inventory", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk(
      makeWorkerStream([
        { id: "w1", cites: ["apps/api/server.js"] },
        { id: "w2", cites: ["apps/web/index.js"] },
      ]),
    )
    await runFrontier("trace flow", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const params = captured.params as {
      options: { agents: Record<string, unknown>; systemPrompt: { append: string } }
    }
    expect(Object.keys(params.options.agents).sort()).toEqual([
      "PartitionWorker",
      "Synthesizer",
    ])
    const append = params.options.systemPrompt.append
    expect(append).toContain("Frontier-discounting protocol")
    // Inventory section must list the dirs Opus can partition over.
    expect(append).toContain("Codebase inventory")
    expect(append).toContain("apps/api")
    expect(append).toContain("apps/web")
    expect(append).toContain("packages/shared")
    // Imperative phase structure.
    expect(append).toContain("Phase 1")
    expect(append).toContain("Phase 2")
    expect(append).toContain("Stay in YOUR region")
    // Algorithm should NOT pre-decide the partition — Opus does that.
    expect(append).not.toMatch(/Worker 1: \[apps\/api\]/)
  })

  it("captures inventory in stats regardless of how many workers Opus spawned", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeWorkerStream([
        { id: "w1", cites: ["apps/api/server.js"] },
      ]),
    )
    const result = await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.frontierStats.inventory).toEqual([
      "apps/api",
      "apps/web",
      "packages/shared",
    ])
    expect(result.frontierStats.worker_dispatched).toBe(1)
  })

  it("computes overlap from observed PartitionWorker delegations", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeWorkerStream([
        { id: "w1", cites: ["apps/web/shared.ts", "apps/web/index.js"] },
        { id: "w2", cites: ["apps/web/shared.ts", "apps/api/server.js"] },
        { id: "w3", cites: ["packages/shared/util.ts"] },
      ]),
    )
    const result = await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.frontierStats.overlap_count).toBe(1)
    expect(result.frontierStats.overlap_files).toEqual(["apps/web/shared.ts"])
    expect(result.frontierStats.worker_dispatched).toBe(3)
  })

  it("respects test-injected listPartitionableDirs override (inventory shape)", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      listPartitionableDirs: () => ["only-this-dir"],
    })
    const append = (
      captured.params as { options: { systemPrompt: { append: string } } }
    ).options.systemPrompt.append
    expect(append).toContain("only-this-dir")
  })

  it("when Opus doesn't dispatch workers, worker_dispatched=0 and overlap=0", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
      // Opus's lone assistant message — no delegations, just text.
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I'll answer directly." }],
        },
      },
    ])
    const result = await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.frontierStats.worker_dispatched).toBe(0)
    expect(result.frontierStats.overlap_count).toBe(0)
  })

  it("flags any_minion_failed when a worker fails", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "w1",
              input: { subagent_type: "PartitionWorker", prompt: "" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "w1",
              content: "MINION_FAILED: empty region",
            },
          ],
        },
      },
    ])
    const result = await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.frontierStats.any_minion_failed).toBe(true)
  })

  it("denies off-allowlist subagent_type", async () => {
    const root = makeMonorepo()
    const { sdkQuery, captured } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    await runFrontier("q", {
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
      (await canUseTool("Task", { subagent_type: "Editor" })).behavior,
    ).toBe("deny")
    expect(
      (await canUseTool("Task", { subagent_type: "PartitionWorker" })).behavior,
    ).toBe("allow")
  })

  it("persists ledger with PartitionWorker attribution + inventory in algorithm_state", async () => {
    const root = makeMonorepo()
    const { sdkQuery } = makeMockSdk(
      makeWorkerStream([
        { id: "w1", cites: ["apps/api/server.js"] },
        { id: "w2", cites: ["apps/web/index.js"] },
      ]),
    )
    await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const onDisk = loadLedger(root)
    expect(onDisk.delegations.length).toBe(2)
    expect(onDisk.files["apps/api/server.js"]?.last_subagent).toBe(
      "PartitionWorker",
    )
    const fState = onDisk.algorithm_state.frontier as {
      last_inventory: string[]
      last_worker_dispatched: number
    }
    expect(fState.last_worker_dispatched).toBe(2)
    expect(fState.last_inventory).toContain("apps/api")
  })

  it("handles single-partition codebase (Opus may pick 1 worker or 0)", async () => {
    const root = makeRepo({ src: "dir", "src/a.js": "file" })
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    const result = await runFrontier("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.frontierStats.inventory).toEqual(["src"])
  })
})

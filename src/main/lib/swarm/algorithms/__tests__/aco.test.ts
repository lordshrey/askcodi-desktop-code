/**
 * ACO algorithm tests, post-orchestrator-refactor. ACO is now a thin
 * wrapper: load ledger → priors block → runOpusOrchestrated. We mock
 * the SDK to verify wiring (Explore registered, system prompt contains
 * priors) and ledger persistence (priorities bump, session counts).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runAco } from "../aco"
import { ledgerPath, loadLedger } from "../../ledger"

const tempDirs: string[] = []
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aco-orch-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

/** Build a fake SDK stream where the parent issues one Task(Explore) delegation that returns cited files. */
function makeFakeExploreSdk(citedPaths: string[]) {
  const messages: unknown[] = [
    { type: "system", subtype: "init", session_id: "test-session" },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        usage: { input_tokens: 5, output_tokens: 2 },
        content: [
          {
            type: "tool_use",
            name: "Task",
            id: "toolu_explore_1",
            input: { subagent_type: "Explore", prompt: "find auth-related code" },
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
            tool_use_id: "toolu_explore_1",
            content: citedPaths
              .map((p, i) => `${p}:${i + 1}: cited line`)
              .join("\n"),
          },
        ],
      },
    },
  ]
  const captured: { params?: Record<string, unknown> } = {}
  const sdkQuery = vi.fn(async function* (params: unknown) {
    captured.params = params as Record<string, unknown>
    for (const m of messages) yield m
  })
  return { sdkQuery, captured }
}

describe("runAco", () => {
  it("creates a fresh ledger on cold start and bumps cited files via Explore delegation", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeFakeExploreSdk(["src/a.ts", "src/b.ts"])

    const result = await runAco("find auth", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    expect(result.acoStats.warm_start).toBe(false)
    expect(result.acoStats.files_at_start).toBe(0)
    expect(result.acoStats.files_bumped).toBe(2)
    expect(result.acoStats.delegation_count).toBe(1)
    expect(result.acoStats.delegations_by_subagent).toEqual({ Explore: 1 })
    expect(result.acoStats.priors_injected).toBe(false)

    const onDisk = loadLedger(root)
    expect(onDisk.session_count).toBe(1)
    expect(onDisk.files["src/a.ts"]?.last_subagent).toBe("Explore")
    expect(onDisk.files["src/b.ts"]).toBeDefined()
    expect(onDisk.delegations.length).toBe(1)
    expect(onDisk.delegations[0].subagent_type).toBe("Explore")

    // SDK should have been called with Explore agent registered + ACO guidance.
    const params = captured.params as {
      options: {
        agents: Record<string, { prompt: string }>
        systemPrompt: { append: string }
      }
    }
    expect(params.options.agents.Explore).toBeDefined()
    expect(params.options.systemPrompt.append).toContain("ACO")
    expect(params.options.systemPrompt.append).toContain("Explore")
  })

  it("injects priors block into system prompt on warm start", async () => {
    const root = makeTempProject()
    // Cold session 1 — seed memory.
    const sdk1 = makeFakeExploreSdk(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
    await runAco("seed", {
      cwd: root,
      sdkQuery: sdk1.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    // Warm session 2 — priors should be injected.
    const sdk2 = makeFakeExploreSdk(["src/a.ts"])
    const result = await runAco("warm query", {
      cwd: root,
      sdkQuery: sdk2.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    expect(result.acoStats.warm_start).toBe(true)
    expect(result.acoStats.priors_injected).toBe(true)
    expect(result.acoStats.priors_paths.length).toBeGreaterThanOrEqual(3)

    const params = sdk2.captured.params as {
      options: { systemPrompt: { append: string } }
    }
    expect(params.options.systemPrompt.append).toContain("Codebase priors")
    expect(params.options.systemPrompt.append).toContain("src/a.ts")
  })

  it("decays priorities each session even without touched files", async () => {
    const root = makeTempProject()
    const sdk = makeFakeExploreSdk(["src/a.ts"])
    await runAco("first", {
      cwd: root,
      sdkQuery: sdk.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    let mem = loadLedger(root)
    expect(mem.files["src/a.ts"].priority).toBeCloseTo(0.15)

    const emptySdk = makeFakeExploreSdk([])
    await runAco("no-touch", {
      cwd: root,
      sdkQuery: emptySdk.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    mem = loadLedger(root)
    // Priority should decay by default 0.95 between sessions.
    expect(mem.files["src/a.ts"]?.priority).toBeCloseTo(0.15 * 0.95)
  })

  it("forwards onMessage callbacks for every streamed message", async () => {
    const root = makeTempProject()
    const { sdkQuery } = makeFakeExploreSdk(["src/a.ts"])
    const seen: unknown[] = []
    await runAco("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      onMessage: (m) => seen.push(m),
    })
    expect(seen.length).toBe(3) // system/init + assistant + user
  })

  it("appends user-supplied systemPromptAppend BEFORE priors + ACO guidance", async () => {
    const root = makeTempProject()
    // Seed enough real-looking paths to clear minFiles=3 priors threshold.
    const seed = makeFakeExploreSdk(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
    await runAco("seed", {
      cwd: root,
      sdkQuery: seed.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    const { sdkQuery, captured } = makeFakeExploreSdk(["src/a.ts"])
    await runAco("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      systemPromptAppend: "USER_BASE_POLICY",
    })

    const append = (
      captured.params as { options: { systemPrompt: { append: string } } }
    ).options.systemPrompt.append
    expect(append.indexOf("USER_BASE_POLICY")).toBeLessThan(
      append.indexOf("Codebase priors"),
    )
    expect(append.indexOf("Codebase priors")).toBeLessThan(
      append.indexOf("Subagent routing policy"),
    )
  })

  it("persists ledger to disk in the standard location", async () => {
    const root = makeTempProject()
    const { sdkQuery } = makeFakeExploreSdk(["src/a.ts"])
    await runAco("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(existsSync(ledgerPath(root))).toBe(true)
    const raw = JSON.parse(readFileSync(ledgerPath(root), "utf-8"))
    expect(raw.session_count).toBe(1)
    expect(raw.delegations.length).toBe(1)
  })
})

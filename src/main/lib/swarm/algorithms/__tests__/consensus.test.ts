/**
 * Consensus tests, post-orchestrator-refactor. Verifies the Voter/
 * Synthesizer registration, parallel-voting prompt content, and the
 * vote-tally aggregation on observed delegations.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runConsensus, tallyVotes } from "../consensus"
import { loadLedger } from "../../ledger"

const tempDirs: string[] = []
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "consensus-test-"))
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

/** Stream of 3 parallel Voters in one turn citing overlapping files. */
function makeThreeVotersStream(citesPerVoter: string[][]) {
  return [
    { type: "system", subtype: "init", session_id: "consensus-sess" },
    {
      type: "assistant",
      message: {
        content: citesPerVoter.map((_, i) => ({
          type: "tool_use",
          name: "Task",
          id: `voter_${i + 1}`,
          input: { subagent_type: "Voter", prompt: "the question" },
        })),
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: citesPerVoter.map((cites, i) => ({
          type: "tool_result",
          tool_use_id: `voter_${i + 1}`,
          content: `Findings:\n${cites.map((c, j) => `- ${c}:${j + 1}: cite`).join("\n")}`,
        })),
      },
    },
  ]
}

function makeMockSdk(messages: unknown[]) {
  const captured: { params?: Record<string, unknown> } = {}
  const sdkQuery = vi.fn(async function* (params: unknown) {
    captured.params = params as Record<string, unknown>
    for (const m of messages) yield m
  })
  return { sdkQuery, captured }
}

describe("tallyVotes", () => {
  it("counts file frequency across voters", () => {
    const votes = tallyVotes([
      new Set(["a", "b", "c"]),
      new Set(["a", "b"]),
      new Set(["a"]),
    ])
    expect(votes).toEqual([
      { path: "a", votes: 3 },
      { path: "b", votes: 2 },
      { path: "c", votes: 1 },
    ])
  })

  it("handles empty input", () => {
    expect(tallyVotes([])).toEqual([])
    expect(tallyVotes([new Set(), new Set()])).toEqual([])
  })

  it("sorts by votes desc, path asc on ties", () => {
    expect(
      tallyVotes([new Set(["z", "a"]), new Set(["a", "z"])]),
    ).toEqual([
      { path: "a", votes: 2 },
      { path: "z", votes: 2 },
    ])
  })
})

describe("runConsensus", () => {
  it("registers Voter + Synthesizer agents + Consensus system prompt", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeMockSdk(
      makeThreeVotersStream([
        ["src/auth.ts"],
        ["src/auth.ts"],
        ["src/billing.ts"],
      ]),
    )
    await runConsensus("trace auth", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const params = captured.params as {
      options: { agents: Record<string, unknown>; systemPrompt: { append: string } }
    }
    expect(Object.keys(params.options.agents).sort()).toEqual([
      "Synthesizer",
      "Voter",
    ])
    expect(params.options.systemPrompt.append).toContain("Consensus")
    expect(params.options.systemPrompt.append).toContain("parallel")
    // Default voterCount=3 — prompt should reference 3 voters explicitly.
    expect(params.options.systemPrompt.append).toMatch(/3 Voters?/)
  })

  it("tallies majority files across observed Voter delegations", async () => {
    const root = makeTempProject()
    const { sdkQuery } = makeMockSdk(
      makeThreeVotersStream([
        ["src/auth.ts", "src/lib/util.ts"],
        ["src/auth.ts", "src/billing.ts"],
        ["src/billing.ts", "src/contexts/X.tsx"],
      ]),
    )
    const result = await runConsensus("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    expect(result.consensusStats.voter_count).toBe(3)
    expect(result.consensusStats.unique_files_cited).toBe(4)
    // src/auth.ts (2 voters) + src/billing.ts (2 voters) → 2 majority files
    expect(result.consensusStats.files_in_majority).toBe(2)
    const top = result.consensusStats.vote_distribution[0]
    expect(top.votes).toBe(2)

    const onDisk = loadLedger(root)
    expect(onDisk.delegations.length).toBe(3)
    expect(onDisk.files["src/auth.ts"]?.last_subagent).toBe("Voter")
  })

  it("voterCount option appears in system prompt template", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeMockSdk(
      makeThreeVotersStream([["a.ts"], ["a.ts"]]),
    )
    await runConsensus("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      voterCount: 5,
    })
    const append = (
      captured.params as { options: { systemPrompt: { append: string } } }
    ).options.systemPrompt.append
    expect(append).toMatch(/5 Voters?/)
  })

  it("flags any_minion_failed when a Voter fails", async () => {
    const root = makeTempProject()
    const stream = [
      { type: "system", subtype: "init", session_id: "x" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "v1",
              input: { subagent_type: "Voter", prompt: "" },
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
              tool_use_id: "v1",
              content: "MINION_FAILED: nope",
            },
          ],
        },
      },
    ]
    const { sdkQuery } = makeMockSdk(stream)
    const result = await runConsensus("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.consensusStats.any_minion_failed).toBe(true)
  })

  it("denies off-allowlist subagent_type", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    await runConsensus("q", {
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
      (await canUseTool("Task", { subagent_type: "Voter" })).behavior,
    ).toBe("allow")
  })
})

/**
 * ABC tests, post-orchestrator-refactor. ABC is now a thin wrapper that
 * registers Scout/Recruit/Synthesizer subagents and prompts Opus toward
 * the phased pattern. Tests verify wiring (right agents, right system
 * prompt content, right allowlist) and ledger updates from observed
 * delegations.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runAbc } from "../abc"
import { loadLedger } from "../../ledger"

const tempDirs: string[] = []
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "abc-test-"))
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

/** Build a stream simulating Opus running the full Scout → Recruits → Synth pattern. */
function makePhasedAbcStream() {
  return [
    { type: "system", subtype: "init", session_id: "abc-sess" },
    // Turn 1: Scout
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Task",
            id: "scout_1",
            input: { subagent_type: "Scout", prompt: "find auth code" },
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
            tool_use_id: "scout_1",
            content:
              "Candidates:\n1. src/auth.ts\n2. src/lib/neonClient.js\n3. src/contexts/AuthContext.tsx",
          },
        ],
      },
    },
    // Turn 2: 3 parallel Recruits in ONE assistant message
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Task",
            id: "recruit_1",
            input: { subagent_type: "Recruit", prompt: "deep-dive src/auth.ts" },
          },
          {
            type: "tool_use",
            name: "Task",
            id: "recruit_2",
            input: { subagent_type: "Recruit", prompt: "deep-dive src/lib/neonClient.js" },
          },
          {
            type: "tool_use",
            name: "Task",
            id: "recruit_3",
            input: { subagent_type: "Recruit", prompt: "deep-dive src/contexts/AuthContext.tsx" },
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
            tool_use_id: "recruit_1",
            content: "Findings on src/auth.ts:\n- src/auth.ts:42 — login flow",
          },
          {
            type: "tool_result",
            tool_use_id: "recruit_2",
            content: "Findings on src/lib/neonClient.js:\n- src/lib/neonClient.js:10 — provider config",
          },
          {
            type: "tool_result",
            tool_use_id: "recruit_3",
            content: "Findings on src/contexts/AuthContext.tsx:\n- src/contexts/AuthContext.tsx:25 — state",
          },
        ],
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

describe("runAbc", () => {
  it("registers Scout/Recruit/Synthesizer agents + ABC system prompt", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeMockSdk(makePhasedAbcStream())

    await runAbc("trace auth", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    const params = captured.params as {
      options: {
        agents: Record<string, unknown>
        systemPrompt: { append: string }
      }
    }
    expect(Object.keys(params.options.agents).sort()).toEqual([
      "Recruit",
      "Scout",
      "Synthesizer",
    ])
    expect(params.options.systemPrompt.append).toContain("scout-recruit")
    expect(params.options.systemPrompt.append).toContain("Scout")
    expect(params.options.systemPrompt.append).toContain("Recruit")
    expect(params.options.systemPrompt.append).toContain("parallel")
  })

  it("captures full Scout + 3 Recruits delegation pattern in stats and ledger", async () => {
    const root = makeTempProject()
    const { sdkQuery } = makeMockSdk(makePhasedAbcStream())

    const result = await runAbc("trace auth", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    expect(result.abcStats.scout_count).toBe(1)
    expect(result.abcStats.recruit_count).toBe(3)
    expect(result.abcStats.synthesizer_count).toBe(0) // synth optional
    expect(result.abcStats.total_delegations).toBe(4)
    expect(result.abcStats.any_minion_failed).toBe(false)

    const onDisk = loadLedger(root)
    expect(onDisk.session_count).toBe(1)
    expect(onDisk.delegations.length).toBe(4)
    expect(onDisk.delegations[0].subagent_type).toBe("Scout")
    expect(onDisk.delegations.slice(1, 4).every((d) => d.subagent_type === "Recruit")).toBe(true)
    // Files cited by Recruits should be bumped with Recruit attribution.
    expect(onDisk.files["src/auth.ts"]?.last_subagent).toBe("Recruit")
  })

  it("recruitCount option appears in the system prompt template", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeMockSdk(makePhasedAbcStream())

    await runAbc("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      recruitCount: 5,
    })

    const append = (
      captured.params as { options: { systemPrompt: { append: string } } }
    ).options.systemPrompt.append
    expect(append).toContain("5 parallel")
  })

  it("flags any_minion_failed when a Recruit returns MINION_FAILED", async () => {
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
              id: "scout_1",
              input: { subagent_type: "Scout", prompt: "" },
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
              tool_use_id: "scout_1",
              content: "MINION_FAILED: empty repo",
            },
          ],
        },
      },
    ]
    const { sdkQuery } = makeMockSdk(stream)

    const result = await runAbc("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.abcStats.any_minion_failed).toBe(true)
  })

  it("warm-starts on second session with prior delegations in ledger", async () => {
    const root = makeTempProject()
    const sdk1 = makeMockSdk(makePhasedAbcStream())
    await runAbc("first", {
      cwd: root,
      sdkQuery: sdk1.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    const sdk2 = makeMockSdk(makePhasedAbcStream())
    const result = await runAbc("second", {
      cwd: root,
      sdkQuery: sdk2.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    expect(result.abcStats.warm_start).toBe(true)
    expect(result.abcStats.prior_session_count).toBe(1)
  })

  it("forwards onMessage callbacks for every streamed message", async () => {
    const root = makeTempProject()
    const messages = makePhasedAbcStream()
    const { sdkQuery } = makeMockSdk(messages)
    const seen: unknown[] = []
    await runAbc("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      onMessage: (m) => seen.push(m),
    })
    expect(seen.length).toBe(messages.length)
  })

  it("denies off-allowlist subagent_type via canUseTool", async () => {
    const root = makeTempProject()
    const { sdkQuery, captured } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "x" },
    ])
    await runAbc("q", {
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
    const verdict = await canUseTool("Task", { subagent_type: "Editor" })
    expect(verdict.behavior).toBe("deny")
    const ok = await canUseTool("Task", { subagent_type: "Scout" })
    expect(ok.behavior).toBe("allow")
  })
})

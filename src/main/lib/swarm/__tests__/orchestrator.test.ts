/**
 * Orchestrator tests. Three concerns:
 *   - canUseTool guard (enforceAllowedSubagents)
 *   - stream observation (delegation open → close pairing, file attribution)
 *   - end-to-end runOpusOrchestrated with a mock SDK
 */
import { describe, expect, it, vi } from "vitest"
import { newLedger } from "../ledger"
import {
  enforceAllowedSubagents,
  observeMessage,
  runOpusOrchestrated,
} from "../orchestrator"
import type { DelegationRecord, Ledger } from "../ledger"

function makeObserveState(sessionId: string | null = null) {
  return {
    open: new Map(),
    finalized: [] as DelegationRecord[],
    parentFilesTouched: new Set<string>(),
    allFilesTouched: new Set<string>(),
    sessionId: { value: sessionId },
  }
}

function makeObserveOptions(ledger: Ledger, algorithm = "test") {
  return { cwd: "/repo", algorithm, bumpAmount: 0.15, ledger, nowMs: () => 1000 }
}

describe("enforceAllowedSubagents", () => {
  const allowed = new Set(["Scout", "Recruit"])

  it("allows non-Task tools to pass through", () => {
    expect(enforceAllowedSubagents("Read", { file_path: "x" }, allowed)).toBeNull()
    expect(enforceAllowedSubagents("Bash", { command: "ls" }, allowed)).toBeNull()
  })

  it("allows Task with subagent_type on the allowlist", () => {
    expect(
      enforceAllowedSubagents("Task", { subagent_type: "Scout" }, allowed),
    ).toBeNull()
    expect(
      enforceAllowedSubagents("Agent", { subagent_type: "Recruit" }, allowed),
    ).toBeNull()
  })

  it("denies Task with off-allowlist subagent_type", () => {
    const verdict = enforceAllowedSubagents(
      "Task",
      { subagent_type: "Editor" },
      allowed,
    )
    expect(verdict?.behavior).toBe("deny")
    expect(verdict?.message).toContain("Editor")
    expect(verdict?.message).toContain("Scout, Recruit")
  })

  it("treats missing subagent_type as allow (parent unsure — let SDK error)", () => {
    expect(enforceAllowedSubagents("Task", {}, allowed)).toBeNull()
  })
})

describe("observeMessage — delegation lifecycle", () => {
  it("opens a delegation on Task tool_use, closes on matching tool_result", () => {
    const ledger = newLedger("/repo")
    const state = makeObserveState()
    const opts = makeObserveOptions(ledger)

    observeMessage(
      {
        type: "system",
        subtype: "init",
        session_id: "sess-abc",
      },
      state,
      opts,
    )
    observeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "toolu_1",
              input: { subagent_type: "Scout", prompt: "find auth" },
            },
          ],
        },
      },
      state,
      opts,
    )
    expect(state.open.has("toolu_1")).toBe(true)
    expect(state.finalized.length).toBe(0)

    observeMessage(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content:
                "Candidates:\n1. src/auth.ts — has login flow\n2. src/lib/neonClient.js — auth provider",
            },
          ],
        },
      },
      state,
      opts,
    )
    expect(state.open.size).toBe(0)
    expect(state.finalized.length).toBe(1)
    expect(state.finalized[0]).toMatchObject({
      subagent_type: "Scout",
      prompt_preview: "find auth",
      session_id: "sess-abc",
    })
    expect(state.finalized[0].files_touched).toContain("src/auth.ts")
    expect(state.finalized[0].files_touched).toContain("src/lib/neonClient.js")
    expect(state.finalized[0].result_summary).toContain("Candidates:")
  })

  it("attributes nested tool_use (subagent's Read/Glob/Grep) to its parent delegation", () => {
    const ledger = newLedger("/repo")
    const state = makeObserveState("sess")
    const opts = makeObserveOptions(ledger)

    // Open delegation
    observeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "toolu_d1",
              input: { subagent_type: "Recruit", prompt: "" },
            },
          ],
        },
      },
      state,
      opts,
    )
    // Subagent's nested Read — flagged with parent_tool_use_id
    observeMessage(
      {
        type: "assistant",
        parent_tool_use_id: "toolu_d1",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/inside.ts" } },
          ],
        },
      },
      state,
      opts,
    )
    expect(state.open.get("toolu_d1")?.filesTouched.has("src/inside.ts")).toBe(true)
    expect(state.parentFilesTouched.has("src/inside.ts")).toBe(false)
  })

  it("attributes parent-direct tool_use (no parent_tool_use_id) to parent set", () => {
    const ledger = newLedger("/repo")
    const state = makeObserveState()
    const opts = makeObserveOptions(ledger)

    observeMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/parent-only.ts" } },
          ],
        },
      },
      state,
      opts,
    )
    expect(state.parentFilesTouched.has("src/parent-only.ts")).toBe(true)
  })

  it("bumps ledger files with subagent attribution on delegation close", () => {
    const ledger = newLedger("/repo")
    const state = makeObserveState()
    const opts = makeObserveOptions(ledger)

    observeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "toolu_v",
              input: { subagent_type: "Voter", prompt: "" },
            },
          ],
        },
      },
      state,
      opts,
    )
    observeMessage(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_v",
              content: "Findings:\n- src/auth.ts:42 login\n- src/billing.ts:10 charge",
            },
          ],
        },
      },
      state,
      opts,
    )
    expect(ledger.files["src/auth.ts"]?.last_subagent).toBe("Voter")
    expect(ledger.files["src/billing.ts"]?.last_subagent).toBe("Voter")
  })

  it("strips blocked paths (node_modules etc.) from attribution", () => {
    const ledger = newLedger("/repo")
    const state = makeObserveState()
    const opts = makeObserveOptions(ledger)

    observeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "node_modules/foo/index.js" },
            },
            { type: "tool_use", name: "Read", input: { file_path: "src/real.ts" } },
          ],
        },
      },
      state,
      opts,
    )
    expect(state.parentFilesTouched.has("src/real.ts")).toBe(true)
    expect(state.parentFilesTouched.has("node_modules/foo/index.js")).toBe(false)
  })
})

describe("runOpusOrchestrated — end-to-end with mock SDK", () => {
  function makeMockSdk(messages: unknown[]) {
    const calls: unknown[] = []
    const sdkQuery = vi.fn(async function* (params: unknown) {
      calls.push(params)
      for (const m of messages) yield m
    })
    return { sdkQuery, calls }
  }

  it("registers agents + system prompt + canUseTool guard", async () => {
    const ledger = newLedger("/repo")
    const { sdkQuery, calls } = makeMockSdk([])

    await runOpusOrchestrated({
      cwd: "/repo",
      sdkQuery: sdkQuery as Parameters<typeof runOpusOrchestrated>[0]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      query: "test",
      algorithm: "abc",
      agents: { Scout: { description: "d", tools: [], model: "haiku", prompt: "p" } },
      allowedSubagents: new Set(["Scout"]),
      systemPromptAppend: "ALGO_GUIDANCE",
      ledger,
    })

    const params = calls[0] as {
      prompt: string
      options: {
        agents: Record<string, unknown>
        systemPrompt: { append?: string }
        canUseTool: (n: string, i: Record<string, unknown>) => Promise<unknown>
      }
    }
    expect(params.prompt).toBe("test")
    expect(params.options.agents.Scout).toBeDefined()
    expect(params.options.systemPrompt.append).toBe("ALGO_GUIDANCE")

    // canUseTool denies off-allowlist Task calls.
    const denied = await params.options.canUseTool("Task", {
      subagent_type: "Editor",
    })
    expect((denied as { behavior: string }).behavior).toBe("deny")
    const allowed = await params.options.canUseTool("Task", {
      subagent_type: "Scout",
    })
    expect((allowed as { behavior: string }).behavior).toBe("allow")
  })

  it("captures one delegation across the message stream", async () => {
    const ledger = newLedger("/repo")
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "s-1" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "toolu_1",
              input: { subagent_type: "Scout", prompt: "find" },
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
              tool_use_id: "toolu_1",
              content: "Candidates:\n1. src/auth.ts — login",
            },
          ],
        },
      },
    ])

    const result = await runOpusOrchestrated({
      cwd: "/repo",
      sdkQuery: sdkQuery as Parameters<typeof runOpusOrchestrated>[0]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      query: "q",
      algorithm: "abc",
      agents: {},
      allowedSubagents: new Set(["Scout"]),
      ledger,
    })

    expect(result.delegations.length).toBe(1)
    expect(result.delegations[0].subagent_type).toBe("Scout")
    expect(result.delegations[0].session_id).toBe("s-1")
    expect(result.filesTouched.has("src/auth.ts")).toBe(true)
    expect(ledger.delegations.length).toBe(1)
    expect(ledger.files["src/auth.ts"]?.last_subagent).toBe("Scout")
  })

  it("captures parallel delegations issued in one assistant turn", async () => {
    const ledger = newLedger("/repo")
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "s" },
      {
        // One assistant turn with THREE Task tool_use blocks — parallel fanout.
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "v1",
              input: { subagent_type: "Voter", prompt: "investigate" },
            },
            {
              type: "tool_use",
              name: "Task",
              id: "v2",
              input: { subagent_type: "Voter", prompt: "investigate" },
            },
            {
              type: "tool_use",
              name: "Task",
              id: "v3",
              input: { subagent_type: "Voter", prompt: "investigate" },
            },
          ],
        },
      },
      {
        // tool_results arrive in the next user turn.
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "v1", content: "Findings:\n- src/a.ts" },
            { type: "tool_result", tool_use_id: "v2", content: "Findings:\n- src/a.ts\n- src/b.ts" },
            { type: "tool_result", tool_use_id: "v3", content: "Findings:\n- src/c.ts" },
          ],
        },
      },
    ])

    const result = await runOpusOrchestrated({
      cwd: "/repo",
      sdkQuery: sdkQuery as Parameters<typeof runOpusOrchestrated>[0]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      query: "q",
      algorithm: "consensus",
      agents: {},
      allowedSubagents: new Set(["Voter"]),
      ledger,
    })

    expect(result.delegations.length).toBe(3)
    expect(result.delegations.map((d) => d.subagent_type)).toEqual([
      "Voter",
      "Voter",
      "Voter",
    ])
    expect(result.filesTouched).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]))
    expect(ledger.files["src/a.ts"]?.hits).toBe(2) // 2 voters cited it
  })

  it("flags anyMinionFailed when a delegation returns the sentinel", async () => {
    const ledger = newLedger("/repo")
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "tu",
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
              tool_use_id: "tu",
              content: "MINION_FAILED: empty repo",
            },
          ],
        },
      },
    ])

    const result = await runOpusOrchestrated({
      cwd: "/repo",
      sdkQuery: sdkQuery as Parameters<typeof runOpusOrchestrated>[0]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      query: "q",
      algorithm: "abc",
      agents: {},
      allowedSubagents: new Set(["Scout"]),
      ledger,
    })
    expect(result.anyMinionFailed).toBe(true)
  })

  it("forwards messages through onMessage", async () => {
    const ledger = newLedger("/repo")
    const messages = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [] } },
    ]
    const { sdkQuery } = makeMockSdk(messages)
    const seen: unknown[] = []

    await runOpusOrchestrated({
      cwd: "/repo",
      sdkQuery: sdkQuery as Parameters<typeof runOpusOrchestrated>[0]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      query: "q",
      algorithm: "any",
      agents: {},
      allowedSubagents: new Set(),
      ledger,
      onMessage: (m) => seen.push(m),
    })
    expect(seen.length).toBe(messages.length)
  })

  it("records orphan delegations when stream ends mid-flight", async () => {
    const ledger = newLedger("/repo")
    const { sdkQuery } = makeMockSdk([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: "orphan",
              input: { subagent_type: "Scout", prompt: "" },
            },
          ],
        },
      },
      // No tool_result — stream ends with delegation open.
    ])

    const result = await runOpusOrchestrated({
      cwd: "/repo",
      sdkQuery: sdkQuery as Parameters<typeof runOpusOrchestrated>[0]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      query: "q",
      algorithm: "abc",
      agents: {},
      allowedSubagents: new Set(["Scout"]),
      ledger,
    })
    expect(result.delegations.length).toBe(1)
    expect(result.delegations[0].result_summary).toContain("no tool_result observed")
  })
})

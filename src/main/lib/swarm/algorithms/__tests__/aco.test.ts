/**
 * Tests for the ACO orchestrator. The SDK is dependency-injected so we
 * never hit the network — we feed a canned message stream and verify
 * the orchestrator updates memory correctly.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runAco, toProjectRelative, collectTouchedFiles } from "../aco"
import { loadMemory, memoryPath } from "../aco-memory"

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

/** Build a fake SDK stream from a list of canned tool-use file paths. */
function makeFakeSdk(toolPaths: string[]) {
  const messages: unknown[] = [
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        usage: { input_tokens: 5, output_tokens: 2 },
        content: toolPaths.map((p, i) => ({
          type: "tool_use",
          id: `toolu_${i}`,
          name: i === 0 ? "Read" : "Glob",
          input: i === 0 ? { file_path: p } : { path: p },
        })),
      },
    },
  ]
  const sdkQuery = vi.fn(async function* () {
    for (const m of messages) yield m
  })
  return { sdkQuery, messages }
}

describe("toProjectRelative", () => {
  it("strips an absolute project-rooted path", () => {
    expect(toProjectRelative("/repo/root/src/a.ts", "/repo/root")).toBe("src/a.ts")
  })

  it("returns relative paths unchanged", () => {
    expect(toProjectRelative("src/a.ts", "/repo/root")).toBe("src/a.ts")
  })

  it("handles trailing slash on root", () => {
    expect(toProjectRelative("/repo/root/src/a.ts", "/repo/root/")).toBe(
      "src/a.ts",
    )
  })

  it("returns unchanged when path is outside the project root", () => {
    expect(toProjectRelative("/somewhere/else/x.ts", "/repo/root")).toBe(
      "/somewhere/else/x.ts",
    )
  })

  it("handles empty input gracefully", () => {
    expect(toProjectRelative("", "/repo/root")).toBe("")
  })
})

describe("collectTouchedFiles", () => {
  it("extracts file_path and path from tool_use blocks", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            {
              type: "tool_use",
              name: "Glob",
              input: { path: "src/", pattern: "*.ts" },
            },
            { type: "text", text: "hello" }, // ignored
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.has("src/a.ts")).toBe(true)
    expect(touched.has("src/")).toBe(true)
  })

  it("dedupes the same file across multiple tool calls", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.size).toBe(1)
  })

  it("ignores user/system messages", () => {
    const messages = [
      { type: "system", subtype: "init" },
      {
        type: "user",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.size).toBe(0)
  })

  it("strips absolute project-root prefix when present", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/repo/root/src/a.ts" },
            },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect([...touched]).toEqual(["src/a.ts"])
  })

  it("mines file paths from Grep tool_result content (string form)", () => {
    const messages = [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content:
                "frontend/src/AuthenticatedApp.js:2:import OpenAI from 'openai';\nfrontend/src/AuthenticatedApp.js:225:return new OpenAI(",
            },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.has("frontend/src/AuthenticatedApp.js")).toBe(true)
  })

  it("mines file paths from tool_result content (array-of-blocks form)", () => {
    const messages = [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "frontend/src/auth.ts:42:user login" },
                { type: "text", text: "lib/billing.ts:10:export const" },
              ],
            },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.has("frontend/src/auth.ts")).toBe(true)
    expect(touched.has("lib/billing.ts")).toBe(true)
  })

  it("mines file paths from final assistant text blocks", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Found OpenAI usage at frontend/src/AuthenticatedApp.js (line 225) and a related util in lib/openai-helper.ts.",
            },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.has("frontend/src/AuthenticatedApp.js")).toBe(true)
    expect(touched.has("lib/openai-helper.ts")).toBe(true)
  })

  it("does not mine URLs from text", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "See https://api.openai.com/v1/chat for the spec.",
            },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect(touched.size).toBe(0)
  })

  it("blocks node_modules and other build/vendor paths from all sources", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "node_modules/foo/index.js" },
            },
            { type: "text", text: "See node_modules/bar/dist/index.d.ts and src/real.ts" },
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
              content:
                "node_modules/junk/index.js:1:hello\nsrc/keepme.ts:42:real code\nbuild/output.js:5:bundled",
            },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect([...touched].sort()).toEqual(["src/keepme.ts", "src/real.ts"])
  })

  it("combines all three sources into a deduped set", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
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
              content: "src/a.ts:10:foo\nsrc/b.ts:5:bar",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Confirmed in src/c.ts" },
          ],
        },
      },
    ]
    const touched = collectTouchedFiles(messages, "/repo/root")
    expect([...touched].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"])
  })
})

describe("runAco", () => {
  it("creates a fresh memory file on cold start and bumps touched files", async () => {
    const root = makeTempProject()
    const { sdkQuery } = makeFakeSdk(["src/a.ts", "src/b.ts"])

    const result = await runAco("find auth", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    expect(result.acoStats.warm_start).toBe(false)
    expect(result.acoStats.files_at_start).toBe(0)
    expect(result.acoStats.files_bumped).toBe(2)
    expect(result.acoStats.priors_injected).toBe(false)

    const onDisk = loadMemory(root)
    expect(onDisk.session_count).toBe(1)
    expect(onDisk.files["src/a.ts"]).toBeDefined()
    expect(onDisk.files["src/b.ts"]).toBeDefined()
  })

  it("injects priors block on a warm start with enough memory", async () => {
    const root = makeTempProject()
    // First session: bump 4 files so the second run sees ≥3 after decay.
    const sdk1 = makeFakeSdk(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
    await runAco("seed", {
      cwd: root,
      sdkQuery: sdk1.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    // Second session: capture the systemPrompt the SDK was called with.
    const captured: { systemPrompt?: unknown } = {}
    const sdk2 = vi.fn(async function* (params: { options?: { systemPrompt?: unknown } }) {
      captured.systemPrompt = params.options?.systemPrompt
      yield {
        type: "assistant",
        message: {
          model: "claude-opus-4-7",
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
          ],
        },
      }
    })

    const result = await runAco("warm query", {
      cwd: root,
      sdkQuery: sdk2 as unknown as Parameters<typeof runAco>[1]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    expect(result.acoStats.warm_start).toBe(true)
    expect(result.acoStats.priors_injected).toBe(true)
    expect(result.acoStats.priors_paths.length).toBeGreaterThanOrEqual(3)

    // Verify the system prompt the SDK actually saw mentions our priors.
    const sp = captured.systemPrompt as { append?: string }
    expect(sp?.append).toContain("Codebase priors")
    expect(sp?.append).toContain("src/a.ts")
  })

  it("decays priorities each session", async () => {
    const root = makeTempProject()
    const sdk = makeFakeSdk(["src/a.ts"])
    // Run twice; bump = 0.15 by default, decay = 0.95.
    await runAco("first", {
      cwd: root,
      sdkQuery: sdk.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    // After session 1: priority of src/a.ts = 0.15 (decay applied to empty
    // memory before bump, so still 0.15).
    let mem = loadMemory(root)
    expect(mem.files["src/a.ts"].priority).toBeCloseTo(0.15)

    // Session 2 with NO file touched — priority should decay.
    const emptySdk = makeFakeSdk([])
    await runAco("no-touch", {
      cwd: root,
      sdkQuery: emptySdk.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    mem = loadMemory(root)
    expect(mem.files["src/a.ts"]?.priority).toBeCloseTo(0.15 * 0.95)
  })

  it("appends ACO priors AFTER any base systemPromptAppend", async () => {
    const root = makeTempProject()
    // Seed memory.
    const seed = makeFakeSdk(["a", "b", "c", "d"])
    await runAco("seed", {
      cwd: root,
      sdkQuery: seed.sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })

    const captured: { systemPrompt?: unknown } = {}
    const sdk = vi.fn(async function* (params: { options?: { systemPrompt?: unknown } }) {
      captured.systemPrompt = params.options?.systemPrompt
      yield { type: "assistant", message: { content: [] } }
    })
    await runAco("q", {
      cwd: root,
      sdkQuery: sdk as unknown as Parameters<typeof runAco>[1]["sdkQuery"],
      pathToClaudeCodeExecutable: "/fake/claude",
      systemPromptAppend: "BASE_POLICY_HERE",
    })

    const sp = captured.systemPrompt as { append: string }
    expect(sp.append.indexOf("BASE_POLICY_HERE")).toBeLessThan(
      sp.append.indexOf("Codebase priors"),
    )
  })

  it("calls onMessage for each streamed message", async () => {
    const root = makeTempProject()
    const { sdkQuery, messages } = makeFakeSdk(["src/a.ts"])
    const seen: unknown[] = []
    await runAco("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
      onMessage: (m) => seen.push(m),
    })
    expect(seen.length).toBe(messages.length)
  })

  it("persists memory file to disk", async () => {
    const root = makeTempProject()
    const { sdkQuery } = makeFakeSdk(["src/a.ts"])
    await runAco("q", {
      cwd: root,
      sdkQuery,
      pathToClaudeCodeExecutable: "/fake/claude",
    })
    const p = memoryPath(root)
    expect(existsSync(p)).toBe(true)
    const raw = JSON.parse(readFileSync(p, "utf-8"))
    expect(raw.session_count).toBe(1)
    expect(raw.files["src/a.ts"]).toBeDefined()
  })
})

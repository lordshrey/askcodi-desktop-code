/**
 * Regression tests for the canUseTool helpers extracted from claude.ts.
 *
 * Locks down the existing Ollama param-normalization and plan-mode blocking
 * behavior before the swarm_explore subagent lands. If a future change to
 * canUseTool silently breaks one of these branches, this test fails.
 */
import { describe, it, expect } from "vitest"
import {
  normalizeOllamaToolInput,
  evaluatePlanModeBlock,
} from "../claude-can-use-tool-helpers"

const PLAN_MODE_BLOCKED_TOOLS = new Set(["Bash", "NotebookEdit"])

describe("normalizeOllamaToolInput", () => {
  it("is a no-op when not using Ollama", () => {
    const input: Record<string, unknown> = { file: "/a/b.ts" }
    normalizeOllamaToolInput("Read", input, false)
    expect(input).toEqual({ file: "/a/b.ts" })
  })

  describe("with isUsingOllama=true", () => {
    it("renames Read.file -> file_path", () => {
      const input: Record<string, unknown> = { file: "/a/b.ts" }
      normalizeOllamaToolInput("Read", input, true)
      expect(input).toEqual({ file_path: "/a/b.ts" })
    })

    it("leaves Read.file_path alone when already correct", () => {
      const input: Record<string, unknown> = { file_path: "/a/b.ts" }
      normalizeOllamaToolInput("Read", input, true)
      expect(input).toEqual({ file_path: "/a/b.ts" })
    })

    it("does not overwrite an existing Read.file_path", () => {
      const input: Record<string, unknown> = {
        file: "/wrong",
        file_path: "/right",
      }
      normalizeOllamaToolInput("Read", input, true)
      expect(input).toEqual({ file: "/wrong", file_path: "/right" })
    })

    it("renames Write.file -> file_path", () => {
      const input: Record<string, unknown> = { file: "/a", content: "x" }
      normalizeOllamaToolInput("Write", input, true)
      expect(input).toEqual({ file_path: "/a", content: "x" })
    })

    it("renames Edit.file -> file_path", () => {
      const input: Record<string, unknown> = { file: "/a" }
      normalizeOllamaToolInput("Edit", input, true)
      expect(input).toEqual({ file_path: "/a" })
    })

    it("renames Glob.directory -> path", () => {
      const input: Record<string, unknown> = {
        directory: "/x",
        pattern: "**/*",
      }
      normalizeOllamaToolInput("Glob", input, true)
      expect(input).toEqual({ path: "/x", pattern: "**/*" })
    })

    it("renames Glob.dir -> path", () => {
      const input: Record<string, unknown> = { dir: "/x" }
      normalizeOllamaToolInput("Glob", input, true)
      expect(input).toEqual({ path: "/x" })
    })

    it("renames Grep.query -> pattern", () => {
      const input: Record<string, unknown> = { query: "foo" }
      normalizeOllamaToolInput("Grep", input, true)
      expect(input).toEqual({ pattern: "foo" })
    })

    it("renames Grep.directory -> path", () => {
      const input: Record<string, unknown> = { pattern: "foo", directory: "/x" }
      normalizeOllamaToolInput("Grep", input, true)
      expect(input).toEqual({ pattern: "foo", path: "/x" })
    })

    it("renames Grep.query and directory together", () => {
      const input: Record<string, unknown> = { query: "foo", directory: "/x" }
      normalizeOllamaToolInput("Grep", input, true)
      expect(input).toEqual({ pattern: "foo", path: "/x" })
    })

    it("renames Bash.cmd -> command", () => {
      const input: Record<string, unknown> = { cmd: "ls" }
      normalizeOllamaToolInput("Bash", input, true)
      expect(input).toEqual({ command: "ls" })
    })

    it("does not touch unknown tool names", () => {
      const input: Record<string, unknown> = { file: "/a" }
      normalizeOllamaToolInput("UnknownTool", input, true)
      expect(input).toEqual({ file: "/a" })
    })
  })
})

describe("evaluatePlanModeBlock", () => {
  it("returns null when not in plan mode", () => {
    const v = evaluatePlanModeBlock(
      "agent",
      "Edit",
      { file_path: "/a/b.ts" },
      PLAN_MODE_BLOCKED_TOOLS,
    )
    expect(v).toBeNull()
  })

  describe("when mode === 'plan'", () => {
    it("denies Edit on a non-.md file", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Edit",
        { file_path: "/src/app.ts" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v).toEqual({
        behavior: "deny",
        message: 'Only ".md" files can be modified in plan mode.',
      })
    })

    it("denies Write on a non-.md file", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Write",
        { file_path: "/src/app.ts" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v?.behavior).toBe("deny")
    })

    it("allows Edit on a .md file (returns null)", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Edit",
        { file_path: "/notes/plan.md" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v).toBeNull()
    })

    it("allows Write on a .md file (returns null)", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Write",
        { file_path: "/notes/plan.md" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v).toBeNull()
    })

    it("treats Edit with no file_path as non-.md (deny)", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Edit",
        {},
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v?.behavior).toBe("deny")
    })

    it("denies ExitPlanMode with the model-facing message", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "ExitPlanMode",
        {},
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v?.behavior).toBe("deny")
      expect(v?.message).toContain("DONT IMPLEMENT THE PLAN")
    })

    it("denies tools in the blocked set (Bash)", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Bash",
        { command: "ls" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v).toEqual({
        behavior: "deny",
        message: 'Tool "Bash" blocked in plan mode.',
      })
    })

    it("denies tools in the blocked set (NotebookEdit)", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "NotebookEdit",
        {},
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v?.behavior).toBe("deny")
    })

    it("returns null for tools not in the blocked set (Read)", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Read",
        { file_path: "/a.ts" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v).toBeNull()
    })

    it("matches .md files case-insensitively", () => {
      const v = evaluatePlanModeBlock(
        "plan",
        "Edit",
        { file_path: "/notes/PLAN.MD" },
        PLAN_MODE_BLOCKED_TOOLS,
      )
      expect(v).toBeNull()
    })
  })
})

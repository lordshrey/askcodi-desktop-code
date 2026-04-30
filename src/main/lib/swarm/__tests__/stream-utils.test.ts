/**
 * Stream-utils tests — collectTouchedFiles and collectAssistantText
 * walk SDK message streams; tests use canned message arrays.
 */
import { describe, expect, it } from "vitest"
import {
  collectAssistantText,
  collectTouchedFiles,
} from "../stream-utils"

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
            { type: "text", text: "hello" },
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
    expect(collectTouchedFiles(messages, "/repo/root").size).toBe(1)
  })

  it("ignores user/system messages without tool_result blocks", () => {
    const messages = [
      { type: "system", subtype: "init" },
      {
        type: "user",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }],
        },
      },
    ]
    expect(collectTouchedFiles(messages, "/repo/root").size).toBe(0)
  })

  it("strips absolute project-root prefix", () => {
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
    expect([...collectTouchedFiles(messages, "/repo/root")]).toEqual(["src/a.ts"])
  })

  it("mines paths from string-form tool_result content", () => {
    const messages = [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content:
                "frontend/src/AuthenticatedApp.js:2:import OpenAI from 'openai';",
            },
          ],
        },
      },
    ]
    expect(collectTouchedFiles(messages, "/repo/root").has(
      "frontend/src/AuthenticatedApp.js",
    )).toBe(true)
  })

  it("mines paths from array-of-blocks tool_result content", () => {
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

  it("mines paths from final assistant text blocks", () => {
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
            { type: "text", text: "See https://api.openai.com/v1/chat for the spec." },
          ],
        },
      },
    ]
    expect(collectTouchedFiles(messages, "/repo/root").size).toBe(0)
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
            {
              type: "text",
              text: "See node_modules/bar/dist/index.d.ts and src/real.ts",
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
})

describe("collectAssistantText", () => {
  it("joins text blocks across multiple assistant messages", () => {
    const messages = [
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "second" }] } },
    ]
    expect(collectAssistantText(messages)).toBe("first\n\nsecond")
  })

  it("ignores tool_use blocks", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "x" } },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]
    expect(collectAssistantText(messages)).toBe("answer")
  })

  it("ignores non-assistant messages", () => {
    const messages = [
      { type: "system", subtype: "init" },
      { type: "user", message: { content: [{ type: "text", text: "ignored" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "kept" }] } },
    ]
    expect(collectAssistantText(messages)).toBe("kept")
  })

  it("returns empty string for streams without text blocks", () => {
    expect(collectAssistantText([])).toBe("")
    expect(
      collectAssistantText([
        { type: "assistant", message: { content: [] } },
      ]),
    ).toBe("")
  })
})

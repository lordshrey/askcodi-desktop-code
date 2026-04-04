import { describe, it, expect } from "vitest"
import { adaptCodexEvents } from "../codex-stream-adapter"
import type { ThreadEvent } from "@openai/codex-sdk"
import type { UIMessageChunk } from "../claude/types"

/** Helper: create an async generator from an array of events. */
async function* eventsFrom(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const e of events) {
    yield e
  }
}

/** Collect all chunks from the adapter. */
async function collectChunks(
  events: ThreadEvent[],
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  for await (const chunk of adaptCodexEvents(eventsFrom(events))) {
    chunks.push(chunk)
  }
  return chunks
}

describe("adaptCodexEvents", () => {
  it("emits start/finish for empty event stream", async () => {
    const chunks = await collectChunks([])
    expect(chunks[0]).toEqual({ type: "start", messageId: expect.any(String) })
    expect(chunks[1]).toEqual({ type: "start-step" })
    // Should end with metadata + finish-step + finish
    expect(chunks[chunks.length - 3]).toMatchObject({ type: "message-metadata" })
    expect(chunks[chunks.length - 2]).toEqual({ type: "finish-step" })
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "finish" })
  })

  it("handles thread.started event", async () => {
    let capturedThreadId: string | null = null
    const chunks: UIMessageChunk[] = []
    for await (const chunk of adaptCodexEvents(
      eventsFrom([{ type: "thread.started", thread_id: "thread-123" }]),
      { onThreadStarted: (id) => { capturedThreadId = id } },
    )) {
      chunks.push(chunk)
    }
    expect(capturedThreadId).toBe("thread-123")
    const sessionInit = chunks.find((c) => c.type === "session-init")
    expect(sessionInit).toBeDefined()
  })

  it("streams AgentMessageItem text", async () => {
    const chunks = await collectChunks([
      { type: "turn.started" },
      {
        type: "item.started",
        item: { id: "msg-1", type: "agent_message", text: "Hello" },
      },
      {
        type: "item.updated",
        item: { id: "msg-1", type: "agent_message", text: " world" },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Hello world" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
      },
    ])

    const textStart = chunks.find((c) => c.type === "text-start")
    expect(textStart).toEqual({ type: "text-start", id: "msg-1" })

    const textDeltas = chunks.filter((c) => c.type === "text-delta")
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)

    const textEnd = chunks.find((c) => c.type === "text-end")
    expect(textEnd).toEqual({ type: "text-end", id: "msg-1" })

    // Check usage in metadata
    const meta = chunks.find((c) => c.type === "message-metadata")
    expect(meta).toMatchObject({
      type: "message-metadata",
      messageMetadata: {
        inputTokens: 80, // 100 - 20 cached
        cacheReadInputTokens: 20,
        outputTokens: 50,
        totalTokens: 150,
      },
    })
  })

  it("handles CommandExecutionItem (Bash)", async () => {
    const chunks = await collectChunks([
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "",
          status: "in_progress" as const,
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "file1.ts\nfile2.ts",
          exit_code: 0,
          status: "completed" as const,
        },
      },
    ])

    const toolStart = chunks.find((c) => c.type === "tool-input-start")
    expect(toolStart).toMatchObject({
      type: "tool-input-start",
      toolCallId: "cmd-1",
      toolName: "Bash",
    })

    const toolInput = chunks.find((c) => c.type === "tool-input-available")
    expect(toolInput).toMatchObject({
      type: "tool-input-available",
      toolCallId: "cmd-1",
      toolName: "Bash",
      input: { command: "ls -la" },
    })

    const toolOutput = chunks.find((c) => c.type === "tool-output-available")
    expect(toolOutput).toMatchObject({
      type: "tool-output-available",
      toolCallId: "cmd-1",
      output: { stdout: "file1.ts\nfile2.ts", exitCode: 0, status: "completed" },
    })
  })

  it("handles FileChangeItem (Edit/Write)", async () => {
    const chunks = await collectChunks([
      {
        type: "item.completed",
        item: {
          id: "fc-1",
          type: "file_change",
          changes: [{ path: "src/index.ts", kind: "update" as const }],
          status: "completed" as const,
        },
      },
    ])

    const toolInput = chunks.find((c) => c.type === "tool-input-available")
    expect(toolInput).toMatchObject({
      toolName: "Edit", // "update" kind → Edit
    })

    // Test "add" kind → Write
    const chunks2 = await collectChunks([
      {
        type: "item.completed",
        item: {
          id: "fc-2",
          type: "file_change",
          changes: [{ path: "src/new.ts", kind: "add" as const }],
          status: "completed" as const,
        },
      },
    ])
    const toolInput2 = chunks2.find((c) => c.type === "tool-input-available")
    expect(toolInput2).toMatchObject({
      toolName: "Write", // "add" kind → Write
    })
  })

  it("handles McpToolCallItem", async () => {
    const chunks = await collectChunks([
      {
        type: "item.started",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "github",
          tool: "list_issues",
          arguments: { repo: "owner/repo" },
          status: "in_progress" as const,
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "github",
          tool: "list_issues",
          arguments: { repo: "owner/repo" },
          result: { content: [], structured_content: { issues: [] } },
          status: "completed" as const,
        },
      },
    ])

    const toolStart = chunks.find((c) => c.type === "tool-input-start")
    expect(toolStart).toMatchObject({
      toolName: "mcp__github__list_issues",
    })

    const toolOutput = chunks.find((c) => c.type === "tool-output-available")
    expect(toolOutput).toMatchObject({
      toolCallId: "mcp-1",
    })
  })

  it("handles McpToolCallItem with error", async () => {
    const chunks = await collectChunks([
      {
        type: "item.completed",
        item: {
          id: "mcp-err",
          type: "mcp_tool_call",
          server: "broken",
          tool: "fail",
          arguments: {},
          error: { message: "Server unreachable" },
          status: "failed" as const,
        },
      },
    ])

    const toolError = chunks.find((c) => c.type === "tool-output-error")
    expect(toolError).toMatchObject({
      toolCallId: "mcp-err",
      errorText: "Server unreachable",
    })
  })

  it("handles ReasoningItem", async () => {
    const chunks = await collectChunks([
      {
        type: "item.started",
        item: { id: "r-1", type: "reasoning", text: "Let me think..." },
      },
      {
        type: "item.updated",
        item: { id: "r-1", type: "reasoning", text: "I should check the file first." },
      },
    ])

    const reasoning = chunks.find((c) => c.type === "reasoning")
    expect(reasoning).toMatchObject({ id: "r-1" })

    const deltas = chunks.filter((c) => c.type === "reasoning-delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
  })

  it("handles WebSearchItem", async () => {
    const chunks = await collectChunks([
      {
        type: "item.started",
        item: { id: "ws-1", type: "web_search", query: "vitest setup" },
      },
      {
        type: "item.completed",
        item: { id: "ws-1", type: "web_search", query: "vitest setup" },
      },
    ])

    const toolStart = chunks.find((c) => c.type === "tool-input-start")
    expect(toolStart).toMatchObject({
      toolName: "WebSearch",
      toolCallId: "ws-1",
    })
  })

  it("emits auth-error for authentication failures", async () => {
    const chunks = await collectChunks([
      {
        type: "turn.failed",
        error: { message: "401 Unauthorized: invalid API key" },
      },
    ])

    const authError = chunks.find((c) => c.type === "auth-error")
    expect(authError).toBeDefined()
  })

  it("emits regular error for non-auth failures", async () => {
    const chunks = await collectChunks([
      {
        type: "turn.failed",
        error: { message: "Model overloaded, try again" },
      },
    ])

    const error = chunks.find((c) => c.type === "error")
    expect(error).toMatchObject({
      type: "error",
      errorText: "Model overloaded, try again",
    })
    expect(chunks.find((c) => c.type === "auth-error")).toBeUndefined()
  })

  it("handles TodoListItem", async () => {
    const chunks = await collectChunks([
      {
        type: "item.started",
        item: {
          id: "todo-1",
          type: "todo_list",
          items: [
            { text: "Read the file", completed: true },
            { text: "Fix the bug", completed: false },
          ],
        },
      },
      {
        type: "item.completed",
        item: {
          id: "todo-1",
          type: "todo_list",
          items: [
            { text: "Read the file", completed: true },
            { text: "Fix the bug", completed: true },
          ],
        },
      },
    ])

    const textStart = chunks.find((c) => c.type === "text-start" && "id" in c && c.id === "todo-1")
    expect(textStart).toBeDefined()

    const textEnd = chunks.find((c) => c.type === "text-end" && "id" in c && c.id === "todo-1")
    expect(textEnd).toBeDefined()
  })

  it("includes sessionId in metadata", async () => {
    const chunks = await collectChunks([
      { type: "thread.started", thread_id: "sess-abc" },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ])

    const meta = chunks.find((c) => c.type === "message-metadata")
    expect(meta).toMatchObject({
      type: "message-metadata",
      messageMetadata: { sessionId: "sess-abc" },
    })
  })
})

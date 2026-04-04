/**
 * Codex Stream Adapter
 *
 * Converts the Codex SDK's AsyncGenerator<ThreadEvent> into AsyncGenerator<UIMessageChunk>
 * that the existing renderer/transport layer expects.
 *
 * This reimplements the message protocol that Vercel AI SDK's toUIMessageStream()
 * provided for the ACP path — including message IDs, tool call correlation,
 * finish ordering, and metadata injection.
 */

import { randomUUID } from "node:crypto"
import type {
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  WebSearchItem,
  TodoListItem,
  ErrorItem,
  Usage,
} from "@openai/codex-sdk"
import type { UIMessageChunk, MessageMetadata } from "./claude/types"

/**
 * Combined auth error hints from both codex.ts and adapter usage.
 * Exported so codex.ts can also use it instead of maintaining a separate list.
 */
export const CODEX_AUTH_HINTS = [
  "not logged in",
  "401",
  "403",
  "unauthorized",
  "codex login",
  "authentication",
  "authentication required",
  "auth required",
  "login required",
  "missing credentials",
  "no credentials",
  "forbidden",
  "invalid api key",
  "invalid_api_key",
  "expired",
]

export function isCodexAuthError(messageOrObj: string | { message?: string | null; code?: string | null }): boolean {
  const text = typeof messageOrObj === "string"
    ? messageOrObj
    : `${messageOrObj.code || ""} ${messageOrObj.message || ""}`
  const lower = text.toLowerCase()
  return CODEX_AUTH_HINTS.some((hint) => lower.includes(hint))
}

// ---------------------------------------------------------------------------
// Tool name mapping
// ---------------------------------------------------------------------------

function toolNameForCommandExecution(): string {
  return "Bash"
}

function toolNameForFileChange(item: FileChangeItem): string {
  // If any change is an "add", it's a Write. Otherwise Edit.
  const hasAdd = item.changes.some((c) => c.kind === "add")
  return hasAdd ? "Write" : "Edit"
}

function toolNameForMcpToolCall(item: McpToolCallItem): string {
  return `mcp__${item.server}__${item.tool}`
}

function toolNameForWebSearch(): string {
  return "WebSearch"
}

function toolNameForReasoning(): string {
  return "Thinking"
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface AdaptOptions {
  /** Called when thread.started event is received with the threadId. */
  onThreadStarted?: (threadId: string) => void
  /** Start timestamp for duration calculation. */
  startedAt?: number
}

/**
 * Adapts Codex SDK ThreadEvent stream to UIMessageChunk stream.
 *
 * The caller iterates this generator and emits each chunk to the tRPC observable.
 */
export async function* adaptCodexEvents(
  events: AsyncGenerator<ThreadEvent>,
  options?: AdaptOptions,
): AsyncGenerator<UIMessageChunk> {
  const startedAt = options?.startedAt ?? Date.now()
  let sessionId: string | null = null
  let lastUsage: Usage | null = null

  // Track which items have emitted a "start" so we can handle
  // cases where the SDK skips item.started and goes straight to item.completed
  const startedItems = new Set<string>()

  // Track last emitted text length per item to avoid O(N^2) re-emission
  // (SDK sends full accumulated text on each update, not just the delta)
  const lastEmittedLength = new Map<string, number>()

  // Emit message start
  yield { type: "start", messageId: randomUUID() }
  yield { type: "start-step" }

  let eventCount = 0
  for await (const event of events) {
    eventCount++
    if (eventCount <= 5 || eventCount % 20 === 0) {
      console.log(`[codex-adapter] Raw event #${eventCount}: type="${event.type}" ${event.type === "item.started" || event.type === "item.completed" ? `item.type="${(event as any).item?.type}"` : ""}`)
    }
    switch (event.type) {
      case "thread.started": {
        sessionId = event.thread_id
        options?.onThreadStarted?.(event.thread_id)
        // Emit session-init with threadId (no MCP/tool info — SDK manages those)
        yield {
          type: "session-init",
          tools: [],
          mcpServers: [],
          plugins: [],
          skills: [],
        } as UIMessageChunk
        break
      }

      case "turn.started": {
        // Turn started — already emitted start-step above
        break
      }

      case "item.started": {
        startedItems.add(event.item.id)
        yield* handleItemStarted(event.item)
        break
      }

      case "item.updated": {
        yield* handleItemUpdated(event.item, lastEmittedLength)
        break
      }

      case "item.completed": {
        yield* handleItemCompleted(event.item, startedItems)
        break
      }

      case "turn.completed": {
        lastUsage = event.usage
        break
      }

      case "turn.failed": {
        const errorMsg = event.error.message
        if (isCodexAuthError(errorMsg)) {
          yield { type: "auth-error", errorText: errorMsg }
        } else {
          yield { type: "error", errorText: errorMsg }
        }
        break
      }

      case "error": {
        const errorMsg = event.message
        if (isCodexAuthError(errorMsg)) {
          yield { type: "auth-error", errorText: errorMsg }
        } else {
          yield { type: "error", errorText: errorMsg }
        }
        break
      }
    }
  }

  console.log(`[codex-adapter] Event stream ended. Total raw events: ${eventCount}`)

  // Emit metadata + finish
  const metadata: MessageMetadata = {
    sessionId: sessionId ?? undefined,
    durationMs: Date.now() - startedAt,
    ...(lastUsage && {
      inputTokens: lastUsage.input_tokens - lastUsage.cached_input_tokens,
      cacheReadInputTokens: lastUsage.cached_input_tokens,
      outputTokens: lastUsage.output_tokens,
      totalTokens: lastUsage.input_tokens + lastUsage.output_tokens,
    }),
  }
  yield { type: "message-metadata", messageMetadata: metadata }
  yield { type: "finish-step" }
  yield { type: "finish", messageMetadata: metadata }
}

// ---------------------------------------------------------------------------
// Item event handlers
// ---------------------------------------------------------------------------

function* handleItemStarted(
  item: ThreadItem,
): Generator<UIMessageChunk> {
  switch (item.type) {
    case "agent_message": {
      yield { type: "text-start", id: item.id }
      // Emit initial text if present
      if ((item as AgentMessageItem).text) {
        yield {
          type: "text-delta",
          id: item.id,
          delta: (item as AgentMessageItem).text,
        }
      }
      break
    }

    case "command_execution": {
      yield {
        type: "tool-input-start",
        toolCallId: item.id,
        toolName: toolNameForCommandExecution(),
      }
      // Emit command as input delta
      const cmd = (item as CommandExecutionItem).command
      if (cmd) {
        yield {
          type: "tool-input-delta",
          toolCallId: item.id,
          inputTextDelta: JSON.stringify({ command: cmd }),
        }
      }
      break
    }

    case "file_change": {
      const fc = item as FileChangeItem
      yield {
        type: "tool-input-start",
        toolCallId: item.id,
        toolName: toolNameForFileChange(fc),
      }
      break
    }

    case "mcp_tool_call": {
      const mcp = item as McpToolCallItem
      yield {
        type: "tool-input-start",
        toolCallId: item.id,
        toolName: toolNameForMcpToolCall(mcp),
      }
      // Emit arguments as input delta
      if (mcp.arguments) {
        yield {
          type: "tool-input-delta",
          toolCallId: item.id,
          inputTextDelta: JSON.stringify(mcp.arguments),
        }
      }
      break
    }

    case "reasoning": {
      yield { type: "reasoning", id: item.id, text: "" }
      const r = item as ReasoningItem
      if (r.text) {
        yield { type: "reasoning-delta", id: item.id, delta: r.text }
      }
      break
    }

    case "web_search": {
      const ws = item as WebSearchItem
      yield {
        type: "tool-input-start",
        toolCallId: item.id,
        toolName: toolNameForWebSearch(),
      }
      yield {
        type: "tool-input-delta",
        toolCallId: item.id,
        inputTextDelta: JSON.stringify({ query: ws.query }),
      }
      break
    }

    case "todo_list": {
      // TodoList items don't have a direct UI mapping — emit as text
      const todo = item as TodoListItem
      const todoText = todo.items
        .map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`)
        .join("\n")
      yield { type: "text-start", id: item.id }
      yield { type: "text-delta", id: item.id, delta: todoText }
      break
    }

    case "error": {
      const err = item as ErrorItem
      yield { type: "error", errorText: err.message }
      break
    }
  }
}

function* handleItemUpdated(
  item: ThreadItem,
  lastEmittedLength: Map<string, number>,
): Generator<UIMessageChunk> {
  switch (item.type) {
    case "agent_message": {
      // SDK sends full accumulated text on each update — extract only the new delta
      const am = item as AgentMessageItem
      if (am.text) {
        const prev = lastEmittedLength.get(item.id) ?? 0
        const newText = am.text.slice(prev)
        if (newText.length > 0) {
          yield { type: "text-delta", id: item.id, delta: newText }
          lastEmittedLength.set(item.id, am.text.length)
        }
      }
      break
    }

    case "command_execution": {
      // SDK sends full accumulated output — extract only the new delta
      const cmd = item as CommandExecutionItem
      if (cmd.aggregated_output) {
        const prev = lastEmittedLength.get(item.id) ?? 0
        const newOutput = cmd.aggregated_output.slice(prev)
        if (newOutput.length > 0) {
          yield {
            type: "tool-input-delta",
            toolCallId: item.id,
            inputTextDelta: newOutput,
          }
          lastEmittedLength.set(item.id, cmd.aggregated_output.length)
        }
      }
      break
    }

    case "reasoning": {
      const r = item as ReasoningItem
      if (r.text) {
        const prev = lastEmittedLength.get(item.id) ?? 0
        const newText = r.text.slice(prev)
        if (newText.length > 0) {
          yield { type: "reasoning-delta", id: item.id, delta: newText }
          lastEmittedLength.set(item.id, r.text.length)
        }
      }
      break
    }

    case "todo_list": {
      const todo = item as TodoListItem
      const todoText = todo.items
        .map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`)
        .join("\n")
      yield { type: "text-delta", id: item.id, delta: todoText }
      break
    }

    // Other item types don't emit meaningful updates
  }
}

function* handleItemCompleted(
  item: ThreadItem,
  startedItems: Set<string>,
): Generator<UIMessageChunk> {
  switch (item.type) {
    case "agent_message": {
      const am = item as AgentMessageItem
      // SDK may skip item.started/updated and go straight to completed
      // In that case, emit the full text sequence here
      if (!startedItems.has(item.id)) {
        yield { type: "text-start", id: item.id }
        if (am.text) {
          yield { type: "text-delta", id: item.id, delta: am.text }
        }
      }
      yield { type: "text-end", id: item.id }
      break
    }

    case "command_execution": {
      const cmd = item as CommandExecutionItem
      if (!startedItems.has(item.id)) {
        yield { type: "tool-input-start", toolCallId: item.id, toolName: toolNameForCommandExecution() }
      }
      yield {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: toolNameForCommandExecution(),
        input: { command: cmd.command },
      }
      yield {
        type: "tool-output-available",
        toolCallId: item.id,
        output: {
          stdout: cmd.aggregated_output,
          exitCode: cmd.exit_code,
          status: cmd.status,
        },
      }
      break
    }

    case "file_change": {
      const fc = item as FileChangeItem
      if (!startedItems.has(item.id)) {
        yield { type: "tool-input-start", toolCallId: item.id, toolName: toolNameForFileChange(fc) }
      }
      yield {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: toolNameForFileChange(fc),
        input: { changes: fc.changes },
      }
      yield {
        type: "tool-output-available",
        toolCallId: item.id,
        output: { status: fc.status },
      }
      break
    }

    case "mcp_tool_call": {
      const mcp = item as McpToolCallItem
      yield {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: toolNameForMcpToolCall(mcp),
        input: mcp.arguments,
      }
      if (mcp.error) {
        yield {
          type: "tool-output-error",
          toolCallId: item.id,
          errorText: mcp.error.message,
        }
      } else {
        yield {
          type: "tool-output-available",
          toolCallId: item.id,
          output: mcp.result ?? null,
        }
      }
      break
    }

    case "reasoning": {
      // Reasoning completed — no explicit end event needed
      // (reasoning chunks are already emitted via updates)
      break
    }

    case "web_search": {
      const ws = item as WebSearchItem
      yield {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: toolNameForWebSearch(),
        input: { query: ws.query },
      }
      yield {
        type: "tool-output-available",
        toolCallId: item.id,
        output: { query: ws.query },
      }
      break
    }

    case "todo_list": {
      yield { type: "text-end", id: item.id }
      break
    }

    case "error": {
      const err = item as ErrorItem
      yield { type: "error", errorText: err.message }
      break
    }
  }
}

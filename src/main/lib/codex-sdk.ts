/**
 * Codex SDK lifecycle wrapper.
 *
 * - Global Codex instance: one per apiKey+env config, recreated when config changes.
 * - Per-subChat Thread: each sub-chat gets its own isolated Thread for session continuity.
 *
 * NOTE: @openai/codex-sdk is ESM-only. We use dynamic import() since Electron's
 * main process runs as CJS. Same pattern as Claude Agent SDK (see claude.ts).
 */

import type {
  Codex,
  CodexOptions,
  ThreadOptions,
  Thread,
  Input,
  TurnOptions,
  ThreadEvent,
} from "@openai/codex-sdk"
import { createHash } from "node:crypto"

// Re-export SDK types that consumers need (type-only, erased at compile time)
export type {
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Input,
  TurnOptions,
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  WebSearchItem,
  TodoListItem,
  ErrorItem,
  Usage,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  ThreadStartedEvent,
  ThreadErrorEvent,
} from "@openai/codex-sdk"

// ---------------------------------------------------------------------------
// Dynamic ESM import (cached)
// ---------------------------------------------------------------------------

let cachedCodexClass: typeof import("@openai/codex-sdk").Codex | null = null

async function getCodexClass() {
  if (cachedCodexClass) return cachedCodexClass
  const sdk = await import("@openai/codex-sdk")
  cachedCodexClass = sdk.Codex
  return cachedCodexClass
}

// ---------------------------------------------------------------------------
// Codex singleton (global instance, recreated when config changes)
// ---------------------------------------------------------------------------

let cachedCodex: Codex | null = null
let cachedCodexFingerprint: string | null = null

function codexFingerprint(options: CodexOptions): string {
  const hash = createHash("sha256")
  hash.update(options.apiKey ?? "")
  hash.update(JSON.stringify(options.config ?? {}))
  hash.update(options.codexPathOverride ?? "")
  hash.update(options.baseUrl ?? "")
  hash.update(JSON.stringify(options.env ?? {}))
  return hash.digest("hex")
}

/**
 * Get or create a global Codex instance. Recreated when apiKey, config, or path changes.
 * Async because the SDK is ESM-only and must be dynamically imported.
 */
export async function getOrCreateCodex(options: CodexOptions): Promise<Codex> {
  const fp = codexFingerprint(options)
  if (cachedCodex && cachedCodexFingerprint === fp) {
    return cachedCodex
  }

  const CodexCtor = await getCodexClass()
  cachedCodex = new CodexCtor(options)
  cachedCodexFingerprint = fp
  return cachedCodex
}

// ---------------------------------------------------------------------------
// Per-subChat Thread management (session isolation)
// ---------------------------------------------------------------------------

interface TrackedThread {
  threadId: string | null // null until first turn starts (thread.started event)
  thread: Thread
}

const threadMap = new Map<string, TrackedThread>()

/**
 * Start a new thread or resume an existing one for a sub-chat.
 *
 * If a threadId is known (from a previous turn stored in DB), attempt to resume.
 * If resume fails (expired session), fall back to a new thread.
 */
export function startOrResumeThread(
  codex: Codex,
  subChatId: string,
  threadOptions: ThreadOptions,
  existingThreadId?: string | null,
): Thread {
  // If there's an existing tracked thread for this sub-chat, return it
  const existing = threadMap.get(subChatId)
  if (existing) {
    return existing.thread
  }

  let thread: Thread

  if (existingThreadId) {
    try {
      thread = codex.resumeThread(existingThreadId, threadOptions)
      threadMap.set(subChatId, { threadId: existingThreadId, thread })
      return thread
    } catch {
      console.warn(
        `[codex-sdk] Failed to resume thread ${existingThreadId}, starting new thread`,
      )
    }
  }

  thread = codex.startThread(threadOptions)
  threadMap.set(subChatId, { threadId: null, thread })
  return thread
}

/**
 * Update the stored threadId for a sub-chat (called when thread.started event is received).
 */
export function setThreadId(subChatId: string, threadId: string): void {
  const tracked = threadMap.get(subChatId)
  if (tracked) {
    tracked.threadId = threadId
  }
}

/**
 * Get the stored threadId for a sub-chat (for persisting to DB).
 */
export function getThreadId(subChatId: string): string | null {
  return threadMap.get(subChatId)?.threadId ?? null
}

/**
 * Clean up a thread for a sub-chat.
 */
export function cleanupThread(subChatId: string): void {
  threadMap.delete(subChatId)
}

/**
 * Clean up all threads (e.g., on app shutdown).
 */
export function cleanupAllThreads(): void {
  threadMap.clear()
  cachedCodex = null
  cachedCodexFingerprint = null
}

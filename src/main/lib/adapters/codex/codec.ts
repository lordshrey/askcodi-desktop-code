import type { AdapterSessionCodec } from "../../../../shared/types/adapter"
import { readNonEmptyString } from "../_shared/codec-utils"

// Codex session codec. Codex uses a `threadId` (sometimes `thread_id`) to resume
// a conversation against the same context.

interface CodexSessionParams {
  threadId: string
  cwd?: string
  workspaceId?: string
}

export const codexSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object") return null
    const record = raw as Record<string, unknown>
    const threadId =
      readNonEmptyString(record.threadId) ??
      readNonEmptyString(record.thread_id)
    if (!threadId) return null
    const result: CodexSessionParams = { threadId }
    const cwd = readNonEmptyString(record.cwd)
    if (cwd) result.cwd = cwd
    const workspaceId = readNonEmptyString(record.workspaceId)
    if (workspaceId) result.workspaceId = workspaceId
    return result as unknown as Record<string, unknown>
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null
    const threadId = readNonEmptyString(params.threadId)
    if (!threadId) return null
    const cleaned: Record<string, unknown> = { threadId }
    const cwd = readNonEmptyString(params.cwd)
    if (cwd) cleaned.cwd = cwd
    const workspaceId = readNonEmptyString(params.workspaceId)
    if (workspaceId) cleaned.workspaceId = workspaceId
    return cleaned
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null
    return readNonEmptyString(params.threadId)
  },
}

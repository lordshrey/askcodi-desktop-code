import type { AdapterSessionCodec } from "../../../../shared/types/adapter"
import { readNonEmptyString } from "../_shared/codec-utils"

// Claude Code session codec.
//
// Stores the SDK's session_id plus the cwd it was opened against. The cwd matters
// because Claude Code's session is bound to a working directory; resuming in a
// different cwd would surprise the agent.
//
// Spelling tolerance: Claude SDK has used `sessionId`, `session_id`, and `sessionID`
// in different versions. Normalize on ingest so older sessions still resume.

interface ClaudeCodeSessionParams {
  sessionId: string
  cwd?: string
  mode?: "plan" | "agent"
  workspaceId?: string
  repoUrl?: string
  repoRef?: string
}

export const claudeCodeSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object") return null
    const record = raw as Record<string, unknown>
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.session_id) ??
      readNonEmptyString(record.sessionID)
    if (!sessionId) return null
    const result: ClaudeCodeSessionParams = { sessionId }
    const cwd = readNonEmptyString(record.cwd)
    if (cwd) result.cwd = cwd
    const mode = readNonEmptyString(record.mode)
    if (mode === "plan" || mode === "agent") result.mode = mode
    const workspaceId = readNonEmptyString(record.workspaceId)
    if (workspaceId) result.workspaceId = workspaceId
    const repoUrl = readNonEmptyString(record.repoUrl)
    if (repoUrl) result.repoUrl = repoUrl
    const repoRef = readNonEmptyString(record.repoRef)
    if (repoRef) result.repoRef = repoRef
    return result as unknown as Record<string, unknown>
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null
    const sessionId = readNonEmptyString(params.sessionId)
    if (!sessionId) return null
    const cleaned: Record<string, unknown> = { sessionId }
    for (const key of ["cwd", "mode", "workspaceId", "repoUrl", "repoRef"] as const) {
      const value = readNonEmptyString(params[key])
      if (value) cleaned[key] = value
    }
    return cleaned
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null
    return readNonEmptyString(params.sessionId)
  },
}

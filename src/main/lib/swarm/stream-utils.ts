/**
 * SDK message-stream utilities. Walks the message stream that
 * `sdk.query()` yields and pulls structured signal out — file paths
 * touched, the final assistant answer text, etc. Pure helpers; do not
 * touch disk or call the SDK.
 */
import {
  extractPathsFromText,
  isBlockedPath,
  toProjectRelative,
} from "./path-utils"

/**
 * Walk the SDK message stream and pull file paths from three sources:
 * (1) tool_use args, (2) tool_result content (Grep matches), (3) final
 * assistant text blocks (model citing files in its answer). Returns
 * the unique set of project-relative paths.
 */
export function collectTouchedFiles(
  messages: Iterable<unknown>,
  projectRoot: string,
): Set<string> {
  const touched = new Set<string>()
  for (const msg of messages) {
    const m = msg as {
      type?: string
      message?: { role?: string; content?: unknown[] }
    }
    const role = m.type ?? m.message?.role
    const content = m.message?.content ?? []

    if (role === "assistant") {
      for (const block of content) {
        const b = block as {
          type?: string
          name?: string
          input?: Record<string, unknown>
          text?: string
        }
        if (b.type === "tool_use") {
          const fp = b.input?.file_path
          const pa = b.input?.path
          let candidate: string | null = null
          if (typeof fp === "string" && fp) candidate = fp
          else if (typeof pa === "string" && pa) candidate = pa
          if (candidate) {
            const rel = toProjectRelative(candidate, projectRoot)
            if (!isBlockedPath(rel)) touched.add(rel)
          }
        } else if (b.type === "text" && typeof b.text === "string") {
          for (const p of extractPathsFromText(b.text, projectRoot)) {
            touched.add(p)
          }
        }
      }
    } else if (role === "user") {
      for (const block of content) {
        const b = block as { type?: string; content?: unknown }
        if (b.type !== "tool_result") continue
        let raw = ""
        if (typeof b.content === "string") {
          raw = b.content
        } else if (Array.isArray(b.content)) {
          for (const c of b.content) {
            const t = (c as { text?: string }).text
            if (typeof t === "string") raw += t + "\n"
          }
        }
        for (const p of extractPathsFromText(raw, projectRoot)) {
          touched.add(p)
        }
      }
    }
  }
  return touched
}

/**
 * Collect the assistant's final text output across all assistant
 * messages in the stream. Joined with double newlines. Skips tool_use
 * blocks; only `text` blocks count. Used by minions to return their
 * structured summary back to the caller.
 */
export function collectAssistantText(messages: Iterable<unknown>): string {
  const parts: string[] = []
  for (const msg of messages) appendAssistantText(parts, msg)
  return parts.join("\n\n")
}

/**
 * Streaming counterpart of `collectAssistantText`: scan one message,
 * push any assistant `text` blocks onto `chunks`. Lets observers buffer
 * incrementally instead of retaining the full message stream.
 */
export function appendAssistantText(chunks: string[], msg: unknown): void {
  const m = msg as {
    type?: string
    message?: { role?: string; content?: unknown[] }
  }
  const role = m.type ?? m.message?.role
  if (role !== "assistant") return
  for (const block of m.message?.content ?? []) {
    const b = block as { type?: string; text?: string }
    if (b.type === "text" && typeof b.text === "string" && b.text) {
      chunks.push(b.text)
    }
  }
}

/** Tally a list of subagent_type strings into per-type counts. */
export function countByType(types: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of types) out[t] = (out[t] ?? 0) + 1
  return out
}

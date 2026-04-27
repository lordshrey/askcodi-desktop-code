/**
 * Pure helpers extracted from the canUseTool callback in claude.ts.
 *
 * These were extracted before adding the swarm_explore subagent to the SDK's
 * `agents` queryOption, so the existing Ollama param-normalization and
 * plan-mode tool-blocking behaviors are locked down by tests and can't drift
 * silently when the swarm work expands canUseTool downstream.
 */

export type DenyVerdict = {
  behavior: "deny"
  message: string
}

/**
 * Mutates `toolInput` in place to fix common parameter-name mistakes that
 * local Ollama models make (e.g., `file` instead of `file_path`). No-op when
 * the model is not Ollama or when the input is already well-formed.
 *
 * Tools normalized: Read, Write, Edit, Glob, Grep, Bash.
 */
export function normalizeOllamaToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  isUsingOllama: boolean,
): void {
  if (!isUsingOllama) return

  if (toolName === "Read" && toolInput.file && !toolInput.file_path) {
    toolInput.file_path = toolInput.file
    delete toolInput.file
  }
  if (toolName === "Write" && toolInput.file && !toolInput.file_path) {
    toolInput.file_path = toolInput.file
    delete toolInput.file
  }
  if (toolName === "Edit" && toolInput.file && !toolInput.file_path) {
    toolInput.file_path = toolInput.file
    delete toolInput.file
  }
  if (toolName === "Glob") {
    if (toolInput.directory && !toolInput.path) {
      toolInput.path = toolInput.directory
      delete toolInput.directory
    }
    if (toolInput.dir && !toolInput.path) {
      toolInput.path = toolInput.dir
      delete toolInput.dir
    }
  }
  if (toolName === "Grep") {
    if (toolInput.query && !toolInput.pattern) {
      toolInput.pattern = toolInput.query
      delete toolInput.query
    }
    if (toolInput.directory && !toolInput.path) {
      toolInput.path = toolInput.directory
      delete toolInput.directory
    }
  }
  if (toolName === "Bash" && toolInput.cmd && !toolInput.command) {
    toolInput.command = toolInput.cmd
    delete toolInput.cmd
  }
}

/**
 * Decides whether a tool call should be denied because the session is in plan
 * mode. Returns a deny verdict, or null if plan mode does not block this call.
 *
 * Rules:
 * - Edit/Write of any file whose path does not end in `.md` → deny.
 * - ExitPlanMode → deny (plan should not be implemented until explicit user
 *   command; see the message body for the model-facing reason).
 * - Anything in `blockedTools` → deny.
 * - Otherwise → null.
 */
export function evaluatePlanModeBlock(
  mode: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  blockedTools: ReadonlySet<string>,
): DenyVerdict | null {
  if (mode !== "plan") return null

  if (toolName === "Edit" || toolName === "Write") {
    const filePath =
      typeof toolInput.file_path === "string" ? toolInput.file_path : ""
    if (!/\.md$/i.test(filePath)) {
      return {
        behavior: "deny",
        message: 'Only ".md" files can be modified in plan mode.',
      }
    }
    return null
  }

  if (toolName === "ExitPlanMode") {
    return {
      behavior: "deny",
      message:
        "IMPORTANT: DONT IMPLEMENT THE PLAN UNTIL THE EXPLIT COMMAND. THE PLAN WAS **ONLY** PRESENTED TO USER, FINISH CURRENT MESSAGE AS SOON AS POSSIBLE",
    }
  }

  if (blockedTools.has(toolName)) {
    return {
      behavior: "deny",
      message: `Tool "${toolName}" blocked in plan mode.`,
    }
  }

  return null
}

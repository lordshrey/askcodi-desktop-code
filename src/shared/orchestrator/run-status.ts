// Run + issue status terminals. Pure constants — safe for both main and renderer.
// Renderer also re-exports timeAgo + STATUS_META icon mappings from
// src/renderer/features/orchestrator/status-meta.ts (icons can't live in shared
// because they pull lucide-react which is renderer-only).

export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number]

export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const
export type TerminalIssueStatus = (typeof TERMINAL_ISSUE_STATUSES)[number]

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

export function isTerminalIssueStatus(status: string): boolean {
  return (TERMINAL_ISSUE_STATUSES as readonly string[]).includes(status)
}

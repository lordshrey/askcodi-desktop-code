import type { AdapterContextPayload } from "../../../../shared/types/adapter"

/**
 * Compose the user-facing prompt for an orchestrator run from issue context.
 * Used by every adapter's execute(); identical across providers because the
 * relevant signal (title, description, parent, continuation summary, wake comment)
 * is provider-agnostic.
 */
export function buildIssuePrompt(context: AdapterContextPayload): string {
  const lines: string[] = []
  if (context.issue) {
    lines.push(`# Issue ${context.issue.identifier}: ${context.issue.title}`)
    if (context.issue.description) {
      lines.push("")
      lines.push(context.issue.description)
    }
  }
  if (context.project) {
    lines.push("")
    lines.push(`Project: ${context.project.name} at ${context.project.path}`)
  }
  if (context.parentIssue) {
    lines.push("")
    lines.push(
      `Parent issue: ${context.parentIssue.id} — ${context.parentIssue.title}`,
    )
  }
  if (context.continuationSummary) {
    lines.push("")
    lines.push("## Continuation summary from prior runs")
    lines.push(context.continuationSummary)
  }
  if (context.prompt) {
    lines.push("")
    lines.push("## Instructions")
    lines.push(context.prompt)
  }
  if (context.wakeComment) {
    lines.push("")
    lines.push(`## New comment that triggered this run`)
    lines.push(context.wakeComment)
  }
  if (lines.length === 0) {
    return "Please review your assigned work and proceed."
  }
  lines.push("")
  lines.push(
    "Work autonomously to advance this issue. When you've made meaningful progress or completed it, summarize what you did in your final message.",
  )
  return lines.join("\n")
}

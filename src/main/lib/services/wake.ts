import { enqueueWakeup, type WakeupSource } from "./heartbeat"

/** Standardized taskKey for a per-issue agent session. Used as the key into
 *  agent_task_sessions, so it must stay stable across the lifetime of an issue. */
export function issueTaskKey(issueId: string): string {
  return `issue:${issueId}`
}

interface WakeOnAssignmentInput {
  issueId: string
  /** The agent the issue was just assigned to. */
  assigneeRuntimeAgentId: string
  reason: string
  source?: WakeupSource
  byActorType: "user" | "agent" | "system"
  byActorId: string
}

/**
 * Wake an agent because an issue was assigned to them. Used by:
 *   - issues.update tRPC procedure when assignee changes
 *   - MCP createIssue tool when assignee is set
 *   - MCP updateIssue tool when assignee changes
 *   - MCP runIssue tool (with reason="delegated_by_agent")
 *
 * Three callers used to construct the same payload by hand. Centralizing them
 * here removes the drift risk.
 */
export async function wakeOnAssignment(input: WakeOnAssignmentInput): Promise<void> {
  await enqueueWakeup({
    runtimeAgentId: input.assigneeRuntimeAgentId,
    source: input.source ?? "assignment",
    reason: input.reason,
    payload: {
      issueId: input.issueId,
      mutation: "assignment",
      byActorId: input.byActorId,
    },
    contextSnapshot: {
      issueId: input.issueId,
      taskKey: issueTaskKey(input.issueId),
    },
    issueId: input.issueId,
    requestedByActorType: input.byActorType,
    requestedByActorId: input.byActorId,
  })
}

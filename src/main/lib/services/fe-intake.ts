import { ensureFoundingEngineer } from "../agents/founding-engineer"
import { enqueueWakeup, type WakeupOutcome } from "./heartbeat"

// FE intake: when a human creates or imports an issue without an assignee,
// wake the project's Founding Engineer so it can route the work (claim it,
// hire a specialist, or post a clarifying question).
//
// Idempotency: enqueueWakeup creates a new wakeup row each call, but the
// dispatcher already coalesces queued runs against the same agent — back-to-back
// intake calls don't spawn parallel runs, the second wakeup is picked up by the
// first run when it polls. Bulk-import fan-out is a Phase 3 concern (TODO #6).

export interface EnqueueFeIntakeInput {
  projectId: string
  issueId: string
  chatId?: string | null  // first chat attached to the issue, if any
  reason?: string         // human-readable trigger ("manual_create" | "external_import")
  requestedByActorType?: "user" | "agent" | "system"
  requestedByActorId?: string | null
}

export async function enqueueFeIntake(input: EnqueueFeIntakeInput): Promise<WakeupOutcome> {
  const fe = await ensureFoundingEngineer(input.projectId)
  return enqueueWakeup({
    runtimeAgentId: fe.id,
    source: "fe_intake",
    reason: input.reason ?? "fe_intake",
    payload: { issueId: input.issueId, chatId: input.chatId ?? null },
    contextSnapshot: { issueId: input.issueId, intakeChatId: input.chatId ?? null },
    issueId: input.issueId,
    requestedByActorType: input.requestedByActorType ?? "user",
    requestedByActorId: input.requestedByActorId ?? "self",
  })
}

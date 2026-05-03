import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"

// ============ AGENT WAKEUP REQUESTS ============
// Queue table. Every wakeup attempt writes a row here, even if pre-flight gates skip the run.
// Provides a complete audit trail of "why did (or didn't) this agent wake up".
//
// status lifecycle:
//   queued                     ← admitted; a heartbeat run row exists
//   skipped                    ← pre-flight failed (budget, paused, hold, deps); no run created
//   coalesced                  ← merged into an in-flight run's contextSnapshot
//   deferred_issue_execution   ← waiting for a different agent to release the issue
//   claimed                    ← run picked it up
//   completed | failed | cancelled ← terminal mirrors of run terminus
export const agentWakeupRequests = sqliteTable("agent_wakeup_requests", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  runtimeAgentId: text("runtime_agent_id").notNull()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  source: text("source").notNull(),                  // timer | assignment | on_demand | automation | system
  triggerDetail: text("trigger_detail"),             // null | "manual" | "system" | "callback"
  reason: text("reason"),                            // human-readable, e.g. "heartbeat_timer" | "child_completed"
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("queued"),
  coalescedCount: integer("coalesced_count").notNull().default(0),
  requestedByActorType: text("requested_by_actor_type"),  // user | agent | system
  requestedByActorId: text("requested_by_actor_id"),
  idempotencyKey: text("idempotency_key"),
  runId: text("run_id"),                             // backref to agent_runs row, set after queue
  contextSnapshot: text("context_snapshot", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  requestedAt: integer("requested_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  claimedAt: integer("claimed_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  error: text("error"),
}, (t) => [
  index("agent_wakeup_requests_agent_status_idx").on(t.runtimeAgentId, t.status),
  index("agent_wakeup_requests_requested_idx").on(t.requestedAt),
  index("agent_wakeup_requests_idempotency_idx").on(t.idempotencyKey),
])

export const agentWakeupRequestsRelations = relations(agentWakeupRequests, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [agentWakeupRequests.runtimeAgentId],
    references: [runtimeAgents.id],
  }),
}))

export type AgentWakeupRequest = typeof agentWakeupRequests.$inferSelect
export type NewAgentWakeupRequest = typeof agentWakeupRequests.$inferInsert

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"
import { agentRuns } from "./agent-runs"

// ============ ACTIVITY LOG ============
// Append-only audit of every mutation in the system.
// Every issue checkout, status change, comment, document update, hire decision,
// run cancellation, etc. writes a row here.
//
// This is what makes "why did this happen?" a 1-query debugging tool instead of
// archeology across log files. Cheap to write; durable; queryable by entity.
//
// actorType:
//   user   → the human (board); actorId is "self" for desktop single-user
//   agent  → a runtime agent; actorId = runtime_agent_id
//   system → automated triggers (timer ticks, watchdog kills, recovery)
//   plugin → reserved for future plugin-originated mutations
export const activityLog = sqliteTable("activity_log", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  actorType: text("actor_type").notNull(),                 // user | agent | system | plugin
  actorId: text("actor_id").notNull(),                     // "self" for user, agentId for agent, "system" for system
  action: text("action").notNull(),                        // namespaced verb, e.g. "issue.checked_out"
  entityType: text("entity_type").notNull(),               // issue | runtime_agent | agent_run | issue_document | ...
  entityId: text("entity_id").notNull(),
  // Optional FKs for fast joins on common queries
  runtimeAgentId: text("runtime_agent_id").references(() => runtimeAgents.id, { onDelete: "set null" }),
  agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  // Free-form details (sanitized of secrets before insert)
  details: text("details", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("activity_log_created_idx").on(t.createdAt),
  index("activity_log_entity_idx").on(t.entityType, t.entityId, t.createdAt),
  index("activity_log_actor_idx").on(t.actorType, t.actorId, t.createdAt),
  index("activity_log_run_idx").on(t.agentRunId),
])

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [activityLog.runtimeAgentId],
    references: [runtimeAgents.id],
  }),
  run: one(agentRuns, { fields: [activityLog.agentRunId], references: [agentRuns.id] }),
}))

export type ActivityLog = typeof activityLog.$inferSelect
export type NewActivityLog = typeof activityLog.$inferInsert

import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"
import { agentRuns } from "./agent-runs"

// ============ AGENT TASK SESSIONS ============
// The agent's "memory" between runs on the same task.
// Keyed by (runtimeAgentId, adapterType, taskKey). One row per agent × task.
//
// On run completion, the adapter's sessionCodec.serialize() encodes adapter-specific
// session state (e.g. Claude session_id + cwd, Codex thread_id) into sessionParamsJson.
// On the next run for the same task, codec.deserialize() restores it and the adapter
// resumes the underlying provider session instead of starting fresh.
//
// This is the single point of "carry forward" between heartbeats.
export const agentTaskSessions = sqliteTable("agent_task_sessions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  runtimeAgentId: text("runtime_agent_id").notNull()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  adapterType: text("adapter_type").notNull(),
  taskKey: text("task_key").notNull(),                       // typically "issue:{issueId}" or "freeform:{chatId}"
  sessionParamsJson: text("session_params_json", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  sessionDisplayId: text("session_display_id"),              // human label, e.g. Claude session ID
  lastRunId: text("last_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("agent_task_sessions_agent_adapter_key_uq")
    .on(t.runtimeAgentId, t.adapterType, t.taskKey),
  index("agent_task_sessions_agent_idx").on(t.runtimeAgentId),
])

export const agentTaskSessionsRelations = relations(agentTaskSessions, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [agentTaskSessions.runtimeAgentId],
    references: [runtimeAgents.id],
  }),
  lastRun: one(agentRuns, {
    fields: [agentTaskSessions.lastRunId],
    references: [agentRuns.id],
  }),
}))

export type AgentTaskSession = typeof agentTaskSessions.$inferSelect
export type NewAgentTaskSession = typeof agentTaskSessions.$inferInsert

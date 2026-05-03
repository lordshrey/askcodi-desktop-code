import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { runtimeAgents } from "./runtime-agents"
import { agentRuns } from "./agent-runs"

// ============ AGENT RUNTIME STATE ============
// One row per agent. Cumulative usage and last-known status.
// Updated on every run completion.
//
// Drives:
//   - dashboard "Total tokens / Total cost for this agent"
//   - budget enforcement: next wakeup checks (totalCostCents) against budgetMonthlyCents
//   - "last error" surface in the agent detail UI
//
// Token totals are stored as INTEGER (SQLite's 8-byte signed int handles up to ~9.2e18,
// so no need for bigint translation).
export const agentRuntimeState = sqliteTable("agent_runtime_state", {
  runtimeAgentId: text("runtime_agent_id").primaryKey()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  adapterType: text("adapter_type").notNull(),
  // Legacy single-session fallback (predates agent_task_sessions; kept for adapters that
  // don't have a sessionCodec yet).
  sessionId: text("session_id"),
  stateJson: text("state_json", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  lastRunId: text("last_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  lastRunStatus: text("last_run_status"),
  // Cumulative usage
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalCachedInputTokens: integer("total_cached_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  totalCostCents: integer("total_cost_cents").notNull().default(0),
  // Most recent terminal error (if any)
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
})

export const agentRuntimeStateRelations = relations(agentRuntimeState, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [agentRuntimeState.runtimeAgentId],
    references: [runtimeAgents.id],
  }),
  lastRun: one(agentRuns, {
    fields: [agentRuntimeState.lastRunId],
    references: [agentRuns.id],
  }),
}))

export type AgentRuntimeState = typeof agentRuntimeState.$inferSelect
export type NewAgentRuntimeState = typeof agentRuntimeState.$inferInsert

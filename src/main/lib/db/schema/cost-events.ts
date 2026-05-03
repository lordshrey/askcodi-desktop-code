import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"
import { agentRuns } from "./agent-runs"
import { issues } from "./issues"
import { projects } from "./index"

// ============ COST EVENTS ============
// One row per LLM call (NOT per run). A single run that does 5 LLM calls produces 5 events.
//
// For adapters that report cumulative usage (e.g. Claude session totals), the heartbeat
// service computes a delta against the previous event for the same session before insert,
// so events here represent only what THIS call cost.
//
// Idempotency: (agentRunId, providerExternalCallId) is unique. Adapters that retry
// transient errors won't double-charge.
export const costEvents = sqliteTable("cost_events", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  runtimeAgentId: text("runtime_agent_id").notNull()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  agentRunId: text("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  billingCode: text("billing_code"),
  // Provider attribution
  provider: text("provider").notNull(),                        // anthropic | openai | google | xai | ollama | ...
  biller: text("biller").notNull(),                            // typically same as provider
  billingType: text("billing_type").notNull().default("unknown"),  // api | subscription | metered_api | subscription_overage | unknown
  model: text("model").notNull(),
  // Usage and cost
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  // Idempotency: provider's external call/request ID, when the SDK exposes one.
  providerExternalCallId: text("provider_external_call_id"),
  occurredAt: integer("occurred_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("cost_events_agent_idx").on(t.runtimeAgentId, t.occurredAt),
  index("cost_events_run_idx").on(t.agentRunId),
  index("cost_events_project_idx").on(t.projectId, t.occurredAt),
  uniqueIndex("cost_events_call_idempotency_uq")
    .on(t.agentRunId, t.providerExternalCallId),
])

export const costEventsRelations = relations(costEvents, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [costEvents.runtimeAgentId],
    references: [runtimeAgents.id],
  }),
  run: one(agentRuns, { fields: [costEvents.agentRunId], references: [agentRuns.id] }),
  issue: one(issues, { fields: [costEvents.issueId], references: [issues.id] }),
  project: one(projects, { fields: [costEvents.projectId], references: [projects.id] }),
}))

export type CostEvent = typeof costEvents.$inferSelect
export type NewCostEvent = typeof costEvents.$inferInsert

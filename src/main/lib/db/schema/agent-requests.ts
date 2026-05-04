import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"
import { agentRuns } from "./agent-runs"
import { issues } from "./issues"

// ============ AGENT REQUESTS ============
// Questions/requests an agent raises during a run. Routes to the founding
// engineer by default; the FE auto-answers `info` and `decision` requests in
// scope, and bubbles `critical` ones to the human inbox.
//
// status state machine:
//   pending ──[fe_answers]──> resolved
//   pending ──[severity=critical]──> human_review ──[approve|reject]──> resolved
//   pending ──[run cancelled]──> abandoned
export const agentRequests = sqliteTable("agent_requests", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  fromAgentId: text("from_agent_id")
    .notNull()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  // Who should answer. "founding_engineer" auto-routes to the FE; "human" goes
  // straight to the inbox (rare — only when the FE explicitly defers).
  addressedTo: text("addressed_to").notNull().default("founding_engineer"), // "founding_engineer" | "human"
  // info     = FYI, no answer needed (still recorded for audit)
  // decision = FE answers via run; non-blocking unless agent waits on it
  // critical = always goes to human inbox; agent typically blocks
  severity: text("severity").notNull().default("decision"),
  kind: text("kind"),                      // free-form tag, e.g. "scope_question" | "approval_request" | "design_choice"
  body: text("body").notNull(),
  // Optional structured context (file paths, diffs, options enumerated)
  context: text("context", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  status: text("status").notNull().default("pending"), // pending | human_review | resolved | abandoned
  resolutionBy: text("resolution_by"),     // "fe_auto" | "human" | runtime_agent_id
  resolution: text("resolution"),          // free-form text answer
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("agent_requests_status_idx").on(t.status),
  index("agent_requests_severity_status_idx").on(t.severity, t.status),
  index("agent_requests_run_idx").on(t.runId),
  index("agent_requests_issue_idx").on(t.issueId),
])

export const agentRequestsRelations = relations(agentRequests, ({ one }) => ({
  fromAgent: one(runtimeAgents, {
    fields: [agentRequests.fromAgentId],
    references: [runtimeAgents.id],
  }),
  run: one(agentRuns, {
    fields: [agentRequests.runId],
    references: [agentRuns.id],
  }),
  issue: one(issues, {
    fields: [agentRequests.issueId],
    references: [issues.id],
  }),
}))

export type AgentRequest = typeof agentRequests.$inferSelect
export type NewAgentRequest = typeof agentRequests.$inferInsert

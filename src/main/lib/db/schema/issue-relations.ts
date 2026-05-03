import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { issues } from "./issues"
import { runtimeAgents } from "./runtime-agents"

// ============ ISSUE RELATIONS ============
// Directed edges between issues. Currently only "blocks" — issue A blocks issue B.
// A blocker is "resolved" only when blocker.status='done'. Cancelled blockers stay
// unresolved until the relation is explicitly removed (forces explicit acknowledgment).
//
// Composite PK: (sourceIssueId, targetIssueId, type) — at most one edge of each type
// between any pair of issues.
export const issueRelations = sqliteTable("issue_relations", {
  sourceIssueId: text("source_issue_id").notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  targetIssueId: text("target_issue_id").notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  type: text("type").notNull(),  // "blocks" (only type today; reserved for future "duplicates", "relates_to")
  createdByRuntimeAgentId: text("created_by_runtime_agent_id")
    .references(() => runtimeAgents.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  primaryKey({ columns: [t.sourceIssueId, t.targetIssueId, t.type] }),
  index("issue_relations_target_idx").on(t.targetIssueId, t.type),
  index("issue_relations_source_idx").on(t.sourceIssueId, t.type),
])

export const issueRelationsRelations = relations(issueRelations, ({ one }) => ({
  source: one(issues, {
    fields: [issueRelations.sourceIssueId],
    references: [issues.id],
    relationName: "blockingEdges",
  }),
  target: one(issues, {
    fields: [issueRelations.targetIssueId],
    references: [issues.id],
    relationName: "blockedByEdges",
  }),
}))

export type IssueRelation = typeof issueRelations.$inferSelect
export type NewIssueRelation = typeof issueRelations.$inferInsert

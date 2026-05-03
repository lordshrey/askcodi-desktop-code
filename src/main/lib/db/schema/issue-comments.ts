import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { issues } from "./issues"
import { runtimeAgents } from "./runtime-agents"

// ============ ISSUE COMMENTS ============
// Threaded comments on issues. Authored by the user (board) or by an agent during a run.
// On insertion the service layer parses @mentions for runtime agents and triggers wakeups.
export const issueComments = sqliteTable("issue_comments", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  issueId: text("issue_id").notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  // Author: exactly one of (authorRuntimeAgentId, isFromUser=true) is true.
  authorRuntimeAgentId: text("author_runtime_agent_id")
    .references(() => runtimeAgents.id, { onDelete: "set null" }),
  isFromUser: integer("is_from_user", { mode: "boolean" }).notNull().default(false),
  body: text("body").notNull(),
  // If posted by an agent during a run, links back. Null if user-authored or system.
  createdByRunId: text("created_by_run_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("issue_comments_issue_idx").on(t.issueId, t.createdAt),
  index("issue_comments_run_idx").on(t.createdByRunId),
])

export const issueCommentsRelations = relations(issueComments, ({ one }) => ({
  issue: one(issues, { fields: [issueComments.issueId], references: [issues.id] }),
  author: one(runtimeAgents, {
    fields: [issueComments.authorRuntimeAgentId],
    references: [runtimeAgents.id],
  }),
}))

export type IssueComment = typeof issueComments.$inferSelect
export type NewIssueComment = typeof issueComments.$inferInsert

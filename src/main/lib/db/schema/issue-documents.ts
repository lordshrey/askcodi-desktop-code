import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { issues } from "./issues"

// ============ ISSUE DOCUMENTS ============
// Inline documents attached to an issue, keyed by purpose (e.g. "plan", "analysis").
// Agents write their plans here via MCP tool rather than into the user's git repo,
// so plans live with the issue and don't get lost across branches.
//
// MVP: inline content + simple revision counter (latest wins). Phase 6 can add
// a separate revisions table if version history matters.
export const issueDocuments = sqliteTable("issue_documents", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  issueId: text("issue_id").notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  key: text("key").notNull(),                                    // "plan" | "analysis" | "continuation_summary" | ...
  content: text("content").notNull().default(""),
  mimeType: text("mime_type").notNull().default("text/markdown"),
  revision: integer("revision").notNull().default(1),
  createdByRunId: text("created_by_run_id"),
  updatedByRunId: text("updated_by_run_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  uniqueIndex("issue_documents_issue_key_uq").on(t.issueId, t.key),
  index("issue_documents_issue_idx").on(t.issueId),
])

export const issueDocumentsRelations = relations(issueDocuments, ({ one }) => ({
  issue: one(issues, { fields: [issueDocuments.issueId], references: [issues.id] }),
}))

export type IssueDocument = typeof issueDocuments.$inferSelect
export type NewIssueDocument = typeof issueDocuments.$inferInsert

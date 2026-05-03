import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { issues } from "./issues"

// ============ ISSUE WORK PRODUCTS ============
// Concrete agent outputs: PRs created, deployments triggered, sub-issues opened externally.
// Created during a run, updated reflectively as PR reviews land or deployments succeed.
//
// (companyId, provider, externalId) unique-ish — for desktop single-user, we drop companyId
// and rely on (provider, externalId) inside a project boundary.
export const issueWorkProducts = sqliteTable("issue_work_products", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  issueId: text("issue_id").notNull()
    .references(() => issues.id, { onDelete: "cascade" }),
  type: text("type").notNull(),               // pull_request | issue | deployment | artifact
  provider: text("provider").notNull(),       // github | gitlab | linear | jira | slack | local
  externalId: text("external_id"),            // PR number, issue key, deployment ID
  title: text("title"),
  url: text("url"),
  status: text("status"),                     // draft | open | merged | closed | deployed | failed
  reviewState: text("review_state"),          // none | approved | changes_requested | pending_review
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  healthStatus: text("health_status").notNull().default("unknown"),  // unknown | healthy | degraded | failed
  summary: text("summary"),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  createdByRunId: text("created_by_run_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("issue_work_products_issue_idx").on(t.issueId, t.type),
  uniqueIndex("issue_work_products_provider_ext_uq").on(t.provider, t.externalId),
])

export const issueWorkProductsRelations = relations(issueWorkProducts, ({ one }) => ({
  issue: one(issues, { fields: [issueWorkProducts.issueId], references: [issues.id] }),
}))

export type IssueWorkProduct = typeof issueWorkProducts.$inferSelect
export type NewIssueWorkProduct = typeof issueWorkProducts.$inferInsert

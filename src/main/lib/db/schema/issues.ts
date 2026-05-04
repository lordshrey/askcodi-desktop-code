import { sqliteTable, text, integer, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { projects } from "./index"
import { runtimeAgents } from "./runtime-agents"

// ============ ISSUES ============
// The native work unit. Replaces "task" as a desktop-internal concept (external GitHub/Linear
// tasks live separately in the externalTasks router and can spawn issues via originKind).
//
// status state machine:
//   backlog → todo → in_progress → in_review → done
//                       ↓
//                    blocked (waiting on dependency or external)
//   cancelled (from any non-terminal state)
//
// Atomic checkout pattern (single most important invariant):
//   UPDATE issues SET assigneeRuntimeAgentId=?, checkoutRunId=?, executionRunId=?,
//                     status='in_progress'
//   WHERE id=? AND status IN (?expectedStatuses)
//     AND (assigneeRuntimeAgentId IS NULL OR (assigneeRuntimeAgentId=? AND ...))
//     AND (executionRunId IS NULL OR executionRunId=?)
//   → 0 rows means lost the race; another agent already grabbed it.
export const issues = sqliteTable("issues", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  parentId: text("parent_id").references((): AnySQLiteColumn => issues.id, { onDelete: "cascade" }),
  // Display
  title: text("title").notNull(),
  description: text("description"),
  identifier: text("identifier").notNull().unique(),  // e.g. "ISS-42"; unique across all projects
  issueNumber: integer("issue_number").notNull(),     // per-project sequential
  // State
  status: text("status").notNull().default("backlog"),  // backlog | todo | in_progress | in_review | blocked | done | cancelled
  priority: text("priority").notNull().default("medium"),  // low | medium | high | urgent
  // Assignment (single-assignee; the human board acts via UI without an explicit row)
  assigneeRuntimeAgentId: text("assignee_runtime_agent_id")
    .references(() => runtimeAgents.id, { onDelete: "set null" }),
  // Execution lock — atomic checkout writes here.
  // checkoutRunId is the run that holds the issue right now.
  // executionRunId may equal checkoutRunId or be null when not actively executing.
  checkoutRunId: text("checkout_run_id"),
  executionRunId: text("execution_run_id"),
  executionAgentNameKey: text("execution_agent_name_key"),
  executionLockedAt: integer("execution_locked_at", { mode: "timestamp" }),
  // Origin tracking (where this issue came from)
  originKind: text("origin_kind").notNull().default("manual"),  // manual | external_task_link | routine | child_of_issue | auto_hire
  originId: text("origin_id"),                                  // external task ID, routine ID, etc.
  originRunId: text("origin_run_id"),                           // run that created this issue
  originFingerprint: text("origin_fingerprint"),                // dedup key for routine fires
  // Workspace (per-issue git worktree, lifted from existing chats.worktreePath pattern)
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  baseBranch: text("base_branch"),
  // Adapter overrides per issue (e.g. force a specific model for this issue)
  assigneeAdapterOverrides: text("assignee_adapter_overrides", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  // Execution policy (approval/review chain config)
  executionPolicy: text("execution_policy", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  executionState: text("execution_state", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  // Recursion bound for parent/child chains created by agents
  requestDepth: integer("request_depth").notNull().default(0),
  // Lifecycle timestamps
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  hiddenAt: integer("hidden_at", { mode: "timestamp" }),
  // Audit
  createdByRuntimeAgentId: text("created_by_runtime_agent_id")
    .references(() => runtimeAgents.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("issues_status_idx").on(t.status),
  index("issues_assignee_status_idx").on(t.assigneeRuntimeAgentId, t.status),
  index("issues_parent_idx").on(t.parentId),
  index("issues_project_status_idx").on(t.projectId, t.status),
  // Routine de-dup is enforced in the service layer (not a partial unique index here).
  // Reason: SQLite partial uniqueIndex syntax in Drizzle is awkward, and the dedup window
  // is "active statuses with non-null fingerprint" which is easier to express as a query.
  index("issues_origin_fingerprint_idx").on(t.originKind, t.originId, t.originFingerprint),
])

export const issuesRelations = relations(issues, ({ one, many }) => ({
  project: one(projects, { fields: [issues.projectId], references: [projects.id] }),
  parent: one(issues, {
    fields: [issues.parentId],
    references: [issues.id],
    relationName: "parent",
  }),
  children: many(issues, { relationName: "parent" }),
  assignee: one(runtimeAgents, {
    fields: [issues.assigneeRuntimeAgentId],
    references: [runtimeAgents.id],
  }),
}))

export type Issue = typeof issues.$inferSelect
export type NewIssue = typeof issues.$inferInsert

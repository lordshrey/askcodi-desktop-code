import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { relations, sql } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"
import { projectRepos } from "./project-repos"
import { issues } from "./issues"

// ============ AGENT WORKTREES ============
// Per-(agent, repo, issue) git worktree carved from a connected repo. Path
// convention: `<askcodiRoot>/<project-slug>/<agent-slug>/<repo-name>-<issue-id>/`.
// `askcodiRoot` defaults to `~/AskCodi/`.
//
// Lifecycle:
//   created    = directory exists, branch checked out
//   active     = the agent is currently working in it (run in flight)
//   idle       = agent finished but didn't merge/discard — kept for resume
//   merged     = changes landed; can be GC'd
//   discarded  = branch deleted, dir removed
export const agentWorktrees = sqliteTable("agent_worktrees", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  agentId: text("agent_id")
    .notNull()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  repoId: text("repo_id")
    .notNull()
    .references(() => projectRepos.id, { onDelete: "cascade" }),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  path: text("path").notNull().unique(),                // absolute path on disk
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  status: text("status").notNull().default("created"),  // created | active | idle | merged | discarded
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  lastActiveAt: integer("last_active_at", { mode: "timestamp" }),
  closedAt: integer("closed_at", { mode: "timestamp" }),
}, (t) => [
  index("agent_worktrees_agent_idx").on(t.agentId),
  index("agent_worktrees_issue_idx").on(t.issueId),
  // At most one open (non-closed) worktree per (agent, repo, issue) tuple.
  // NULL issueId is handled by app code — SQLite treats NULL as distinct in
  // unique constraints, which is the behavior we want (agent can have many
  // free-form worktrees on the same repo).
  uniqueIndex("agent_worktrees_open_uq")
    .on(t.agentId, t.repoId, t.issueId)
    .where(sql`${t.status} IN ('created', 'active', 'idle')`),
])

export const agentWorktreesRelations = relations(agentWorktrees, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [agentWorktrees.agentId],
    references: [runtimeAgents.id],
  }),
  repo: one(projectRepos, {
    fields: [agentWorktrees.repoId],
    references: [projectRepos.id],
  }),
  issue: one(issues, {
    fields: [agentWorktrees.issueId],
    references: [issues.id],
  }),
}))

export type AgentWorktree = typeof agentWorktrees.$inferSelect
export type NewAgentWorktree = typeof agentWorktrees.$inferInsert

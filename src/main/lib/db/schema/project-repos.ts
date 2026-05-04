import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { relations, sql } from "drizzle-orm"
import { createId } from "../utils"
import { projects } from "./index"

// ============ PROJECT REPOS ============
// A project can have many connected repos (frontend, backend, extension, ...).
// Exactly one repo per project is marked primary; agents default to it when no
// repo is specified. The primary repo is also the source of truth for the
// project's git remote info on the orchestrator surface.
//
// Migration story: every existing project gets a `project_repos` row backfilled
// from `projects.path` + git fields with `isPrimary=true`. `projects.path`
// stays populated (write-through from the primary row) so legacy consumers
// keep working until they are migrated to read from `project_repos`.
export const projectRepos = sqliteTable("project_repos", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                             // display name, e.g. "frontend" | "backend" | "stripe-extension"
  path: text("path").notNull().unique(),                    // local checkout path
  role: text("role"),                                       // free-form tag: "frontend" | "backend" | "extension" | null
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  defaultBranch: text("default_branch"),                    // "main" | "master" | etc
  // Git remote info (mirrors fields on projects, scoped to this repo)
  gitRemoteUrl: text("git_remote_url"),
  gitProvider: text("git_provider"),                        // "github" | "gitlab" | "bitbucket" | null
  gitOwner: text("git_owner"),
  gitRepo: text("git_repo"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("project_repos_project_id_idx").on(t.projectId),
  // At most one primary repo per project. Partial unique on is_primary=true.
  uniqueIndex("project_repos_primary_per_project_uq")
    .on(t.projectId)
    .where(sql`${t.isPrimary} = 1`),
])

export const projectReposRelations = relations(projectRepos, ({ one }) => ({
  project: one(projects, {
    fields: [projectRepos.projectId],
    references: [projects.id],
  }),
}))

export type ProjectRepo = typeof projectRepos.$inferSelect
export type NewProjectRepo = typeof projectRepos.$inferInsert

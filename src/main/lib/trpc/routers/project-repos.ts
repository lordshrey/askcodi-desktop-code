import { z } from "zod"
import { eq, and, ne, desc } from "drizzle-orm"
import { dialog, BrowserWindow } from "electron"
import { basename } from "path"
import { router, publicProcedure } from "../index"
import { getDatabase, projectRepos, projects } from "../../db"
import { getGitRemoteInfo } from "../../git"
import { logActivity } from "../../services/activity-log"

// tRPC router for managing the repos attached to a project.
// A project can have many repos (frontend, backend, extension, ...). Exactly
// one repo per project is `isPrimary` — used as the default checkout when no
// repo is specified, and mirrored back to `projects.path` so legacy consumers
// keep working.

const ROLE_VALUES = ["frontend", "backend", "extension", "shared", "infra", "docs", "primary", "other"] as const

const gitInfoSchema = z
  .object({
    remoteUrl: z.string().nullable(),
    provider: z.string().nullable(),
    owner: z.string().nullable(),
    repo: z.string().nullable(),
  })
  .partial()

const addRepoSchema = z.object({
  projectId: z.string(),
  path: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  role: z.enum(ROLE_VALUES).nullable().optional(),
  setPrimary: z.boolean().default(false),
  /** Pass-through from `pickFolder` so we don't re-shell-out to git. */
  gitInfo: gitInfoSchema.optional(),
})

export const projectReposRouter = router({
  /**
   * List repos attached to a project. Primary repo is sorted first; others by
   * recency.
   */
  list: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      return db
        .select()
        .from(projectRepos)
        .where(eq(projectRepos.projectId, input.projectId))
        .orderBy(desc(projectRepos.isPrimary), desc(projectRepos.updatedAt))
        .all()
    }),

  /**
   * Open the native folder picker, return the selected path. Renderer follows
   * up with `add` to attach it. Two-step so the renderer can show a confirm
   * step (role / name) before committing.
   */
  pickFolder: publicProcedure.mutation(async ({ ctx }) => {
    const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()
    if (!window) return null
    if (!window.isFocused()) {
      window.focus()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      title: "Select Repo Folder",
      buttonLabel: "Add Repo",
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folderPath = result.filePaths[0]!
    const gitInfo = await getGitRemoteInfo(folderPath)
    return {
      path: folderPath,
      name: basename(folderPath),
      gitInfo,
    }
  }),

  /**
   * Attach a repo to a project. Extracts git remote info from the local checkout.
   * If `setPrimary` is true (or it's the first repo), demotes any existing primary
   * and writes through to `projects.path` for legacy consumers.
   */
  add: publicProcedure.input(addRepoSchema).mutation(async ({ input }) => {
    const db = getDatabase()

    const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get()
    if (!project) throw new Error("Project not found")

    const existingByPath = db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.path, input.path))
      .get()
    if (existingByPath) {
      throw new Error("This repo path is already attached to a project.")
    }

    // pickFolder already extracted git info; re-fetch only if the renderer
    // didn't pass it through (e.g. add called directly).
    const gitInfo = input.gitInfo
      ? {
          remoteUrl: input.gitInfo.remoteUrl ?? null,
          provider: (input.gitInfo.provider ?? null) as
            | "github"
            | "gitlab"
            | "bitbucket"
            | null,
          owner: input.gitInfo.owner ?? null,
          repo: input.gitInfo.repo ?? null,
        }
      : await getGitRemoteInfo(input.path)
    const name = input.name ?? basename(input.path)

    const existingRepos = db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, input.projectId))
      .all()
    const isFirst = existingRepos.length === 0
    const shouldBePrimary = input.setPrimary || isFirst

    if (shouldBePrimary) {
      // Demote any current primary so the partial unique index stays valid.
      db
        .update(projectRepos)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(projectRepos.projectId, input.projectId), eq(projectRepos.isPrimary, true)))
        .run()
    }

    const inserted = db
      .insert(projectRepos)
      .values({
        projectId: input.projectId,
        name,
        path: input.path,
        role: input.role ?? null,
        isPrimary: shouldBePrimary,
        gitRemoteUrl: gitInfo.remoteUrl,
        gitProvider: gitInfo.provider,
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
      })
      .returning()
      .all()
    const created = inserted[0]!

    if (shouldBePrimary) {
      db
        .update(projects)
        .set({
          path: input.path,
          gitRemoteUrl: gitInfo.remoteUrl,
          gitProvider: gitInfo.provider,
          gitOwner: gitInfo.owner,
          gitRepo: gitInfo.repo,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId))
        .run()
    }

    await logActivity({
      actorType: "user",
      actorId: "self",
      action: "project.repo_added",
      entityType: "project",
      entityId: input.projectId,
      details: { repoId: created.id, path: input.path, role: input.role, isPrimary: shouldBePrimary },
    })

    return created
  }),

  /**
   * Update the role / display name of a repo.
   */
  update: publicProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).max(100).optional(),
      role: z.enum(ROLE_VALUES).nullable().optional(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const updates: Partial<typeof projectRepos.$inferInsert> = { updatedAt: new Date() }
      if (input.name !== undefined) updates.name = input.name
      if (input.role !== undefined) updates.role = input.role
      const updated = db
        .update(projectRepos)
        .set(updates)
        .where(eq(projectRepos.id, input.id))
        .returning()
        .all()
      return updated[0] ?? null
    }),

  /**
   * Promote a repo to primary. Demotes any existing primary in the same project
   * and write-throughs to `projects.path`.
   */
  setPrimary: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const repo = db.select().from(projectRepos).where(eq(projectRepos.id, input.id)).get()
      if (!repo) throw new Error("Repo not found")
      if (repo.isPrimary) return repo

      db
        .update(projectRepos)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(and(eq(projectRepos.projectId, repo.projectId), eq(projectRepos.isPrimary, true)))
        .run()
      const updated = db
        .update(projectRepos)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(eq(projectRepos.id, input.id))
        .returning()
        .all()

      db
        .update(projects)
        .set({
          path: repo.path,
          gitRemoteUrl: repo.gitRemoteUrl,
          gitProvider: repo.gitProvider,
          gitOwner: repo.gitOwner,
          gitRepo: repo.gitRepo,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, repo.projectId))
        .run()

      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "project.repo_set_primary",
        entityType: "project",
        entityId: repo.projectId,
        details: { repoId: repo.id, path: repo.path },
      })

      return updated[0]!
    }),

  /**
   * Detach a repo from a project. Refuses to detach the primary repo if it's
   * the only one — the project would have no checkout left. If it's the primary
   * AND there are siblings, the most-recent sibling is auto-promoted.
   */
  remove: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const repo = db.select().from(projectRepos).where(eq(projectRepos.id, input.id)).get()
      if (!repo) throw new Error("Repo not found")

      const siblings = db
        .select()
        .from(projectRepos)
        .where(and(eq(projectRepos.projectId, repo.projectId), ne(projectRepos.id, repo.id)))
        .all()

      if (repo.isPrimary && siblings.length === 0) {
        throw new Error("Cannot remove the only repo. Detach the project instead.")
      }

      db.delete(projectRepos).where(eq(projectRepos.id, input.id)).run()

      if (repo.isPrimary && siblings.length > 0) {
        const next = siblings.sort(
          (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
        )[0]!
        db
          .update(projectRepos)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(projectRepos.id, next.id))
          .run()
        db
          .update(projects)
          .set({
            path: next.path,
            gitRemoteUrl: next.gitRemoteUrl,
            gitProvider: next.gitProvider,
            gitOwner: next.gitOwner,
            gitRepo: next.gitRepo,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, repo.projectId))
          .run()
      }

      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "project.repo_removed",
        entityType: "project",
        entityId: repo.projectId,
        details: { repoId: repo.id, path: repo.path, wasPrimary: repo.isPrimary },
      })

      return { ok: true }
    }),
})

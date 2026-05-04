import { z } from "zod"
import { eq, and, desc, isNull } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { CHAT_KIND, chats, getDatabase, projects, runtimeAgents, subChats } from "../../db"
import { logActivity } from "../../services/activity-log"

// tRPC router for the Founding Engineer chat tab.
// FE threads are stored as `chats` rows with kind=CHAT_KIND.FE_THREAD. This
// lets us reuse the entire existing chat pipeline (sub_chats, claude SDK,
// message streaming) without forking the surface.

export const feThreadsRouter = router({
  /**
   * List FE threads for a project, newest first. Excludes archived.
   */
  list: publicProcedure
    .input(z.object({ projectId: z.string(), limit: z.number().int().min(1).max(200).default(100) }))
    .query(({ input }) => {
      const db = getDatabase()
      return db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.projectId, input.projectId),
            eq(chats.kind, CHAT_KIND.FE_THREAD),
            isNull(chats.archivedAt),
          ),
        )
        .orderBy(desc(chats.updatedAt))
        .limit(input.limit)
        .all()
    }),

  /**
   * Create a new FE thread. Returns the chat row so the renderer can mount
   * the existing ActiveChat component against it.
   *
   * Mirrors the Solo `chats.create` shape just enough that ChatView can render:
   *  - one initial sub-chat (mode="agent", no initial messages)
   *  - worktreePath = project.path (FE conversations are about the project,
   *    not isolated edits — the FE delegates to issues which get their own
   *    per-agent worktrees)
   */
  create: publicProcedure
    .input(z.object({ projectId: z.string(), title: z.string().min(1).max(200).optional() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      // Sanity check: the project must have a founding engineer hired so the
      // chat has someone to talk to. If it doesn't, the renderer normally
      // calls ensureFoundingEngineer first; this is just a defense.
      const fe = db
        .select()
        .from(runtimeAgents)
        .where(
          and(
            eq(runtimeAgents.defaultProjectId, input.projectId),
            eq(runtimeAgents.isFounding, true),
          ),
        )
        .get()
      if (!fe) throw new Error("Founding engineer not hired for this project yet")

      const project = db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .get()
      if (!project) throw new Error("Project not found")

      const created = db
        .insert(chats)
        .values({
          projectId: input.projectId,
          name: input.title ?? "New thread",
          kind: CHAT_KIND.FE_THREAD,
          worktreePath: project.path,
        })
        .returning()
        .get()

      db.insert(subChats)
        .values({
          chatId: created.id,
          mode: "agent",
          messages: "[]",
        })
        .run()

      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "fe_thread.created",
        entityType: "chat",
        entityId: created.id,
        details: { projectId: input.projectId, title: created.name },
      })

      return created
    }),

  /**
   * Rename a thread.
   */
  rename: publicProcedure
    .input(z.object({ id: z.string(), title: z.string().min(1).max(200) }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const updated = db
        .update(chats)
        .set({ name: input.title, updatedAt: new Date() })
        .where(and(eq(chats.id, input.id), eq(chats.kind, CHAT_KIND.FE_THREAD)))
        .returning()
        .all()
      return updated[0] ?? null
    }),

  /**
   * Archive a thread (soft delete). Hidden from list but preserved for audit.
   */
  archive: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      db
        .update(chats)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(chats.id, input.id), eq(chats.kind, CHAT_KIND.FE_THREAD)))
        .run()
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "fe_thread.archived",
        entityType: "chat",
        entityId: input.id,
        details: {},
      })
      return { ok: true }
    }),
})

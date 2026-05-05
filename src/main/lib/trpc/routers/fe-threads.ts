import { z } from "zod"
import { eq, and, desc, isNull } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { CHAT_KIND, chats, getDatabase, runtimeAgents } from "../../db"
import { logActivity } from "../../services/activity-log"
import { createChatWithInitialSubChat } from "../../services/chats"

// tRPC router for the Founding Engineer chat tab.
// Threads are stored as `chats` rows with kind=CHAT_KIND.THREAD. This lets us
// reuse the entire existing chat pipeline (sub_chats, claude SDK, message
// streaming) without forking the surface.
//
// Router name kept as `feThreads` for one cycle to avoid renderer churn — the
// schema constant rename (FE_THREAD → THREAD) is the substantive change.

export const feThreadsRouter = router({
  /**
   * List threads for a project, newest first. Excludes archived.
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
            eq(chats.kind, CHAT_KIND.THREAD),
            isNull(chats.archivedAt),
          ),
        )
        .orderBy(desc(chats.updatedAt))
        .limit(input.limit)
        .all()
    }),

  /**
   * Create a new thread. Returns the chat row so the renderer can mount the
   * existing ActiveChat component against it.
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

      const { chat } = createChatWithInitialSubChat({
        projectId: input.projectId,
        kind: CHAT_KIND.THREAD,
        name: input.title ?? "New thread",
      })

      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "thread.created",
        entityType: "chat",
        entityId: chat.id,
        details: { projectId: input.projectId, title: chat.name },
      })

      return chat
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
        .where(and(eq(chats.id, input.id), eq(chats.kind, CHAT_KIND.THREAD)))
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
        .where(and(eq(chats.id, input.id), eq(chats.kind, CHAT_KIND.THREAD)))
        .run()
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "thread.archived",
        entityType: "chat",
        entityId: input.id,
        details: {},
      })
      return { ok: true }
    }),
})

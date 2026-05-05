import { z } from "zod"
import { eq, and, desc, isNull } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { CHAT_KIND, chats, getDatabase, issues } from "../../db"
import { logActivity } from "../../services/activity-log"
import { createChatWithInitialSubChat } from "../../services/chats"

// tRPC router for chats attached to an orchestrator issue.
// Each issue can host many chats — multiple "agent sessions" on one work unit
// (e.g., refactor, then add tests, then write docs as three chats on one issue).

export const issueChatsRouter = router({
  /**
   * List chats for an issue, newest first. Excludes archived.
   */
  list: publicProcedure
    .input(z.object({ issueId: z.string(), limit: z.number().int().min(1).max(200).default(100) }))
    .query(({ input }) => {
      const db = getDatabase()
      return db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.issueId, input.issueId),
            eq(chats.kind, CHAT_KIND.ISSUE_CHAT),
            isNull(chats.archivedAt),
          ),
        )
        .orderBy(desc(chats.updatedAt))
        .limit(input.limit)
        .all()
    }),

  /**
   * Create a new chat attached to an issue. The issue's project is resolved
   * server-side so the renderer doesn't have to plumb projectId.
   */
  create: publicProcedure
    .input(z.object({
      issueId: z.string(),
      name: z.string().min(1).max(200).optional(),
      initialMessage: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const issue = db.select().from(issues).where(eq(issues.id, input.issueId)).get()
      if (!issue) throw new Error("Issue not found")

      const initialMessages = input.initialMessage
        ? JSON.stringify([{
            id: `msg-${Date.now()}`,
            role: "user",
            parts: [{ type: "text", text: input.initialMessage }],
          }])
        : "[]"

      const { chat } = createChatWithInitialSubChat({
        projectId: issue.projectId,
        kind: CHAT_KIND.ISSUE_CHAT,
        name: input.name ?? `Chat on ${issue.identifier ?? issue.id}`,
        issueId: issue.id,
        worktreePath: issue.worktreePath,
        initialMessages,
      })

      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "issue_chat.created",
        entityType: "chat",
        entityId: chat.id,
        details: { issueId: issue.id, projectId: issue.projectId, title: chat.name },
      })

      return chat
    }),

  /**
   * Rename a chat.
   */
  rename: publicProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(200) }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const updated = db
        .update(chats)
        .set({ name: input.name, updatedAt: new Date() })
        .where(and(eq(chats.id, input.id), eq(chats.kind, CHAT_KIND.ISSUE_CHAT)))
        .returning()
        .all()
      return updated[0] ?? null
    }),

  /**
   * Archive a chat (soft delete). Hidden from list but preserved for audit.
   */
  archive: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      db
        .update(chats)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(chats.id, input.id), eq(chats.kind, CHAT_KIND.ISSUE_CHAT)))
        .run()
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "issue_chat.archived",
        entityType: "chat",
        entityId: input.id,
        details: {},
      })
      return { ok: true }
    }),
})

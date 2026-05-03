import { z } from "zod"
import { eq, desc, and } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { getDatabase, activityLog } from "../../db"

// tRPC router for the activity log feed.
// Read-only — the log is written by mutating endpoints elsewhere.
// Mirrors paperclip's /activity page.

export const activityRouter = router({
  feed: publicProcedure
    .input(
      z
        .object({
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          runtimeAgentId: z.string().optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDatabase()
      const limit = input?.limit ?? 100
      const conditions = []
      if (input?.entityType) conditions.push(eq(activityLog.entityType, input.entityType))
      if (input?.entityId) conditions.push(eq(activityLog.entityId, input.entityId))
      if (input?.runtimeAgentId) conditions.push(eq(activityLog.runtimeAgentId, input.runtimeAgentId))
      const where = conditions.length > 0 ? and(...conditions) : undefined
      return where
        ? db.select().from(activityLog).where(where).orderBy(desc(activityLog.createdAt)).limit(limit).all()
        : db.select().from(activityLog).orderBy(desc(activityLog.createdAt)).limit(limit).all()
    }),
})

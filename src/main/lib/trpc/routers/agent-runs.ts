import { z } from "zod"
import { eq, desc, and } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { getDatabase, agentRuns, agentRunEvents } from "../../db"
import { cancelRun } from "../../services/heartbeat"

// tRPC router for agent run inspection. Read-only views + cancel.
//
// MVP scope: list, get, cancel. Live event subscription comes in Phase 7
// (it needs WebSocket-like emitters that the run-store doesn't yet publish).

export const agentRunsRouter = router({
  /**
   * List runs for an agent or project. Default sort: newest first.
   */
  list: publicProcedure
    .input(
      z
        .object({
          runtimeAgentId: z.string().optional(),
          issueId: z.string().optional(),
          status: z.enum(["queued", "scheduled_retry", "running", "succeeded", "failed", "cancelled", "timed_out"]).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDatabase()
      const limit = input?.limit ?? 50
      // Build all conditions then apply once. Previous if/else-if chain dropped
      // additional filters silently when more than one was provided, and applied
      // .where() after .limit() which is fragile across Drizzle versions.
      const conditions = []
      if (input?.runtimeAgentId) conditions.push(eq(agentRuns.runtimeAgentId, input.runtimeAgentId))
      if (input?.issueId) conditions.push(eq(agentRuns.issueId, input.issueId))
      if (input?.status) conditions.push(eq(agentRuns.status, input.status))
      const where = conditions.length > 0 ? and(...conditions) : undefined
      return where
        ? db.select().from(agentRuns).where(where).orderBy(desc(agentRuns.createdAt)).limit(limit).all()
        : db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt)).limit(limit).all()
    }),

  /**
   * Get a run with its event stream (capped at 500 most-recent events).
   * For full log viewing, use a separate endpoint that streams the bulk file.
   */
  get: publicProcedure
    .input(z.object({ id: z.string(), eventLimit: z.number().int().min(1).max(2000).default(500) }))
    .query(({ input }) => {
      const db = getDatabase()
      const run = db.select().from(agentRuns).where(eq(agentRuns.id, input.id)).get()
      if (!run) return null
      const events = db
        .select()
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, input.id))
        .orderBy(desc(agentRunEvents.seq))
        .limit(input.eventLimit)
        .all()
        .reverse()  // chronological for the UI
      return { run, events }
    }),

  /**
   * Cancel a queued or running run. Process termination (PGID kill) is Phase 7;
   * for MVP, this just flips DB state and releases the issue lock.
   */
  cancel: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      await cancelRun(input.id, input.reason)
      return { ok: true }
    }),
})

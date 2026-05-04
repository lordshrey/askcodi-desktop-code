import { z } from "zod"
import { eq, desc, and, gt } from "drizzle-orm"
import { observable } from "@trpc/server/observable"
import { router, publicProcedure } from "../index"
import { getDatabase, agentRuns, agentRunEvents, type AgentRunEvent } from "../../db"
import { cancelRun } from "../../services/heartbeat"
import { subscribeToRun } from "../../services/run-store"
import { isTerminalRunStatus } from "../../../../shared/orchestrator/run-status"

// tRPC router for agent run inspection. Read-only views + cancel + live tail.

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
   * Cancel a queued or running run. Maps the cancel through to the SDK's
   * abortSignal (via heartbeat.cancelRun), flushes the run-log handle, releases
   * the issue lock, and emits a terminal notification so live-tail subscribers
   * close.
   */
  cancel: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      await cancelRun(input.id, input.reason)
      return { ok: true }
    }),

  /**
   * Live event subscription for a run. Replays existing events from `sinceSeq`
   * (default -1 = all) then streams new ones as they're persisted by run-store.
   *
   * Closes when the run reaches terminal status (succeeded/failed/cancelled/
   * timed_out). The renderer's tRPC subscription hook receives each event via
   * `onData` and the terminal close via `onComplete`.
   */
  subscribeEvents: publicProcedure
    .input(
      z.object({
        runId: z.string(),
        sinceSeq: z.number().int().optional(),
        backfillLimit: z.number().int().min(1).max(5000).optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<AgentRunEvent | { type: "terminal"; status: string }>((emit) => {
        const db = getDatabase()
        const sinceSeq = input.sinceSeq ?? -1
        const backfillLimit = input.backfillLimit ?? 2000

        // Replay events the client missed. Predicate is pushed into SQL so a
        // 100k-event run resuming from seq=99000 reads ~1k rows, not 100k.
        try {
          const backfill = db
            .select()
            .from(agentRunEvents)
            .where(
              and(eq(agentRunEvents.runId, input.runId), gt(agentRunEvents.seq, sinceSeq)),
            )
            .orderBy(agentRunEvents.seq)
            .limit(backfillLimit)
            .all()
          for (const ev of backfill) emit.next(ev)
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("[agent-runs.subscribeEvents] backfill failed:", error)
        }

        const unsubscribe = subscribeToRun(input.runId, {
          onEvent: (ev) => {
            if (ev.seq > sinceSeq) emit.next(ev)
          },
          onTerminal: ({ status }) => {
            emit.next({ type: "terminal", status })
            emit.complete()
          },
        })

        // If the run is already terminal at subscribe time, close immediately
        // after the backfill so the renderer doesn't wait for a notification
        // that will never come.
        const run = db.select().from(agentRuns).where(eq(agentRuns.id, input.runId)).get()
        if (run && isTerminalRunStatus(run.status)) {
          emit.next({ type: "terminal", status: run.status })
          emit.complete()
        }

        return unsubscribe
      })
    }),
})

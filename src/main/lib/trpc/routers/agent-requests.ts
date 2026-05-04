import { z } from "zod"
import { eq, and, desc, inArray, sql } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { getDatabase, agentRequests, runtimeAgents, issues } from "../../db"
import { logActivity } from "../../services/activity-log"

// tRPC router for the agent → FE → human escalation queue.
// `agent_requests` rows are written by the `askFoundingEngineer` MCP tool. The
// renderer reads them for the Inbox view and lets the human approve / reject /
// answer critical ones.

const SEVERITY = ["info", "decision", "critical"] as const
const STATUSES = ["pending", "human_review", "resolved", "abandoned"] as const

export const agentRequestsRouter = router({
  /**
   * List agent requests, default = the human inbox: severity=critical AND
   * status='human_review'. Pass other filters to inspect FE-handled traffic.
   */
  list: publicProcedure
    .input(
      z
        .object({
          status: z.enum(STATUSES).optional(),
          severity: z.enum(SEVERITY).optional(),
          fromAgentId: z.string().optional(),
          /** Default: critical + human_review (the inbox). */
          inboxOnly: z.boolean().default(false),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDatabase()
      const conditions = []
      if (input?.inboxOnly) {
        conditions.push(eq(agentRequests.severity, "critical"))
        conditions.push(eq(agentRequests.status, "human_review"))
      } else {
        if (input?.status) conditions.push(eq(agentRequests.status, input.status))
        if (input?.severity) conditions.push(eq(agentRequests.severity, input.severity))
      }
      if (input?.fromAgentId) conditions.push(eq(agentRequests.fromAgentId, input.fromAgentId))
      const where = conditions.length > 0 ? and(...conditions) : undefined
      const limit = input?.limit ?? 200
      return where
        ? db.select().from(agentRequests).where(where).orderBy(desc(agentRequests.createdAt)).limit(limit).all()
        : db.select().from(agentRequests).orderBy(desc(agentRequests.createdAt)).limit(limit).all()
    }),

  /**
   * Inbox count — feeds the sidebar badge. Uses count(*) on the partial index
   * rather than materializing rows.
   */
  inboxCount: publicProcedure.query(() => {
    const db = getDatabase()
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(agentRequests)
      .where(and(eq(agentRequests.severity, "critical"), eq(agentRequests.status, "human_review")))
      .get()
    return row?.n ?? 0
  }),

  /**
   * Get a single request with its calling agent + linked issue (if any).
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const req = db.select().from(agentRequests).where(eq(agentRequests.id, input.id)).get()
      if (!req) return null
      const agent = db
        .select()
        .from(runtimeAgents)
        .where(eq(runtimeAgents.id, req.fromAgentId))
        .get()
      const issue = req.issueId
        ? db.select().from(issues).where(eq(issues.id, req.issueId)).get()
        : null
      return { request: req, fromAgent: agent ?? null, issue: issue ?? null }
    }),

  /**
   * Resolve a request: human (or FE) writes an answer + decision. The
   * `decision` field tells the agent how to interpret the resolution
   * (`approved` = proceed, `rejected` = stop). Without this the agent can't
   * tell a yes from a no — both used to land as `status='resolved'`.
   */
  resolve: publicProcedure
    .input(
      z.object({
        id: z.string(),
        resolution: z.string().min(1),
        decision: z.enum(["approved", "rejected"]).default("approved"),
        resolutionBy: z.enum(["human", "fe_auto"]).default("human"),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const existing = db.select().from(agentRequests).where(eq(agentRequests.id, input.id)).get()
      if (!existing) throw new Error("Request not found")
      if (existing.status === "resolved") return existing
      const prefix = input.decision === "rejected" ? "[rejected] " : ""
      const updated = db
        .update(agentRequests)
        .set({
          status: "resolved",
          resolution: `${prefix}${input.resolution}`,
          resolutionBy: input.resolutionBy === "human" ? "human" : "fe_auto",
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentRequests.id, input.id))
        .returning()
        .all()

      await logActivity({
        actorType: input.resolutionBy === "human" ? "user" : "agent",
        actorId: input.resolutionBy === "human" ? "self" : "founding_engineer",
        action: "agent_request.resolved",
        entityType: "agent_request",
        entityId: input.id,
        details: {
          severity: existing.severity,
          fromAgentId: existing.fromAgentId,
          resolutionBy: input.resolutionBy,
          decision: input.decision,
        },
      })

      return updated[0]!
    }),

  /**
   * Mark abandoned (e.g. the run was cancelled and the question is no longer
   * relevant). Doesn't write a resolution.
   */
  abandon: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      db
        .update(agentRequests)
        .set({ status: "abandoned", updatedAt: new Date() })
        .where(eq(agentRequests.id, input.id))
        .run()
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "agent_request.abandoned",
        entityType: "agent_request",
        entityId: input.id,
        details: {},
      })
      return { ok: true }
    }),

  /**
   * Bulk-abandon all pending/human_review requests linked to a cancelled run.
   * Called from cancelRun. Exposed here so the renderer can also trigger it
   * (e.g. when an issue is cancelled).
   */
  abandonForRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(({ input }) => {
      const db = getDatabase()
      db
        .update(agentRequests)
        .set({ status: "abandoned", updatedAt: new Date() })
        .where(
          and(
            eq(agentRequests.runId, input.runId),
            inArray(agentRequests.status, ["pending", "human_review"]),
          ),
        )
        .run()
      return { ok: true }
    }),
})

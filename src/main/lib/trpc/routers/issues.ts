import { z } from "zod"
import { eq, desc, and, inArray, isNull, or } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import {
  getDatabase,
  issues,
  issueComments,
  issueRelations,
  issueDocuments,
  agentRuns,
  type NewIssueComment,
  type NewIssueDocument,
} from "../../db"
import {
  createIssue,
  getIssue,
  listIssuesForProject,
  checkoutIssue,
  IssueConflictError,
  IssueBlockedError,
} from "../../services/issues"
import { enqueueWakeup } from "../../services/heartbeat"
import { wakeOnAssignment, issueTaskKey } from "../../services/wake"
import { logActivity } from "../../services/activity-log"

// tRPC router for native orchestrator issues.
// Distinct from `externalTasks` (GitHub/Linear browsing) — these are paperclip-style
// work units owned by the orchestrator.

const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const

const PRIORITIES = ["low", "medium", "high", "urgent"] as const

const createIssueSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(PRIORITIES).default("medium"),
  status: z.enum(["backlog", "todo", "in_progress", "blocked", "in_review"]).default("todo"),
  parentId: z.string().nullable().optional(),
  assigneeRuntimeAgentId: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
})

const updateIssueSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeRuntimeAgentId: z.string().nullable().optional(),
})

export const issuesRouter = router({
  /**
   * List issues, optionally scoped to a project and/or status. Default sort: most
   * recently updated first. Mirrors paperclip's /issues endpoint.
   */
  list: publicProcedure
    .input(
      z
        .object({
          projectId: z.string().optional(),
          status: z.enum(ISSUE_STATUSES).optional(),
          assigneeRuntimeAgentId: z.string().nullable().optional(),
          parentId: z.string().nullable().optional(),
          includeHidden: z.boolean().default(false),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDatabase()
      const conditions = []
      if (input?.projectId) conditions.push(eq(issues.projectId, input.projectId))
      if (input?.status) conditions.push(eq(issues.status, input.status))
      if (input?.parentId !== undefined) {
        conditions.push(input.parentId === null ? isNull(issues.parentId) : eq(issues.parentId, input.parentId))
      }
      if (input?.assigneeRuntimeAgentId !== undefined) {
        conditions.push(
          input.assigneeRuntimeAgentId === null
            ? isNull(issues.assigneeRuntimeAgentId)
            : eq(issues.assigneeRuntimeAgentId, input.assigneeRuntimeAgentId),
        )
      }
      if (!input?.includeHidden) conditions.push(isNull(issues.hiddenAt))

      const where = conditions.length > 0 ? and(...conditions) : undefined
      return where
        ? db.select().from(issues).where(where).orderBy(desc(issues.updatedAt)).all()
        : db.select().from(issues).orderBy(desc(issues.updatedAt)).all()
    }),

  /**
   * Get a single issue with its comments, blockers, and recent runs. The detail view binds here.
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const issue = getIssue(input.id)
      if (!issue) return null
      const db = getDatabase()
      const comments = db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, input.id))
        .orderBy(issueComments.createdAt)
        .all()
      const blockers = db
        .select({
          relation: issueRelations,
          blocker: issues,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.sourceIssueId))
        .where(and(eq(issueRelations.targetIssueId, input.id), eq(issueRelations.type, "blocks")))
        .all()
      const runs = db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.issueId, input.id))
        .orderBy(desc(agentRuns.createdAt))
        .limit(20)
        .all()
      const documents = db
        .select()
        .from(issueDocuments)
        .where(eq(issueDocuments.issueId, input.id))
        .all()
      return { issue, comments, blockers, runs, documents }
    }),

  /**
   * Create a new issue. Returns the created row with auto-generated identifier (ISS-N).
   */
  create: publicProcedure.input(createIssueSchema).mutation(async ({ input }) => {
    return createIssue({
      ...input,
      actor: { type: "user", id: "self" },
    })
  }),

  /**
   * Update issue fields. Status transitions, reassignment, priority changes go through here.
   * Important: this does NOT take the execution lock — for that, use checkout.
   */
  update: publicProcedure.input(updateIssueSchema).mutation(async ({ input }) => {
    const db = getDatabase()
    const existing = db.select().from(issues).where(eq(issues.id, input.id)).get()
    if (!existing) throw new Error("Issue not found")

    const updates: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() }
    if (input.title !== undefined) updates.title = input.title
    if (input.description !== undefined) updates.description = input.description
    if (input.status !== undefined) {
      updates.status = input.status
      if (input.status === "in_progress" && !existing.startedAt) updates.startedAt = new Date()
      if (input.status === "done" && !existing.completedAt) updates.completedAt = new Date()
      if (input.status === "cancelled" && !existing.cancelledAt) updates.cancelledAt = new Date()
    }
    if (input.priority !== undefined) updates.priority = input.priority
    if (input.assigneeRuntimeAgentId !== undefined) {
      updates.assigneeRuntimeAgentId = input.assigneeRuntimeAgentId
    }

    const updated = db.update(issues).set(updates).where(eq(issues.id, input.id)).returning().all()
    const result = updated[0]

    await logActivity({
      actorType: "user",
      actorId: "self",
      action: input.status ? "issue.status_changed" : "issue.updated",
      entityType: "issue",
      entityId: input.id,
      details: { fromStatus: existing.status, toStatus: input.status, fields: Object.keys(updates) },
    })

    if (
      input.assigneeRuntimeAgentId &&
      input.assigneeRuntimeAgentId !== existing.assigneeRuntimeAgentId &&
      result.status !== "backlog"
    ) {
      void wakeOnAssignment({
        issueId: input.id,
        assigneeRuntimeAgentId: input.assigneeRuntimeAgentId,
        reason: "issue_assigned",
        byActorType: "user",
        byActorId: "self",
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[issues.update] wake on assignment failed:", err)
      })
    }

    return result
  }),

  /**
   * Add a blocking relation. After insert, if the target issue is currently the active
   * issue, the agent's next checkout will fail with IssueBlockedError.
   */
  addBlocker: publicProcedure
    .input(z.object({ blockedIssueId: z.string(), blockerIssueId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      db
        .insert(issueRelations)
        .values({
          sourceIssueId: input.blockerIssueId,
          targetIssueId: input.blockedIssueId,
          type: "blocks",
        })
        .run()
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "issue.blocker_added",
        entityType: "issue",
        entityId: input.blockedIssueId,
        details: { blockerIssueId: input.blockerIssueId },
      })
      return { ok: true }
    }),

  /**
   * Remove a blocking relation.
   */
  removeBlocker: publicProcedure
    .input(z.object({ blockedIssueId: z.string(), blockerIssueId: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      db
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.sourceIssueId, input.blockerIssueId),
            eq(issueRelations.targetIssueId, input.blockedIssueId),
            eq(issueRelations.type, "blocks"),
          ),
        )
        .run()
      return { ok: true }
    }),

  /**
   * Add a comment. If the comment body @-mentions an agent, the service layer wakes them.
   * MVP: skip mention parsing for now — service layer to add in Phase 5.
   */
  addComment: publicProcedure
    .input(z.object({
      issueId: z.string(),
      body: z.string().min(1),
      authorRuntimeAgentId: z.string().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const row: NewIssueComment = {
        issueId: input.issueId,
        body: input.body,
        authorRuntimeAgentId: input.authorRuntimeAgentId ?? null,
        isFromUser: !input.authorRuntimeAgentId,
      }
      const inserted = db.insert(issueComments).values(row).returning().all()
      const created = inserted[0]
      await logActivity({
        actorType: input.authorRuntimeAgentId ? "agent" : "user",
        actorId: input.authorRuntimeAgentId ?? "self",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: input.issueId,
        runtimeAgentId: input.authorRuntimeAgentId ?? null,
        details: { commentId: created.id, length: input.body.length },
      })
      return created
    }),

  /**
   * Upsert a named document on an issue (e.g. "plan", "analysis"). Returns the latest revision.
   * Mirrors paperclip's PUT /issues/:id/documents/:key.
   */
  upsertDocument: publicProcedure
    .input(z.object({
      issueId: z.string(),
      key: z.string().min(1).max(64),
      content: z.string(),
      mimeType: z.string().default("text/markdown"),
    }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const existing = db
        .select()
        .from(issueDocuments)
        .where(and(eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, input.key)))
        .get()

      if (existing) {
        const updated = db
          .update(issueDocuments)
          .set({
            content: input.content,
            mimeType: input.mimeType,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(issueDocuments.id, existing.id))
          .returning()
          .all()
        await logActivity({
          actorType: "user",
          actorId: "self",
          action: "issue.document_updated",
          entityType: "issue",
          entityId: input.issueId,
          details: { key: input.key, revision: existing.revision + 1 },
        })
        return updated[0]
      }
      const row: NewIssueDocument = {
        issueId: input.issueId,
        key: input.key,
        content: input.content,
        mimeType: input.mimeType,
      }
      const inserted = db.insert(issueDocuments).values(row).returning().all()
      const created = inserted[0]
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "issue.document_created",
        entityType: "issue",
        entityId: input.issueId,
        details: { key: input.key },
      })
      return created
    }),

  /**
   * Run an issue: equivalent to "wake the assignee against this issue."
   * Validates an assignee exists, then enqueues a wakeup. The atomic checkout happens
   * inside executeRun() — this endpoint just kicks the dispatcher.
   */
  run: publicProcedure
    .input(z.object({ issueId: z.string() }))
    .mutation(async ({ input }) => {
      const issue = getIssue(input.issueId)
      if (!issue) throw new Error("Issue not found")
      if (!issue.assigneeRuntimeAgentId) {
        throw new Error("Issue has no assignee — assign an agent before running.")
      }
      const outcome = await enqueueWakeup({
        runtimeAgentId: issue.assigneeRuntimeAgentId,
        source: "on_demand",
        reason: "user_run_button",
        payload: { issueId: issue.id },
        contextSnapshot: { issueId: issue.id, taskKey: issueTaskKey(issue.id) },
        issueId: issue.id,
        requestedByActorType: "user",
        requestedByActorId: "self",
      })
      return outcome
    }),
})

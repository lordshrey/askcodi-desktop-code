import { z } from "zod"
import { eq, desc, and, inArray } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { getDatabase, agentWorktrees } from "../../db"
import {
  ensureAgentWorktree,
  closeAgentWorktree,
  gcAgentWorktree,
  readWorktreeDiff,
} from "../../services/agent-worktrees"

const OPEN_WORKTREE_STATUSES = ["created", "active", "idle"] as const

// tRPC router exposing the agent worktree lifecycle to the renderer.
// The orchestrator runtime calls `ensureAgentWorktree` directly from heartbeat;
// these endpoints are for the UI (issue detail Diff tab, agent surface).

export const agentWorktreesRouter = router({
  /**
   * List worktrees for an agent (or all). Newest first. Optionally filter to
   * still-open worktrees only.
   */
  list: publicProcedure
    .input(
      z
        .object({
          agentId: z.string().optional(),
          issueId: z.string().optional(),
          openOnly: z.boolean().default(false),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDatabase()
      const conditions = []
      if (input?.agentId) conditions.push(eq(agentWorktrees.agentId, input.agentId))
      if (input?.issueId) conditions.push(eq(agentWorktrees.issueId, input.issueId))
      if (input?.openOnly) {
        conditions.push(inArray(agentWorktrees.status, OPEN_WORKTREE_STATUSES))
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined
      return where
        ? db.select().from(agentWorktrees).where(where).orderBy(desc(agentWorktrees.createdAt)).all()
        : db.select().from(agentWorktrees).orderBy(desc(agentWorktrees.createdAt)).all()
    }),

  /**
   * Provision a worktree on demand. Idempotent — returns the existing one if
   * a matching open worktree exists.
   */
  ensure: publicProcedure
    .input(
      z.object({
        agentId: z.string(),
        repoId: z.string(),
        issueId: z.string().nullable(),
        branch: z.string().optional(),
        baseBranch: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return ensureAgentWorktree({
        agentId: input.agentId,
        repoId: input.repoId,
        issueId: input.issueId,
        branch: input.branch,
        baseBranch: input.baseBranch,
      })
    }),

  /**
   * Read the current diff in a worktree (base..HEAD plus uncommitted).
   * Truncates at 256kB by default to keep the renderer fast.
   */
  diff: publicProcedure
    .input(z.object({ worktreeId: z.string(), maxBytes: z.number().int().min(1024).max(2_000_000).optional() }))
    .query(async ({ input }) => {
      try {
        return await readWorktreeDiff(input.worktreeId, input.maxBytes)
      } catch (e) {
        return { diff: "", truncated: false, bytes: 0, error: (e as Error).message }
      }
    }),

  /**
   * Close a worktree (merged or discarded). Doesn't delete files — call gc to
   * actually remove from disk.
   */
  close: publicProcedure
    .input(z.object({ id: z.string(), outcome: z.enum(["merged", "discarded"]) }))
    .mutation(async ({ input }) => {
      await closeAgentWorktree(input.id, input.outcome)
      return { ok: true }
    }),

  /**
   * Garbage-collect a worktree (`git worktree remove --force` + delete row).
   */
  gc: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await gcAgentWorktree(input.id)
      return { ok: true }
    }),
})

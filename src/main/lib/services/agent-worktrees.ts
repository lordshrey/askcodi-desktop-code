import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { eq, and, inArray } from "drizzle-orm"
import {
  getDatabase,
  agentWorktrees,
  projectRepos,
  runtimeAgents,
  projects,
  type AgentWorktree,
} from "../db"
import { logActivity } from "./activity-log"
import { createWorktree, removeWorktree, getWorktreeDiff } from "../git/worktree"
import { sanitizeProjectName } from "../git/worktree-naming"

// Per-(agent, repo, issue) git worktree carved from a connected repo. Path
// convention: `<askcodiRoot>/<project-slug>/<agent-slug>/<repo-name>-<issue-id>/`.
//
// Lifecycle:
//   created/active/idle = "open" (writable, exists on disk)
//   merged | discarded  = "closed" (status flipped, files still present until gc)
//
// `ensureAgentWorktree` is idempotent: returns the existing open row if one
// matches, otherwise calls `createWorktree` from git/worktree.ts (execFile-based,
// LFS-aware, lock-error-categorized).

const ASKCODI_ROOT_ENV = "ASKCODI_WORKTREE_ROOT"

const OPEN_WORKTREE_STATUSES = ["created", "active", "idle"] as const

export function getAskcodiRoot(): string {
  return process.env[ASKCODI_ROOT_ENV] ?? join(homedir(), "AskCodi")
}

interface EnsureArgs {
  agentId: string
  repoId: string
  issueId: string | null
  branch?: string
  baseBranch?: string
}

export async function ensureAgentWorktree(args: EnsureArgs): Promise<AgentWorktree> {
  const db = getDatabase()

  const conditions = [
    eq(agentWorktrees.agentId, args.agentId),
    eq(agentWorktrees.repoId, args.repoId),
    inArray(agentWorktrees.status, OPEN_WORKTREE_STATUSES),
  ]
  if (args.issueId) conditions.push(eq(agentWorktrees.issueId, args.issueId))
  const existing = db.select().from(agentWorktrees).where(and(...conditions)).get()
  if (existing) return existing

  const repo = db.select().from(projectRepos).where(eq(projectRepos.id, args.repoId)).get()
  if (!repo) throw new Error(`Repo ${args.repoId} not found`)
  const agent = db.select().from(runtimeAgents).where(eq(runtimeAgents.id, args.agentId)).get()
  if (!agent) throw new Error(`Agent ${args.agentId} not found`)
  const project = db.select().from(projects).where(eq(projects.id, repo.projectId)).get()

  const baseBranch = args.baseBranch ?? repo.defaultBranch ?? "main"
  const branch = args.branch ?? `askcodi/${sanitizeProjectName(agent.name)}/${args.issueId ?? "free"}`
  const dirName = `${sanitizeProjectName(repo.name)}-${args.issueId ? args.issueId.slice(0, 8) : "free"}`
  const worktreePath = join(
    getAskcodiRoot(),
    sanitizeProjectName(project?.name ?? repo.projectId),
    sanitizeProjectName(agent.name),
    dirName,
  )

  await mkdir(dirname(worktreePath), { recursive: true })
  // Lean on createWorktree's atomic failure if the path exists — no TOCTOU
  // pre-check. createWorktree categorizes lock/LFS errors with friendly text.
  await createWorktree(repo.path, branch, worktreePath, baseBranch)

  const inserted = db
    .insert(agentWorktrees)
    .values({
      agentId: args.agentId,
      repoId: args.repoId,
      issueId: args.issueId,
      path: worktreePath,
      branch,
      baseBranch,
      status: "created",
    })
    .returning()
    .all()
  const created = inserted[0]!

  await logActivity({
    actorType: "system",
    actorId: "agent_worktrees",
    action: "agent_worktree.created",
    entityType: "agent_worktree",
    entityId: created.id,
    runtimeAgentId: args.agentId,
    details: { path: worktreePath, branch, baseBranch, issueId: args.issueId },
  })

  return created
}

export async function closeAgentWorktree(
  worktreeId: string,
  outcome: "merged" | "discarded",
): Promise<void> {
  const db = getDatabase()
  db
    .update(agentWorktrees)
    .set({ status: outcome, closedAt: new Date() })
    .where(eq(agentWorktrees.id, worktreeId))
    .run()
}

export async function gcAgentWorktree(worktreeId: string): Promise<void> {
  const db = getDatabase()
  const row = db.select().from(agentWorktrees).where(eq(agentWorktrees.id, worktreeId)).get()
  if (!row) return
  const repo = db.select().from(projectRepos).where(eq(projectRepos.id, row.repoId)).get()
  if (!repo) return
  const result = await removeWorktree(repo.path, row.path)
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error(`[agent-worktrees] failed to remove ${row.path}:`, result.error)
  }
  db.delete(agentWorktrees).where(eq(agentWorktrees.id, worktreeId)).run()
}

/**
 * Wrap getWorktreeDiff with a byte cap so the renderer never receives a
 * pathological diff that locks up scroll. Truncation is purely a UI concern,
 * not a data-integrity one.
 */
export async function readWorktreeDiff(
  worktreeId: string,
  maxBytes = 256 * 1024,
): Promise<{ diff: string; truncated: boolean; bytes: number; error?: string }> {
  const db = getDatabase()
  const row = db.select().from(agentWorktrees).where(eq(agentWorktrees.id, worktreeId)).get()
  if (!row) throw new Error("Worktree not found")
  const result = await getWorktreeDiff(row.path, row.baseBranch)
  if (!result.success) {
    return { diff: "", truncated: false, bytes: 0, error: result.error }
  }
  const full = result.diff ?? ""
  const truncated = full.length > maxBytes
  return {
    diff: truncated ? full.slice(0, maxBytes) : full,
    truncated,
    bytes: full.length,
  }
}

import { and, eq, inArray, isNull, or, sql, desc } from "drizzle-orm"
import {
  getDatabase,
  issues,
  issueRelations,
  type Issue,
  type NewIssue,
} from "../db"
import { logActivity } from "./activity-log"

// Issue service. Atomic checkout, dependency readiness, identifier generation.
//
// THE atomic checkout pattern (the single most important invariant in the orchestrator):
//
//   UPDATE issues SET assigneeRuntimeAgentId=?, checkoutRunId=?, executionRunId=?,
//                     status='in_progress', startedAt=now, updatedAt=now
//   WHERE id=? AND status IN (?expectedStatuses)
//     AND (assigneeRuntimeAgentId IS NULL
//          OR (assigneeRuntimeAgentId=? AND (checkoutRunId IS NULL OR checkoutRunId=?)))
//     AND (executionRunId IS NULL OR executionRunId=?)
//
// The compound WHERE clause is what guarantees mutual exclusion. SQLite serializes
// writes within the process (better-sqlite3 is synchronous), so two callers racing
// for the same issue cannot both win.
//
// Tested by services/__tests__/issues-checkout.test.ts.

export class IssueConflictError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "IssueConflictError"
  }
}

export class IssueBlockedError extends Error {
  constructor(
    message: string,
    public readonly unresolvedBlockerIssueIds: string[],
  ) {
    super(message)
    this.name = "IssueBlockedError"
  }
}

export interface DependencyReadiness {
  issueId: string
  unresolvedBlockerIssueIds: string[]
  isDependencyReady: boolean
}

/**
 * For each issue id, return the list of "blocks" relations whose source is not yet `done`.
 * A cancelled blocker stays unresolved until the relation is explicitly removed.
 */
export function listIssueDependencyReadinessMap(
  issueIds: string[],
): Map<string, DependencyReadiness> {
  const result = new Map<string, DependencyReadiness>()
  if (issueIds.length === 0) return result
  const db = getDatabase()

  const rows = db
    .select({
      blockedIssueId: issueRelations.targetIssueId,
      blockerIssueId: issueRelations.sourceIssueId,
      blockerStatus: issues.status,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issues.id, issueRelations.sourceIssueId))
    .where(
      and(
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.targetIssueId, issueIds),
      ),
    )
    .all()

  for (const id of issueIds) {
    result.set(id, { issueId: id, unresolvedBlockerIssueIds: [], isDependencyReady: true })
  }
  for (const row of rows) {
    const entry = result.get(row.blockedIssueId)
    if (!entry) continue
    if (row.blockerStatus !== "done") {
      entry.unresolvedBlockerIssueIds.push(row.blockerIssueId)
      entry.isDependencyReady = false
    }
  }
  return result
}

export function getDependencyReadiness(issueId: string): DependencyReadiness {
  const map = listIssueDependencyReadinessMap([issueId])
  return (
    map.get(issueId) ?? {
      issueId,
      unresolvedBlockerIssueIds: [],
      isDependencyReady: true,
    }
  )
}

interface CheckoutInput {
  issueId: string
  runtimeAgentId: string
  expectedStatuses: string[]            // typically ["backlog", "todo", "blocked", "in_review"]
  checkoutRunId: string                 // current run id this checkout is bound to
  actor: { type: "user" | "agent" | "system"; id: string }
}

/**
 * Atomic checkout. Returns the updated issue or throws:
 *   - IssueBlockedError if blockers are unresolved
 *   - IssueConflictError if the row's state didn't match the WHERE clause (lost race,
 *     wrong status, or already locked by a different run)
 */
export async function checkoutIssue(input: CheckoutInput): Promise<Issue> {
  const db = getDatabase()

  // 1) Pre-flight: blockers
  const readiness = getDependencyReadiness(input.issueId)
  if (!readiness.isDependencyReady) {
    throw new IssueBlockedError(
      "Issue is blocked by unresolved blockers",
      readiness.unresolvedBlockerIssueIds,
    )
  }

  // 2) Atomic update with compound WHERE.
  const now = new Date()
  const updated = db
    .update(issues)
    .set({
      assigneeRuntimeAgentId: input.runtimeAgentId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.checkoutRunId,
      executionLockedAt: now,
      status: "in_progress",
      startedAt: sql`COALESCE(${issues.startedAt}, ${Math.floor(now.getTime() / 1000)})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(issues.id, input.issueId),
        inArray(issues.status, input.expectedStatuses),
        or(
          isNull(issues.assigneeRuntimeAgentId),
          and(
            eq(issues.assigneeRuntimeAgentId, input.runtimeAgentId),
            or(
              isNull(issues.checkoutRunId),
              eq(issues.checkoutRunId, input.checkoutRunId),
            ),
          ),
        ),
        or(
          isNull(issues.executionRunId),
          eq(issues.executionRunId, input.checkoutRunId),
        ),
      ),
    )
    .returning()
    .all()

  if (updated.length === 0) {
    // Diagnose: what state is the row actually in?
    const current = db.select().from(issues).where(eq(issues.id, input.issueId)).get()
    throw new IssueConflictError("Issue checkout failed: state did not match expected", {
      issueId: input.issueId,
      currentStatus: current?.status ?? null,
      currentAssignee: current?.assigneeRuntimeAgentId ?? null,
      currentExecutionRunId: current?.executionRunId ?? null,
      expectedStatuses: input.expectedStatuses,
      requestedAgent: input.runtimeAgentId,
      requestedRunId: input.checkoutRunId,
    })
  }

  await logActivity({
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: "issue.checked_out",
    entityType: "issue",
    entityId: input.issueId,
    runtimeAgentId: input.runtimeAgentId,
    agentRunId: input.checkoutRunId,
    details: { previousStatus: input.expectedStatuses },
  })

  return updated[0]
}

/**
 * Release execution lock when a run terminates (success or failure).
 * Does NOT change the issue's status — the run handler decides what status to leave the
 * issue in (succeeded → done? in_review? leave as-is for next run?).
 */
export async function releaseIssueExecutionLock(
  issueId: string,
  runId: string,
): Promise<void> {
  const db = getDatabase()
  db
    .update(issues)
    .set({
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(issues.id, issueId), eq(issues.executionRunId, runId)))
    .run()
}

/**
 * Identifier generation for new issues. Format: "ISS-N" where N is monotonic per project.
 * Best-effort uniqueness via a single SELECT MAX; the unique index on identifier is the
 * actual guarantee.
 */
export function nextIdentifierForProject(projectId: string): {
  identifier: string
  issueNumber: number
} {
  const db = getDatabase()
  const row = db
    .select({ maxNumber: sql<number>`COALESCE(MAX(${issues.issueNumber}), 0)` })
    .from(issues)
    .where(eq(issues.projectId, projectId))
    .get()
  const next = (row?.maxNumber ?? 0) + 1
  return { identifier: `ISS-${next}`, issueNumber: next }
}

export interface CreateIssueInput {
  projectId: string
  title: string
  description?: string | null
  priority?: "low" | "medium" | "high" | "urgent"
  status?: "backlog" | "todo" | "in_progress" | "blocked" | "in_review"
  parentId?: string | null
  assigneeRuntimeAgentId?: string | null
  worktreePath?: string | null
  branch?: string | null
  baseBranch?: string | null
  originKind?: string
  originId?: string | null
  originRunId?: string | null
  originFingerprint?: string | null
  createdByRuntimeAgentId?: string | null
  actor: { type: "user" | "agent" | "system"; id: string }
}

export async function createIssue(input: CreateIssueInput): Promise<Issue> {
  const db = getDatabase()
  const { identifier, issueNumber } = nextIdentifierForProject(input.projectId)
  const row: NewIssue = {
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? null,
    identifier,
    issueNumber,
    status: input.status ?? "backlog",
    priority: input.priority ?? "medium",
    parentId: input.parentId ?? null,
    assigneeRuntimeAgentId: input.assigneeRuntimeAgentId ?? null,
    worktreePath: input.worktreePath ?? null,
    branch: input.branch ?? null,
    baseBranch: input.baseBranch ?? null,
    originKind: input.originKind ?? "manual",
    originId: input.originId ?? null,
    originRunId: input.originRunId ?? null,
    originFingerprint: input.originFingerprint ?? null,
    createdByRuntimeAgentId: input.createdByRuntimeAgentId ?? null,
  }
  const inserted = db.insert(issues).values(row).returning().all()
  const created = inserted[0]
  if (!created) throw new Error("Issue insert returned no rows")

  await logActivity({
    actorType: input.actor.type,
    actorId: input.actor.id,
    action: "issue.created",
    entityType: "issue",
    entityId: created.id,
    runtimeAgentId: input.createdByRuntimeAgentId ?? null,
    details: {
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      identifier,
    },
  })

  return created
}

export function getIssue(id: string): Issue | null {
  const db = getDatabase()
  return db.select().from(issues).where(eq(issues.id, id)).get() ?? null
}

export function listIssuesForProject(projectId: string): Issue[] {
  const db = getDatabase()
  return db
    .select()
    .from(issues)
    .where(eq(issues.projectId, projectId))
    .orderBy(desc(issues.updatedAt))
    .all()
}

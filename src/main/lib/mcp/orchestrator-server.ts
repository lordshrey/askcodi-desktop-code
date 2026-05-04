import { z } from "zod"
import { eq, and, desc } from "drizzle-orm"
import {
  getDatabase,
  runtimeAgents,
  issues,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  agentRuntimeState,
  type NewIssueComment,
  type NewIssueDocument,
  type NewIssueWorkProduct,
  type NewRuntimeAgent,
  type RuntimeAgent,
} from "../db"
import { logActivity } from "../services/activity-log"
import { createIssue, getIssue } from "../services/issues"
import { enqueueWakeup } from "../services/heartbeat"
import { wakeOnAssignment, issueTaskKey } from "../services/wake"
import { tryGet as tryGetAdapter } from "../adapters"
import type { AdapterType } from "../../../shared/types/adapter"
import { ADAPTER_TYPES } from "../../../shared/types/adapter"

// Orchestrator MCP server.
//
// Defines the askcodi__* tool surface that running agents call to create issues,
// hire teammates, comment, register work products, etc. Built on the Claude Agent
// SDK's `createSdkMcpServer` (in-process, no HTTP transport — saves a port and
// removes a JWT-passing failure mode).
//
// Auth model: each run gets its own MCP server instance with the calling agent's
// id and the runId baked into closures. Handlers know "who is calling" without a
// token. When other adapters (Codex, Cursor) need MCP support, we'll wrap this
// same tool surface in an HTTP adapter — the handlers stay the same.

interface AuthContext {
  /** The agent making the tool call. */
  callingAgentId: string
  /** The run during which the call happened. Used for activity log + provenance. */
  runId: string
  /** Project the calling agent is scoped to. Issues created without an explicit
   *  projectId default to this. */
  defaultProjectId?: string | null
}

function ok(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

function err(message: string): { content: [{ type: "text"; text: string }]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true }
}

async function requireCallingAgent(auth: AuthContext): Promise<RuntimeAgent> {
  const db = getDatabase()
  const agent = db
    .select()
    .from(runtimeAgents)
    .where(eq(runtimeAgents.id, auth.callingAgentId))
    .get()
  if (!agent) {
    throw new Error(`Calling agent ${auth.callingAgentId} not found`)
  }
  return agent
}

function hasPermission(agent: RuntimeAgent, key: string): boolean {
  const perms = (agent.permissions ?? {}) as Record<string, unknown>
  return perms[key] === true
}

// ===========================================================================
// Tool: createIssue
// ===========================================================================

const createIssueInputSchema = {
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked"]).optional(),
  parentIssueId: z.string().optional(),
  assigneeRuntimeAgentId: z.string().optional().describe(
    "ID of the agent to assign. Use `listAgents` to find IDs, or omit to leave unassigned (backlog).",
  ),
  projectId: z.string().optional().describe(
    "Project to create the issue in. Defaults to the calling agent's project.",
  ),
}

async function createIssueHandler(
  args: {
    title: string
    description?: string
    priority?: "low" | "medium" | "high" | "urgent"
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked"
    parentIssueId?: string
    assigneeRuntimeAgentId?: string
    projectId?: string
  },
  auth: AuthContext,
) {
  const projectId = args.projectId ?? auth.defaultProjectId
  if (!projectId) {
    return err(
      "createIssue: no projectId provided and the calling agent has no default project. Pass projectId explicitly.",
    )
  }
  const created = await createIssue({
    projectId,
    title: args.title,
    description: args.description ?? null,
    priority: args.priority ?? "medium",
    status: args.status ?? (args.assigneeRuntimeAgentId ? "todo" : "backlog"),
    parentId: args.parentIssueId ?? null,
    assigneeRuntimeAgentId: args.assigneeRuntimeAgentId ?? null,
    createdByRuntimeAgentId: auth.callingAgentId,
    actor: { type: "agent", id: auth.callingAgentId },
  })
  if (created.assigneeRuntimeAgentId && created.status !== "backlog") {
    void wakeOnAssignment({
      issueId: created.id,
      assigneeRuntimeAgentId: created.assigneeRuntimeAgentId,
      reason: "issue_assigned_by_agent",
      byActorType: "agent",
      byActorId: auth.callingAgentId,
    }).catch((wakeError) => {
      // eslint-disable-next-line no-console
      console.error("[mcp] wake on createIssue failed:", wakeError)
    })
  }
  return ok({
    id: created.id,
    identifier: created.identifier,
    title: created.title,
    status: created.status,
    assigneeRuntimeAgentId: created.assigneeRuntimeAgentId,
  })
}

// ===========================================================================
// Tool: updateIssue
// ===========================================================================

const updateIssueInputSchema = {
  issueId: z.string(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.enum([
    "backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled",
  ]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeRuntimeAgentId: z.string().nullable().optional(),
}

async function updateIssueHandler(
  args: {
    issueId: string
    title?: string
    description?: string | null
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled"
    priority?: "low" | "medium" | "high" | "urgent"
    assigneeRuntimeAgentId?: string | null
  },
  auth: AuthContext,
) {
  const db = getDatabase()
  const existing = db.select().from(issues).where(eq(issues.id, args.issueId)).get()
  if (!existing) return err(`Issue ${args.issueId} not found`)

  const updates: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() }
  if (args.title !== undefined) updates.title = args.title
  if (args.description !== undefined) updates.description = args.description
  if (args.status !== undefined) {
    updates.status = args.status
    if (args.status === "in_progress" && !existing.startedAt) updates.startedAt = new Date()
    if (args.status === "done" && !existing.completedAt) updates.completedAt = new Date()
    if (args.status === "cancelled" && !existing.cancelledAt) updates.cancelledAt = new Date()
  }
  if (args.priority !== undefined) updates.priority = args.priority
  if (args.assigneeRuntimeAgentId !== undefined) {
    updates.assigneeRuntimeAgentId = args.assigneeRuntimeAgentId
  }
  const updated = db.update(issues).set(updates).where(eq(issues.id, args.issueId)).returning().all()[0]

  await logActivity({
    actorType: "agent",
    actorId: auth.callingAgentId,
    action: args.status ? "issue.status_changed" : "issue.updated",
    entityType: "issue",
    entityId: args.issueId,
    runtimeAgentId: auth.callingAgentId,
    agentRunId: auth.runId,
    details: {
      fromStatus: existing.status,
      toStatus: args.status,
      fields: Object.keys(updates),
    },
  })

  if (
    args.assigneeRuntimeAgentId &&
    args.assigneeRuntimeAgentId !== existing.assigneeRuntimeAgentId &&
    updated.status !== "backlog"
  ) {
    void wakeOnAssignment({
      issueId: args.issueId,
      assigneeRuntimeAgentId: args.assigneeRuntimeAgentId,
      reason: "issue_reassigned_by_agent",
      byActorType: "agent",
      byActorId: auth.callingAgentId,
    }).catch(() => {})
  }

  return ok({ id: updated.id, status: updated.status, assigneeRuntimeAgentId: updated.assigneeRuntimeAgentId })
}

// ===========================================================================
// Tool: listIssues
// ===========================================================================

const listIssuesInputSchema = {
  status: z.enum([
    "backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled",
  ]).optional(),
  assigneeRuntimeAgentId: z.string().optional(),
  parentIssueId: z.string().optional(),
  projectId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}

async function listIssuesHandler(
  args: {
    status?: string
    assigneeRuntimeAgentId?: string
    parentIssueId?: string
    projectId?: string
    limit?: number
  },
  auth: AuthContext,
) {
  const db = getDatabase()
  const projectId = args.projectId ?? auth.defaultProjectId
  const conditions = []
  if (projectId) conditions.push(eq(issues.projectId, projectId))
  if (args.status) conditions.push(eq(issues.status, args.status))
  if (args.assigneeRuntimeAgentId)
    conditions.push(eq(issues.assigneeRuntimeAgentId, args.assigneeRuntimeAgentId))
  if (args.parentIssueId) conditions.push(eq(issues.parentId, args.parentIssueId))
  const where = conditions.length > 0 ? and(...conditions) : undefined
  const limit = args.limit ?? 50
  const rows = where
    ? db.select().from(issues).where(where).orderBy(desc(issues.updatedAt)).limit(limit).all()
    : db.select().from(issues).orderBy(desc(issues.updatedAt)).limit(limit).all()
  return ok(
    rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      status: r.status,
      priority: r.priority,
      assigneeRuntimeAgentId: r.assigneeRuntimeAgentId,
      parentId: r.parentId,
      updatedAt: r.updatedAt,
    })),
  )
}

// ===========================================================================
// Tool: addComment
// ===========================================================================

const addCommentInputSchema = {
  issueId: z.string(),
  body: z.string().min(1),
}

async function addCommentHandler(
  args: { issueId: string; body: string },
  auth: AuthContext,
) {
  const db = getDatabase()
  const issue = getIssue(args.issueId)
  if (!issue) return err(`Issue ${args.issueId} not found`)
  const row: NewIssueComment = {
    issueId: args.issueId,
    body: args.body,
    authorRuntimeAgentId: auth.callingAgentId,
    isFromUser: false,
    createdByRunId: auth.runId,
  }
  const created = db.insert(issueComments).values(row).returning().all()[0]
  await logActivity({
    actorType: "agent",
    actorId: auth.callingAgentId,
    action: "issue.comment_added",
    entityType: "issue",
    entityId: args.issueId,
    runtimeAgentId: auth.callingAgentId,
    agentRunId: auth.runId,
    details: { commentId: created.id, length: args.body.length },
  })
  return ok({ id: created.id })
}

// ===========================================================================
// Tool: upsertIssueDocument
// ===========================================================================

const upsertIssueDocumentInputSchema = {
  issueId: z.string(),
  key: z.string().min(1).max(64).describe(
    'Document identifier within the issue, e.g. "plan", "analysis", "continuation_summary".',
  ),
  content: z.string(),
  mimeType: z.string().optional(),
}

async function upsertIssueDocumentHandler(
  args: { issueId: string; key: string; content: string; mimeType?: string },
  auth: AuthContext,
) {
  const db = getDatabase()
  const issue = getIssue(args.issueId)
  if (!issue) return err(`Issue ${args.issueId} not found`)
  const existing = db
    .select()
    .from(issueDocuments)
    .where(and(eq(issueDocuments.issueId, args.issueId), eq(issueDocuments.key, args.key)))
    .get()
  let result
  if (existing) {
    result = db
      .update(issueDocuments)
      .set({
        content: args.content,
        mimeType: args.mimeType ?? existing.mimeType,
        revision: existing.revision + 1,
        updatedByRunId: auth.runId,
        updatedAt: new Date(),
      })
      .where(eq(issueDocuments.id, existing.id))
      .returning()
      .all()[0]
  } else {
    const row: NewIssueDocument = {
      issueId: args.issueId,
      key: args.key,
      content: args.content,
      mimeType: args.mimeType ?? "text/markdown",
      createdByRunId: auth.runId,
      updatedByRunId: auth.runId,
    }
    result = db.insert(issueDocuments).values(row).returning().all()[0]
  }
  await logActivity({
    actorType: "agent",
    actorId: auth.callingAgentId,
    action: existing ? "issue.document_updated" : "issue.document_created",
    entityType: "issue",
    entityId: args.issueId,
    runtimeAgentId: auth.callingAgentId,
    agentRunId: auth.runId,
    details: { key: args.key, revision: result.revision },
  })
  return ok({ id: result.id, revision: result.revision })
}

// ===========================================================================
// Tool: createWorkProduct
// ===========================================================================

const createWorkProductInputSchema = {
  issueId: z.string(),
  type: z.enum(["pull_request", "issue", "deployment", "artifact"]),
  provider: z.string(),
  externalId: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  isPrimary: z.boolean().optional(),
}

async function createWorkProductHandler(
  args: {
    issueId: string
    type: "pull_request" | "issue" | "deployment" | "artifact"
    provider: string
    externalId?: string
    title?: string
    url?: string
    status?: string
    summary?: string
    isPrimary?: boolean
  },
  auth: AuthContext,
) {
  const db = getDatabase()
  const issue = getIssue(args.issueId)
  if (!issue) return err(`Issue ${args.issueId} not found`)
  const row: NewIssueWorkProduct = {
    issueId: args.issueId,
    type: args.type,
    provider: args.provider,
    externalId: args.externalId ?? null,
    title: args.title ?? null,
    url: args.url ?? null,
    status: args.status ?? null,
    summary: args.summary ?? null,
    isPrimary: args.isPrimary ?? false,
    createdByRunId: auth.runId,
  }
  const created = db.insert(issueWorkProducts).values(row).returning().all()[0]
  await logActivity({
    actorType: "agent",
    actorId: auth.callingAgentId,
    action: "issue.work_product_created",
    entityType: "issue",
    entityId: args.issueId,
    runtimeAgentId: auth.callingAgentId,
    agentRunId: auth.runId,
    details: { type: args.type, provider: args.provider, workProductId: created.id },
  })
  return ok({ id: created.id })
}

// ===========================================================================
// Tool: hireAgent (gated by canCreateAgents)
// ===========================================================================

const hireAgentInputSchema = {
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(40).describe(
    'Role label, e.g. "frontend_engineer", "backend_engineer", "test_engineer", "designer".',
  ),
  title: z.string().optional(),
  adapterType: z.enum(ADAPTER_TYPES as unknown as [AdapterType, ...AdapterType[]]),
  model: z.string().optional().describe("Model id, e.g. 'claude-sonnet-4-5'. Defaults to the adapter's default."),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
  autonomyMode: z.enum(["off", "event", "timer"]).optional(),
}

async function hireAgentHandler(
  args: {
    name: string
    role: string
    title?: string
    adapterType: AdapterType
    model?: string
    budgetMonthlyCents?: number
    autonomyMode?: "off" | "event" | "timer"
  },
  auth: AuthContext,
) {
  const calling = await requireCallingAgent(auth)
  if (!hasPermission(calling, "canCreateAgents")) {
    return err(
      `Agent ${calling.name} does not have canCreateAgents permission. Only the founding engineer (and agents you grant the permission) can hire teammates.`,
    )
  }

  const adapter = tryGetAdapter(args.adapterType)
  if (!adapter) {
    return err(`Unknown adapter "${args.adapterType}". Use listAvailableAdapters first if needed.`)
  }
  const config: Record<string, unknown> = args.model ? { model: args.model } : {}
  const envTest = await adapter.testEnvironment({ config })
  if (!envTest.ok) {
    return err(`Adapter environment check failed: ${envTest.message}${envTest.fixHint ? ` — ${envTest.fixHint}` : ""}`)
  }

  const db = getDatabase()
  const row: NewRuntimeAgent = {
    name: args.name,
    role: args.role,
    title: args.title ?? null,
    adapterType: args.adapterType,
    adapterConfig: config,
    autonomyMode: args.autonomyMode ?? "event",
    budgetMonthlyCents: args.budgetMonthlyCents ?? null,
    defaultProjectId: auth.defaultProjectId ?? null,
    reportsTo: auth.callingAgentId,
    permissions: {},
    status: "idle",
  }
  const created = db.insert(runtimeAgents).values(row).returning().all()[0]
  db
    .insert(agentRuntimeState)
    .values({ runtimeAgentId: created.id, adapterType: created.adapterType })
    .onConflictDoNothing()
    .run()

  await logActivity({
    actorType: "agent",
    actorId: auth.callingAgentId,
    action: "runtime_agent.hired",
    entityType: "runtime_agent",
    entityId: created.id,
    runtimeAgentId: auth.callingAgentId,
    agentRunId: auth.runId,
    details: { hiredAgentId: created.id, role: args.role, adapterType: args.adapterType },
  })

  return ok({
    id: created.id,
    name: created.name,
    role: created.role,
    adapterType: created.adapterType,
    reportsTo: created.reportsTo,
  })
}

// ===========================================================================
// Tool: listAgents
// ===========================================================================

const listAgentsInputSchema = {
  managerId: z.string().optional().describe(
    "If provided, only list direct reports of this manager. Pass 'self' to list your own reports.",
  ),
  includeTerminated: z.boolean().optional(),
}

async function listAgentsHandler(
  args: { managerId?: string; includeTerminated?: boolean },
  auth: AuthContext,
) {
  const db = getDatabase()
  const conditions = []
  if (args.managerId === "self") {
    conditions.push(eq(runtimeAgents.reportsTo, auth.callingAgentId))
  } else if (args.managerId) {
    conditions.push(eq(runtimeAgents.reportsTo, args.managerId))
  }
  if (auth.defaultProjectId) {
    conditions.push(eq(runtimeAgents.defaultProjectId, auth.defaultProjectId))
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined
  const rows = where
    ? db.select().from(runtimeAgents).where(where).orderBy(desc(runtimeAgents.createdAt)).all()
    : db.select().from(runtimeAgents).orderBy(desc(runtimeAgents.createdAt)).all()
  return ok(
    rows
      .filter((r) => args.includeTerminated || r.status !== "terminated")
      .map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        title: r.title,
        adapterType: r.adapterType,
        status: r.status,
        isFounding: r.isFounding,
        reportsTo: r.reportsTo,
        autonomyMode: r.autonomyMode,
        spentMonthlyCents: r.spentMonthlyCents,
      })),
  )
}

// ===========================================================================
// Tool: runIssue (delegate trigger — wake the assignee)
// ===========================================================================

const runIssueInputSchema = {
  issueId: z.string(),
  reason: z.string().optional().describe("Optional human-readable reason for the wake."),
}

async function runIssueHandler(args: { issueId: string; reason?: string }, auth: AuthContext) {
  const issue = getIssue(args.issueId)
  if (!issue) return err(`Issue ${args.issueId} not found`)
  if (!issue.assigneeRuntimeAgentId) {
    return err("Issue has no assignee. Assign an agent first using updateIssue.")
  }
  const outcome = await enqueueWakeup({
    runtimeAgentId: issue.assigneeRuntimeAgentId,
    source: "on_demand",
    reason: args.reason ?? "delegated_by_agent",
    payload: { issueId: issue.id, byAgentId: auth.callingAgentId },
    contextSnapshot: { issueId: issue.id, taskKey: issueTaskKey(issue.id) },
    issueId: issue.id,
    requestedByActorType: "agent",
    requestedByActorId: auth.callingAgentId,
  })
  return ok({ status: outcome.status, runId: outcome.runId, reason: outcome.reason })
}

// ===========================================================================
// Server factory
// ===========================================================================

/**
 * Returns an MCP server config bound to this run's auth context. Pass to the
 * Claude SDK as `mcpServers: { askcodi: createOrchestratorMcpServer(auth) }`.
 *
 * Important: each run gets its own server instance. Tools close over `auth` so
 * activity log + provenance writes are correctly attributed without any token-
 * passing layer.
 */
export async function createOrchestratorMcpServer(auth: AuthContext) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  const { createSdkMcpServer, tool } = sdk

  return createSdkMcpServer({
    name: "askcodi",
    version: "0.1.0",
    tools: [
      tool(
        "createIssue",
        "Create a new issue. Use this to break work into pieces or assign sub-tasks to teammates you've hired. Returns the new issue's id and identifier (ISS-N).",
        createIssueInputSchema,
        (args) => createIssueHandler(args, auth),
      ),
      tool(
        "updateIssue",
        "Update an issue's status, priority, assignee, title, or description. Use status='done' when the issue is complete; the orchestrator will wake the parent issue's assignee.",
        updateIssueInputSchema,
        (args) => updateIssueHandler(args, auth),
      ),
      tool(
        "listIssues",
        "List issues, optionally filtered by status, assignee, parent, or project. Defaults to your project. Returns up to 50 by default.",
        listIssuesInputSchema,
        (args) => listIssuesHandler(args, auth),
      ),
      tool(
        "addComment",
        "Post a comment on an issue. Useful for status updates, feedback to teammates, and questions for the user.",
        addCommentInputSchema,
        (args) => addCommentHandler(args, auth),
      ),
      tool(
        "upsertIssueDocument",
        'Create or replace a structured document on an issue (e.g. key="plan" for the working plan, key="analysis" for investigation notes). The user reads these in the UI.',
        upsertIssueDocumentInputSchema,
        (args) => upsertIssueDocumentHandler(args, auth),
      ),
      tool(
        "createWorkProduct",
        "Register a concrete output produced by the agent — a PR, deployment, sub-issue opened externally. Lets the user see what shipped from this issue.",
        createWorkProductInputSchema,
        (args) => createWorkProductHandler(args, auth),
      ),
      tool(
        "hireAgent",
        "Hire a new teammate. The new agent reports to you. Requires the canCreateAgents permission (the founding engineer has it). Specify role (e.g. 'frontend_engineer'), adapterType, optional model + budget.",
        hireAgentInputSchema,
        (args) => hireAgentHandler(args, auth),
      ),
      tool(
        "listAgents",
        "List agents in your project. Pass managerId='self' to list your direct reports. Useful before assigning issues.",
        listAgentsInputSchema,
        (args) => listAgentsHandler(args, auth),
      ),
      tool(
        "runIssue",
        "Wake the assignee of an issue immediately (instead of waiting for an event). Use this after creating + assigning an issue to a teammate to kick them off right away.",
        runIssueInputSchema,
        (args) => runIssueHandler(args, auth),
      ),
    ],
  })
}

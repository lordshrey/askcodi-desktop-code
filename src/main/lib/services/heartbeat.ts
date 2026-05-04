import { eq, and, asc, sql } from "drizzle-orm"
import {
  getDatabase,
  agentRuns,
  agentWakeupRequests,
  agentTaskSessions,
  agentRuntimeState,
  runtimeAgents,
  issues,
  projects,
  costEvents,
  type AgentRun,
  type NewAgentRun,
  type NewAgentWakeupRequest,
  type NewCostEvent,
  type RuntimeAgent,
} from "../db"
import { buildProjectContextMarkdown } from "../agents/project-context"
import { withAgentStartLock } from "./agent-start-lock"
import { logActivity } from "./activity-log"
import { appendRunLog, finalizeRunLog, openRunLog, emitRunTerminal } from "./run-store"
import { tryGet as tryGetAdapter } from "../adapters/registry"
import { getIssue, releaseIssueExecutionLock } from "./issues"
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
  AdapterRuntime,
  AdapterSpawnInfo,
  AdapterType,
} from "../../../shared/types/adapter"

// ===========================================================================
// Heartbeat — the orchestration core.
//
// MVP path (single agent, single user, no concurrency edge cases):
//
//   enqueueWakeup ──┬──▶ pre-flight gates (status, budget, autonomy mode)
//                   │      └─[fail]─▶ wakeup row inserted with status="skipped"
//                   ▼
//             insert agent_wakeup_requests (status="queued")
//             insert agent_runs (status="queued", linked via wakeup.runId)
//                   │
//                   ▼
//             startNextQueuedRunForAgent (under withAgentStartLock per agent)
//                   │
//                   ▼
//             claim: queued → running
//                   │
//                   ▼
//             executeRun(runId)  ───▶ build context, call adapter.execute,
//                                       stream onLog/onMeta/onSpawn to run-store,
//                                       finalize on result, persist usage + cost,
//                                       upsert agent_task_sessions via codec
//
// What's deliberately NOT here yet (Phase 7 polish):
//   - Coalescing wakeups into in-flight runs (every wakeup = new run for MVP)
//   - Watchdog liveness scans
//   - Transient retry with bounded delays
//   - Process group recovery on boot
//   - Tree holds, deferred queue, complex pre-flight (budget gate IS here, the rest aren't)
// ===========================================================================

export type WakeupSource =
  | "timer"
  | "assignment"
  | "on_demand"
  | "automation"
  | "system"

export interface WakeupInput {
  runtimeAgentId: string
  source: WakeupSource
  reason?: string
  triggerDetail?: string | null
  payload?: Record<string, unknown>
  contextSnapshot?: Record<string, unknown>
  requestedByActorType?: "user" | "agent" | "system"
  requestedByActorId?: string | null
  idempotencyKey?: string | null
  issueId?: string | null
}

export interface WakeupOutcome {
  status: "queued" | "skipped"
  wakeupRequestId: string
  runId: string | null
  reason?: string
}

// ---------------------------------------------------------------------------
// Pre-flight gates
// ---------------------------------------------------------------------------

interface PreflightResult {
  ok: boolean
  reason?: string
}

function preflightAgent(agent: RuntimeAgent | null, source: WakeupSource): PreflightResult {
  if (!agent) return { ok: false, reason: "agent_not_found" }
  if (agent.status === "paused") return { ok: false, reason: "agent_paused" }
  if (agent.status === "terminated") return { ok: false, reason: "agent_terminated" }
  if (agent.status === "pending_approval") return { ok: false, reason: "agent_pending_approval" }
  // Autonomy mode (Decision 4C):
  //   off    → only "assignment" and "on_demand" wake the agent
  //   event  → all event-driven sources wake the agent (default for "real" agents)
  //   timer  → also wakes on "timer" ticks
  if (agent.autonomyMode === "off") {
    if (source === "timer" || source === "automation") {
      return { ok: false, reason: "autonomy_off" }
    }
  } else if (agent.autonomyMode === "event") {
    if (source === "timer") return { ok: false, reason: "autonomy_event_only" }
  }
  // Budget gate
  if (agent.budgetMonthlyCents != null) {
    if (agent.spentMonthlyCents >= agent.budgetMonthlyCents) {
      return { ok: false, reason: "budget_exceeded" }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// enqueueWakeup
// ---------------------------------------------------------------------------

/**
 * Inserts a wakeup request and (on success) a queued run row.
 * Always returns an outcome; never throws for "skipped" cases — those are recorded.
 */
export async function enqueueWakeup(input: WakeupInput): Promise<WakeupOutcome> {
  const db = getDatabase()
  const agent =
    db
      .select()
      .from(runtimeAgents)
      .where(eq(runtimeAgents.id, input.runtimeAgentId))
      .get() ?? null

  const preflight = preflightAgent(agent, input.source)

  const baseRow: NewAgentWakeupRequest = {
    runtimeAgentId: input.runtimeAgentId,
    source: input.source,
    triggerDetail: input.triggerDetail ?? null,
    reason: input.reason ?? null,
    payload: input.payload ?? {},
    contextSnapshot: input.contextSnapshot ?? {},
    requestedByActorType: input.requestedByActorType ?? "user",
    requestedByActorId: input.requestedByActorId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    status: preflight.ok ? "queued" : "skipped",
    finishedAt: preflight.ok ? null : new Date(),
    error: preflight.ok ? null : preflight.reason,
  }

  const insertedWakeup = db
    .insert(agentWakeupRequests)
    .values(baseRow)
    .returning()
    .all()
  const wakeup = insertedWakeup[0]

  if (!preflight.ok || !agent) {
    await logActivity({
      actorType: (input.requestedByActorType ?? "system") as "user" | "agent" | "system",
      actorId: input.requestedByActorId ?? "system",
      action: "wakeup.skipped",
      entityType: "runtime_agent",
      entityId: input.runtimeAgentId,
      runtimeAgentId: input.runtimeAgentId,
      details: { reason: preflight.reason, source: input.source },
    })
    return {
      status: "skipped",
      wakeupRequestId: wakeup.id,
      runId: null,
      reason: preflight.reason,
    }
  }

  // Create the queued run.
  const newRun: NewAgentRun = {
    runtimeAgentId: input.runtimeAgentId,
    invocationSource: input.source,
    triggerDetail: input.triggerDetail ?? null,
    wakeupRequestId: wakeup.id,
    contextSnapshot: input.contextSnapshot ?? {},
    issueId: input.issueId ?? null,
    status: "queued",
    adapterType: agent.adapterType,
  }
  const insertedRun = db.insert(agentRuns).values(newRun).returning().all()
  const run = insertedRun[0]

  // Backref wakeup → run.
  db
    .update(agentWakeupRequests)
    .set({ runId: run.id })
    .where(eq(agentWakeupRequests.id, wakeup.id))
    .run()

  await logActivity({
    actorType: (input.requestedByActorType ?? "system") as "user" | "agent" | "system",
    actorId: input.requestedByActorId ?? "system",
    action: "wakeup.queued",
    entityType: "agent_run",
    entityId: run.id,
    runtimeAgentId: input.runtimeAgentId,
    agentRunId: run.id,
    details: { source: input.source, reason: input.reason ?? null },
  })

  // Fire dispatcher synchronously after enqueue (paperclip pattern).
  // Don't await — let the run start in the background.
  void startNextQueuedRunForAgent(input.runtimeAgentId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[heartbeat] startNextQueuedRunForAgent failed:", err)
  })

  return { status: "queued", wakeupRequestId: wakeup.id, runId: run.id }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Pick up the oldest queued run for `agentId` (under the start lock) and execute it.
 * MVP: runs at most one at a time per agent. Phase 7 generalizes to maxConcurrentRuns.
 */
export async function startNextQueuedRunForAgent(
  runtimeAgentId: string,
): Promise<AgentRun | null> {
  return withAgentStartLock(runtimeAgentId, async () => {
    const db = getDatabase()

    // Don't start a new run if one is already running.
    const running = db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.runtimeAgentId, runtimeAgentId),
          eq(agentRuns.status, "running"),
        ),
      )
      .get()
    if (running) return null

    const queued = db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.runtimeAgentId, runtimeAgentId),
          eq(agentRuns.status, "queued"),
        ),
      )
      .orderBy(asc(agentRuns.createdAt))
      .limit(1)
      .get()
    if (!queued) return null

    // Atomic claim: queued → running.
    const claimed = db
      .update(agentRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, queued.id), eq(agentRuns.status, "queued")))
      .returning()
      .all()
    if (claimed.length === 0) {
      // Lost the race to another caller (shouldn't happen under the lock, but defensive).
      return null
    }
    const run = claimed[0]

    // Mark wakeup row as claimed.
    if (queued.wakeupRequestId) {
      db
        .update(agentWakeupRequests)
        .set({ status: "claimed", claimedAt: new Date() })
        .where(eq(agentWakeupRequests.id, queued.wakeupRequestId))
        .run()
    }

    // Fire the actual execution. Don't await — return the claimed run record so the
    // caller can subscribe to events. Errors land in finalizeRun.
    void executeRun(run.id).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[heartbeat] executeRun failed:", err)
    })

    return run
  })
}

// ---------------------------------------------------------------------------
// Execute run
// ---------------------------------------------------------------------------

async function buildAdapterRuntime(
  runtimeAgentId: string,
  adapterType: AdapterType,
  taskKey: string | null,
): Promise<AdapterRuntime> {
  if (!taskKey) {
    return { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }
  }
  const db = getDatabase()
  const session = db
    .select()
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.runtimeAgentId, runtimeAgentId),
        eq(agentTaskSessions.adapterType, adapterType),
        eq(agentTaskSessions.taskKey, taskKey),
      ),
    )
    .get()
  if (!session) {
    return { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey }
  }
  const adapter = tryGetAdapter(adapterType)
  const codec = adapter?.sessionCodec
  const decoded = codec ? codec.deserialize(session.sessionParamsJson) : null
  return {
    sessionId: session.sessionDisplayId,
    sessionParams: decoded,
    sessionDisplayId: session.sessionDisplayId,
    taskKey,
  }
}

async function persistFinalResult(
  run: AgentRun,
  result: AdapterExecutionResult,
  finalizeMeta: Awaited<ReturnType<typeof finalizeRunLog>>,
): Promise<void> {
  const db = getDatabase()
  const usage = result.usage
    ? {
        inputTokens: Math.max(0, Math.floor(result.usage.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.floor(result.usage.outputTokens ?? 0)),
        cachedInputTokens: Math.max(0, Math.floor(result.usage.cachedInputTokens ?? 0)),
      }
    : null

  db
    .update(agentRuns)
    .set({
      status: result.status,
      finishedAt: new Date(),
      sessionIdAfter: result.sessionId ?? run.sessionIdAfter,
      logRef: finalizeMeta.logRef,
      logBytes: finalizeMeta.logBytes,
      logCompressed: finalizeMeta.logCompressed,
      logSha256: finalizeMeta.logSha256,
      stdoutExcerpt: finalizeMeta.stdoutExcerpt,
      stderrExcerpt: finalizeMeta.stderrExcerpt,
      resultJson: result.resultJson ?? null,
      errorCode: result.errorCode ?? null,
      error: result.error ?? null,
      usageJson: usage,
      livenessState: result.status === "succeeded" ? "completed" : "failed",
      livenessReason: result.summary ?? null,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id))
    .run()

  // Wakeup row terminal state.
  if (run.wakeupRequestId) {
    db
      .update(agentWakeupRequests)
      .set({
        status:
          result.status === "succeeded"
            ? "completed"
            : result.status === "timed_out"
              ? "failed"
              : "failed",
        finishedAt: new Date(),
        error: result.error ?? null,
      })
      .where(eq(agentWakeupRequests.id, run.wakeupRequestId))
      .run()
  }

  // Cumulative agent state.
  const additionalCostCents = Math.max(0, Math.floor(result.costCents ?? 0))
  if (usage || additionalCostCents > 0) {
    db
      .insert(agentRuntimeState)
      .values({
        runtimeAgentId: run.runtimeAgentId,
        adapterType: run.adapterType,
        lastRunId: run.id,
        lastRunStatus: result.status,
        totalInputTokens: usage?.inputTokens ?? 0,
        totalCachedInputTokens: usage?.cachedInputTokens ?? 0,
        totalOutputTokens: usage?.outputTokens ?? 0,
        totalCostCents: additionalCostCents,
        lastError: result.error ?? null,
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.runtimeAgentId,
        set: {
          lastRunId: run.id,
          lastRunStatus: result.status,
          totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${usage?.inputTokens ?? 0}`,
          totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${usage?.cachedInputTokens ?? 0}`,
          totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${usage?.outputTokens ?? 0}`,
          totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
          lastError: result.error ?? null,
          updatedAt: new Date(),
        },
      })
      .run()

    // Bump the agent's spent budget so the next preflight sees it.
    db
      .update(runtimeAgents)
      .set({
        spentMonthlyCents: sql`${runtimeAgents.spentMonthlyCents} + ${additionalCostCents}`,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runtimeAgents.id, run.runtimeAgentId))
      .run()
  }

  // One cost event for the run as a whole. Adapters that emit per-call events can
  // bypass this (their own writes), but for MVP we record one summary row.
  if (additionalCostCents > 0 || usage) {
    const event: NewCostEvent = {
      runtimeAgentId: run.runtimeAgentId,
      agentRunId: run.id,
      issueId: run.issueId ?? null,
      provider: result.provider ?? "unknown",
      biller: result.provider ?? "unknown",
      billingType: result.billingType ?? "unknown",
      model: result.model ?? "unknown",
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costCents: additionalCostCents,
      providerExternalCallId: null,
    }
    try {
      db.insert(costEvents).values(event).run()
    } catch (error) {
      // Idempotency unique violation possible if same external_call_id; non-fatal.
      // eslint-disable-next-line no-console
      console.error("[heartbeat] cost_events insert (non-fatal):", error)
    }
  }

  // Resume state via codec.
  if (result.sessionParams && run.contextSnapshot) {
    const taskKey =
      typeof (run.contextSnapshot as Record<string, unknown>).taskKey === "string"
        ? ((run.contextSnapshot as Record<string, unknown>).taskKey as string)
        : null
    if (taskKey) {
      const adapter = tryGetAdapter(run.adapterType as AdapterType)
      const encoded = adapter?.sessionCodec?.serialize(result.sessionParams) ?? null
      if (encoded) {
        const displayId =
          adapter?.sessionCodec?.getDisplayId?.(result.sessionParams) ?? null
        db
          .insert(agentTaskSessions)
          .values({
            runtimeAgentId: run.runtimeAgentId,
            adapterType: run.adapterType,
            taskKey,
            sessionParamsJson: encoded,
            sessionDisplayId: displayId,
            lastRunId: run.id,
          })
          .onConflictDoUpdate({
            target: [
              agentTaskSessions.runtimeAgentId,
              agentTaskSessions.adapterType,
              agentTaskSessions.taskKey,
            ],
            set: {
              sessionParamsJson: encoded,
              sessionDisplayId: displayId,
              lastRunId: run.id,
              updatedAt: new Date(),
            },
          })
          .run()
      }
    }
  }

  // Release the issue's execution lock if this run held it.
  if (run.issueId) {
    await releaseIssueExecutionLock(run.issueId, run.id)
  }

  // Notify live tail subscribers that the run has reached terminal state so
  // they can close their stream cleanly.
  emitRunTerminal(run.id, result.status)
}

/**
 * The actual execution. Builds context, calls adapter.execute, finalizes.
 * Catches all errors and routes through persistFinalResult so a run never gets stuck
 * in "running" status.
 */
export async function executeRun(runId: string): Promise<void> {
  const db = getDatabase()
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get()
  if (!run) {
    // eslint-disable-next-line no-console
    console.error("[heartbeat] executeRun: run not found", runId)
    return
  }

  const agent = db
    .select()
    .from(runtimeAgents)
    .where(eq(runtimeAgents.id, run.runtimeAgentId))
    .get()
  if (!agent) {
    await persistFinalResult(
      run,
      {
        status: "failed",
        error: "agent_not_found",
        errorCode: "agent_not_found",
        errorFamily: "permanent",
      },
      await finalizeRunLog(run.id),
    )
    return
  }

  const adapter = tryGetAdapter(agent.adapterType as AdapterType)
  if (!adapter) {
    await persistFinalResult(
      run,
      {
        status: "failed",
        error: `no_adapter_registered:${agent.adapterType}`,
        errorCode: "no_adapter",
        errorFamily: "permanent",
      },
      await finalizeRunLog(run.id),
    )
    return
  }

  const issue = run.issueId ? getIssue(run.issueId) : null
  const taskKey =
    typeof (run.contextSnapshot as Record<string, unknown>).taskKey === "string"
      ? ((run.contextSnapshot as Record<string, unknown>).taskKey as string)
      : run.issueId
        ? `issue:${run.issueId}`
        : null

  // Stash taskKey into contextSnapshot so persistFinalResult can find it.
  if (taskKey && !((run.contextSnapshot as Record<string, unknown>).taskKey)) {
    db
      .update(agentRuns)
      .set({
        contextSnapshot: { ...(run.contextSnapshot ?? {}), taskKey },
      })
      .where(eq(agentRuns.id, run.id))
      .run()
    ;(run.contextSnapshot as Record<string, unknown>).taskKey = taskKey
  }

  await openRunLog(run.id)
  const runtime = await buildAdapterRuntime(
    agent.id,
    agent.adapterType as AdapterType,
    taskKey,
  )

  // Resolve project for cwd + context. Issue's project wins; otherwise the agent's
  // default project (which is set on founding-engineer hire).
  const projectId = issue?.projectId ?? agent.defaultProjectId ?? null
  const project = projectId
    ? db.select().from(projects).where(eq(projects.id, projectId)).get() ?? null
    : null
  const cwd = issue?.worktreePath ?? project?.path ?? process.cwd()

  // Project context (README, scripts, file tree). Only built when we have a real
  // project path — skipped in tests / sandbox runs where cwd is process.cwd().
  let projectContextMd: string | null = null
  if (project?.path) {
    try {
      projectContextMd = await buildProjectContextMarkdown(project.path)
    } catch {
      projectContextMd = null
    }
  }

  const abortController = new AbortController()

  const ctx: AdapterExecutionContext = {
    runId: run.id,
    agentId: agent.id,
    agentRole: agent.role,
    agentName: agent.name,
    adapterType: agent.adapterType as AdapterType,
    runtime,
    config: agent.adapterConfig,
    context: {
      issue: issue
        ? {
            id: issue.id,
            title: issue.title,
            description: issue.description,
            status: issue.status,
            identifier: issue.identifier,
          }
        : undefined,
      project: project
        ? { id: project.id, name: project.name, path: project.path }
        : undefined,
      // First-run agents need orientation; we splice the project context into the
      // continuationSummary slot so the existing prompt builder picks it up without
      // a schema change.
      continuationSummary: projectContextMd,
    },
    executionTarget: {
      cwd,
      projectId: projectId ?? undefined,
      branch: issue?.branch ?? null,
      baseBranch: issue?.baseBranch ?? null,
    },
    onLog: async (stream, chunk) => {
      await appendRunLog(run.id, stream, chunk)
    },
    onMeta: async (meta: AdapterInvocationMeta) => {
      await appendRunLog(run.id, "stdout", JSON.stringify(meta), {
        eventType: "meta",
        payload: meta as unknown as Record<string, unknown>,
      })
    },
    onSpawn: async (info: AdapterSpawnInfo) => {
      db
        .update(agentRuns)
        .set({
          processPid: info.pid,
          processGroupId: info.processGroupId,
          processStartedAt: new Date(info.startedAt),
        })
        .where(eq(agentRuns.id, run.id))
        .run()
    },
    // The orchestrator MCP server is wired in-process by the adapter (closure-bound
    // auth) so we don't pass a token here. If a future adapter needs HTTP MCP, this
    // is where a per-run JWT would land.
    authToken: null,
    abortSignal: abortController.signal,
  }

  let result: AdapterExecutionResult
  try {
    result = await adapter.execute(ctx)
  } catch (error) {
    const err = error as Error & { code?: string }
    result = {
      status: "failed",
      error: err.message,
      errorCode: err.code ?? "adapter_threw",
      errorFamily:
        err.code === "adapter_not_implemented"
          ? "permanent"
          : "transient_upstream",
    }
  }

  const finalizeMeta = await finalizeRunLog(run.id)
  await persistFinalResult(run, result, finalizeMeta)

  await logActivity({
    actorType: "system",
    actorId: "heartbeat",
    action: result.status === "succeeded" ? "agent_run.succeeded" : "agent_run.failed",
    entityType: "agent_run",
    entityId: run.id,
    runtimeAgentId: agent.id,
    agentRunId: run.id,
    details: { errorCode: result.errorCode ?? null },
  })
}

/**
 * Cancel a running or queued run. Sets status=cancelled, closes the open run-log
 * file handle (preventing FD leak), and releases the issue lock. Process termination
 * via PGID is a future addition — for now this just flips DB state.
 */
export async function cancelRun(runId: string, reason = "Cancelled by user"): Promise<void> {
  const db = getDatabase()
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get()
  if (!run) return
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
    return  // already terminal
  }
  // Flush + close the run-log file handle. Without this, cancelled runs leak FDs
  // until the process exits (executeRun's finally is bypassed when cancellation
  // flips status before the run loop completes).
  const finalizeMeta = await finalizeRunLog(runId)
  db
    .update(agentRuns)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
      logRef: finalizeMeta.logRef,
      logBytes: finalizeMeta.logBytes,
      logCompressed: finalizeMeta.logCompressed,
      logSha256: finalizeMeta.logSha256,
      stdoutExcerpt: finalizeMeta.stdoutExcerpt,
      stderrExcerpt: finalizeMeta.stderrExcerpt,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, runId))
    .run()
  if (run.issueId) {
    await releaseIssueExecutionLock(run.issueId, run.id)
  }
  emitRunTerminal(runId, "cancelled")
  await logActivity({
    actorType: "user",
    actorId: "self",
    action: "agent_run.cancelled",
    entityType: "agent_run",
    entityId: runId,
    runtimeAgentId: run.runtimeAgentId,
    agentRunId: runId,
    details: { reason },
  })
}

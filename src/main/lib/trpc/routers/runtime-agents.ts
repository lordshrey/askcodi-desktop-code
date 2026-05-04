import { z } from "zod"
import { eq, desc, and } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import {
  getDatabase,
  runtimeAgents,
  agentRuntimeState,
  agentRuns,
  type NewRuntimeAgent,
} from "../../db"
import { tryGet as tryGetAdapter, list as listAdapters } from "../../adapters"
import { logActivity } from "../../services/activity-log"
import { ADAPTER_TYPES, type AdapterType } from "../../../../shared/types/adapter"
import { ensureFoundingEngineer } from "../../agents/founding-engineer"

// tRPC router for orchestrated runtime agents (CEO, engineers, designers...).
// Mirrors paperclip's /agents endpoints, single-user shape.
//
// IMPORTANT: this is "runtimeAgents" — distinct from the existing `agentDefinitions`
// router which reads file-based prompt configs from ~/.claude/agents/.

// Derive zod enum from the canonical ADAPTER_TYPES so a new adapter only registers
// in one place.
const adapterTypeEnum = z.enum(
  ADAPTER_TYPES as unknown as [AdapterType, ...AdapterType[]],
)

const hireAgentSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(40).default("general"),
  title: z.string().max(80).optional(),
  icon: z.string().max(8).optional(),
  adapterType: adapterTypeEnum,
  adapterConfig: z.record(z.unknown()).default({}),
  reportsTo: z.string().nullable().optional(),
  defaultProjectId: z.string().nullable().optional(),
  budgetMonthlyCents: z.number().int().nonnegative().nullable().optional(),
  autonomyMode: z.enum(["off", "event", "timer"]).default("event"),
  heartbeatIntervalSec: z.number().int().positive().nullable().optional(),
})

const updateAgentSchema = hireAgentSchema.partial().extend({
  id: z.string(),
  status: z.enum(["idle", "running", "paused", "terminated", "pending_approval"]).optional(),
  pauseReason: z.string().nullable().optional(),
})

export const runtimeAgentsRouter = router({
  /**
   * List all hired runtime agents. Mirrors paperclip's /agents/all.
   */
  list: publicProcedure
    .input(
      z
        .object({
          status: z.enum(["idle", "running", "paused", "terminated", "pending_approval"]).optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const db = getDatabase()
      const rows = input?.status
        ? db
            .select()
            .from(runtimeAgents)
            .where(eq(runtimeAgents.status, input.status))
            .orderBy(desc(runtimeAgents.createdAt))
            .all()
        : db.select().from(runtimeAgents).orderBy(desc(runtimeAgents.createdAt)).all()
      return rows
    }),

  /**
   * Get a single agent with its cumulative usage stats and last 10 runs.
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const db = getDatabase()
      const agent = db.select().from(runtimeAgents).where(eq(runtimeAgents.id, input.id)).get()
      if (!agent) return null
      const state = db
        .select()
        .from(agentRuntimeState)
        .where(eq(agentRuntimeState.runtimeAgentId, input.id))
        .get()
      const recentRuns = db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.runtimeAgentId, input.id))
        .orderBy(desc(agentRuns.createdAt))
        .limit(10)
        .all()
      return { agent, state: state ?? null, recentRuns }
    }),

  /**
   * Hire a new agent. Validates adapter availability + runs testEnvironment() before insert
   * so users see config errors at hire time, not at first run.
   */
  hire: publicProcedure
    .input(hireAgentSchema)
    .mutation(async ({ input }) => {
      const adapter = tryGetAdapter(input.adapterType)
      if (!adapter) {
        throw new Error(
          `Unknown adapter "${input.adapterType}". Registered: [${listAdapters().map((a) => a.type).join(", ")}]`,
        )
      }
      const envTest = await adapter.testEnvironment({ config: input.adapterConfig })
      if (!envTest.ok) {
        throw new Error(`Adapter environment check failed: ${envTest.message}${envTest.fixHint ? ` — ${envTest.fixHint}` : ""}`)
      }

      const db = getDatabase()
      const row: NewRuntimeAgent = {
        name: input.name,
        role: input.role,
        title: input.title ?? null,
        icon: input.icon ?? null,
        adapterType: input.adapterType,
        adapterConfig: input.adapterConfig,
        reportsTo: input.reportsTo ?? null,
        defaultProjectId: input.defaultProjectId ?? null,
        budgetMonthlyCents: input.budgetMonthlyCents ?? null,
        autonomyMode: input.autonomyMode,
        heartbeatIntervalSec: input.heartbeatIntervalSec ?? null,
        status: "idle",
      }
      const inserted = db.insert(runtimeAgents).values(row).returning().all()
      const created = inserted[0]

      // Initialize runtime_state row so cumulative counters increment cleanly later.
      db
        .insert(agentRuntimeState)
        .values({
          runtimeAgentId: created.id,
          adapterType: created.adapterType,
        })
        .run()

      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "runtime_agent.hired",
        entityType: "runtime_agent",
        entityId: created.id,
        runtimeAgentId: created.id,
        details: {
          adapterType: created.adapterType,
          role: created.role,
          autonomyMode: created.autonomyMode,
        },
      })
      return created
    }),

  /**
   * Update agent metadata. Status transitions (pause/resume/terminate) go through here.
   */
  update: publicProcedure
    .input(updateAgentSchema)
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const existing = db.select().from(runtimeAgents).where(eq(runtimeAgents.id, input.id)).get()
      if (!existing) throw new Error("Agent not found")

      const updates: Partial<NewRuntimeAgent> = { updatedAt: new Date() }
      if (input.name !== undefined) updates.name = input.name
      if (input.role !== undefined) updates.role = input.role
      if (input.title !== undefined) updates.title = input.title
      if (input.icon !== undefined) updates.icon = input.icon
      if (input.adapterConfig !== undefined) updates.adapterConfig = input.adapterConfig
      if (input.budgetMonthlyCents !== undefined) updates.budgetMonthlyCents = input.budgetMonthlyCents
      if (input.autonomyMode !== undefined) updates.autonomyMode = input.autonomyMode
      if (input.heartbeatIntervalSec !== undefined) updates.heartbeatIntervalSec = input.heartbeatIntervalSec
      if (input.reportsTo !== undefined) updates.reportsTo = input.reportsTo
      if (input.defaultProjectId !== undefined) updates.defaultProjectId = input.defaultProjectId
      if (input.status !== undefined) {
        updates.status = input.status
        if (input.status === "paused") {
          updates.pausedAt = new Date()
          updates.pauseReason = input.pauseReason ?? "Paused by user"
        } else if (existing.status === "paused") {
          updates.pausedAt = null
          updates.pauseReason = null
        }
      }

      const updated = db
        .update(runtimeAgents)
        .set(updates)
        .where(eq(runtimeAgents.id, input.id))
        .returning()
        .all()
      const result = updated[0]
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "runtime_agent.updated",
        entityType: "runtime_agent",
        entityId: input.id,
        runtimeAgentId: input.id,
        details: { updates: Object.keys(updates) },
      })
      return result
    }),

  /**
   * Terminate (soft-delete). Row is preserved for audit; status flips to "terminated" so
   * preflight gates refuse future wakeups. The founding engineer cannot be terminated —
   * the user owns it for the lifetime of the project.
   */
  terminate: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const existing = db
        .select()
        .from(runtimeAgents)
        .where(eq(runtimeAgents.id, input.id))
        .get()
      if (!existing) throw new Error("Agent not found")
      if (existing.isFounding) {
        throw new Error(
          "Founding engineer cannot be terminated. Pause if you need to stop them temporarily.",
        )
      }
      db
        .update(runtimeAgents)
        .set({ status: "terminated", pauseReason: input.reason ?? null, updatedAt: new Date() })
        .where(eq(runtimeAgents.id, input.id))
        .run()
      await logActivity({
        actorType: "user",
        actorId: "self",
        action: "runtime_agent.terminated",
        entityType: "runtime_agent",
        entityId: input.id,
        runtimeAgentId: input.id,
        details: { reason: input.reason ?? null },
      })
      return { ok: true }
    }),

  /**
   * Idempotently ensure a founding engineer is hired for the given project.
   * Called from the renderer when a project is selected. Safe to call repeatedly —
   * second + later calls are no-ops that return the existing agent.
   */
  ensureFoundingEngineer: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ input }) => {
      return ensureFoundingEngineer(input.projectId)
    }),

  /**
   * Available adapters + their config schemas. Drives the hire dialog.
   */
  listAvailableAdapters: publicProcedure.query(() => {
    return listAdapters().map((adapter) => ({
      type: adapter.type,
      displayName: adapter.displayName,
      description: adapter.description ?? null,
      models: adapter.models ?? [],
      configSchema: adapter.getConfigSchema?.() ?? { fields: [] },
      agentConfigurationDoc: adapter.agentConfigurationDoc ?? null,
    }))
  }),

  /**
   * Pre-flight environment check for a proposed adapter config. Used by the hire form
   * to give users immediate feedback before they submit.
   */
  testAdapterEnvironment: publicProcedure
    .input(z.object({
      adapterType: adapterTypeEnum,
      config: z.record(z.unknown()).default({}),
      cwd: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const adapter = tryGetAdapter(input.adapterType)
      if (!adapter) {
        return { ok: false, message: `No adapter registered for "${input.adapterType}"` }
      }
      return adapter.testEnvironment({ config: input.config, cwd: input.cwd })
    }),
})

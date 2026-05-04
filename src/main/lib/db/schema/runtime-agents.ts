import { sqliteTable, text, integer, index, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { relations, sql } from "drizzle-orm"
import { createId } from "../utils"
import { projects } from "./index"

// ============ RUNTIME AGENTS ============
// Persistent orchestrated agents (CEO, engineer, designer, ...).
// One row per agent that the user has hired. Survives across sessions.
// reportsTo is a self-reference forming the org chart (tree, cycle-prevented in service layer).
//
// status state machine:
//   idle ──[wakeup]──> running ──[finish]──> idle
//                                  ↓
//                                paused (manual or budget-exceeded)
//   pending_approval (created via hire flow with board approval required)
//                  └─[approved]──> idle
//   terminated (soft-deleted; row preserved for audit)
export const runtimeAgents = sqliteTable("runtime_agents", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  name: text("name").notNull(),
  role: text("role").notNull().default("general"),         // ceo | engineer | designer | researcher | general
  title: text("title"),
  icon: text("icon"),
  status: text("status").notNull().default("idle"),        // idle | running | paused | terminated | pending_approval
  // Marks the founding engineer auto-hired on project load. Cannot be terminated; can hire others.
  // At most one founding engineer per project (enforced by partial unique index below).
  isFounding: integer("is_founding", { mode: "boolean" }).notNull().default(false),
  reportsTo: text("reports_to").references((): AnySQLiteColumn => runtimeAgents.id, { onDelete: "set null" }),
  adapterType: text("adapter_type").notNull(),             // claude_code | claude_api | codex | cursor | ollama
  adapterConfig: text("adapter_config", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  runtimeConfig: text("runtime_config", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  defaultProjectId: text("default_project_id").references(() => projects.id, { onDelete: "set null" }),
  budgetMonthlyCents: integer("budget_monthly_cents"),
  spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
  pauseReason: text("pause_reason"),
  pausedAt: integer("paused_at", { mode: "timestamp" }),
  permissions: text("permissions", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  autonomyMode: text("autonomy_mode").notNull().default("off"),  // off | event | timer (Decision 4C)
  heartbeatIntervalSec: integer("heartbeat_interval_sec"),
  lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp" }),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("runtime_agents_status_idx").on(t.status),
  index("runtime_agents_reports_to_idx").on(t.reportsTo),
  // At most one founding engineer per project. Partial unique on is_founding=true.
  uniqueIndex("runtime_agents_founding_per_project_uq")
    .on(t.defaultProjectId)
    .where(sql`${t.isFounding} = 1`),
])

export const runtimeAgentsRelations = relations(runtimeAgents, ({ one, many }) => ({
  manager: one(runtimeAgents, {
    fields: [runtimeAgents.reportsTo],
    references: [runtimeAgents.id],
    relationName: "manager",
  }),
  reports: many(runtimeAgents, { relationName: "manager" }),
  defaultProject: one(projects, {
    fields: [runtimeAgents.defaultProjectId],
    references: [projects.id],
  }),
}))

export type RuntimeAgent = typeof runtimeAgents.$inferSelect
export type NewRuntimeAgent = typeof runtimeAgents.$inferInsert

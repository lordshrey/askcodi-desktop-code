import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { agentRuns } from "./agent-runs"

// ============ AGENT RUN EVENTS ============
// Append-only log of what happened during a run. One row per chunk.
// Three sinks fan-out from the adapter's onLog/onMeta/onSpawn callbacks:
//   1. This table (event stream — durable, queryable, replayable)
//   2. Bulk log file under userData/runs/{runId}.log (full text, gzipped on completion)
//   3. tRPC subscription (live tail to UI)
//
// `seq` is monotonic per run, used for ordered replay and for watchdog "last output" tracking.
// SQLite's INTEGER PK with autoincrement gives us a global insertion order if needed.
//
// Max chunk size persisted in `message`: ~16KB. Larger chunks are truncated here but
// preserved fully in the bulk log file.
export const agentRunEvents = sqliteTable("agent_run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),                              // monotonic per run
  eventType: text("event_type").notNull(),                    // stdout | stderr | lifecycle | tool_call | meta | spawn
  stream: text("stream").notNull(),                           // stdout | stderr | system
  level: text("level"),                                       // info | warn | error | debug (optional)
  message: text("message"),                                   // truncated chunk; full text in log_ref file
  payload: text("payload", { mode: "json" })
    .$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("agent_run_events_run_seq_idx").on(t.runId, t.seq),
  index("agent_run_events_run_type_idx").on(t.runId, t.eventType),
])

export const agentRunEventsRelations = relations(agentRunEvents, ({ one }) => ({
  run: one(agentRuns, { fields: [agentRunEvents.runId], references: [agentRuns.id] }),
}))

export type AgentRunEvent = typeof agentRunEvents.$inferSelect
export type NewAgentRunEvent = typeof agentRunEvents.$inferInsert

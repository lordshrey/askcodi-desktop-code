import { sqliteTable, text, integer, index, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { runtimeAgents } from "./runtime-agents"
import { issues } from "./issues"

// ============ AGENT RUNS ============
// One row per execution attempt. The master ledger.
//
// status state machine:
//   queued ─────────► running ─────► succeeded
//                       │            failed
//                       │            timed_out
//                       │            cancelled
//                       │
//                       └──► scheduled_retry ──(after delay)──► queued (new row, retryOfRunId set)
//
// Retry policy: bounded transient delays [2m, 10m, 30m, 2h], max 4 attempts, ±25% jitter.
// Process tracking: processGroupId allows kill -PGID to reap detached children.
// Session resume: sessionIdAfter feeds into agentTaskSessions for the next run.
export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  runtimeAgentId: text("runtime_agent_id").notNull()
    .references(() => runtimeAgents.id, { onDelete: "cascade" }),
  // Source / context
  invocationSource: text("invocation_source").notNull(),    // timer | assignment | on_demand | automation | system
  triggerDetail: text("trigger_detail"),
  wakeupRequestId: text("wakeup_request_id"),               // backref to agent_wakeup_requests
  contextSnapshot: text("context_snapshot", { mode: "json" })
    .$type<Record<string, unknown>>().notNull().default({}),
  issueId: text("issue_id").references(() => issues.id, { onDelete: "set null" }),
  // Status lifecycle
  status: text("status").notNull().default("queued"),       // queued | scheduled_retry | running | succeeded | failed | cancelled | timed_out
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  // Retry chain
  scheduledRetryAt: integer("scheduled_retry_at", { mode: "timestamp" }),
  scheduledRetryAttempt: integer("scheduled_retry_attempt").notNull().default(0),
  retryOfRunId: text("retry_of_run_id").references((): AnySQLiteColumn => agentRuns.id, { onDelete: "set null" }),
  continuationAttempt: integer("continuation_attempt").notNull().default(0),
  // Adapter session bridge — sessionCodec on the adapter encodes/decodes these blobs.
  adapterType: text("adapter_type").notNull(),              // denormalized for analytics
  sessionIdBefore: text("session_id_before"),
  sessionIdAfter: text("session_id_after"),
  // Process tracking — PGID makes cancellation reap children.
  processPid: integer("process_pid"),
  processGroupId: integer("process_group_id"),
  processStartedAt: integer("process_started_at", { mode: "timestamp" }),
  // Liveness classification (output of run-liveness service)
  livenessState: text("liveness_state"),                    // completed | advanced | plan_only | empty_response | blocked | failed | needs_followup
  livenessReason: text("liveness_reason"),
  lastOutputAt: integer("last_output_at", { mode: "timestamp" }),
  lastOutputSeq: integer("last_output_seq").notNull().default(0),
  // Bulk log archive — events go to agent_run_events; full log gzipped on completion.
  logRef: text("log_ref"),                                  // file path under userData/runs/
  logBytes: integer("log_bytes"),
  logCompressed: integer("log_compressed", { mode: "boolean" }),
  logSha256: text("log_sha256"),
  stdoutExcerpt: text("stdout_excerpt"),                    // last ~8KB for cheap UI display
  stderrExcerpt: text("stderr_excerpt"),
  // Result and usage
  resultJson: text("result_json", { mode: "json" })
    .$type<Record<string, unknown>>(),
  errorCode: text("error_code"),                            // semantic classifier: cancelled | process_detached | claude_transient_upstream | ...
  error: text("error"),
  usageJson: text("usage_json", { mode: "json" })
    .$type<{ inputTokens: number; outputTokens: number; cachedInputTokens: number } | null>(),
  externalRunId: text("external_run_id"),                   // adapter-specific handle (Codex external_id, etc.)
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (t) => [
  index("agent_runs_agent_status_idx").on(t.runtimeAgentId, t.status),
  index("agent_runs_status_last_output_idx").on(t.status, t.lastOutputAt),
  index("agent_runs_issue_idx").on(t.issueId),
  index("agent_runs_scheduled_retry_idx").on(t.scheduledRetryAt),
])

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  agent: one(runtimeAgents, {
    fields: [agentRuns.runtimeAgentId],
    references: [runtimeAgents.id],
  }),
  issue: one(issues, { fields: [agentRuns.issueId], references: [issues.id] }),
  retryOf: one(agentRuns, {
    fields: [agentRuns.retryOfRunId],
    references: [agentRuns.id],
    relationName: "retryChain",
  }),
}))

export type AgentRun = typeof agentRuns.$inferSelect
export type NewAgentRun = typeof agentRuns.$inferInsert

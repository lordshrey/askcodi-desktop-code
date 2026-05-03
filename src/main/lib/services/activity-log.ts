import { getDatabase, activityLog, type NewActivityLog } from "../db"

export const ACTOR_TYPES = ["user", "agent", "system", "plugin"] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

// Append-only audit log helper.
//
// Every mutation in the orchestrator (issue checkout, status change, comment, hire,
// run cancel, ...) writes a row here. Writing is cheap; the value is recoverable
// "what happened?" forensics without grepping log files.
//
// Naming convention for `action`:  "<entity>.<verb>"
//   issue.checked_out / issue.status_changed / issue.comment_added / issue.document_updated
//   runtime_agent.hired / runtime_agent.paused / runtime_agent.permissions_changed
//   agent_run.started / agent_run.cancelled / agent_run.failed
//   wakeup.queued / wakeup.skipped / wakeup.coalesced
//
// `details` is sanitized of secrets at the callsite. Don't dump arbitrary payloads
// here — name what you mean.

export interface LogActivityInput {
  actorType: ActorType
  actorId: string
  action: string
  entityType: string
  entityId: string
  runtimeAgentId?: string | null
  agentRunId?: string | null
  details?: Record<string, unknown>
}

const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /apikey/i,
  /api[_-]?key/i,
  /bearer/i,
  /authorization/i,
]

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key))
}

function sanitizeRecord(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth_limit]"
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => sanitizeRecord(v, depth + 1))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        out[k] = "[redacted]"
      } else {
        out[k] = sanitizeRecord(v, depth + 1)
      }
    }
    return out
  }
  return value
}

/**
 * Insert an activity log row. Synchronous-feeling (better-sqlite3 writes are sync)
 * but typed `Promise<void>` to leave room for a future remote sink.
 *
 * Never throws. Failures here would cascade into mutation rollbacks, which is a worse
 * outcome than a missed audit row.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    const db = getDatabase()
    const sanitized =
      input.details
        ? (sanitizeRecord(input.details) as Record<string, unknown>)
        : {}
    const row: NewActivityLog = {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      runtimeAgentId: input.runtimeAgentId ?? null,
      agentRunId: input.agentRunId ?? null,
      details: sanitized,
    }
    db.insert(activityLog).values(row).run()
  } catch (error) {
    // Last-resort: log to console. Do NOT rethrow — caller's mutation has already happened.
    // eslint-disable-next-line no-console
    console.error("[activity-log] insert failed:", error)
  }
}

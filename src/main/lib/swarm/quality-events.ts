/**
 * Quality-event capture for swarm_explore delegations.
 *
 * Two pieces:
 *   1. `classifyDelegation` — pure function that decides accepted/rejected/
 *      swarm_failed/unknown from a window of post-delegation events.
 *   2. `QualityEventBatcher` — buffers events and flushes them in batches
 *      to the gateway. Fire-and-forget; flush failures are logged and
 *      events are dropped (the data is not critical to the user's session).
 *
 * Caller (claude.ts) owns the wiring: when a swarm_explore Task tool result
 * arrives, the caller (a) detects SWARM_FAILED, (b) starts a 90s observation
 * window for re-search detection, (c) on window close calls
 * `classifyDelegation` and enqueues the final event.
 */
import { isSwarmFailure } from "./subagent-registry"
import {
  postQualityEvents,
  type GatewayClientOptions,
} from "./gateway-client"
import type {
  QualityDetectionMethod,
  QualityEvent,
  QualityOutcome,
} from "./types"

/**
 * One observation collected during the post-delegation window. Keep this shape
 * minimal — anything richer should be reduced into one of these by the caller.
 */
export type PostDelegationObservation =
  | {
      kind: "search_intent"
      query: string
      tool: "swarm_explore" | "Read" | "Glob" | "Grep"
      ts_ms: number // milliseconds since epoch
    }
  | {
      kind: "terminal"
      // Edit/Write completed, user explicit ack, etc.
      ts_ms: number
    }
  | {
      kind: "session_end"
      ts_ms: number
    }

/** Time windows. */
const RE_SEARCH_WINDOW_MS = 90_000 // 90s
const TERMINAL_WINDOW_MS = 5 * 60_000 // 5 min
const SESSION_ABANDON_MS = 30 * 60_000 // 30 min

/**
 * Pure classifier. Inputs:
 *   - delegationToolResult: the string the swarm_explore subagent returned
 *   - delegationQuery: the prompt the parent gave the subagent
 *   - delegationTs: ms since epoch when the delegation finished
 *   - observations: events recorded after delegationTs
 *   - now: ms since epoch (lets tests be deterministic)
 */
export function classifyDelegation(args: {
  delegationToolResult: string
  delegationQuery: string
  delegationTs: number
  observations: PostDelegationObservation[]
  now: number
}): { outcome: QualityOutcome; detection_method: QualityDetectionMethod | null } {
  const { delegationToolResult, delegationQuery, delegationTs, observations, now } =
    args

  // 1) Swarm-side failure trumps everything else.
  if (isSwarmFailure(delegationToolResult)) {
    return { outcome: "swarm_failed", detection_method: null }
  }

  // 2) Re-search detection: did the parent (or another swarm call) search
  // for a similar query within RE_SEARCH_WINDOW_MS? If so, the delegation's
  // result didn't satisfy the parent.
  const normalizedDelegationQuery = normalizeQuery(delegationQuery)
  const reSearch = observations.find((o) => {
    if (o.kind !== "search_intent") return false
    const dt = o.ts_ms - delegationTs
    if (dt <= 0 || dt > RE_SEARCH_WINDOW_MS) return false
    return queriesAreSimilar(normalizedDelegationQuery, normalizeQuery(o.query))
  })
  if (reSearch) {
    return { outcome: "rejected", detection_method: "re_search_detection" }
  }

  // 3) Task-completion proxy: any terminal event within 5 min and no
  // re-search means the delegation's result was useful enough to drive the
  // session forward.
  const terminal = observations.find(
    (o) =>
      o.kind === "terminal" &&
      o.ts_ms > delegationTs &&
      o.ts_ms - delegationTs <= TERMINAL_WINDOW_MS,
  )
  if (terminal) {
    return { outcome: "accepted", detection_method: "task_completion_proxy" }
  }

  // 4) Session-end fallback: if the session ended without re-search but
  // also without a terminal event, treat as unknown unless the gap is long
  // enough to count as abandoned.
  const sessionEnd = observations.find((o) => o.kind === "session_end")
  if (sessionEnd) {
    return { outcome: "unknown", detection_method: null }
  }

  // 5) The window is still observing — but our "now" cap forces a decision.
  if (now - delegationTs >= SESSION_ABANDON_MS) {
    return { outcome: "unknown", detection_method: null }
  }
  return { outcome: "unknown", detection_method: null }
}

/** Lower-case + trimmed + whitespace-collapsed. */
export function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ")
}

/**
 * "Similar" for v0.1 = either query is a non-trivial substring of the other.
 * v0.2 may add embeddings; v0.1 keeps it cheap and deterministic.
 */
export function queriesAreSimilar(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 8 && b.includes(a)) return true
  if (b.length >= 8 && a.includes(b)) return true
  return false
}

/**
 * In-memory queue + batched flush. Caller decides cadence (e.g.,
 * setInterval(batcher.flush, 10_000)).
 *
 * Events accumulate via `enqueue`. `flush` posts the current queue and
 * empties it on success. On failure, events stay queued for the next
 * attempt; if the queue exceeds the max size, oldest events are dropped.
 */
export class QualityEventBatcher {
  private queue: QualityEvent[] = []
  private readonly maxQueueSize: number
  private readonly clientOptions: GatewayClientOptions
  private readonly post: typeof postQualityEvents

  constructor(opts: {
    clientOptions?: GatewayClientOptions
    maxQueueSize?: number
    /** Injectable poster for tests. Defaults to the real gateway client. */
    post?: typeof postQualityEvents
  } = {}) {
    this.clientOptions = opts.clientOptions ?? {}
    this.maxQueueSize = opts.maxQueueSize ?? 500
    this.post = opts.post ?? postQualityEvents
  }

  enqueue(event: QualityEvent): void {
    this.queue.push(event)
    if (this.queue.length > this.maxQueueSize) {
      const dropped = this.queue.length - this.maxQueueSize
      this.queue.splice(0, dropped)
      console.warn(
        `[swarm] quality event queue overflow, dropped ${dropped} oldest events`,
      )
    }
  }

  size(): number {
    return this.queue.length
  }

  /**
   * Posts the current queue to the gateway. Empties the queue on success;
   * leaves it intact on failure so a future flush can retry.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.slice()
    const ok = await this.post(batch, this.clientOptions)
    if (ok) {
      // Only remove the events that were in this batch, in case enqueue
      // happened concurrently.
      this.queue.splice(0, batch.length)
    }
  }
}

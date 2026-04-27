/**
 * Tests for the quality-event classifier and batcher.
 */
import { describe, it, expect, vi } from "vitest"
import {
  classifyDelegation,
  normalizeQuery,
  queriesAreSimilar,
  QualityEventBatcher,
  type PostDelegationObservation,
} from "../quality-events"
import type { QualityEvent } from "../types"

const T0 = 1_000_000_000_000

const baseEvent: QualityEvent = {
  session_id: "s1",
  tool_call_id: "t1",
  subagent_type: "swarm_explore",
  outcome: "unknown",
  detection_method: null,
  latency_ms: 1234,
  input_tokens_haiku: 0,
  output_tokens_haiku: 0,
  frontier_tokens_saved_estimate: null,
  emitted_at: new Date(T0).toISOString(),
}

describe("normalizeQuery", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeQuery("  Find  Auth\n flow ")).toBe("find auth flow")
  })

  it("returns empty string for empty input", () => {
    expect(normalizeQuery("")).toBe("")
  })
})

describe("queriesAreSimilar", () => {
  it("returns true on exact match", () => {
    expect(queriesAreSimilar("find auth", "find auth")).toBe(true)
  })

  it("returns true when one is a substring of the other and ≥8 chars", () => {
    expect(queriesAreSimilar("find auth flow", "find auth")).toBe(true)
  })

  it("returns false for short non-matching queries", () => {
    expect(queriesAreSimilar("auth", "user")).toBe(false)
  })

  it("returns false for very short substrings (avoids false positives)", () => {
    expect(queriesAreSimilar("auth", "auth flow")).toBe(false)
  })

  it("returns false on empty input", () => {
    expect(queriesAreSimilar("", "find auth")).toBe(false)
    expect(queriesAreSimilar("find auth", "")).toBe(false)
  })
})

describe("classifyDelegation", () => {
  it("returns swarm_failed when the result starts with the sentinel", () => {
    const r = classifyDelegation({
      delegationToolResult: "SWARM_FAILED: timeout",
      delegationQuery: "find auth flow",
      delegationTs: T0,
      observations: [],
      now: T0 + 1000,
    })
    expect(r).toEqual({ outcome: "swarm_failed", detection_method: null })
  })

  it("returns rejected when a similar query is observed within 90s", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        {
          kind: "search_intent",
          query: "find authentication flow handler",
          tool: "Grep",
          ts_ms: T0 + 30_000,
        },
      ],
      now: T0 + 31_000,
    })
    expect(r).toEqual({
      outcome: "rejected",
      detection_method: "re_search_detection",
    })
  })

  it("does NOT flag a re-search outside the 90s window", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        {
          kind: "search_intent",
          query: "find authentication flow",
          tool: "Grep",
          ts_ms: T0 + 91_000, // 91s after delegation
        },
      ],
      now: T0 + 92_000,
    })
    expect(r.outcome).not.toBe("rejected")
  })

  it("does NOT flag a re-search for a DIFFERENT query", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        {
          kind: "search_intent",
          query: "billing controllers",
          tool: "Grep",
          ts_ms: T0 + 10_000,
        },
      ],
      now: T0 + 11_000,
    })
    expect(r.outcome).not.toBe("rejected")
  })

  it("returns accepted when a terminal event happens within 5min and no re-search", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        { kind: "terminal", ts_ms: T0 + 60_000 },
      ],
      now: T0 + 70_000,
    })
    expect(r).toEqual({
      outcome: "accepted",
      detection_method: "task_completion_proxy",
    })
  })

  it("returns unknown when terminal event is outside the 5min window", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        { kind: "terminal", ts_ms: T0 + 6 * 60_000 },
      ],
      now: T0 + 7 * 60_000,
    })
    expect(r.outcome).toBe("unknown")
  })

  it("returns unknown when session ends with no terminal and no re-search", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [{ kind: "session_end", ts_ms: T0 + 120_000 }],
      now: T0 + 121_000,
    })
    expect(r).toEqual({ outcome: "unknown", detection_method: null })
  })

  it("returns unknown when no observations have arrived yet", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [],
      now: T0 + 5_000,
    })
    expect(r).toEqual({ outcome: "unknown", detection_method: null })
  })

  it("prefers swarm_failed over rejected even if a re-search exists", () => {
    const r = classifyDelegation({
      delegationToolResult: "SWARM_FAILED: bad",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        {
          kind: "search_intent",
          query: "find authentication flow",
          tool: "Grep",
          ts_ms: T0 + 30_000,
        },
      ],
      now: T0 + 31_000,
    })
    expect(r.outcome).toBe("swarm_failed")
  })

  it("prefers rejected over accepted when both are observed", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        {
          kind: "search_intent",
          query: "find authentication flow handler",
          tool: "Grep",
          ts_ms: T0 + 30_000,
        },
        { kind: "terminal", ts_ms: T0 + 120_000 },
      ],
      now: T0 + 130_000,
    })
    expect(r.outcome).toBe("rejected")
  })

  it("ignores observations at or before the delegation timestamp", () => {
    const r = classifyDelegation({
      delegationToolResult: "Summary: ...",
      delegationQuery: "find authentication flow",
      delegationTs: T0,
      observations: [
        {
          kind: "search_intent",
          query: "find authentication flow",
          tool: "Grep",
          ts_ms: T0 - 1_000,
        },
        {
          kind: "search_intent",
          query: "find authentication flow",
          tool: "Grep",
          ts_ms: T0,
        },
      ],
      now: T0 + 5_000,
    })
    expect(r.outcome).toBe("unknown")
  })
})

describe("QualityEventBatcher", () => {
  it("queues events and reports size", () => {
    const post = vi.fn().mockResolvedValue(true)
    const b = new QualityEventBatcher({ post })
    b.enqueue(baseEvent)
    b.enqueue(baseEvent)
    expect(b.size()).toBe(2)
  })

  it("flushes events and clears the queue on success", async () => {
    const post = vi.fn().mockResolvedValue(true)
    const b = new QualityEventBatcher({ post })
    b.enqueue(baseEvent)
    b.enqueue(baseEvent)
    await b.flush()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toHaveLength(2)
    expect(b.size()).toBe(0)
  })

  it("retains events on flush failure for next attempt", async () => {
    const post = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const b = new QualityEventBatcher({ post })
    b.enqueue(baseEvent)
    await b.flush()
    expect(b.size()).toBe(1)
    await b.flush()
    expect(b.size()).toBe(0)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("is a no-op when the queue is empty", async () => {
    const post = vi.fn().mockResolvedValue(true)
    const b = new QualityEventBatcher({ post })
    await b.flush()
    expect(post).not.toHaveBeenCalled()
  })

  it("drops oldest events when queue exceeds maxQueueSize", () => {
    const post = vi.fn().mockResolvedValue(true)
    const b = new QualityEventBatcher({ post, maxQueueSize: 3 })
    for (let i = 0; i < 5; i++) {
      b.enqueue({ ...baseEvent, tool_call_id: `t${i}` })
    }
    expect(b.size()).toBe(3)
  })
})

/**
 * Per-cell aggregation for the swarm suite. A "cell" is one
 * (algorithm × query) execution. The runner emits one CellSummary per
 * cell; the analyzer consumes a directory of these and produces a
 * comparison report.
 *
 * The summary captures *aggregates*, not the raw event stream — keeps
 * the analyzer fast (single JSON read per cell vs. thousands of stream
 * messages). The raw .jsonl is still written alongside for deep dives.
 */
import type { AlgorithmStats } from "../algorithms/algorithm"

export type ModelTokenUsage = {
  calls: number
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
}

/** Per-model cost + token breakdown, taken straight from CC's result.modelUsage. */
export type ModelUsageRecord = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

export type CellSummary = {
  /** Schema version. Bump when the shape changes. */
  version: 1
  /** Algorithm name (registry key). */
  algorithm: string
  /** Query text (may be truncated for very long prompts; full text is in the .jsonl). */
  query: string
  /** Short query id, e.g. "Q1". Set by the runner. */
  queryId: string
  /** Wall-clock milliseconds the cell took (runner-measured around algorithm.run). */
  durationMs: number
  /** Whether the cell threw an exception (true = failed before producing useful stats). */
  errored: boolean
  /** Error message if errored. */
  errorMessage?: string
  /** Path to the raw event-stream .jsonl. */
  rawLogPath: string
  /** ISO 8601 timestamp when the cell finished (or errored). */
  finishedAt: string

  // Aggregated event-stream stats (algorithm-agnostic).
  parentMessages: number
  delegations: Record<string, number>
  toolCalls: Record<string, number>
  swarmFailures: number
  modelTokens: Record<string, ModelTokenUsage>

  // CC-reported metadata from the trailing result message. Use these
  // for canonical cost numbers rather than computing from modelTokens.
  /** Total cost USD as reported by Claude Code. Sum across all models in the session. */
  totalCostUsd?: number
  /** API-side duration in ms (excludes harness overhead). */
  durationApiMs?: number
  /** Per-model cost + token usage, straight from CC's result.modelUsage. */
  modelUsage?: Record<string, ModelUsageRecord>

  // Algorithm-specific stats (whatever the algorithm.run() returned).
  algorithmStats: AlgorithmStats
}

export type StreamStats = {
  parentMessages: number
  delegations: Record<string, number>
  toolCalls: Record<string, number>
  swarmFailures: number
  modelTokens: Record<string, ModelTokenUsage>
}

export function newStreamStats(): StreamStats {
  return {
    parentMessages: 0,
    delegations: {},
    toolCalls: {},
    swarmFailures: 0,
    modelTokens: {},
  }
}

function bump(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by
}

function recordModelUsage(
  stats: StreamStats,
  model: string,
  usage:
    | {
        input_tokens?: number
        output_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    | undefined,
): void {
  if (!model) return
  const m = (stats.modelTokens[model] ??= {
    calls: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
  })
  m.calls += 1
  m.input += usage?.input_tokens ?? 0
  m.output += usage?.output_tokens ?? 0
  m.cacheCreate += usage?.cache_creation_input_tokens ?? 0
  m.cacheRead += usage?.cache_read_input_tokens ?? 0
}

/**
 * Walk the raw SDK event stream and accumulate algorithm-agnostic stats.
 * Pure function — no IO, no console output. Both the live runner and
 * the analyzer can call this on a stream they already have in memory.
 */
export function summarizeStream(messages: Iterable<unknown>): StreamStats {
  const stats = newStreamStats()
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    const t = m.type as string | undefined

    if (t === "assistant") {
      stats.parentMessages += 1
      const message = (m.message as Record<string, unknown> | undefined) ?? {}
      const model = message.model as string | undefined
      const usage = message.usage as Record<string, number> | undefined
      if (model) recordModelUsage(stats, model, usage)

      const content =
        (message.content as Array<Record<string, unknown>> | undefined) ?? []
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === "tool_use") {
          const name = (b.name as string) ?? "?"
          bump(stats.toolCalls, name)
          const input = (b.input as Record<string, unknown> | undefined) ?? {}
          if (name === "Agent" || name === "Task") {
            const sa = (input.subagent_type as string) ?? "<unknown>"
            bump(stats.delegations, sa)
          }
        } else if (b.type === "text") {
          const text = String(b.text ?? "").trim()
          if (text.startsWith("SWARM_FAILED") || text.startsWith("MINION_FAILED")) {
            stats.swarmFailures += 1
          }
        }
      }
    }
  }
  return stats
}

export type ModelClass = "haiku" | "opus" | "sonnet" | "other"

export function classifyModel(name: string): ModelClass {
  if (name.includes("haiku")) return "haiku"
  if (name.includes("opus")) return "opus"
  if (name.includes("sonnet")) return "sonnet"
  return "other"
}

/**
 * Pull the trailing result message's metadata: total cost USD, api duration,
 * and per-model usage records. CC's SDK emits one `result` message per
 * sdk.query() session; we grab that and surface it directly so callers
 * use canonical Anthropic-reported costs instead of approximating from
 * token counts.
 */
export function extractResultMetadata(messages: Iterable<unknown>): {
  totalCostUsd?: number
  durationApiMs?: number
  modelUsage?: Record<string, ModelUsageRecord>
} {
  let last: Record<string, unknown> | null = null
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    if (m.type === "result") last = m
  }
  if (!last) return {}
  const out: {
    totalCostUsd?: number
    durationApiMs?: number
    modelUsage?: Record<string, ModelUsageRecord>
  } = {}
  if (typeof last.total_cost_usd === "number") out.totalCostUsd = last.total_cost_usd
  if (typeof last.duration_api_ms === "number") out.durationApiMs = last.duration_api_ms
  const mu = last.modelUsage as
    | Record<string, Partial<ModelUsageRecord>>
    | undefined
  if (mu && typeof mu === "object") {
    out.modelUsage = {}
    for (const [model, u] of Object.entries(mu)) {
      out.modelUsage[model] = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
        costUSD: u.costUSD ?? 0,
      }
    }
  }
  return out
}

/** Sum token totals across all models. Used by the analyzer for cross-cell comparison. */
export function totalTokens(modelTokens: Record<string, ModelTokenUsage>): {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  byClass: Record<ModelClass, ModelTokenUsage>
} {
  const byClass: Record<ModelClass, ModelTokenUsage> = {
    haiku: { calls: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    opus: { calls: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    sonnet: { calls: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    other: { calls: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  }
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheCreate = 0
  for (const [model, u] of Object.entries(modelTokens)) {
    input += u.input
    output += u.output
    cacheRead += u.cacheRead
    cacheCreate += u.cacheCreate
    const cls = classifyModel(model)
    byClass[cls].calls += u.calls
    byClass[cls].input += u.input
    byClass[cls].output += u.output
    byClass[cls].cacheCreate += u.cacheCreate
    byClass[cls].cacheRead += u.cacheRead
  }
  return { input, output, cacheRead, cacheCreate, byClass }
}

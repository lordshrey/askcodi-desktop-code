/**
 * Async runner for swarm suite experiments.
 *
 * Takes an N×M matrix of (algorithm × query) cells and executes them
 * with a concurrency cap, yielding per-cell summaries as each finishes.
 * The cap matters — without it, 4 algos × 7 queries × 5 fanout-minions
 * each = up to 140 concurrent claude subprocesses, which swamps the
 * test machine and produces noisy data.
 *
 * Pure orchestration: this file knows nothing about the SDK or the
 * filesystem. The caller (scripts/run-swarm-suite.ts) injects the
 * sdkQuery + onCellFinish callbacks.
 */
import type {
  AlgorithmRunOptions,
  SwarmAlgorithm,
} from "../algorithms/algorithm"
import { simulateAlgorithmRun } from "../simulate"
import {
  extractResultMetadata,
  summarizeStream,
  type CellSummary,
  type ModelTokenUsage,
} from "./cell"

export type SuiteCell = {
  algorithm: SwarmAlgorithm
  queryId: string
  queryText: string
  /** Path the runner should write the raw .jsonl to. */
  rawLogPath: string
  /** Extra options the algorithm needs (e.g. registerSwarmExplore for none). */
  extraOptions?: Record<string, unknown>
}

export type CellRunContext = {
  cwd: string
  sdkQuery: AlgorithmRunOptions["sdkQuery"]
  pathToClaudeCodeExecutable: string
  /** Called for every SDK message — the runner uses this to write the raw .jsonl. */
  onMessage: (queryId: string, algorithmName: string, msg: unknown) => void
}

/**
 * Run one cell. Catches errors so a single bad cell doesn't kill the
 * suite. Returns a CellSummary regardless of success/failure.
 */
export async function runCell(
  cell: SuiteCell,
  ctx: CellRunContext,
  now = () => Date.now(),
): Promise<CellSummary> {
  const start = now()
  const collected: unknown[] = []
  const onMsg = (msg: unknown) => {
    collected.push(msg)
    ctx.onMessage(cell.queryId, cell.algorithm.name, msg)
  }

  try {
    const result = await simulateAlgorithmRun(cell.algorithm, cell.queryText, {
      cwd: ctx.cwd,
      sdkQuery: ctx.sdkQuery,
      pathToClaudeCodeExecutable: ctx.pathToClaudeCodeExecutable,
      onMessage: onMsg,
      algorithmOptions: cell.extraOptions,
    })
    const messages = result.messages
    const streamStats = summarizeStream(messages)
    const meta = extractResultMetadata(messages)
    const finishedAt = new Date(now()).toISOString()
    return {
      version: 1,
      algorithm: cell.algorithm.name,
      query: cell.queryText,
      queryId: cell.queryId,
      durationMs: now() - start,
      errored: false,
      rawLogPath: cell.rawLogPath,
      finishedAt,
      parentMessages: streamStats.parentMessages,
      delegations: streamStats.delegations,
      toolCalls: streamStats.toolCalls,
      swarmFailures: streamStats.swarmFailures,
      modelTokens: streamStats.modelTokens,
      totalCostUsd: meta.totalCostUsd,
      durationApiMs: meta.durationApiMs,
      modelUsage: meta.modelUsage,
      algorithmStats: result.stats ?? {},
    }
  } catch (err) {
    const streamStats = summarizeStream(collected)
    return {
      version: 1,
      algorithm: cell.algorithm.name,
      query: cell.queryText,
      queryId: cell.queryId,
      durationMs: now() - start,
      errored: true,
      errorMessage: (err as Error).message ?? String(err),
      rawLogPath: cell.rawLogPath,
      finishedAt: new Date(now()).toISOString(),
      parentMessages: streamStats.parentMessages,
      delegations: streamStats.delegations,
      toolCalls: streamStats.toolCalls,
      swarmFailures: streamStats.swarmFailures,
      modelTokens: streamStats.modelTokens as Record<string, ModelTokenUsage>,
      algorithmStats: {},
    }
  }
}

/**
 * Run a list of cells with a concurrency cap. Returns the array of
 * summaries in the order cells were submitted. `onCellFinish` fires
 * as each cell completes — useful for incremental disk writes and
 * progress logging.
 */
export async function runSuite(
  cells: SuiteCell[],
  ctx: CellRunContext,
  options: {
    concurrency: number
    onCellFinish?: (summary: CellSummary) => void | Promise<void>
    now?: () => number
  },
): Promise<CellSummary[]> {
  const concurrency = Math.max(1, options.concurrency)
  const results: CellSummary[] = new Array(cells.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const myIndex = nextIndex++
      if (myIndex >= cells.length) return
      const summary = await runCell(cells[myIndex], ctx, options.now)
      results[myIndex] = summary
      if (options.onCellFinish) await options.onCellFinish(summary)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, cells.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

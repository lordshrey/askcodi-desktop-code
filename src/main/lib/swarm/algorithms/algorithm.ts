/**
 * SwarmAlgorithm interface — the pluggability contract.
 *
 * Each algorithm is a self-contained module that knows how to wrap a
 * single SDK query with its own orchestration (memory, scout-recruit,
 * consensus, etc.). The harness (test-swarm.ts, future runtime) only
 * sees this interface, never the concrete algorithm.
 *
 * Adding a new algorithm = ship one file + register it in registry.ts.
 * No harness changes.
 */

/** Generic SDK query function shape — the SDK's `query` export. */
export type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<unknown>
  options?: Record<string, unknown>
}) => AsyncIterable<unknown>

/** Options every algorithm receives. Concrete algorithms may take more in their own opts; this is the harness baseline. */
export type AlgorithmRunOptions = {
  cwd: string
  sdkQuery: SdkQueryFn
  pathToClaudeCodeExecutable: string
  /** Streaming hook — harness uses this to log + render the live ticker. */
  onMessage?: (msg: unknown) => void
}

/** Algorithm-specific stats blob. Each algorithm owns its shape. */
export type AlgorithmStats = Record<string, unknown>

export type AlgorithmResult = {
  /** All SDK messages this run produced, in order. */
  messages: unknown[]
  /** Algorithm-specific stats. Shape depends on the algorithm. */
  stats: AlgorithmStats
}

export type SwarmAlgorithm = {
  /** Matches the `--algorithm <name>` CLI flag and the registry key. */
  name: string
  /** One-line description for `--help` output. */
  description: string
  /** Run the orchestration. Stream events via `options.onMessage`. */
  run(query: string, options: AlgorithmRunOptions): Promise<AlgorithmResult>
  /** Optional: format algorithm-specific stats lines for the SUMMARY block. */
  formatStats?(stats: AlgorithmStats): string[]
  /** Optional: produce the one-line verdict shown at the end of a run. */
  formatVerdict?(stats: AlgorithmStats): string
}

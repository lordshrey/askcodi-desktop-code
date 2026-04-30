/**
 * SwarmAlgorithm interface — the pluggability contract.
 *
 * Each algorithm is a self-contained module that knows how to augment a
 * single SDK query with its own orchestration knobs (system prompt
 * additions, subagent registrations, tool guards, message observers,
 * cleanup). The runtime — claude.ts in production, the suite runner for
 * offline experiments — composes the augmentation onto its own
 * sdk.query() call.
 *
 * Adding a new algorithm = ship one file + register it in registry.ts.
 * No runtime changes.
 */

import type { SwarmAgentDefinition } from "../types"

/** Generic SDK query function shape — the SDK's `query` export. */
export type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<unknown>
  options?: Record<string, unknown>
}) => AsyncIterable<unknown>

/**
 * Runtime context passed to every prepare() call. Carries facts the
 * algorithm needs to decide whether/how to participate.
 */
export type AlgorithmContext = {
  /** Absolute path to the project root the user opened. */
  cwd: string
  /** True when the chat is in plan mode (read-only / no edits). */
  planMode?: boolean
  /** True when the model is served via Ollama (no agents/tools support). */
  ollama?: boolean
  /** True when this turn is resuming a prior session (vs. fresh start). */
  isResume?: boolean
  /** Path to the bundled Claude Code binary (when offline experiments need it). */
  pathToClaudeCodeExecutable?: string
}

export type DenyVerdict = { behavior: "deny"; message: string }

/** Algorithm-specific stats blob. Each algorithm owns its shape. */
export type AlgorithmStats = Record<string, unknown>

/**
 * Augmentation returned by prepare(). Each field is optional: an
 * algorithm only fills in what it needs. The runtime composes all
 * present fields onto its own queryOptions.
 *
 * Lifecycle ordering:
 *   1. prepare() runs once before sdk.query() starts.
 *   2. If skip is true, runtime takes the vanilla path and never calls
 *      observeMessage or finalize.
 *   3. canUseToolGuard runs on every tool invocation, BEFORE the
 *      runtime's own permission callback.
 *   4. observeMessage runs on every SDK message, after the runtime
 *      forwards it to the UI.
 *   5. finalize runs in a finally block: success, error, or abort.
 */
export type AlgorithmAugmentation = {
  /**
   * If true, the runtime treats the algorithm as inactive for this turn
   * and falls through to a vanilla sdk.query() (no augmentation, no
   * observer, no finalize). Set when ctx is incompatible (plan mode,
   * ollama, mid-session resume the algorithm doesn't handle, etc.).
   */
  skip?: boolean
  /** Human-readable reason logged when skip is true. */
  skipReason?: string
  /**
   * Text appended to the runtime's systemPrompt.append. Carries algorithm
   * coordination guidance and prior knowledge (ACO priors, partition
   * cache renderings, etc.).
   */
  systemPromptAppend?: string
  /**
   * Subagent definitions to register on the SDK call. Merged with the
   * runtime's existing agents — when a name collides, runtime agents
   * (user plugin definitions) win.
   */
  agents?: Record<string, SwarmAgentDefinition>
  /**
   * Tool guard. Runs BEFORE the runtime's own permission callback. Return
   * a deny verdict to block; return null to fall through to the runtime.
   * If this throws, the runtime swallows + logs and treats it as null.
   */
  canUseToolGuard?: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => DenyVerdict | null
  /**
   * Observer called on every SDK message. Side effects only — return
   * value ignored. If this throws, the runtime swallows + logs and
   * disables this turn's observer (chat continues).
   */
  observeMessage?: (msg: unknown) => void
  /**
   * Cleanup hook. Always runs (success / error / abort). Returns the
   * algorithm's stats for the suite reporter; runtime ignores them.
   * If this throws, the runtime swallows + logs.
   */
  finalize?: () => Promise<AlgorithmStats> | AlgorithmStats
}

export type SwarmAlgorithm = {
  /** Matches the env value (MAIN_VITE_SWARM_ALGORITHM=<name>) and the registry key. */
  name: string
  /** One-line description for help output and debugging. */
  description: string
  /**
   * Build the augmentation for this turn. Pure setup — should not call
   * sdk.query() itself. Called once per chat turn.
   */
  prepare(
    query: string,
    ctx: AlgorithmContext,
  ): Promise<AlgorithmAugmentation> | AlgorithmAugmentation
  /** Optional: format algorithm-specific stats lines for the SUMMARY block. */
  formatStats?(stats: AlgorithmStats): string[]
  /** Optional: produce the one-line verdict shown at the end of a run. */
  formatVerdict?(stats: AlgorithmStats): string
}

/**
 * Legacy options shape — kept for the suite runner harness only.
 * Production code (claude.ts) goes through prepare() instead.
 */
export type AlgorithmRunOptions = {
  cwd: string
  sdkQuery: SdkQueryFn
  pathToClaudeCodeExecutable: string
  /** Streaming hook — harness uses this to log + render the live ticker. */
  onMessage?: (msg: unknown) => void
}

/** Legacy result shape — emitted by the suite runner when it composes prepare() into a full run. */
export type AlgorithmResult = {
  messages: unknown[]
  stats: AlgorithmStats
}

/**
 * simulateAlgorithmRun — composes prepare()/observer/finalize into a
 * complete sdk.query() call.
 *
 * Used by:
 *   - The suite runner (offline experiments, scripts/run-swarm-suite.ts)
 *   - The test helper (algorithm tests, __tests__/_helpers.ts)
 *
 * This is the canonical composition outside the production runtime
 * (claude.ts), so any change to how augmentation pieces fit together
 * lands here once and applies to both call sites. Eliminates the
 * dual-track algorithm code (production prepare() vs. legacy runX).
 */
import { buildBaseSdkOptions } from "./sdk-options"
import type {
  AlgorithmAugmentation,
  AlgorithmContext,
  AlgorithmStats,
  SdkQueryFn,
  SwarmAlgorithm,
} from "./algorithms/algorithm"

export type SimulateOptions = {
  /** Project root (matches AlgorithmContext.cwd). */
  cwd: string
  /** SDK query function — usually sdk.query from @anthropic-ai/claude-agent-sdk. */
  sdkQuery: SdkQueryFn
  /** Path to bundled claude binary. */
  pathToClaudeCodeExecutable: string
  /** Forwarded to the algorithm via prepare(query, ctx, opts). */
  algorithmOptions?: Record<string, unknown>
  /** Streaming hook — every SDK message gets forwarded here in addition to the observer. */
  onMessage?: (msg: unknown) => void
  /** Plan mode flag for the algorithm context (some algorithms skip in plan mode). */
  planMode?: boolean
  /** Ollama flag (algorithms typically skip when on a non-Anthropic backend). */
  ollama?: boolean
  /** Whether this is a session resume (some algorithms behave differently mid-session). */
  isResume?: boolean
}

export type SimulateResult = {
  /** All messages observed from the SDK stream, in order. */
  messages: unknown[]
  /** Whether the algorithm asked to be skipped (vanilla path was taken). */
  skipped: boolean
  /** Reason returned by the algorithm when skipped. */
  skipReason?: string
  /** Stats returned by augmentation.finalize() (null when skipped or finalize threw). */
  stats: AlgorithmStats | null
}

/**
 * Run one full chat turn end-to-end:
 *   1. algorithm.prepare(query, ctx, opts) → augmentation
 *   2. If skip → vanilla sdk.query (no observer, no finalize)
 *   3. Else → sdk.query with composed options; observeMessage on each msg
 *   4. finalize() in finally (success / error / abort)
 *
 * Always returns a SimulateResult — caught errors are surfaced via
 * thrown rejection so the caller can decide how to handle them.
 */
export async function simulateAlgorithmRun(
  algorithm: SwarmAlgorithm,
  query: string,
  options: SimulateOptions,
): Promise<SimulateResult> {
  const ctx: AlgorithmContext = {
    cwd: options.cwd,
    planMode: options.planMode,
    ollama: options.ollama,
    isResume: options.isResume,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
  }

  const augmentation = await callPrepare(algorithm, query, ctx, options.algorithmOptions)

  // Vanilla path: algorithm asked to be skipped.
  if (augmentation.skip) {
    const messages: unknown[] = []
    const stream = options.sdkQuery({
      prompt: query,
      options: {
        ...buildBaseSdkOptions({
          cwd: options.cwd,
          pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
        }),
      },
    })
    for await (const msg of stream) {
      messages.push(msg)
      options.onMessage?.(msg)
    }
    return {
      messages,
      skipped: true,
      skipReason: augmentation.skipReason,
      stats: null,
    }
  }

  // Composed path: build queryOptions with the augmentation wired in.
  const messages: unknown[] = []
  const stream = options.sdkQuery({
    prompt: query,
    options: {
      ...buildBaseSdkOptions({
        cwd: options.cwd,
        pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      }),
      ...(augmentation.agents
        ? { agents: augmentation.agents as unknown as Record<string, unknown> }
        : {}),
      ...(augmentation.systemPromptAppend
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: augmentation.systemPromptAppend,
            },
          }
        : {}),
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>,
      ) => {
        if (augmentation.canUseToolGuard) {
          let denied = null
          try {
            denied = augmentation.canUseToolGuard(toolName, toolInput)
          } catch (err) {
            console.warn(
              `[simulate:${algorithm.name}] canUseToolGuard threw, treating as allow:`,
              err,
            )
          }
          if (denied) return denied
        }
        return { behavior: "allow" as const }
      },
    },
  })

  let observerEnabled = augmentation.observeMessage != null
  let stats: AlgorithmStats | null = null
  try {
    for await (const msg of stream) {
      messages.push(msg)
      options.onMessage?.(msg)
      if (observerEnabled && augmentation.observeMessage) {
        try {
          augmentation.observeMessage(msg)
        } catch (err) {
          observerEnabled = false
          console.warn(
            `[simulate:${algorithm.name}] observeMessage threw, disabling for this run:`,
            err,
          )
        }
      }
    }
  } finally {
    if (augmentation.finalize) {
      try {
        stats = await augmentation.finalize()
      } catch (err) {
        console.warn(`[simulate:${algorithm.name}] finalize threw:`, err)
      }
    }
  }

  return {
    messages,
    skipped: false,
    stats,
  }
}

function callPrepare(
  algorithm: SwarmAlgorithm,
  query: string,
  ctx: AlgorithmContext,
  algorithmOptions: Record<string, unknown> | undefined,
): Promise<AlgorithmAugmentation> | AlgorithmAugmentation {
  // Algorithms accept an optional third opts argument; the SwarmAlgorithm
  // interface doesn't declare it (it's algorithm-specific), so we cast.
  const prep = algorithm.prepare as (
    q: string,
    c: AlgorithmContext,
    o?: Record<string, unknown>,
  ) => Promise<AlgorithmAugmentation> | AlgorithmAugmentation
  return Promise.resolve(prep(query, ctx, algorithmOptions))
}

/**
 * Composes an algorithm's AlgorithmAugmentation onto the runtime's
 * sdk.query() options. Pulled out of claude.ts so the integration glue
 * is testable in isolation and the router stays focused on chat
 * lifecycle / IPC.
 *
 * Usage in the runtime:
 *
 *   const algo = getConfiguredAlgorithm()
 *   const aug = await algo.prepare(query, ctx)
 *   if (aug.skip) {
 *     // vanilla path — observer/finalize never run
 *     return runVanillaQuery(opts)
 *   }
 *   const composed = applyAlgorithmToQueryOptions(opts, aug, { mergeAgents })
 *   try {
 *     for await (const msg of sdk.query(composed)) {
 *       composed.handleMessage(msg)  // forwards to UI + observer
 *     }
 *   } finally {
 *     await composed.finalize()
 *   }
 */
import type { SwarmAgentDefinition } from "./types"
import type {
  AlgorithmAugmentation,
  AlgorithmStats,
  DenyVerdict,
} from "./algorithms/algorithm"

/** Subset of the SDK queryOptions shape we read/write. Loose by design — SDK options are huge. */
export type ComposableQueryOptions = {
  agents?: Record<string, SwarmAgentDefinition>
  systemPrompt?:
    | { type: "preset"; preset: "claude_code"; append?: string }
    | { type: "default" }
    | undefined
  canUseTool?: (
    toolName: string,
    toolInput: Record<string, unknown>,
    extra: { toolUseID: string },
  ) => Promise<{ behavior: "allow" | "deny"; message?: string; updatedInput?: unknown }>
  [key: string]: unknown
}

export type AllowVerdict = {
  behavior: "allow"
  updatedInput?: unknown
}

export type ToolVerdict =
  | AllowVerdict
  | { behavior: "deny"; message: string }

export type ApplyAlgorithmResult = {
  /** Augmented queryOptions to pass to sdk.query(). */
  options: ComposableQueryOptions
  /**
   * Forward a stream message to the algorithm's observer with try/catch
   * isolation. Errors are logged once per turn and disable the observer
   * for the rest of the turn (chat continues unaffected).
   */
  handleMessage: (msg: unknown) => void
  /**
   * Run the algorithm's finalize() with try/catch isolation. Always
   * safe to call — runtime puts this in a finally block.
   */
  finalize: () => Promise<AlgorithmStats | null>
  /**
   * Whether the observer was disabled mid-turn due to an exception. UI
   * can surface this for debugging if needed.
   */
  observerDisabled: () => boolean
}

export type ApplyAlgorithmContext = {
  /** Identifier logged when observer/finalize errors fire. */
  algorithmName: string
  /**
   * Existing agents map (e.g., user plugin agents). When the algorithm
   * also wants to register agents under the same key, the existing
   * mapping wins (plugin override precedence).
   */
  existingAgents?: Record<string, SwarmAgentDefinition>
}

/**
 * Compose the augmentation onto a baseline queryOptions object.
 *
 * Composition rules:
 *  - systemPromptAppend is concatenated onto baseOpts.systemPrompt.append
 *    (with a blank-line separator). If baseOpts has no systemPrompt, a
 *    claude_code preset is created.
 *  - agents are merged with existingAgents winning on key collision.
 *  - canUseTool wraps the existing callback: algorithm guard runs first
 *    (try/catch), then falls through to the existing callback.
 *  - observeMessage / finalize are exposed as handleMessage / finalize
 *    on the result, both with try/catch isolation.
 */
export function applyAlgorithmToQueryOptions(
  baseOpts: ComposableQueryOptions,
  augmentation: AlgorithmAugmentation,
  ctx: ApplyAlgorithmContext,
): ApplyAlgorithmResult {
  const out: ComposableQueryOptions = { ...baseOpts }

  // 1. systemPrompt.append composition
  if (augmentation.systemPromptAppend) {
    const baseAppend =
      baseOpts.systemPrompt && "append" in baseOpts.systemPrompt
        ? baseOpts.systemPrompt.append ?? ""
        : ""
    const combined = baseAppend
      ? `${baseAppend}\n\n${augmentation.systemPromptAppend}`
      : augmentation.systemPromptAppend
    out.systemPrompt = {
      type: "preset" as const,
      preset: "claude_code" as const,
      append: combined,
    }
  }

  // 2. agents merge — existing wins on collision (plugin override).
  if (augmentation.agents) {
    out.agents = {
      ...augmentation.agents,
      ...(ctx.existingAgents ?? baseOpts.agents ?? {}),
    }
  }

  // 3. canUseTool composition — algorithm guard first, then fallback.
  const baseCanUseTool = baseOpts.canUseTool
  const algoGuard = augmentation.canUseToolGuard
  if (algoGuard) {
    out.canUseTool = async (toolName, toolInput, extra) => {
      let denied: DenyVerdict | null = null
      try {
        denied = algoGuard(toolName, toolInput)
      } catch (err) {
        console.warn(
          `[swarm:${ctx.algorithmName}] canUseToolGuard threw, treating as allow:`,
          err,
        )
      }
      if (denied) return denied
      if (baseCanUseTool) return baseCanUseTool(toolName, toolInput, extra)
      return { behavior: "allow", updatedInput: toolInput }
    }
  }

  // 4. observer + finalize with try/catch isolation
  let observerEnabled = augmentation.observeMessage != null
  let observerEverErrored = false

  const handleMessage = (msg: unknown) => {
    if (!observerEnabled || !augmentation.observeMessage) return
    try {
      augmentation.observeMessage(msg)
    } catch (err) {
      observerEnabled = false
      observerEverErrored = true
      console.warn(
        `[swarm:${ctx.algorithmName}] observeMessage threw, disabling observer for this turn:`,
        err,
      )
    }
  }

  const finalize = async (): Promise<AlgorithmStats | null> => {
    if (!augmentation.finalize) return null
    try {
      return await augmentation.finalize()
    } catch (err) {
      console.warn(
        `[swarm:${ctx.algorithmName}] finalize threw:`,
        err,
      )
      return null
    }
  }

  return {
    options: out,
    handleMessage,
    finalize,
    observerDisabled: () => observerEverErrored,
  }
}

/**
 * Helper for the runtime's existing canUseTool composition: turns a
 * DenyVerdict-or-null result into the SDK-expected ToolVerdict shape.
 */
export function denyToToolVerdict(deny: DenyVerdict): ToolVerdict {
  return deny
}

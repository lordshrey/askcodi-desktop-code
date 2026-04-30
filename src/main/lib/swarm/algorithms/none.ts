/**
 * "none" — no swarm intelligence layer. The runtime takes its vanilla
 * path: Opus parent with default subagents, no system-prompt addendum,
 * no canUseTool guard.
 *
 * Used as the baseline arm when comparing swarm algorithms in offline
 * experiments, and as the env default (MAIN_VITE_SWARM_ALGORITHM unset
 * or =none disables swarm in production).
 */
import { buildBaseSdkOptions } from "../sdk-options"
import type {
  AlgorithmAugmentation,
  AlgorithmContext,
  AlgorithmResult,
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "./algorithm"

export type NoneStats = Record<string, never>

/**
 * Always returns {skip: true}. The runtime falls through to a vanilla
 * sdk.query() call. No observer, no finalize.
 */
function prepareNone(
  _query: string,
  _ctx: AlgorithmContext,
): AlgorithmAugmentation {
  return {
    skip: true,
    skipReason: "baseline arm — no augmentation",
  }
}

/**
 * Suite-runner harness path. Composes prepare() into a full sdk.query()
 * call so offline experiments can measure baseline behavior.
 */
export async function runNone(
  query: string,
  options: AlgorithmRunOptions,
): Promise<AlgorithmResult> {
  const stream = options.sdkQuery({
    prompt: query,
    options: { ...buildBaseSdkOptions(options) },
  })

  const messages: unknown[] = []
  for await (const msg of stream) {
    messages.push(msg)
    options.onMessage?.(msg)
  }

  return { messages, stats: {} }
}

export const noneAlgorithm: SwarmAlgorithm = {
  name: "none",
  description:
    "Direct SDK call (no swarm intelligence). Opus parent with default subagents. Used as the baseline arm in experiments and the env default.",
  prepare: prepareNone,
}

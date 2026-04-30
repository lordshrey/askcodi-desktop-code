/**
 * Read the configured algorithm from env. Single source of truth for
 * "which algorithm runs" in the production runtime.
 *
 *   MAIN_VITE_SWARM_ALGORITHM=none           -> no swarm (vanilla SDK)
 *   MAIN_VITE_SWARM_ALGORITHM=aco            -> ACO with Explore subagent
 *   MAIN_VITE_SWARM_ALGORITHM=aco-frontier   -> hybrid ACO + Frontier
 *   ...etc, see registry.ts for the full list.
 *
 * Unknown values fall back to "none" with a console warning so a typo
 * in .env doesn't crash the app.
 */
import { algorithmNames, getAlgorithm } from "./algorithms/registry"
import type { SwarmAlgorithm } from "./algorithms/algorithm"

export const SWARM_ALGORITHM_ENV_KEY = "MAIN_VITE_SWARM_ALGORITHM"

/**
 * Resolve the SwarmAlgorithm to use for production runs.
 *
 * @param envValue - raw value of MAIN_VITE_SWARM_ALGORITHM (or undefined)
 * @param onWarn - optional callback for unknown values (defaults to console.warn)
 */
export function getConfiguredAlgorithm(
  envValue: string | undefined,
  onWarn: (msg: string) => void = (msg) => console.warn(msg),
): SwarmAlgorithm {
  const trimmed = (envValue ?? "").trim()
  if (!trimmed) {
    // Unset → off. No warning; this is the default.
    return getAlgorithm("none")!
  }
  const algo = getAlgorithm(trimmed)
  if (!algo) {
    onWarn(
      `[swarm] ${SWARM_ALGORITHM_ENV_KEY}="${trimmed}" is not a known algorithm. ` +
        `Falling back to "none". Valid values: ${algorithmNames().join(", ")}.`,
    )
    return getAlgorithm("none")!
  }
  return algo
}

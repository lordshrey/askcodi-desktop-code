/**
 * Legacy swarm-failure sentinel used by quality-events for backward
 * compatibility with older raw-event logs. The v0.1 swarm_explore
 * subagent emitted "SWARM_FAILED:" on failure; v0.2 algorithms use
 * "MINION_FAILED:" via subagents.ts. Both are still detected when
 * scanning historical logs.
 *
 * Builder + merge helpers for the v0.1 swarm_explore subagent were
 * removed when the runtime migrated to algorithm.prepare()-based
 * augmentation (claude.ts:~1655 reads MAIN_VITE_SWARM_ALGORITHM and
 * delegates agent registration to the algorithm itself).
 */
export type { SwarmAgentDefinition } from "./types"

/** Sentinel string the legacy v0.1 swarm_explore subagent emitted on failure. */
export const SWARM_FAILED_SENTINEL = "SWARM_FAILED:"

/** True if the given text is a swarm-failure sentinel. */
export function isSwarmFailure(text: string): boolean {
  return text.trimStart().startsWith(SWARM_FAILED_SENTINEL)
}

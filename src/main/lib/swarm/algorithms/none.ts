/**
 * "none" — the direct-SDK algorithm. No swarm intelligence layer; this
 * is the pluggable equivalent of "just call sdk.query and stream events".
 *
 * Lives behind the same SwarmAlgorithm interface as ACO/ABC/etc. so the
 * harness can dispatch through one path. Two flavors via `options`:
 *   - vanilla baseline (no agents, no system-prompt append)
 *   - legacy swarm_explore registration (the v0.1 cosmetic-twin path,
 *     kept for back-compat with old test runs)
 */
import {
  buildSwarmExploreAgent,
  mergeWithPluginAgents,
} from "../subagent-registry"
import { buildBaseSdkOptions } from "../sdk-options"
import type {
  AlgorithmResult,
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "./algorithm"

const SWARM_ROUTING_POLICY = `
## Subagent routing policy

You have access to a \`swarm_explore\` subagent (model: haiku) registered alongside the default Explore/general-purpose subagents.

When deciding whether to delegate via the Task tool, follow this rule:

- For ANY task that requires examining more than one file to answer — pattern searches, framework surveys, multi-file reads, "find every place that...", "trace the X flow", "what does this codebase do" — delegate to \`swarm_explore\` by default. Even if the work feels small (3-4 grep calls), the subagent absorbs the raw output into its own context, keeping YOUR context window lean for higher-value reasoning. This is the preferred path.
- Use Read/Glob/Grep directly ONLY for show-me-the-contents-of-this-exact-file requests with a known path.
- Only fall back to other subagents (Explore, general-purpose) if \`swarm_explore\` is not available or has just returned a SWARM_FAILED sentinel.

This policy applies even when you could complete the task yourself with a few tool calls. The point is to preserve your context budget for the hard parts of the task.
`

export type NoneRunOptions = AlgorithmRunOptions & {
  /** When true, register swarm_explore + the routing-policy systemPrompt append. Otherwise pure default SDK behavior. */
  registerSwarmExplore?: boolean
}

export type NoneStats = {
  registered_swarm_explore: boolean
}

async function runNone(
  query: string,
  options: NoneRunOptions,
): Promise<AlgorithmResult> {
  const registerSwarm = options.registerSwarmExplore ?? false
  const agents = registerSwarm
    ? mergeWithPluginAgents(buildSwarmExploreAgent(null), undefined)
    : undefined

  const stream = options.sdkQuery({
    prompt: query,
    options: {
      ...buildBaseSdkOptions(options),
      ...(agents ? { agents: agents as unknown as Record<string, unknown> } : {}),
      ...(registerSwarm
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: SWARM_ROUTING_POLICY,
            },
          }
        : {}),
    },
  })

  const messages: unknown[] = []
  for await (const msg of stream) {
    messages.push(msg)
    options.onMessage?.(msg)
  }

  const stats: NoneStats = { registered_swarm_explore: registerSwarm }
  return { messages, stats: stats as AlgorithmStats }
}

export const noneAlgorithm: SwarmAlgorithm = {
  name: "none",
  description:
    "Direct SDK call (no swarm intelligence layer). Used as the baseline arm in experiments.",
  run: (query, options) => runNone(query, options),
}

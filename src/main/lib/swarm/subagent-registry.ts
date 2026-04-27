/**
 * Builds the `swarm_explore` AgentDefinition for the Claude SDK's `agents`
 * queryOption and merges it with whatever pluginAgents/agentsOption the
 * parent already has.
 *
 * Architecture rule (decided in plan-eng-review 2026-04-27): the mini-agent
 * is a delegation TARGET, not an interception layer. The frontier model
 * still uses built-in Read/Glob/Grep when it wants — it can also delegate
 * via Task(subagent_type='swarm_explore', ...) to get a Haiku-summarized
 * answer in its own context window.
 */
import type { CodebaseFingerprint, SwarmAgentDefinition } from "./types"

export type { SwarmAgentDefinition } from "./types"

const SWARM_EXPLORE_DESCRIPTION =
  "DEFAULT for codebase exploration. Use this for ANY non-trivial code lookup: pattern searches, multi-file reads, framework/feature surveys, gap analysis, anything that requires examining more than one file to answer. Returns a compact summary with file paths, line ranges, and relevant excerpts — keeping the parent's context window small. Use Read/Glob/Grep directly ONLY for show-me-the-contents-of-this-exact-file requests where the path is already known. When in doubt, prefer this subagent — it preserves your context budget. On failure returns `SWARM_FAILED: <reason>` so you can retry with built-in tools."

const SWARM_EXPLORE_BASE_PROMPT = `You are a code-search subagent. Your job is to use Read, Glob, and Grep efficiently and return a compact, useful summary to a parent agent.

## Output format

When you succeed, your final message must be a brief structured summary, no preamble:

Summary: <one paragraph, what you found and where>
Files (<total> total, <shown> shown):
  - <path> (lines X-Y): <one-line relevance note>
  - <path>: <one-line relevance note>
  - ...

Aim for ≤2000 tokens of output. Cut snippets to the smallest excerpt that conveys relevance. If you found more than 10 matches, show the top 10 and note the count. Never paste full file contents.

## Failure contract

If you cannot complete the search (e.g., the codebase is empty, your tools fail repeatedly, the query is genuinely impossible), return EXACTLY this on a single line and stop:

SWARM_FAILED: <one short reason>

The parent will retry with built-in tools. Do not apologize, do not try to explain.

## Search discipline

- Start with Glob to scope the search by file pattern, then Grep to find matches.
- Read only the files most likely to be relevant. Do not Read every match.
- If the parent gave a vague query, infer the most useful interpretation and answer that. Do not ask clarifying questions — return your best answer with a short note about the assumption.
- You are not allowed to write files or run commands. Only Read, Glob, Grep.`

function buildPromptWithFingerprint(
  base: string,
  fingerprint: CodebaseFingerprint | null,
): string {
  if (!fingerprint) return base

  const langs = Object.entries(fingerprint.language_breakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([ext, count]) => `${ext} (${count} files)`)
    .join(", ")

  const frameworks = fingerprint.frameworks_detected.length
    ? fingerprint.frameworks_detected.join(", ")
    : "none detected"

  const dirs = fingerprint.top_level_dirs.slice(0, 8).join(", ") || "none"

  const hint = `## Codebase context

- Top languages: ${langs || "unknown"}
- Frameworks: ${frameworks}
- Top-level dirs: ${dirs}
- Total files: ${fingerprint.total_files}

Use these hints to prioritize where to search. Don't explore irrelevant directories.
`

  return `${base}\n\n${hint}`
}

/**
 * Returns the swarm_explore AgentDefinition. Fingerprint is optional — when
 * absent, the prompt falls back to a cold-start version without project hints.
 */
export function buildSwarmExploreAgent(
  fingerprint: CodebaseFingerprint | null = null,
): SwarmAgentDefinition {
  return {
    description: SWARM_EXPLORE_DESCRIPTION,
    tools: ["Read", "Glob", "Grep"],
    model: "haiku",
    prompt: buildPromptWithFingerprint(SWARM_EXPLORE_BASE_PROMPT, fingerprint),
  }
}

/**
 * Merges the swarm subagent with the parent's existing agents map.
 *
 * Conflict rule: if the parent already has a `swarm_explore` key (e.g., a
 * user plugin overriding the built-in), the parent's definition wins. This
 * lets users customize the swarm prompt without us silently clobbering them.
 *
 * Returns undefined when there are no agents to register at all.
 */
export function mergeWithPluginAgents<T extends Record<string, unknown>>(
  swarmAgent: SwarmAgentDefinition,
  parentAgents: T | undefined,
): Record<string, unknown> | undefined {
  if (!parentAgents || Object.keys(parentAgents).length === 0) {
    return { swarm_explore: swarmAgent }
  }

  // Parent override wins on key conflict.
  if ("swarm_explore" in parentAgents) {
    return { ...parentAgents }
  }

  return { ...parentAgents, swarm_explore: swarmAgent }
}

/**
 * Sentinel string the swarm_explore subagent emits on failure. Parent agents
 * should detect this prefix in tool results and retry with built-in tools.
 */
export const SWARM_FAILED_SENTINEL = "SWARM_FAILED:"

/** True if the given text is a swarm-failure sentinel. */
export function isSwarmFailure(text: string): boolean {
  return text.trimStart().startsWith(SWARM_FAILED_SENTINEL)
}

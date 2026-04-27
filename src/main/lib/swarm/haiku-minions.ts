/**
 * Haiku-forced minion subagents for swarm runs.
 *
 * Architectural rule: orchestrator stays on the parent driver (typically
 * Opus); every minion runs on Haiku. Two enforcement layers — register
 * Haiku-forced variants under the same names as the SDK built-ins, AND
 * a canUseTool guard that denies Task delegations whose subagent_type
 * isn't on the Haiku allowlist.
 */
import type { SwarmAgentDefinition } from "./types"
import type { DenyVerdict } from "../trpc/routers/claude-can-use-tool-helpers"

export type MinionAgent = SwarmAgentDefinition & { model: "haiku" }

/** Allowlisted subagent_types the canUseTool guard will permit. */
export const HAIKU_ALLOWED_SUBAGENT_TYPES = new Set<string>([
  "Explore",
  "general-purpose",
])

const TASK_TOOL_NAMES = new Set(["Task", "Agent"])

/**
 * Returns Haiku-forced agent definitions keyed by name. Pass this to the
 * SDK's `agents` queryOption to attempt override of the built-ins.
 *
 * We deliberately keep the prompts compact — the parent already sees the
 * agent's `description`; the `prompt` only needs to define the minion's
 * behavior once invoked. Anthropic's built-in prompts are not visible to
 * us, so we can't claim parity, but Haiku is capable enough on these
 * focused tasks that a tight prompt usually suffices.
 */
export function buildHaikuMinions(): Record<string, MinionAgent> {
  return {
    Explore: {
      description:
        "Explore the codebase to answer a question or build context. Use Read, Glob, and Grep to find files and patterns. Return a compact summary with file paths and line numbers — never paste full file contents back. Cap your output around 2000 tokens.",
      tools: ["Read", "Glob", "Grep"],
      model: "haiku",
      prompt:
        "You are the Explore minion. Your only job is to investigate the codebase efficiently and return a concise summary to the parent.\n\nGuidelines:\n- Start with Glob (file/directory shapes) before Grep (content patterns).\n- Read only files you have strong reason to read. Do not Read on speculation.\n- Return a structured summary: a one-paragraph overview, then a list of `path (lines X-Y): one-line note` rows.\n- Aim for output ≤2000 tokens. If you found more matches than fit, list the top 10 and note the total count.\n- Never paste raw file contents. Quote only the smallest excerpt that conveys relevance.\n- If the task is genuinely impossible (empty repo, nonsense query), return a single line starting with `MINION_FAILED:` and a one-clause reason. The parent will retry with built-in tools.",
    },
    "general-purpose": {
      description:
        "General-purpose Haiku worker for codebase tasks that don't fit the Explore pattern (e.g., synthesizing findings, comparing two files, light analysis). Has all the same tools as the parent. Return a focused result, not a transcript.",
      tools: ["Read", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"],
      model: "haiku",
      prompt:
        "You are a general-purpose Haiku minion. The parent has delegated a task to you because Haiku is sufficient and they want to preserve their context budget.\n\nGuidelines:\n- Be focused. Do exactly what the parent asked, nothing more.\n- Use the smallest set of tool calls that produces a confident answer.\n- Output ≤2000 tokens. Bullet lists with file:line references are preferred over prose.\n- Quote the smallest excerpts. Never paste whole files.\n- If the task is malformed or impossible, return a single line starting with `MINION_FAILED:` and a one-clause reason.",
    },
  }
}

/**
 * canUseTool guard for swarm runs. Denies Task delegations whose
 * `subagent_type` isn't Haiku-forced. Returns null when the call is
 * allowed so callers can chain other gates.
 */
export function evaluateHaikuMinionGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
): DenyVerdict | null {
  if (!TASK_TOOL_NAMES.has(toolName)) return null
  const requested = toolInput.subagent_type
  if (typeof requested !== "string") return null
  if (HAIKU_ALLOWED_SUBAGENT_TYPES.has(requested)) return null
  return {
    behavior: "deny",
    message: `Subagent "${requested}" is not available in swarm mode (minions must run on Haiku for cost-control). Use one of: ${[
      ...HAIKU_ALLOWED_SUBAGENT_TYPES,
    ].join(", ")}.`,
  }
}

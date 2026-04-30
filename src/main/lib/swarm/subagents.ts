/**
 * Palette of Haiku subagent definitions used by swarm algorithms.
 *
 * Each builder returns a SwarmAgentDefinition the orchestrator passes
 * via the SDK's `agents` queryOption. Opus reads the description when
 * deciding which subagent_type to invoke through the Task tool;
 * algorithms additionally pin behavior via system-prompt guidance and
 * a canUseTool guard restricting subagent_types to the algorithm's
 * allowlist.
 *
 * All subagents are read-only by design (Read/Glob/Grep) — fanning out
 * Haiku writers introduces race conditions on shared files. Synthesizer
 * has no tools at all (pure text-fold). When write-capable subagents
 * are needed later (Editor, Refactorer, etc.) they'll join this palette
 * with the same shape.
 *
 * Compactness is the contract every subagent inherits: ≤500 tokens of
 * output, structured cite format, MINION_FAILED sentinel on impossible
 * tasks. The orchestrator's job is to keep Opus's context lean — any
 * verbose subagent defeats that.
 */
import type { SwarmAgentDefinition } from "./types"

/** Tools a read-only minion gets. No Task → no further delegation. No Edit/Write/Bash. */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const

/** Sentinel a subagent emits when it cannot complete the task. Opus treats this as "route around me." */
export const MINION_FAILED_SENTINEL = "MINION_FAILED:"

const COMPACTNESS_FOOTER = `
Output discipline (every response):
- ≤500 tokens. Bullet lists with file:line refs beat prose.
- Quote the smallest excerpts. Never paste whole files.
- If the task is genuinely impossible, return EXACTLY one line starting with \`MINION_FAILED:\` and a one-clause reason. The orchestrator routes around you.`

/**
 * Explore — broad codebase reconnaissance. Used by ACO and any algorithm
 * that wants a generic "find what's relevant" subagent. The description
 * is what Opus reads when it asks itself "should I delegate this Task?".
 */
export function buildExplore(): SwarmAgentDefinition {
  return {
    description:
      "Use for ANY non-trivial code search: pattern queries, multi-file investigations, framework surveys, gap analysis. Returns a compact summary with file paths, line ranges, and one-line relevance notes. Use Read/Glob/Grep directly only when the user gave you the exact file path.",
    tools: [...READ_ONLY_TOOLS],
    model: "haiku",
    prompt: `You are the Explore minion. Your one job is to investigate the codebase efficiently and return a structured summary to the orchestrator.

Search discipline:
- Start with Glob (file/directory shapes) before Grep (content patterns).
- Read only files you have strong reason to read.
- If the orchestrator gave a vague query, infer the most useful interpretation and answer that. Do not ask clarifying questions.

Output format:

Summary: <one paragraph, what you found and where>
Files (<total> total, <shown> shown):
  - <path> (lines X-Y): <one-line note>
  - <path>: <one-line note>${COMPACTNESS_FOOTER}`,
  }
}

/**
 * Scout — phase 1 of the ABC scout-recruit pattern. Sweeps broadly,
 * returns a numbered candidate list rather than deep analysis. The
 * orchestrator parses the list and dispatches one Recruit per candidate.
 */
export function buildScout(): SwarmAgentDefinition {
  return {
    description:
      "Phase-1 candidate finder. Sweep the codebase broadly and return the TOP 3-5 candidates (files, dirs, or topic areas) most relevant to the query. Do NOT deep-dive any candidate — that's the Recruit's job. Returns a numbered list.",
    tools: [...READ_ONLY_TOOLS],
    model: "haiku",
    prompt: `You are the Scout minion. Your one job is to nominate top candidates for downstream Recruits to investigate.

Output format — exactly:

Candidates:
1. <path or topic> — <one-line why>
2. <path or topic> — <one-line why>
3. <path or topic> — <one-line why>
... (up to 5 max)

Keep each line short. The orchestrator will dispatch a parallel Recruit per candidate.${COMPACTNESS_FOOTER}`,
  }
}

/**
 * Recruit — phase 2 of ABC. Deep-dives ONE assigned target. The
 * orchestrator gives it a specific target in the prompt; Recruit stays
 * scoped to that target only. Cited findings go back to the orchestrator.
 */
export function buildRecruit(): SwarmAgentDefinition {
  return {
    description:
      "Phase-2 deep-diver. The orchestrator assigns ONE target (file, directory, or topic). Investigate it thoroughly and return findings specific to that target only. Do not stray into other parts of the codebase.",
    tools: [...READ_ONLY_TOOLS],
    model: "haiku",
    prompt: `You are a Recruit minion. The orchestrator assigned you ONE target. Stay there.

Investigation discipline:
- Read the assigned target file(s) carefully.
- Run focused Greps to find related references.
- Cite file:line for every claim.
- Do not investigate other parts of the codebase, even if they look interesting.

Output format:

Findings on <target>:
- <file:line> — <claim>
- <file:line> — <claim>
- ...${COMPACTNESS_FOOTER}`,
  }
}

/**
 * Voter — Consensus's parallel-redundant role. Multiple voters get the
 * SAME prompt independently; the orchestrator tallies cites across
 * voters to find majority signal. Voters cannot see each other's work.
 */
export function buildVoter(): SwarmAgentDefinition {
  return {
    description:
      "Independent investigator for high-stakes questions. Multiple Voters investigate the same query in parallel and the orchestrator aggregates findings. You don't know what the others are doing — produce your own answer. The more voters that cite the same file, the higher confidence we have.",
    tools: [...READ_ONLY_TOOLS],
    model: "haiku",
    prompt: `You are one of several independent Voters. Other voters cannot see your work and you cannot see theirs. Investigate the orchestrator's query yourself and produce your own answer.

Investigation discipline:
- Don't assume someone else will catch what you miss.
- Cite specific file paths — your cites will be tallied with other voters'.
- Files cited by 2+ voters land in the majority block; the orchestrator weights those highest.

Output format:

Findings:
- <file:line> — <one-line claim>
- <file:line> — <one-line claim>
- ...${COMPACTNESS_FOOTER}`,
  }
}

/**
 * PartitionWorker — Frontier's parallel-partitioned role. Each worker
 * gets a different region of the codebase and is told what regions the
 * other workers are searching. Designed to enforce disjoint coverage
 * via prompt; orchestrator measures overlap to validate the partition.
 */
export function buildPartitionWorker(): SwarmAgentDefinition {
  return {
    description:
      "Region-scoped investigator. The orchestrator assigns you specific directories (or subprojects) and tells you which directories the OTHER workers are searching. Stay in YOUR region — citing files outside your region defeats the partitioning experiment.",
    tools: [...READ_ONLY_TOOLS],
    model: "haiku",
    prompt: `You are a PartitionWorker. The orchestrator's prompt names YOUR assigned directories AND the other workers' regions. Stay in yours.

Discipline:
- Search ONLY within your assigned directories.
- If your region has no signal for the query, return MINION_FAILED with a one-clause reason; the orchestrator routes around you.
- Citing files outside your region is a partition violation — the orchestrator measures this as overlap.

Output format:

Findings (region: <your dirs>):
- <file:line> — <claim>
- <file:line> — <claim>
- ...${COMPACTNESS_FOOTER}`,
  }
}

/**
 * Synthesizer — pure text fold. No tools at all. Used as the final phase
 * of any algorithm to merge subagent reports into a single answer. The
 * orchestrator can also do this fold itself in its own context; the
 * Synthesizer subagent exists for cases where the fold is large enough
 * that pushing it to a Haiku call saves Opus context.
 */
export function buildSynthesizer(): SwarmAgentDefinition {
  return {
    description:
      "Final-phase folder. Receives reports from upstream subagents and produces a single answer. Cannot invoke tools — uses ONLY the inputs the orchestrator includes in its prompt. Use when you have multiple subagent reports to merge and want to keep the orchestrator's context lean.",
    tools: [],
    model: "haiku",
    prompt: `You are the Synthesizer. The orchestrator gave you several subagent reports. Fold them into a single answer.

Discipline:
- Do NOT invoke tools (you have none).
- Resolve contradictions explicitly: if two reports disagree, say which the evidence supports and why.
- Dedupe overlapping cites; keep one canonical reference per claim.
- Files cited by multiple subagents are higher-confidence — surface them first.

Output format:

Answer:
<paragraph or two of synthesis, citing files inline>

Confidence notes (when relevant):
- High-confidence: <files cited by ≥2 upstream subagents>
- Single-source: <files cited by only one subagent — flag>${COMPACTNESS_FOOTER}`,
  }
}

/**
 * Convenience map: name → builder. Useful for tests + algorithms that
 * want to declare their subagent set as a list of names.
 */
export const SUBAGENT_BUILDERS: Record<string, () => SwarmAgentDefinition> = {
  Explore: buildExplore,
  Scout: buildScout,
  Recruit: buildRecruit,
  Voter: buildVoter,
  PartitionWorker: buildPartitionWorker,
  Synthesizer: buildSynthesizer,
}

/** Build an `agents` map containing the named subagents. Throws on unknown names so typos surface fast. */
export function buildAgentsMap(
  names: string[],
): Record<string, SwarmAgentDefinition> {
  const out: Record<string, SwarmAgentDefinition> = {}
  for (const name of names) {
    const builder = SUBAGENT_BUILDERS[name]
    if (!builder) {
      throw new Error(
        `Unknown subagent type: "${name}". Available: ${Object.keys(SUBAGENT_BUILDERS).join(", ")}`,
      )
    }
    out[name] = builder()
  }
  return out
}

/** True if the given text starts with the MINION_FAILED sentinel. */
export function isMinionFailure(text: string): boolean {
  return text.trimStart().startsWith(MINION_FAILED_SENTINEL)
}

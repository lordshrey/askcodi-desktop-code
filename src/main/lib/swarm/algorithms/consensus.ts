/**
 * Consensus voting (parallel-redundant).
 *
 * Architecture:
 *   - prepare(): loads ledger, applies decay, builds priors + Consensus
 *     guidance. Registers two Haiku subagents (Voter, Synthesizer).
 *   - canUseToolGuard / observeMessage from createOpusObserver.
 *   - finalize: tallies per-voter cite sets, persists vote distribution
 *     into algorithm_state, prunes, records session, saves via queue.
 *
 * Why parallel-redundant: independent voters diverge on noise but
 * converge on signal. Files cited by 2+ voters are high-confidence;
 * files cited by 1 are flagged as low-confidence in the synthesis.
 */
import {
  applyDecay,
  buildPriorsBlock,
  loadLedger,
  pruneFiles,
  recordSession,
  saveLedgerQueued,
  setAlgorithmState,
  type Ledger,
} from "../ledger"
import {
  createOpusObserver,
  runOpusOrchestrated,
} from "../orchestrator"
import { countByType } from "../stream-utils"
import { buildAgentsMap } from "../subagents"
import type {
  AlgorithmAugmentation,
  AlgorithmContext,
  AlgorithmResult,
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "./algorithm"

export type RunConsensusOptions = AlgorithmRunOptions & {
  voterCount?: number
  systemPromptAppend?: string
}

export type ConsensusStats = {
  warm_start: boolean
  prior_session_count: number
  voter_count: number
  synthesizer_count: number
  total_delegations: number
  unique_files_cited: number
  files_in_majority: number
  vote_distribution: { path: string; votes: number }[]
  files_bumped: number
  any_minion_failed: boolean
  priors_injected: boolean
}

const CONSENSUS_GUIDANCE = (voterCount: number) => `
# Consensus voting protocol

This is a Consensus-algorithm session. You MUST follow the protocol below — do not search the codebase yourself or answer from prior knowledge alone. The Voters do the searching; you do the synthesis.

## Phase 1: Launch ${voterCount} Voters in parallel

Use the Task tool to launch ${voterCount} Voter subagents concurrently in a SINGLE assistant message. Each Voter gets the user's full original query, verbatim, with no modifications. The Voters investigate independently — they cannot see each other.

Issue all ${voterCount} tool_use blocks in your FIRST assistant turn. Do NOT investigate the codebase yourself first. Do NOT call Read/Glob/Grep before delegating. The whole point of voting is that the Voters search independently of you.

Example structure of your first turn (${voterCount} blocks):

\`\`\`
Task(subagent_type='Voter', prompt=<user's original query>)
Task(subagent_type='Voter', prompt=<user's original query>)
Task(subagent_type='Voter', prompt=<user's original query>)
\`\`\`

## Phase 2: Synthesize from voter reports

After all ${voterCount} tool_results return, write the final answer in your NEXT assistant turn. Use the Voter reports as your evidence:

- Files cited by ≥2 Voters are high-confidence — surface them first
- Files cited by only one Voter are low-confidence — flag the single-voter status
- If Voters disagree, explain why and which the evidence supports
- If a Voter returned MINION_FAILED, work without their input but note the failure

Do NOT call Read/Glob/Grep in Phase 2. Do NOT delegate further. The Voters did the searching; your job is synthesis from their structured reports.

## When to skip the protocol

Only skip Phase 1 if the user's query is a literal command to display a file you've been given the path for (e.g., "show me the contents of /path/to/file.ts"). In that case, just Read the file. For everything else — including questions that feel obvious — run the Voters. Disagreement among independent Voters is useful signal we collect even on "easy" questions.
`

export type RunConsensusResult = AlgorithmResult & {
  consensusStats: ConsensusStats
  ledger: Ledger
}

/** Tally per-voter file-cite sets into a frequency distribution, sorted desc. */
export function tallyVotes(
  voterTouched: Set<string>[],
): { path: string; votes: number }[] {
  const counts = new Map<string, number>()
  for (const set of voterTouched) {
    for (const path of set) counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([path, votes]) => ({ path, votes }))
    .sort((a, b) => b.votes - a.votes || a.path.localeCompare(b.path))
}

function buildConsensusStats(
  ledger: Ledger,
  warmStart: boolean,
  delegations: Array<{ subagent_type: string; files_touched: string[] }>,
  filesBumped: number,
  anyMinionFailed: boolean,
  priorsInjected: boolean,
): ConsensusStats {
  const voterCites = delegations
    .filter((d) => d.subagent_type === "Voter")
    .map((d) => new Set(d.files_touched))
  const distribution = tallyVotes(voterCites)
  const filesInMajority = distribution.filter((d) => d.votes >= 2).length
  const counts = countByType(delegations.map((d) => d.subagent_type))
  return {
    warm_start: warmStart,
    prior_session_count: ledger.session_count - 1,
    voter_count: counts.Voter ?? 0,
    synthesizer_count: counts.Synthesizer ?? 0,
    total_delegations: delegations.length,
    unique_files_cited: distribution.length,
    files_in_majority: filesInMajority,
    vote_distribution: distribution,
    files_bumped: filesBumped,
    any_minion_failed: anyMinionFailed,
    priors_injected: priorsInjected,
  }
}

export async function prepareConsensus(
  _query: string,
  ctx: AlgorithmContext,
  opts?: { voterCount?: number; systemPromptAppend?: string },
): Promise<AlgorithmAugmentation> {
  const voterCount = opts?.voterCount ?? 3
  const ledger = loadLedger(ctx.cwd)
  const warmStart = ledger.session_count > 0
  applyDecay(ledger)

  const { block: priors } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    opts?.systemPromptAppend?.trim(),
    priors,
    CONSENSUS_GUIDANCE(voterCount),
  ]
    .filter(Boolean)
    .join("\n\n")

  const allowedSubagents = new Set(["Voter", "Synthesizer"])
  const observer = createOpusObserver({
    cwd: ctx.cwd,
    algorithm: "consensus",
    ledger,
    allowedSubagents,
  })

  return {
    systemPromptAppend,
    agents: buildAgentsMap(["Voter", "Synthesizer"]),
    canUseToolGuard: observer.canUseToolGuard,
    observeMessage: observer.observeMessage,
    async finalize() {
      const result = observer.finalize()
      const stats = buildConsensusStats(
        ledger,
        warmStart,
        result.delegations,
        result.filesTouched.size,
        result.anyMinionFailed,
        priors !== null,
      )
      setAlgorithmState(ledger, "consensus", {
        last_voter_count: stats.voter_count,
        last_majority_count: stats.files_in_majority,
        last_session_at: new Date().toISOString(),
      })
      pruneFiles(ledger)
      recordSession(ledger)
      await saveLedgerQueued(ledger)
      return stats
    },
  }
}

export async function runConsensus(
  query: string,
  options: RunConsensusOptions,
): Promise<RunConsensusResult> {
  const voterCount = options.voterCount ?? 3
  const ledger = loadLedger(options.cwd)
  const warmStart = ledger.session_count > 0
  applyDecay(ledger)

  const { block: priors } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    options.systemPromptAppend?.trim(),
    priors,
    CONSENSUS_GUIDANCE(voterCount),
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = await runOpusOrchestrated({
    cwd: options.cwd,
    sdkQuery: options.sdkQuery,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    onMessage: options.onMessage,
    query,
    algorithm: "consensus",
    agents: buildAgentsMap(["Voter", "Synthesizer"]),
    allowedSubagents: new Set(["Voter", "Synthesizer"]),
    systemPromptAppend,
    ledger,
  })

  const consensusStats = buildConsensusStats(
    ledger,
    warmStart,
    result.delegations,
    result.filesTouched.size,
    result.anyMinionFailed,
    priors !== null,
  )
  setAlgorithmState(ledger, "consensus", {
    last_voter_count: consensusStats.voter_count,
    last_majority_count: consensusStats.files_in_majority,
    last_session_at: new Date().toISOString(),
  })
  pruneFiles(ledger)
  recordSession(ledger)
  await saveLedgerQueued(ledger)

  return {
    messages: result.messages,
    stats: consensusStats,
    consensusStats,
    ledger,
  }
}

function formatConsensusStats(stats: AlgorithmStats): string[] {
  const s = stats as ConsensusStats
  const lines = [
    "Consensus voting:",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  delegations: voter=${s.voter_count}, synthesizer=${s.synthesizer_count} (total ${s.total_delegations})`,
    `  unique files cited: ${s.unique_files_cited}`,
    `  files in majority (≥2 votes): ${s.files_in_majority}`,
  ]
  if (s.vote_distribution.length > 0) {
    lines.push("  top cited:")
    for (const d of s.vote_distribution.slice(0, 5)) {
      lines.push(`    - ${d.path} (${d.votes})`)
    }
  }
  if (s.any_minion_failed) lines.push("  ⚠ at least one Voter returned MINION_FAILED")
  if (s.voter_count === 0 && s.total_delegations === 0) {
    lines.push("  ⚠ Opus skipped voting entirely — query may have been too narrow")
  }
  return lines
}

function formatConsensusVerdict(stats: AlgorithmStats): string {
  const s = stats as ConsensusStats
  return `CONSENSUS ${s.voter_count}V/${s.synthesizer_count}Synth, ${s.files_in_majority}/${s.unique_files_cited} majority, fail=${s.any_minion_failed ? "Y" : "N"}`
}

export const consensusAlgorithm: SwarmAlgorithm = {
  name: "consensus",
  description:
    "Parallel-redundant voting: Opus issues N parallel Voter calls in one turn (each gets the same query independently), then synthesizes weighting majority cites. Highest-confidence shape; pays N× tokens for it.",
  prepare: prepareConsensus,
  formatStats: formatConsensusStats,
  formatVerdict: formatConsensusVerdict,
}

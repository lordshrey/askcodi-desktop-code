/**
 * ABC (Artificial Bee Colony) — scout-recruit pattern.
 *
 * Architecture:
 *   - prepare(): loads ledger, applies decay, builds priors + ABC
 *     guidance. Registers three Haiku subagents (Scout, Recruit,
 *     Synthesizer). Returns the augmentation for the runtime.
 *   - canUseToolGuard: denies Task delegations to non-allowlisted names.
 *   - observeMessage: tracks delegations and file touches.
 *   - finalize: persists per-algorithm scratch (last recruit count),
 *     prunes, records session, saves ledger via the per-cwd queue.
 *
 * Soft enforcement: if Opus skips a phase or doesn't fan out in
 * parallel, the algorithm doesn't override — we just see it in the
 * ledger and tune the prompt later.
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

export type RunAbcOptions = AlgorithmRunOptions & {
  recruitCount?: number
  systemPromptAppend?: string
}

export type AbcStats = {
  warm_start: boolean
  prior_session_count: number
  scout_count: number
  recruit_count: number
  synthesizer_count: number
  total_delegations: number
  files_bumped: number
  any_minion_failed: boolean
  priors_injected: boolean
}

const ABC_GUIDANCE = (recruitCount: number) => `
## Subagent routing policy (ABC scout-recruit)

You have three Haiku subagents available:
- **Scout** — sweeps the codebase and returns the top 3-5 CANDIDATES for downstream investigation. Returns a numbered list, no deep analysis.
- **Recruit** — deep-dives ONE assigned candidate. Returns focused findings cited by file:line.
- **Synthesizer** — folds multiple Recruit reports into a single answer. No tools — pure text fold.

For non-trivial questions, follow this phased pattern:

1. First turn: \`Task(subagent_type='Scout', prompt=<the user's question>)\` — get a candidate list.
2. Next turn: parse the candidates from the Scout's response. Then issue ${recruitCount} parallel \`Task(subagent_type='Recruit', prompt='Original query: ... | Your assigned target: <candidate>')\` calls IN A SINGLE ASSISTANT MESSAGE — multiple tool_use blocks in one turn so the SDK runs them concurrently.
3. After all Recruits return: either synthesize the findings yourself in a final assistant turn (preferred — keeps the answer in your context for follow-up), OR delegate the fold to \`Task(subagent_type='Synthesizer', ...)\` and pass the Recruit reports in the prompt.

Skip the scout-recruit pattern only when the user's query is genuinely a single-file lookup. If you're unsure, run the pattern — it's cheap.

The orchestrator measures whether you actually fanned out in parallel. Sequential delegations work but are slower; aim for the single-turn parallel pattern.
`

export type RunAbcResult = AlgorithmResult & {
  abcStats: AbcStats
  ledger: Ledger
}

function buildAbcStats(
  ledger: Ledger,
  warmStart: boolean,
  delegations: Array<{ subagent_type: string }>,
  filesBumped: number,
  anyMinionFailed: boolean,
  priorsInjected: boolean,
): AbcStats {
  const counts = countByType(delegations.map((d) => d.subagent_type))
  return {
    warm_start: warmStart,
    prior_session_count: ledger.session_count - 1,
    scout_count: counts.Scout ?? 0,
    recruit_count: counts.Recruit ?? 0,
    synthesizer_count: counts.Synthesizer ?? 0,
    total_delegations: delegations.length,
    files_bumped: filesBumped,
    any_minion_failed: anyMinionFailed,
    priors_injected: priorsInjected,
  }
}

export async function prepareAbc(
  _query: string,
  ctx: AlgorithmContext,
  opts?: { recruitCount?: number; systemPromptAppend?: string },
): Promise<AlgorithmAugmentation> {
  const recruitCount = opts?.recruitCount ?? 3
  const ledger = loadLedger(ctx.cwd)
  const warmStart = ledger.session_count > 0
  applyDecay(ledger)

  const { block: priors } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    opts?.systemPromptAppend?.trim(),
    priors,
    ABC_GUIDANCE(recruitCount),
  ]
    .filter(Boolean)
    .join("\n\n")

  const allowedSubagents = new Set(["Scout", "Recruit", "Synthesizer"])
  const observer = createOpusObserver({
    cwd: ctx.cwd,
    algorithm: "abc",
    ledger,
    allowedSubagents,
  })

  return {
    systemPromptAppend,
    agents: buildAgentsMap(["Scout", "Recruit", "Synthesizer"]),
    canUseToolGuard: observer.canUseToolGuard,
    observeMessage: observer.observeMessage,
    async finalize() {
      const result = observer.finalize()
      const counts = countByType(result.delegations.map((d) => d.subagent_type))
      setAlgorithmState(ledger, "abc", {
        last_recruit_count: counts.Recruit ?? 0,
        last_session_at: new Date().toISOString(),
      })
      pruneFiles(ledger)
      recordSession(ledger)
      await saveLedgerQueued(ledger)
      return buildAbcStats(
        ledger,
        warmStart,
        result.delegations,
        result.filesTouched.size,
        result.anyMinionFailed,
        priors !== null,
      )
    },
  }
}

export async function runAbc(
  query: string,
  options: RunAbcOptions,
): Promise<RunAbcResult> {
  const recruitCount = options.recruitCount ?? 3
  const ledger = loadLedger(options.cwd)
  const warmStart = ledger.session_count > 0
  applyDecay(ledger)

  const { block: priors } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    options.systemPromptAppend?.trim(),
    priors,
    ABC_GUIDANCE(recruitCount),
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = await runOpusOrchestrated({
    cwd: options.cwd,
    sdkQuery: options.sdkQuery,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    onMessage: options.onMessage,
    query,
    algorithm: "abc",
    agents: buildAgentsMap(["Scout", "Recruit", "Synthesizer"]),
    allowedSubagents: new Set(["Scout", "Recruit", "Synthesizer"]),
    systemPromptAppend,
    ledger,
  })

  const counts = countByType(result.delegations.map((d) => d.subagent_type))
  setAlgorithmState(ledger, "abc", {
    last_recruit_count: counts.Recruit ?? 0,
    last_session_at: new Date().toISOString(),
  })
  pruneFiles(ledger)
  recordSession(ledger)
  await saveLedgerQueued(ledger)

  const abcStats = buildAbcStats(
    ledger,
    warmStart,
    result.delegations,
    result.filesTouched.size,
    result.anyMinionFailed,
    priors !== null,
  )

  return {
    messages: result.messages,
    stats: abcStats,
    abcStats,
    ledger,
  }
}

function formatAbcStats(stats: AlgorithmStats): string[] {
  const s = stats as AbcStats
  const lines = [
    "ABC scout-recruit:",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  delegations: scout=${s.scout_count}, recruit=${s.recruit_count}, synthesizer=${s.synthesizer_count} (total ${s.total_delegations})`,
    `  files bumped this session: ${s.files_bumped}`,
    `  priors injected: ${s.priors_injected ? "YES" : "no (cold start)"}`,
  ]
  if (s.any_minion_failed) lines.push("  ⚠ at least one minion returned MINION_FAILED")
  if (s.scout_count === 0 && s.total_delegations > 0) {
    lines.push("  ⚠ Opus skipped the Scout phase — pattern not fully exercised")
  }
  if (s.scout_count > 0 && s.recruit_count === 0) {
    lines.push("  ⚠ Scout ran but no Recruits dispatched — query may have been too narrow")
  }
  return lines
}

function formatAbcVerdict(stats: AlgorithmStats): string {
  const s = stats as AbcStats
  return `ABC ${s.scout_count}S/${s.recruit_count}R/${s.synthesizer_count}Synth (${s.files_bumped} files bumped, fail=${s.any_minion_failed ? "Y" : "N"})`
}

export const abcAlgorithm: SwarmAlgorithm = {
  name: "abc",
  description:
    "Artificial Bee Colony scout-recruit: Opus dispatches one Scout to nominate candidates, then issues parallel Recruits per candidate in one turn, then synthesizes. Sequential-phased coordination via Haiku subagents.",
  prepare: prepareAbc,
  formatStats: formatAbcStats,
  formatVerdict: formatAbcVerdict,
}

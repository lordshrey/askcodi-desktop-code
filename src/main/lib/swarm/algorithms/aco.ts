/**
 * ACO (Ant Colony Optimization) — single Opus session with persistent
 * pheromone memory across sessions on the same codebase.
 *
 * Architecture:
 *   - prepare(): loads ledger, applies decay, builds priors block.
 *     Registers ONE Haiku subagent (Explore). Returns the augmentation
 *     for the runtime to compose onto its sdk.query() call.
 *   - canUseToolGuard: denies Task delegations to non-allowlisted
 *     subagents.
 *   - observeMessage: walks the stream, attributes file touches per
 *     subagent, bumps pheromone counters in the ledger.
 *   - finalize: prunes low-priority entries, increments session count,
 *     persists ledger via the per-cwd write queue.
 *
 * The compounding moat — file-priority accumulating across sessions —
 * is unchanged. ACO's bookkeeping lives in the shared
 * .askcodi/ledger.json alongside ABC/Consensus/Frontier delegations.
 */
import {
  applyDecay,
  buildPriorsBlock,
  loadLedger,
  pruneFiles,
  recordSession,
  saveLedgerQueued,
  type Ledger,
} from "../ledger"
import {
  createOpusObserver,
  runOpusOrchestrated,
} from "../orchestrator"
import { buildAgentsMap } from "../subagents"
import type {
  AlgorithmAugmentation,
  AlgorithmContext,
  AlgorithmResult,
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "./algorithm"

export type RunAcoOptions = AlgorithmRunOptions & {
  decayRate?: number
  bumpAmount?: number
  systemPromptAppend?: string
}

export type AcoStats = {
  warm_start: boolean
  prior_session_count: number
  files_at_start: number
  files_at_end: number
  files_bumped: number
  priors_injected: boolean
  priors_paths: string[]
  delegation_count: number
  delegations_by_subagent: Record<string, number>
  any_minion_failed: boolean
}

const ACO_GUIDANCE = `
## Subagent routing policy (ACO)

You have an \`Explore\` subagent (Haiku-pinned, read-only Read/Glob/Grep).

Delegation rule:
- For ANY non-trivial code investigation — pattern searches, multi-file reads, framework surveys, "find every place that...", "trace the X flow", or anything that requires examining more than one file — delegate via \`Task(subagent_type='Explore', ...)\`. The subagent's context absorbs the raw search output and returns a compact summary, keeping your context lean for the actual reasoning.
- Use Read/Glob/Grep directly ONLY when the user gave you a specific file path to display.
- If the priors block above suggests starting points, weave them into your delegation prompt — but never insist the subagent use them. Treat priors as hints, not directives.
`

export type RunAcoResult = AlgorithmResult & {
  acoStats: AcoStats
  ledger: Ledger
}

/** Build an AcoStats from the observer result + ledger snapshots. */
function buildAcoStats(
  ledger: Ledger,
  warmStart: boolean,
  filesAtStart: number,
  delegations: Array<{ subagent_type: string; result_summary: string }>,
  filesTouched: number,
  priorsInjected: boolean,
  priorsPaths: string[],
  anyMinionFailed: boolean,
): AcoStats {
  const delegations_by_subagent: Record<string, number> = {}
  for (const d of delegations) {
    delegations_by_subagent[d.subagent_type] =
      (delegations_by_subagent[d.subagent_type] ?? 0) + 1
  }
  return {
    warm_start: warmStart,
    prior_session_count: ledger.session_count - 1,
    files_at_start: filesAtStart,
    files_at_end: Object.keys(ledger.files).length,
    files_bumped: filesTouched,
    priors_injected: priorsInjected,
    priors_paths: priorsPaths,
    delegation_count: delegations.length,
    delegations_by_subagent,
    any_minion_failed: anyMinionFailed,
  }
}

/**
 * Production prepare(). Returns the augmentation pieces the runtime
 * composes onto its sdk.query() call.
 */
export async function prepareAco(
  _query: string,
  ctx: AlgorithmContext,
  opts?: { decayRate?: number; bumpAmount?: number; systemPromptAppend?: string },
): Promise<AlgorithmAugmentation> {
  const ledger = loadLedger(ctx.cwd)
  const warmStart = ledger.session_count > 0
  const filesAtStart = Object.keys(ledger.files).length

  applyDecay(ledger, opts?.decayRate)

  const { block: priors, paths: priorsPaths } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    opts?.systemPromptAppend?.trim(),
    priors,
    ACO_GUIDANCE,
  ]
    .filter(Boolean)
    .join("\n\n")

  const allowedSubagents = new Set(["Explore"])
  const observer = createOpusObserver({
    cwd: ctx.cwd,
    algorithm: "aco",
    ledger,
    allowedSubagents,
    bumpAmount: opts?.bumpAmount,
  })

  return {
    systemPromptAppend,
    agents: buildAgentsMap(["Explore"]),
    canUseToolGuard: observer.canUseToolGuard,
    observeMessage: observer.observeMessage,
    async finalize() {
      const result = observer.finalize()
      pruneFiles(ledger)
      recordSession(ledger)
      await saveLedgerQueued(ledger)
      return buildAcoStats(
        ledger,
        warmStart,
        filesAtStart,
        result.delegations,
        result.filesTouched.size,
        priors !== null,
        priorsPaths,
        result.anyMinionFailed,
      )
    },
  }
}

/**
 * Suite-runner harness. Composes prepare() into a full sdk.query() run
 * so offline experiments can measure ACO end-to-end without booting
 * the production runtime.
 */
export async function runAco(
  query: string,
  options: RunAcoOptions,
): Promise<RunAcoResult> {
  const ledger = loadLedger(options.cwd)
  const warmStart = ledger.session_count > 0
  const filesAtStart = Object.keys(ledger.files).length

  applyDecay(ledger, options.decayRate)

  const { block: priors, paths: priorsPaths } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    options.systemPromptAppend?.trim(),
    priors,
    ACO_GUIDANCE,
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = await runOpusOrchestrated({
    cwd: options.cwd,
    sdkQuery: options.sdkQuery,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    onMessage: options.onMessage,
    query,
    algorithm: "aco",
    agents: buildAgentsMap(["Explore"]),
    allowedSubagents: new Set(["Explore"]),
    systemPromptAppend,
    ledger,
    bumpAmount: options.bumpAmount,
  })

  pruneFiles(ledger)
  recordSession(ledger)
  await saveLedgerQueued(ledger)

  const acoStats = buildAcoStats(
    ledger,
    warmStart,
    filesAtStart,
    result.delegations,
    result.filesTouched.size,
    priors !== null,
    priorsPaths,
    result.anyMinionFailed,
  )

  return {
    messages: result.messages,
    stats: acoStats,
    acoStats,
    ledger,
  }
}

function formatAcoStats(stats: AlgorithmStats): string[] {
  const s = stats as AcoStats
  const lines = [
    "ACO pheromone memory:",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  files tracked: ${s.files_at_start} → ${s.files_at_end}`,
    `  files bumped this session: ${s.files_bumped}`,
    `  priors injected: ${s.priors_injected ? "YES" : "no (cold start)"}`,
    `  delegations: ${s.delegation_count}`,
  ]
  if (s.delegation_count > 0) {
    const breakdown = Object.entries(s.delegations_by_subagent)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
    lines.push(`  by subagent: ${breakdown}`)
  }
  if (s.priors_injected) {
    lines.push("  top priors shown to parent:")
    for (const p of s.priors_paths) lines.push(`    - ${p}`)
  }
  if (s.any_minion_failed) lines.push("  ⚠ at least one minion returned MINION_FAILED")
  return lines
}

function formatAcoVerdict(stats: AlgorithmStats): string {
  const s = stats as AcoStats
  return s.warm_start
    ? `ACO WARM (${s.prior_session_count} prior sessions, ${s.delegation_count} delegations, ${s.files_bumped} files bumped, priors=${s.priors_injected ? "ON" : "off"})`
    : `ACO COLD START (${s.delegation_count} delegations, ${s.files_bumped} files seeded)`
}

export const acoAlgorithm: SwarmAlgorithm = {
  name: "aco",
  description:
    "Ant Colony Optimization: persistent file-priority ledger compounds across sessions, injected as priors. Single Opus session; delegates exploration to a Haiku Explore subagent.",
  prepare: prepareAco,
  formatStats: formatAcoStats,
  formatVerdict: formatAcoVerdict,
}

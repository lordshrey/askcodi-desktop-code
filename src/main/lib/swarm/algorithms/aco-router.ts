/**
 * ACO/Frontier Router (adaptive swarm).
 *
 * Single Opus session with BOTH Explore and PartitionWorker subagents
 * registered. Opus reads the user's query plus the codebase inventory
 * plus cached partitions and decides per-query whether to use:
 *
 *   - **Explore** (single Haiku subagent, ACO-style): for NARROW queries
 *     about a single area or specific file. Cheaper, fewer turns.
 *   - **PartitionWorker** fanout (Frontier-style): for BROAD queries
 *     spanning multiple regions. Higher quality, more cost.
 *   - **Mixed**: one Explore + targeted PartitionWorker is allowed when
 *     the query has a small focused part plus broad context.
 *
 * The point: ACO wins on narrow queries (per the per-cell data);
 * Frontier wins on broad ones. Letting Opus pick per query gets us
 * both wins.
 *
 * Architecture: reuses everything from aco-frontier (per-region
 * pheromones, partition cache, cache auto-detection) plus ACO's
 * standard global priors block. Adds a routing decision tag that
 * Opus emits so we can track distribution of choices.
 */
import {
  applyDecay,
  buildPriorsBlock,
  DEFAULT_BUMP,
  loadLedger,
  pruneFiles,
  recordSession,
  saveLedgerQueued,
  setAlgorithmState,
  type FileEntry,
  type Ledger,
} from "../ledger"
import {
  createOpusObserver,
  runOpusOrchestrated,
} from "../orchestrator"
import {
  appendAssistantText,
  collectAssistantText,
  countByType,
} from "../stream-utils"
import { buildAgentsMap } from "../subagents"
import {
  ACO_FRONTIER_STATE_KEY,
  applyRegionDecay,
  bumpRegionPheromones,
  buildPriorsByRegion,
  detectSelectedCandidate,
  loadAcoFrontierState,
  parseCandidates,
  renderPartitionCache,
  updatePartitionCache,
} from "./aco-frontier"
import {
  computeOverlap,
  listPartitionableDirs,
  type ListPartitionableOptions,
} from "./frontier"
import type {
  AlgorithmAugmentation,
  AlgorithmContext,
  AlgorithmResult,
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "./algorithm"

export type RoutingDecision = "explore" | "partition" | "mixed" | "none"

export type RunAcoRouterOptions = AlgorithmRunOptions & {
  minionModel?: string
  listPartitionableDirs?: (cwd: string) => string[]
  partitionOptions?: ListPartitionableOptions
  priorsPerRegion?: number
  systemPromptAppend?: string
  decayRate?: number
  bumpAmount?: number
}

export type AcoRouterStats = {
  warm_start: boolean
  prior_session_count: number
  inventory: string[]
  routing_decision: RoutingDecision
  routing_explicit: boolean
  explore_count: number
  partition_worker_count: number
  synthesizer_count: number
  total_delegations: number
  overlap_count: number
  overlap_files: string[]
  files_bumped: number
  any_minion_failed: boolean
  priors_injected: boolean
  cache_action: "reused" | "created" | "untagged"
  cache_action_id: string | null
  cache_size: number
  /** Beam partitioning analytics (populated only when route=partition). */
  beam_candidates_emitted: number
  beam_selected_candidate: number | null
}

const ROUTE_RE = /\[route:(explore|partition|mixed)\]/i

/** Detect [route:explore|partition|mixed] in Opus's text. Returns the route or null. */
export function detectRouteTag(text: string): RoutingDecision | null {
  const m = text.match(ROUTE_RE)
  if (!m) return null
  const v = m[1].toLowerCase()
  if (v === "explore" || v === "partition" || v === "mixed") return v
  return null
}

/**
 * Infer routing decision from observed delegation counts when Opus
 * didn't tag explicitly. Pure helper.
 */
export function inferRoutingFromCounts(
  exploreCount: number,
  partitionCount: number,
): RoutingDecision {
  if (exploreCount > 0 && partitionCount > 0) return "mixed"
  if (partitionCount > 0) return "partition"
  if (exploreCount > 0) return "explore"
  return "none"
}

const ROUTER_GUIDANCE = (
  inventory: string[],
  priorsByRegionMap: Record<string, FileEntry[]>,
  cacheBlock: string,
): string => {
  const inventoryBlock =
    inventory.length > 0
      ? inventory
          .map((d) => {
            const ps = priorsByRegionMap[d] ?? []
            if (ps.length === 0) return `  - ${d}  (no priors yet)`
            const list = ps
              .map((e) => `${e.path} (priority ${e.priority.toFixed(2)})`)
              .join(", ")
            return `  - ${d}\n      hot files: ${list}`
          })
          .join("\n")
      : "  (codebase has no top-level dirs to inventory)"

  return `
# Adaptive Swarm protocol (ACO/Frontier router)

This is an adaptive-swarm session. You have TWO subagent types and you decide which fits the user's query:

- **Explore**: single Haiku subagent. Returns a compact summary in ONE context. Best for NARROW queries about a single area, a specific file, or a small focused topic.
- **PartitionWorker**: parallel Haiku subagents covering disjoint regions. Best for BROAD queries that span multiple parts of the codebase, "trace the X flow", "what's incomplete", "map the Y layer."

## Codebase inventory + per-region priors

${inventoryBlock}
${cacheBlock ? "\n" + cacheBlock + "\n" : ""}
## Routing decision

Read the user's query. Decide:

1. **Narrow / single-area / specific?** Examples: "show me the contents of X", "what does function Y do", "explain how auth.ts works." → Use \`Task(Explore, prompt=<the query>)\`. ONE call. Cheaper, faster.

2. **Broad / cross-cutting / spans regions?** Examples: "trace data flow end to end", "find every place that does X", "map the IPC layer." → Use the BEAM PARTITIONING protocol below, then spawn 2-4 \`Task(PartitionWorker)\` calls in a SINGLE assistant turn matching your selected partition.

   **Beam partitioning** (only when route=partition):
   - First, in your text block, emit THREE different candidate partition shapes using \`[CANDIDATE 1] ... [CANDIDATE 2] ... [CANDIDATE 3] ...\` with worker scopes + rationale.
   - Then evaluate them and tag your pick with \`[selected:N]\` (1, 2, or 3).
   - Then dispatch the selected candidate's PartitionWorker calls.
   - Same turn — text block + tool_use blocks together.
   - Also tag with \`[reuse:XXXX]\` if any candidate aligns with a cached partition, or \`[new-partition: <pattern>]\` for a brand-new shape.

3. **Could go either way?** Default to Explore (cheaper). If Explore returns insufficient findings, you can still spawn PartitionWorkers in a follow-up turn — that's the "mixed" route.

START your first assistant turn with one of:
- \`[route:explore]\` if you're using Explore alone
- \`[route:partition]\` if you're spawning PartitionWorkers
- \`[route:mixed]\` if you're using both

This tag lets the algorithm track routing distribution across queries.

## Worker prompt requirements (when using PartitionWorker)

Each PartitionWorker prompt MUST contain:
1. The user's original query (verbatim)
2. The Worker's assigned region (under heading \`YOUR REGION:\`)
3. The OTHER workers' regions ("Stay in YOUR region; the others cover: ...")
4. Hot files in your region from the priors above (if any)

If you reuse a cached partition, also tag with \`[reuse:XXXX]\` (the partition id). If you design a new partition, also tag with \`[new-partition: <one-line pattern>]\`.

## Phase 2: Synthesize

After delegation(s) return, write the final answer in your next assistant turn. Don't call Read/Glob/Grep yourself in synthesis — the subagents did the searching.
`
}

export type RunAcoRouterResult = AlgorithmResult & {
  acoRouterStats: AcoRouterStats
  ledger: Ledger
}

import type { AcoFrontierState } from "./aco-frontier"

/** Shared post-processing used by both prepareAcoRouter and runAcoRouter. */
function processAcoRouterResult(
  ledger: Ledger,
  state: AcoFrontierState,
  inventory: string[],
  warmStart: boolean,
  globalPriorsInjected: boolean,
  byRegion: Record<string, FileEntry[]>,
  query: string,
  bumpAmount: number,
  observerResult: {
    opusText: string
    delegations: Array<{
      subagent_type: string
      prompt_preview: string
      files_touched: string[]
      result_summary: string
    }>
    filesTouched: Set<string>
    anyMinionFailed: boolean
  },
  now: Date,
): AcoRouterStats {
  const partitionDelegations = observerResult.delegations.filter(
    (d) => d.subagent_type === "PartitionWorker",
  )
  const exploreDelegations = observerResult.delegations.filter(
    (d) => d.subagent_type === "Explore",
  )

  bumpRegionPheromones(state, partitionDelegations, inventory, bumpAmount, now)

  const overlap = computeOverlap(
    partitionDelegations.map((d) => new Set(d.files_touched)),
  )

  const opusText = observerResult.opusText
  const explicitRoute = detectRouteTag(opusText)
  const beamCandidates = parseCandidates(opusText)
  const beamSelected = detectSelectedCandidate(opusText)
  const routing: RoutingDecision =
    explicitRoute ??
    inferRoutingFromCounts(exploreDelegations.length, partitionDelegations.length)
  const routingExplicit = explicitRoute !== null

  const { cacheAction, cacheActionId } = updatePartitionCache(state, {
    opusText,
    query,
    partitionDelegations,
    overlapCount: overlap.count,
    now,
  })

  const counts = countByType(observerResult.delegations.map((d) => d.subagent_type))
  return {
    warm_start: warmStart,
    prior_session_count: ledger.session_count - 1,
    inventory,
    routing_decision: routing,
    routing_explicit: routingExplicit,
    explore_count: counts.Explore ?? 0,
    partition_worker_count: counts.PartitionWorker ?? 0,
    synthesizer_count: counts.Synthesizer ?? 0,
    total_delegations: observerResult.delegations.length,
    overlap_count: overlap.count,
    overlap_files: overlap.files,
    files_bumped: observerResult.filesTouched.size,
    any_minion_failed: observerResult.anyMinionFailed,
    priors_injected:
      globalPriorsInjected || Object.values(byRegion).some((l) => l.length > 0),
    cache_action: cacheAction,
    cache_action_id: cacheActionId,
    cache_size: state.cached_partitions.length,
    beam_candidates_emitted: beamCandidates.length,
    beam_selected_candidate: beamSelected,
  }
}

export async function prepareAcoRouter(
  query: string,
  ctx: AlgorithmContext,
  opts?: {
    listPartitionableDirs?: (cwd: string) => string[]
    partitionOptions?: ListPartitionableOptions
    priorsPerRegion?: number
    systemPromptAppend?: string
    decayRate?: number
    bumpAmount?: number
  },
): Promise<AlgorithmAugmentation> {
  const enumerate =
    opts?.listPartitionableDirs ??
    ((cwd: string) => listPartitionableDirs(cwd, opts?.partitionOptions))
  const inventory = enumerate(ctx.cwd)
  const topN = opts?.priorsPerRegion ?? 5

  const ledger = loadLedger(ctx.cwd)
  const warmStart = ledger.session_count > 0
  const state = loadAcoFrontierState(ledger)

  applyRegionDecay(state, inventory, opts?.decayRate)
  applyDecay(ledger, opts?.decayRate)

  const byRegion = buildPriorsByRegion(state, inventory, topN)
  const { block: globalPriors } = buildPriorsBlock(ledger)
  const cacheBlock = renderPartitionCache(state)

  const systemPromptAppend = [
    opts?.systemPromptAppend?.trim(),
    globalPriors,
    ROUTER_GUIDANCE(inventory, byRegion, cacheBlock),
  ]
    .filter(Boolean)
    .join("\n\n")

  const allowedSubagents = new Set([
    "Explore",
    "PartitionWorker",
    "Synthesizer",
  ])
  const observer = createOpusObserver({
    cwd: ctx.cwd,
    algorithm: "aco-router",
    ledger,
    allowedSubagents,
    bumpAmount: opts?.bumpAmount,
  })
  const opusTextChunks: string[] = []
  const bumpAmount = opts?.bumpAmount ?? DEFAULT_BUMP

  return {
    systemPromptAppend,
    agents: buildAgentsMap(["Explore", "PartitionWorker", "Synthesizer"]),
    canUseToolGuard: observer.canUseToolGuard,
    observeMessage(msg) {
      appendAssistantText(opusTextChunks, msg)
      observer.observeMessage(msg)
    },
    async finalize() {
      const result = observer.finalize()
      const stats = processAcoRouterResult(
        ledger,
        state,
        inventory,
        warmStart,
        globalPriors !== null,
        byRegion,
        query,
        bumpAmount,
        { ...result, opusText: opusTextChunks.join("\n\n") },
        new Date(),
      )
      setAlgorithmState(ledger, ACO_FRONTIER_STATE_KEY, state)
      pruneFiles(ledger)
      recordSession(ledger)
      await saveLedgerQueued(ledger)
      return stats
    },
  }
}

export async function runAcoRouter(
  query: string,
  options: RunAcoRouterOptions,
): Promise<RunAcoRouterResult> {
  const enumerate =
    options.listPartitionableDirs ??
    ((cwd: string) => listPartitionableDirs(cwd, options.partitionOptions))
  const inventory = enumerate(options.cwd)
  const topN = options.priorsPerRegion ?? 5

  const ledger = loadLedger(options.cwd)
  const warmStart = ledger.session_count > 0
  const state = loadAcoFrontierState(ledger)

  applyRegionDecay(state, inventory, options.decayRate)
  applyDecay(ledger, options.decayRate)

  const byRegion = buildPriorsByRegion(state, inventory, topN)
  const { block: globalPriors } = buildPriorsBlock(ledger)
  const cacheBlock = renderPartitionCache(state)

  const systemPromptAppend = [
    options.systemPromptAppend?.trim(),
    globalPriors,
    ROUTER_GUIDANCE(inventory, byRegion, cacheBlock),
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = await runOpusOrchestrated({
    cwd: options.cwd,
    sdkQuery: options.sdkQuery,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    onMessage: options.onMessage,
    query,
    algorithm: "aco-router",
    agents: buildAgentsMap(["Explore", "PartitionWorker", "Synthesizer"]),
    allowedSubagents: new Set(["Explore", "PartitionWorker", "Synthesizer"]),
    systemPromptAppend,
    ledger,
    bumpAmount: options.bumpAmount,
  })

  const bumpAmount = options.bumpAmount ?? DEFAULT_BUMP
  const now = new Date()
  const stats = processAcoRouterResult(
    ledger,
    state,
    inventory,
    warmStart,
    globalPriors !== null,
    byRegion,
    query,
    bumpAmount,
    { ...result, opusText: collectAssistantText(result.messages) },
    now,
  )

  setAlgorithmState(ledger, ACO_FRONTIER_STATE_KEY, state)
  pruneFiles(ledger)
  recordSession(ledger)
  await saveLedgerQueued(ledger)

  return {
    messages: result.messages,
    stats,
    acoRouterStats: stats,
    ledger,
  }
}

function formatAcoRouterStats(stats: AlgorithmStats): string[] {
  const s = stats as AcoRouterStats
  const lines = [
    "ACO/Frontier router (adaptive swarm):",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  routing: ${s.routing_decision.toUpperCase()}${s.routing_explicit ? " (Opus tagged)" : " (inferred)"}`,
    `  delegations: explore=${s.explore_count}, partition_worker=${s.partition_worker_count}, synthesizer=${s.synthesizer_count}`,
    `  inventory: ${s.inventory.length} regions`,
    `  files bumped: ${s.files_bumped}`,
  ]
  if (s.partition_worker_count > 0) {
    lines.push(
      `  partition: ${s.overlap_count} overlap files, cache=${s.cache_action} [${s.cache_action_id || "-"}] (${s.cache_size} cached)`,
    )
  }
  if (s.any_minion_failed) lines.push("  ⚠ at least one minion returned MINION_FAILED")
  return lines
}

function formatAcoRouterVerdict(stats: AlgorithmStats): string {
  const s = stats as AcoRouterStats
  return `ROUTER ${s.routing_decision} (E=${s.explore_count}, P=${s.partition_worker_count}, ${s.files_bumped} files, fail=${s.any_minion_failed ? "Y" : "N"})`
}

export const acoRouterAlgorithm: SwarmAlgorithm = {
  name: "aco-router",
  description:
    "Adaptive swarm: Opus reads the query and picks Explore (narrow, ACO-style single subagent) OR PartitionWorker fanout (broad, Frontier-style parallel coverage), or both. Reuses per-region pheromones + partition cache from the hybrid.",
  prepare: prepareAcoRouter,
  formatStats: formatAcoRouterStats,
  formatVerdict: formatAcoRouterVerdict,
}

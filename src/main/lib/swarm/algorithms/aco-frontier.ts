/**
 * ACO+Frontier hybrid (stigmergic frontier exploration).
 *
 * Combines:
 *   - **Frontier's Opus-decides partition** — Opus reads the codebase
 *     inventory plus per-region priors, carves up the search space per
 *     query, dispatches parallel PartitionWorkers per region.
 *   - **ACO's persistent priors, scoped per region** — instead of a
 *     single global pheromone map, the hybrid keeps a separate
 *     pheromone table for each inventory region. Workers' file bumps
 *     get attributed to their region by longest-prefix matching on the
 *     codebase inventory.
 *
 * Why per-region memory: a global pheromone table conflates files
 * across queries that touched them from different angles. Q1 might
 * bump auth.ts because the user asked about auth; Q2 bumps it because
 * the user asked about routing that crosses auth. Per-region tables
 * let each region's pheromones converge on what's hot WITHIN that
 * region's natural use cases, without cross-pollination noise.
 *
 * Architecture is otherwise identical to plain Frontier — single Opus
 * session via the orchestrator, PartitionWorker + Synthesizer subagents,
 * canUseTool guard restricting subagent_types.
 */
import {
  applyDecay,
  buildPriorsBlock,
  DEFAULT_BUMP,
  DEFAULT_DECAY,
  getAlgorithmState,
  loadLedger,
  PRIORITY_CEIL,
  PRIORITY_FLOOR,
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

/** Per-region pheromone table. Same shape as ledger.files but scoped to one region. */
export type RegionMemory = {
  /** Files touched while a Worker was assigned to this region. */
  files: Record<string, FileEntry>
  /** How many sessions have touched this region. */
  region_sessions: number
  /** ISO 8601 of last activity. */
  last_touched: string
}

/** One worker's role within a cached partition. */
export type CachedWorkerSpec = {
  label: string
  scope: string
}

/** A partition shape Opus designed previously, kept around for reuse on similar queries. */
export type CachedPartition = {
  /** Short stable id (4 chars). Opus references it as [reuse:XXXX]. */
  id: string
  /** Free-form description of the kinds of queries this partition fits. */
  query_pattern: string
  workers: CachedWorkerSpec[]
  reuse_count: number
  created_at: string
  last_used: string
  /** Last overlap_count this partition produced. Lower = cleaner cut. */
  last_overlap_count: number
  /** Sum of overlap counts across all uses. Divide by (1+reuse_count) for avg. */
  total_overlap: number
}

/** Algorithm-specific state stored in ledger.algorithm_state["aco-frontier"]. */
export type AcoFrontierState = {
  version: 2
  /** region path (from inventory) -> RegionMemory */
  region_memory: Record<string, RegionMemory>
  /** Partition shapes Opus has designed before. Grows with new query types. */
  cached_partitions: CachedPartition[]
}

/** How many cached partitions to keep. Beyond this, oldest by last_used get evicted. */
export const MAX_CACHED_PARTITIONS = 20

/** Ledger algorithm_state key for the hybrid (router shares this state). */
export const ACO_FRONTIER_STATE_KEY = "aco-frontier" as const

/** Action taken on the partition cache during a session. */
export type CacheAction = "reused" | "created" | "untagged"

export type CacheUpdateOutcome = {
  cacheAction: CacheAction
  cacheActionId: string | null
}

export type RunAcoFrontierOptions = AlgorithmRunOptions & {
  minionModel?: string
  /** Override directory enumerator (tests inject a fake). */
  listPartitionableDirs?: (cwd: string) => string[]
  /** Tuning for the default monorepo-aware enumerator. */
  partitionOptions?: ListPartitionableOptions
  /** How many top-priority files to expose per inventory entry. Default 5. */
  priorsPerRegion?: number
  /** Append to the system prompt alongside priors + hybrid guidance. */
  systemPromptAppend?: string
  /** Override decay rate per region (default 0.95). */
  decayRate?: number
  /** Override per-touch bump (default DEFAULT_BUMP from ledger.ts). */
  bumpAmount?: number
  /** Include the MCTS-style beam-partitioning instructions in the system prompt. Default true. */
  withBeam?: boolean
}

export type AcoFrontierStats = {
  warm_start: boolean
  prior_session_count: number
  inventory: string[]
  /** Number of inventory regions that had at least one prior. */
  regions_with_priors: number
  /** Total prior file entries surfaced across all regions. */
  total_priors_surfaced: number
  worker_dispatched: number
  synthesizer_count: number
  total_delegations: number
  overlap_count: number
  overlap_files: string[]
  files_bumped: number
  /** Per-region session counts AFTER this run finalized. Useful to see compounding shape. */
  region_sessions: Record<string, number>
  any_minion_failed: boolean
  priors_injected: boolean
  /** Did Opus reuse a cached partition, create a new one, or skip the tagging? */
  cache_action: "reused" | "created" | "untagged"
  /** Partition id involved in the cache action (the one reused or just created). */
  cache_action_id: string | null
  /** Total cached partitions in the ledger after this session. */
  cache_size: number
  /** Beam partitioning: how many candidate partitions Opus emitted (target: 3). */
  beam_candidates_emitted: number
  /** Beam partitioning: which candidate index Opus selected (1-based). null if untagged. */
  beam_selected_candidate: number | null
}

/** Load the hybrid's per-region state from the ledger, defaulting to empty. */
export function loadAcoFrontierState(ledger: Ledger): AcoFrontierState {
  // Read with a wider type so v1 (no longer in the live AcoFrontierState union)
  // is still detectable for one-shot migration.
  const existing = getAlgorithmState<{
    version?: number
    region_memory?: Record<string, RegionMemory>
    cached_partitions?: CachedPartition[]
  }>(ledger, ACO_FRONTIER_STATE_KEY)
  if (!existing) {
    return { version: 2, region_memory: {}, cached_partitions: [] }
  }
  // v1 → v2 migration: pull region_memory, init empty partition cache.
  if (existing.version === 1) {
    return {
      version: 2,
      region_memory: existing.region_memory ?? {},
      cached_partitions: [],
    }
  }
  if (existing.version !== 2) {
    return { version: 2, region_memory: {}, cached_partitions: [] }
  }
  return {
    version: 2,
    region_memory: existing.region_memory ?? {},
    cached_partitions: existing.cached_partitions ?? [],
  }
}

function emptyRegionMemory(now = new Date()): RegionMemory {
  return { files: {}, region_sessions: 0, last_touched: now.toISOString() }
}

/** Longest-prefix match: which inventory entry does this file path belong to? */
export function attributeFileToRegion(
  file: string,
  inventory: string[],
): string | null {
  const sorted = [...inventory].sort((a, b) => b.length - a.length)
  for (const region of sorted) {
    if (file === region || file.startsWith(region + "/")) return region
  }
  return null
}

/**
 * Bump one file's priority within a region. Creates the region if missing.
 * Mirrors ledger.bumpFile semantics but scoped to RegionMemory.files.
 */
export function bumpFileInRegion(
  state: AcoFrontierState,
  region: string,
  filePath: string,
  by: number = DEFAULT_BUMP,
  subagent: string | null = "PartitionWorker",
  now = new Date(),
): void {
  const mem = (state.region_memory[region] ??= emptyRegionMemory(now))
  const existing = mem.files[filePath]
  const iso = now.toISOString()
  if (existing) {
    existing.priority = Math.min(PRIORITY_CEIL, existing.priority + by)
    existing.hits += 1
    existing.last_hit = iso
    if (subagent) existing.last_subagent = subagent
  } else {
    mem.files[filePath] = {
      path: filePath,
      priority: Math.min(PRIORITY_CEIL, by),
      hits: 1,
      last_hit: iso,
      last_subagent: subagent,
    }
  }
  mem.last_touched = iso
}

/**
 * Apply decay to specified regions. Files below PRIORITY_FLOOR get
 * dropped (same rule as ACO's global ledger). Pure mutation.
 */
export function applyRegionDecay(
  state: AcoFrontierState,
  regions: string[],
  rate: number = DEFAULT_DECAY,
): void {
  for (const region of regions) {
    const mem = state.region_memory[region]
    if (!mem) continue
    const toDelete: string[] = []
    for (const [path, entry] of Object.entries(mem.files)) {
      entry.priority = Math.min(PRIORITY_CEIL, entry.priority * rate)
      if (entry.priority < PRIORITY_FLOOR) toDelete.push(path)
    }
    for (const p of toDelete) delete mem.files[p]
  }
}

/** Generate a short unique partition ID. */
export function newPartitionId(state: AcoFrontierState): string {
  const taken = new Set(state.cached_partitions.map((p) => p.id))
  // 4-char base36 ids; collisions are extremely rare at our cap of 20 partitions.
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = Math.random().toString(36).slice(2, 6)
    if (!taken.has(id)) return id
  }
  // Fallback: timestamp-based (vanishingly unlikely to be needed).
  return Date.now().toString(36).slice(-4)
}

/** Find a cached partition by id. */
export function findCachedPartition(
  state: AcoFrontierState,
  id: string,
): CachedPartition | undefined {
  return state.cached_partitions.find((p) => p.id === id)
}

/** Add a new cached partition. Evicts oldest by last_used if at cap. */
export function addCachedPartition(
  state: AcoFrontierState,
  partition: Omit<CachedPartition, "reuse_count" | "created_at" | "last_used" | "total_overlap">,
  now = new Date(),
): CachedPartition {
  const iso = now.toISOString()
  const entry: CachedPartition = {
    ...partition,
    reuse_count: 0,
    created_at: iso,
    last_used: iso,
    total_overlap: partition.last_overlap_count,
  }
  state.cached_partitions.push(entry)
  if (state.cached_partitions.length > MAX_CACHED_PARTITIONS) {
    state.cached_partitions.sort((a, b) =>
      a.last_used < b.last_used ? -1 : 1,
    )
    state.cached_partitions = state.cached_partitions.slice(
      -MAX_CACHED_PARTITIONS,
    )
  }
  return entry
}

/** Bump a cached partition's reuse counters after Opus reused it. */
export function bumpReusedPartition(
  state: AcoFrontierState,
  id: string,
  newOverlap: number,
  now = new Date(),
): boolean {
  const p = findCachedPartition(state, id)
  if (!p) return false
  p.reuse_count += 1
  p.last_used = now.toISOString()
  p.last_overlap_count = newOverlap
  p.total_overlap += newOverlap
  return true
}

/** Render the cache as a system-prompt block. Empty string when no cache yet. */
export function renderPartitionCache(state: AcoFrontierState): string {
  if (state.cached_partitions.length === 0) return ""
  const sorted = [...state.cached_partitions].sort(
    (a, b) => b.reuse_count - a.reuse_count,
  )
  const lines = sorted.map((p) => {
    const workers = p.workers
      .map((w, i) => `    Worker ${i + 1} (${w.label}): ${w.scope}`)
      .join("\n")
    const avgOverlap =
      p.total_overlap / (p.reuse_count + 1)
    return `[${p.id}] ${p.query_pattern}\n${workers}\n    Reused ${p.reuse_count}× | last overlap: ${p.last_overlap_count} | avg overlap: ${avgOverlap.toFixed(1)}`
  })
  return [
    "## Cached partitions (reuse if your query fits)",
    "",
    "These partitions have worked on this codebase before. If the user's query fits one of these patterns, reuse it by ID — saves you the partition-design tokens. If none fit, design a new partition; we'll cache it for future similar queries.",
    "",
    ...lines,
    "",
    `When you reuse a cached partition, START your first assistant turn with \`[reuse:XXXX]\` (the partition id). When you create a new partition, START your first assistant turn with \`[new-partition: <one-line query pattern>]\` so we cache it under that pattern.`,
  ].join("\n")
}

const REUSE_RE = /\[reuse:([a-z0-9]{4})\]/i
const NEW_PARTITION_RE = /\[new-partition:\s*([^\]]+)\]/i
const SELECTED_RE = /\[selected:\s*([1-9]\d*)\s*\]/i
const CANDIDATE_RE =
  /\[CANDIDATE\s+(\d+)\]([^]+?)(?=\[CANDIDATE\s+\d+\]|\[selected:|$)/gi

/** Detect [reuse:ID] in a text. Returns the ID or null. */
export function detectReuseTag(text: string): string | null {
  const m = text.match(REUSE_RE)
  return m ? m[1].toLowerCase() : null
}

/** Detect [new-partition: <pattern>] in text. Returns the pattern or null. */
export function detectNewPartitionTag(text: string): string | null {
  const m = text.match(NEW_PARTITION_RE)
  return m ? m[1].trim().slice(0, 200) : null
}

/** Detect [selected:N] tag from beam partitioning. Returns N (1-based) or null. */
export function detectSelectedCandidate(text: string): number | null {
  const m = text.match(SELECTED_RE)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Lightweight candidate-block. We don't parse worker shapes (they live in actual delegations); we just record presence + rationale length. */
export type CandidateBlock = {
  index: number
  body: string // raw text block trimmed
  rationale_len: number
}

/** Extract [CANDIDATE N] ... blocks from Opus's text. Returns ordered list. */
export function parseCandidates(text: string): CandidateBlock[] {
  const out: CandidateBlock[] = []
  let m: RegExpExecArray | null
  CANDIDATE_RE.lastIndex = 0
  while ((m = CANDIDATE_RE.exec(text)) !== null) {
    const index = parseInt(m[1], 10)
    if (!Number.isFinite(index)) continue
    const body = m[2].trim().slice(0, 600)
    out.push({ index, body, rationale_len: body.length })
  }
  return out
}

/** Pull "assigned region" / "YOUR REGION" out of a Worker's prompt. */
export function extractWorkerScope(prompt: string): string {
  const patterns = [
    /YOUR REGION[^:]*:[^]+?(?=OTHER WORKERS|Stay in YOUR|other workers|Hot files|\n\n[A-Z]|$)/i,
    /Your assigned region[^:]*:[^]+?(?=Other workers|Stay in YOUR|Hot files|\n\n[A-Z]|$)/i,
    /assigned region[^:]*:[^]+?(?=Other workers|Stay in YOUR|other workers|Hot files|\n\n[A-Z]|$)/i,
  ]
  for (const re of patterns) {
    const m = prompt.match(re)
    if (m) return m[0].replace(/\s+/g, " ").slice(0, 250).trim()
  }
  return prompt.slice(0, 200).replace(/\s+/g, " ").trim()
}

/** English stopwords + common imperative-query words we ignore when fingerprinting queries. */
const QUERY_STOPWORDS = new Set([
  "what","is","the","a","an","do","does","how","where","when","why","who","which",
  "this","that","with","of","to","in","and","or","by","for","on","at","as","be","are",
  "you","give","me","plus","top","list","first","get","run","look","show","tell",
  "from","into","through","across","over","not","no","yes","we","i","my","your",
  "just","also","each","all","out","up","down","can","should","would","will","may",
  "might","must","its","it","they","them","their","there","here","then","than",
  "but","if","else","while","done","now","new","old","find","handle","handled",
])

/** Tokenize a query: lowercase, alphanum-only, drop short/stop words. */
export function tokenizeQuery(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !QUERY_STOPWORDS.has(t)),
  )
}

/** Tokenize a worker's scope (file paths, patterns, topical phrases). */
export function tokenizeScope(scope: string): Set<string> {
  return new Set(
    scope
      .toLowerCase()
      .replace(/[^a-z0-9/]/g, " ")
      .split(/[/\s]+/)
      .filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t)),
  )
}

/** Jaccard similarity on two token sets. 0 if both empty. */
export function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersect = 0
  for (const t of a) if (b.has(t)) intersect++
  const union = a.size + b.size - intersect
  return union === 0 ? 0 : intersect / union
}

/**
 * Score a current session's worker scopes against a cached partition.
 * Computes Jaccard on the union of tokens from each side. Robust to
 * scope wording differences (path vs prose).
 */
export function workerScopeSimilarity(
  currentScopes: string[],
  cached: CachedPartition,
): number {
  const currentTokens = new Set<string>()
  for (const s of currentScopes) {
    for (const t of tokenizeScope(s)) currentTokens.add(t)
  }
  const cachedTokens = new Set<string>()
  for (const w of cached.workers) {
    for (const t of tokenizeScope(w.scope)) cachedTokens.add(t)
  }
  return jaccardSim(currentTokens, cachedTokens)
}

/** Find the best-matching cached partition by query-text similarity. Returns null if no match above threshold. */
export function findCachedByQuery(
  state: AcoFrontierState,
  query: string,
  minSimilarity = 0.5,
): { partition: CachedPartition; similarity: number } | null {
  if (state.cached_partitions.length === 0) return null
  const queryTokens = tokenizeQuery(query)
  if (queryTokens.size === 0) return null
  let best: { partition: CachedPartition; similarity: number } | null = null
  for (const p of state.cached_partitions) {
    const sim = jaccardSim(queryTokens, tokenizeQuery(p.query_pattern))
    if (sim >= minSimilarity && (!best || sim > best.similarity)) {
      best = { partition: p, similarity: sim }
    }
  }
  return best
}

/** Find the best-matching cached partition by current worker-scope similarity. */
export function findCachedByScope(
  state: AcoFrontierState,
  currentScopes: string[],
  minSimilarity = 0.6,
): { partition: CachedPartition; similarity: number } | null {
  if (state.cached_partitions.length === 0) return null
  let best: { partition: CachedPartition; similarity: number } | null = null
  for (const p of state.cached_partitions) {
    const sim = workerScopeSimilarity(currentScopes, p)
    if (sim >= minSimilarity && (!best || sim > best.similarity)) {
      best = { partition: p, similarity: sim }
    }
  }
  return best
}

/** Top-N priority files within a region. Empty if region unknown or empty. */
export function getRegionPriors(
  state: AcoFrontierState,
  region: string,
  topN: number,
): FileEntry[] {
  const mem = state.region_memory[region]
  if (!mem) return []
  return Object.values(mem.files)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, topN)
}

/** Build the inventory + priors map. Always uses per-region memory; cold regions show empty. */
export function buildPriorsByRegion(
  state: AcoFrontierState,
  inventory: string[],
  topN: number,
): Record<string, FileEntry[]> {
  const out: Record<string, FileEntry[]> = {}
  for (const region of inventory) {
    out[region] = getRegionPriors(state, region, topN)
  }
  return out
}

const HYBRID_GUIDANCE = (
  inventory: string[],
  priorsByRegionMap: Record<string, FileEntry[]>,
  cacheBlock: string,
  withBeam: boolean = true,
): string => {
  const sessionInventoryBlock =
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
# Stigmergic Frontier protocol (ACO + Frontier hybrid)

This is an ACO+Frontier session. The principle: divide the search space (Frontier), but use what you've learned from prior sessions in EACH REGION (ACO) to seed each Worker with known-relevant files specific to its region.

${cacheBlock ? cacheBlock + "\n\n" : ""}## Codebase inventory + per-region priors

Each region below shows up to 5 high-priority files from prior sessions that touched THAT region specifically. These are not global hints — they're region-local pheromones. Treat as warm starting points; if the user's query plausibly involves those files, your Workers should look there first.

${sessionInventoryBlock}

${
    withBeam
      ? `## Phase 1A: Generate 3 candidate partitions (in your first text block)

Before dispatching workers, emit THREE different candidate partition shapes for this query. Use this exact format:

\`\`\`
[CANDIDATE 1] <one-line pattern>
  W1: <region/scope>
  W2: <region/scope>
  W3: <region/scope>
  Rationale: <why this shape; predicted overlap; priors alignment>

[CANDIDATE 2] <one-line pattern>
  W1: ...
  ...
  Rationale: ...

[CANDIDATE 3] <one-line pattern>
  W1: ...
  ...
  Rationale: ...
\`\`\`

The three should be MEANINGFULLY different (different splits — by tier, by feature, by file pattern). Don't propose three near-identical shapes.

## Phase 1B: Pick the best with [selected:N]

Score each candidate against:
- **Disjoint coverage**: would the workers' regions overlap minimally on the cited files?
- **Inventory + priors fit**: does each worker's region have hot files in the per-region priors above? Hot regions deserve dedicated workers.
- **Cached partitions**: does any candidate align with a cached partition shape that already worked? If so, prefer it (and tag with \`[reuse:XXXX]\`).

Tag your choice with \`[selected:1]\`, \`[selected:2]\`, or \`[selected:3]\` in the same text block.

${cacheBlock ? "If a candidate effectively reuses a cached partition's shape, ALSO tag with `[reuse:XXXX]`. If you're committing a brand new pattern, tag with `[new-partition: <pattern>]`." : "Tag with `[new-partition: <one-line pattern>]` so we cache the chosen shape."}

## Phase 1C: Decide partition + launch Workers (same assistant turn)`
      : "## Phase 1: Decide partition + launch Workers"
  }

Read the user's query. Decide:

1. **How many workers** (typically 2-4). More for broad questions, fewer for narrow ones.
2. **Which regions** each worker covers. Regions can be inventory entries, file patterns, or topical scopes.
3. **Per-worker prior injection**. For each Worker, look at the priors attached to its assigned region(s) above. Include them in the Worker's prompt as starting hints.

Each Worker's prompt MUST contain:

1. **The user's original query** (verbatim)
2. **The Worker's assigned region** (dirs, patterns, or topical scope) — use the heading "YOUR REGION:"
3. **Hot files in your region** — list the priors files attached to the Worker's region(s). Tell the Worker "files X, Y were relevant in past sessions on this region; check them first if the query involves them."
4. **The OTHER workers' regions** — text like "Stay in YOUR region; the others cover: [list]"

Issue all PartitionWorker Task calls in a SINGLE assistant message. Do NOT call Read/Glob/Grep in Phase 1.

## Phase 2: Synthesize from worker reports

After all worker tool_results return, write the final answer:

- Surface findings from all workers in a unified answer
- Note overlap (files cited by ≥2 workers) — the orchestrator measures this as overlap_count
- If a worker returned MINION_FAILED, proceed without their input

Do NOT call Read/Glob/Grep in Phase 2. Do NOT delegate further.

## When to skip the protocol

Only skip Phase 1 if the query is a literal command to display a file you've been given the path for. For everything else — including questions that feel obvious — partition and run the workers.
`
}

/**
 * Apply per-region pheromone bumps for a list of PartitionWorker
 * delegations and increment region_sessions for any region whose files
 * were touched. Single pass through the delegations + per-file region
 * lookup (avoids the previous double-iteration pattern).
 */
export function bumpRegionPheromones(
  state: AcoFrontierState,
  partitionDelegations: { files_touched: string[] }[],
  inventory: string[],
  bumpAmount: number,
  now: Date,
): void {
  const touchedRegions = new Set<string>()
  for (const d of partitionDelegations) {
    for (const file of d.files_touched) {
      const region = attributeFileToRegion(file, inventory)
      if (!region) continue
      bumpFileInRegion(state, region, file, bumpAmount, "PartitionWorker", now)
      touchedRegions.add(region)
    }
  }
  for (const region of touchedRegions) {
    const mem = state.region_memory[region]
    if (mem) mem.region_sessions += 1
  }
}

/**
 * Four-tier cache update: explicit [reuse:XXXX] → scope-similarity
 * auto-reuse → [new-partition:...] → auto-create from query. Pure
 * mutation of `state.cached_partitions`. Same logic that aco-frontier
 * and aco-router used to inline separately; consolidated here.
 */
export function updatePartitionCache(
  state: AcoFrontierState,
  args: {
    opusText: string
    query: string
    partitionDelegations: { prompt_preview: string; files_touched: string[] }[]
    overlapCount: number
    now: Date
  },
): CacheUpdateOutcome {
  if (args.partitionDelegations.length === 0) {
    return { cacheAction: "untagged", cacheActionId: null }
  }
  const explicitReuseId = detectReuseTag(args.opusText)
  if (explicitReuseId && findCachedPartition(state, explicitReuseId)) {
    bumpReusedPartition(state, explicitReuseId, args.overlapCount, args.now)
    return { cacheAction: "reused", cacheActionId: explicitReuseId }
  }

  const explicitNewPattern = detectNewPartitionTag(args.opusText)
  const currentScopes = args.partitionDelegations.map((d) =>
    extractWorkerScope(d.prompt_preview),
  )
  const autoReuse = explicitNewPattern
    ? null
    : findCachedByScope(state, currentScopes, 0.6)
  if (autoReuse) {
    bumpReusedPartition(state, autoReuse.partition.id, args.overlapCount, args.now)
    return { cacheAction: "reused", cacheActionId: autoReuse.partition.id }
  }

  const pattern =
    explicitNewPattern ?? args.query.slice(0, 200).replace(/\s+/g, " ").trim()
  const workers: CachedWorkerSpec[] = currentScopes.map((scope, i) => ({
    label: `Worker ${i + 1}`,
    scope,
  }))
  const id = newPartitionId(state)
  addCachedPartition(
    state,
    {
      id,
      query_pattern: pattern,
      workers,
      last_overlap_count: args.overlapCount,
    },
    args.now,
  )
  return { cacheAction: "created", cacheActionId: id }
}

export type RunAcoFrontierResult = AlgorithmResult & {
  acoFrontierStats: AcoFrontierStats
  ledger: Ledger
}

/**
 * Shared post-orchestration logic: bump region pheromones, compute
 * overlap, parse beam candidates, update partition cache, build stats.
 * Used by both prepareAcoFrontier (production) and runAcoFrontier (suite).
 */
function processAcoFrontierResult(
  ledger: Ledger,
  state: AcoFrontierState,
  inventory: string[],
  warmStart: boolean,
  regionsWithPriors: number,
  totalPriorsSurfaced: number,
  globalPriorsInjected: boolean,
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
): AcoFrontierStats {
  const partitionDelegations = observerResult.delegations.filter(
    (d) => d.subagent_type === "PartitionWorker",
  )

  bumpRegionPheromones(state, partitionDelegations, inventory, bumpAmount, now)

  const overlap = computeOverlap(
    partitionDelegations.map((d) => new Set(d.files_touched)),
  )

  const opusText = observerResult.opusText
  const candidates = parseCandidates(opusText)
  const selectedCandidate = detectSelectedCandidate(opusText)

  const { cacheAction, cacheActionId } = updatePartitionCache(state, {
    opusText,
    query,
    partitionDelegations,
    overlapCount: overlap.count,
    now,
  })

  const counts = countByType(observerResult.delegations.map((d) => d.subagent_type))
  const regionSessionCounts: Record<string, number> = {}
  for (const region of inventory) {
    regionSessionCounts[region] = state.region_memory[region]?.region_sessions ?? 0
  }

  return {
    warm_start: warmStart,
    prior_session_count: ledger.session_count - 1,
    inventory,
    regions_with_priors: regionsWithPriors,
    total_priors_surfaced: totalPriorsSurfaced,
    worker_dispatched: counts.PartitionWorker ?? 0,
    synthesizer_count: counts.Synthesizer ?? 0,
    total_delegations: observerResult.delegations.length,
    overlap_count: overlap.count,
    overlap_files: overlap.files,
    files_bumped: observerResult.filesTouched.size,
    region_sessions: regionSessionCounts,
    any_minion_failed: observerResult.anyMinionFailed,
    priors_injected: globalPriorsInjected || regionsWithPriors > 0,
    cache_action: cacheAction,
    cache_action_id: cacheActionId,
    cache_size: state.cached_partitions.length,
    beam_candidates_emitted: candidates.length,
    beam_selected_candidate: selectedCandidate,
  }
}

export async function prepareAcoFrontier(
  query: string,
  ctx: AlgorithmContext,
  opts?: {
    listPartitionableDirs?: (cwd: string) => string[]
    partitionOptions?: ListPartitionableOptions
    priorsPerRegion?: number
    systemPromptAppend?: string
    decayRate?: number
    bumpAmount?: number
    withBeam?: boolean
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
  const regionsWithPriors = Object.values(byRegion).filter((l) => l.length > 0).length
  const totalPriorsSurfaced = Object.values(byRegion).reduce(
    (s, l) => s + l.length,
    0,
  )

  const { block: globalPriors } = buildPriorsBlock(ledger)
  const cacheBlock = renderPartitionCache(state)
  const withBeam = opts?.withBeam ?? true
  const systemPromptAppend = [
    opts?.systemPromptAppend?.trim(),
    globalPriors,
    HYBRID_GUIDANCE(inventory, byRegion, cacheBlock, withBeam),
  ]
    .filter(Boolean)
    .join("\n\n")

  const allowedSubagents = new Set(["PartitionWorker", "Synthesizer"])
  const observer = createOpusObserver({
    cwd: ctx.cwd,
    algorithm: ACO_FRONTIER_STATE_KEY,
    ledger,
    allowedSubagents,
    bumpAmount: opts?.bumpAmount,
  })
  const opusTextChunks: string[] = []
  const bumpAmount = opts?.bumpAmount ?? DEFAULT_BUMP

  return {
    systemPromptAppend,
    agents: buildAgentsMap(["PartitionWorker", "Synthesizer"]),
    canUseToolGuard: observer.canUseToolGuard,
    observeMessage(msg) {
      appendAssistantText(opusTextChunks, msg)
      observer.observeMessage(msg)
    },
    async finalize() {
      const result = observer.finalize()
      const stats = processAcoFrontierResult(
        ledger,
        state,
        inventory,
        warmStart,
        regionsWithPriors,
        totalPriorsSurfaced,
        globalPriors !== null,
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

export async function runAcoFrontier(
  query: string,
  options: RunAcoFrontierOptions,
): Promise<RunAcoFrontierResult> {
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
  const regionsWithPriors = Object.values(byRegion).filter((l) => l.length > 0).length
  const totalPriorsSurfaced = Object.values(byRegion).reduce(
    (s, l) => s + l.length,
    0,
  )

  const { block: globalPriors } = buildPriorsBlock(ledger)
  const cacheBlock = renderPartitionCache(state)
  const withBeam = options.withBeam ?? true
  const systemPromptAppend = [
    options.systemPromptAppend?.trim(),
    globalPriors,
    HYBRID_GUIDANCE(inventory, byRegion, cacheBlock, withBeam),
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = await runOpusOrchestrated({
    cwd: options.cwd,
    sdkQuery: options.sdkQuery,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    onMessage: options.onMessage,
    query,
    algorithm: "aco-frontier",
    agents: buildAgentsMap(["PartitionWorker", "Synthesizer"]),
    allowedSubagents: new Set(["PartitionWorker", "Synthesizer"]),
    systemPromptAppend,
    ledger,
    bumpAmount: options.bumpAmount,
  })

  const bumpAmount = options.bumpAmount ?? DEFAULT_BUMP
  const now = new Date()
  const stats = processAcoFrontierResult(
    ledger,
    state,
    inventory,
    warmStart,
    regionsWithPriors,
    totalPriorsSurfaced,
    globalPriors !== null,
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
    acoFrontierStats: stats,
    ledger,
  }
}

function formatAcoFrontierStats(stats: AlgorithmStats): string[] {
  const s = stats as AcoFrontierStats
  const cacheLine =
    s.cache_action === "reused"
      ? `  partition cache: REUSED [${s.cache_action_id}] (${s.cache_size} cached)`
      : s.cache_action === "created"
        ? `  partition cache: CREATED [${s.cache_action_id}] (${s.cache_size} cached)`
        : `  partition cache: untagged (${s.cache_size} cached)`
  const beamLine =
    s.beam_candidates_emitted > 0
      ? `  beam: ${s.beam_candidates_emitted} candidates, selected #${s.beam_selected_candidate ?? "?"}`
      : `  beam: not emitted (Opus skipped structured-thinking phase)`
  const lines = [
    "ACO+Frontier (per-region memory + partition cache):",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  inventory (${s.inventory.length} entries, ${s.regions_with_priors} with priors)`,
    `  priors surfaced: ${s.total_priors_surfaced} files`,
    beamLine,
    cacheLine,
    `  workers dispatched: ${s.worker_dispatched}`,
    `  synthesizer delegations: ${s.synthesizer_count}`,
    `  overlap: ${s.overlap_count} ${s.overlap_count === 1 ? "file" : "files"}`,
  ]
  if (s.overlap_files.length > 0 && s.overlap_files.length <= 5) {
    for (const f of s.overlap_files) lines.push(`    - ${f}`)
  }
  // Show region session counts for regions that have history.
  const activeRegions = Object.entries(s.region_sessions).filter(([, n]) => n > 0)
  if (activeRegions.length > 0) {
    lines.push("  region session counts:")
    for (const [r, n] of activeRegions.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`    - ${r}: ${n}`)
    }
  }
  if (s.any_minion_failed) lines.push("  ⚠ at least one worker returned MINION_FAILED")
  return lines
}

function formatAcoFrontierVerdict(stats: AlgorithmStats): string {
  const s = stats as AcoFrontierStats
  return `ACO-FRONTIER ${s.warm_start ? "WARM" : "COLD"} ${s.worker_dispatched}w (${s.regions_with_priors}/${s.inventory.length} regions had priors), ${s.overlap_count} overlap, fail=${s.any_minion_failed ? "Y" : "N"}`
}

export const acoFrontierAlgorithm: SwarmAlgorithm = {
  name: "aco-frontier",
  description:
    "Stigmergic Frontier with per-partition memory: Opus partitions per query (Frontier) and uses per-region pheromone tables (ACO style, scoped per inventory region) to seed each Worker with region-local hot files. Region pheromones converge independently per region.",
  prepare: prepareAcoFrontier,
  formatStats: formatAcoFrontierStats,
  formatVerdict: formatAcoFrontierVerdict,
}

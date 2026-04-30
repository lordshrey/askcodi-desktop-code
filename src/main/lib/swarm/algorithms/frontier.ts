/**
 * Frontier-discounting (Opus-decides partition).
 *
 * Architecture:
 *   - Single Opus parent sdk.query() session via the orchestrator
 *   - Registers two Haiku subagents: PartitionWorker, Synthesizer
 *   - The algorithm surfaces a codebase INVENTORY (top-level dirs,
 *     monorepo-aware) in the system prompt as information.
 *   - Opus reads query + inventory and decides:
 *       1. how many workers to spawn (typically 2-4)
 *       2. what region each worker should investigate (file patterns,
 *          directories, or topical scope)
 *       3. how to instruct each worker to stay in its region
 *     Then issues parallel Task(PartitionWorker) calls accordingly.
 *
 * Why Opus decides: the right partition depends on the query. "Trace
 * auth flow" wants partitions like {Auth contexts, Auth routes, DB
 * adapters}. "Find incomplete features" wants partitions by feature
 * directory. A pre-computed round-robin partition can't know either.
 *
 * Algorithm measures overlap_count post-hoc to validate Opus's choice:
 * low overlap = clean partition for this query, high overlap = the
 * answer crossed boundaries (Opus could have partitioned differently).
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"
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
import { INDEX_SKIP_DIRS } from "../path-utils"
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

export type RunFrontierOptions = AlgorithmRunOptions & {
  /** Override Haiku model id. */
  minionModel?: string
  /** Override directory enumerator (tests inject a fake). */
  listPartitionableDirs?: (cwd: string) => string[]
  /** Tuning for the default monorepo-aware enumerator. */
  partitionOptions?: ListPartitionableOptions
  /** Append to the system prompt alongside priors + Frontier guidance. */
  systemPromptAppend?: string
}

export type FrontierStats = {
  warm_start: boolean
  prior_session_count: number
  /** Codebase inventory passed to Opus (top-level dirs / workspaces). */
  inventory: string[]
  /** How many PartitionWorker delegations Opus actually fired. */
  worker_dispatched: number
  synthesizer_count: number
  total_delegations: number
  /** Files touched by ≥2 PartitionWorkers — measures whether Opus's partition was disjoint. */
  overlap_count: number
  overlap_files: string[]
  files_bumped: number
  any_minion_failed: boolean
  priors_injected: boolean
}

export const DEFAULT_CONTAINER_NAMES = new Set([
  "apps",
  "packages",
  "libs",
  "services",
  "modules",
  "projects",
  "crates",
  "workspaces",
  "examples",
  "contracts",
  "integrations",
  "plugins",
  "tools",
])

export type ListPartitionableOptions = {
  containerNames?: Set<string>
  maxDepth?: number
}

function isHidden(name: string): boolean {
  return name.startsWith(".") && name !== ".github"
}

function shouldSkipName(name: string): boolean {
  return INDEX_SKIP_DIRS.has(name) || isHidden(name)
}

function readDirsSafe(absPath: string): string[] {
  try {
    return readdirSync(absPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !shouldSkipName(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function isContainer(
  absPath: string,
  name: string,
  containerNames: Set<string>,
): boolean {
  if (containerNames.has(name)) return true
  let entries
  try {
    entries = readdirSync(absPath, { withFileTypes: true }).filter(
      (e) => !shouldSkipName(e.name),
    )
  } catch {
    return false
  }
  if (entries.length === 0) return false
  const dirs = entries.filter((e) => e.isDirectory()).length
  return dirs >= 2 && dirs / entries.length >= 0.8
}

/**
 * Monorepo-aware top-level dir enumerator. Used by Frontier to build
 * a codebase inventory for Opus to consult when deciding how to
 * partition. Descends one level into "container" dirs (apps/, packages/,
 * etc.) so workspaces become inventory entries instead of the empty
 * parent.
 *
 * Results are memoized per (cwd, options) for INVENTORY_TTL_MS — the
 * inventory shape rarely changes within a session, but every prepare()
 * call would otherwise re-walk the whole tree (10-100ms on monorepos).
 */
const INVENTORY_TTL_MS = 60_000
type InventoryCacheEntry = { value: string[]; expiresAt: number }
const inventoryCache = new Map<string, InventoryCacheEntry>()

function inventoryCacheKey(
  cwd: string,
  opts: ListPartitionableOptions,
): string {
  const containerKey = opts.containerNames
    ? [...opts.containerNames].sort().join(",")
    : "default"
  return `${cwd}|${opts.maxDepth ?? 2}|${containerKey}`
}

export function listPartitionableDirs(
  cwd: string,
  opts: ListPartitionableOptions = {},
): string[] {
  const key = inventoryCacheKey(cwd, opts)
  const cached = inventoryCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const maxDepth = opts.maxDepth ?? 2
  const containerNames = opts.containerNames ?? DEFAULT_CONTAINER_NAMES

  const out: string[] = []
  function visit(absPath: string, relPath: string, depth: number): void {
    if (depth >= maxDepth) {
      out.push(relPath)
      return
    }
    const baseName = relPath.split("/").pop() ?? ""
    if (depth >= 1 && isContainer(absPath, baseName, containerNames)) {
      const children = readDirsSafe(absPath)
      if (children.length === 0) return
      for (const sub of children) {
        visit(join(absPath, sub), `${relPath}/${sub}`, depth + 1)
      }
      return
    }
    if (relPath) out.push(relPath)
  }

  for (const name of readDirsSafe(cwd)) {
    visit(join(cwd, name), name, 1)
  }
  const result = out.sort()
  inventoryCache.set(key, {
    value: result,
    expiresAt: Date.now() + INVENTORY_TTL_MS,
  })
  return result
}

/** For tests — clear the inventory cache to force a fresh walk. */
export function clearInventoryCache(): void {
  inventoryCache.clear()
}

const FRONTIER_GUIDANCE = (inventory: string[]): string => {
  const inventoryBlock =
    inventory.length > 0
      ? inventory.map((d) => `  - ${d}`).join("\n")
      : "  (codebase has no top-level dirs to inventory)"
  return `
# Frontier-discounting protocol

This is a Frontier-algorithm session. The principle: divide the search space into disjoint regions, dispatch one PartitionWorker per region, and synthesize. The partition is YOUR call — it should match the query, not a fixed pre-computed split.

## Codebase inventory

This is what the codebase looks like at the top level. Treat as info, not as a partition:

${inventoryBlock}

## Phase 1: Decide the partition + launch parallel PartitionWorkers

Read the user's query. Decide:

1. **How many workers** to spawn. Typically 2-4. More for broad questions ("trace every flow"), fewer for narrow ones ("find this one bug"). If the codebase is tiny or the query is single-file, 1 worker is fine.
2. **What region each worker should investigate.** Regions can be:
   - Sets of directories (\`{frontend/src/contexts, frontend/src/lib}\`)
   - File patterns (\`**/*.test.ts\` vs source files)
   - Topical scope (\`auth-related code\` vs \`billing-related code\`)
3. **The disjoint coverage rule.** Each worker's region should NOT overlap another's. Measure: would a relevant file get cited by exactly ONE worker, ideally?

Then issue all N PartitionWorker Task calls in a SINGLE assistant message. Each Worker's prompt MUST contain three things:

1. **The user's original query** (verbatim)
2. **The Worker's assigned region** — explicit dirs, patterns, or topical scope
3. **The OTHER workers' regions** — text like "Stay in YOUR region; the other workers are investigating: [list]"

Example for the query "How is authentication handled?":

\`\`\`
Worker 1: assigned region = "auth contexts and providers (frontend/src/contexts/Auth*, frontend/src/lib/neon*)" — Stay in YOUR region; other workers cover: routing, components.
Worker 2: assigned region = "routing and entry points (App.js, AuthenticatedApp.js, index.js)" — Stay in YOUR region; other workers cover: contexts/lib, components.
Worker 3: assigned region = "components that consume auth state (frontend/src/components/**)" — Stay in YOUR region; other workers cover: contexts/lib, routing.
\`\`\`

Do NOT investigate the codebase yourself before delegating. Do NOT call Read/Glob/Grep in Phase 1. The whole point is that PartitionWorkers do the searching in parallel.

## Phase 2: Synthesize from worker reports

After all worker tool_results return, write the final answer in your NEXT assistant turn:

- Surface findings from all workers in a unified answer
- Note overlap (files cited by ≥2 workers) — that's signal that the answer crosses partition boundaries; the orchestrator records this as overlap_count
- If a worker returned MINION_FAILED, proceed without their input and note the missing region
- Low overlap = clean partition for this query; high overlap = your partition shape didn't match the query

Do NOT call Read/Glob/Grep in Phase 2. Do NOT delegate further. Workers did the searching; your job is synthesis.

## When to skip the protocol

Only skip Phase 1 if the query is a literal command to display a file you've been given the path for. For everything else — including questions that feel obvious — partition and run the workers.
`
}

export type RunFrontierResult = AlgorithmResult & {
  frontierStats: FrontierStats
  ledger: Ledger
}

function buildFrontierStats(
  ledger: Ledger,
  warmStart: boolean,
  inventory: string[],
  delegations: Array<{ subagent_type: string; files_touched: string[] }>,
  filesBumped: number,
  anyMinionFailed: boolean,
  priorsInjected: boolean,
): FrontierStats {
  const workerCites = delegations
    .filter((d) => d.subagent_type === "PartitionWorker")
    .map((d) => new Set(d.files_touched))
  const overlap = computeOverlap(workerCites)
  const counts = countByType(delegations.map((d) => d.subagent_type))
  return {
    warm_start: warmStart,
    prior_session_count: ledger.session_count - 1,
    inventory,
    worker_dispatched: counts.PartitionWorker ?? 0,
    synthesizer_count: counts.Synthesizer ?? 0,
    total_delegations: delegations.length,
    overlap_count: overlap.count,
    overlap_files: overlap.files,
    files_bumped: filesBumped,
    any_minion_failed: anyMinionFailed,
    priors_injected: priorsInjected,
  }
}

export async function prepareFrontier(
  _query: string,
  ctx: AlgorithmContext,
  opts?: {
    listPartitionableDirs?: (cwd: string) => string[]
    partitionOptions?: ListPartitionableOptions
    systemPromptAppend?: string
  },
): Promise<AlgorithmAugmentation> {
  const enumerate =
    opts?.listPartitionableDirs ??
    ((cwd: string) => listPartitionableDirs(cwd, opts?.partitionOptions))
  const inventory = enumerate(ctx.cwd)

  const ledger = loadLedger(ctx.cwd)
  const warmStart = ledger.session_count > 0
  applyDecay(ledger)

  const { block: priors } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    opts?.systemPromptAppend?.trim(),
    priors,
    FRONTIER_GUIDANCE(inventory),
  ]
    .filter(Boolean)
    .join("\n\n")

  const allowedSubagents = new Set(["PartitionWorker", "Synthesizer"])
  const observer = createOpusObserver({
    cwd: ctx.cwd,
    algorithm: "frontier",
    ledger,
    allowedSubagents,
  })

  return {
    systemPromptAppend,
    agents: buildAgentsMap(["PartitionWorker", "Synthesizer"]),
    canUseToolGuard: observer.canUseToolGuard,
    observeMessage: observer.observeMessage,
    async finalize() {
      const result = observer.finalize()
      const stats = buildFrontierStats(
        ledger,
        warmStart,
        inventory,
        result.delegations,
        result.filesTouched.size,
        result.anyMinionFailed,
        priors !== null,
      )
      setAlgorithmState(ledger, "frontier", {
        last_inventory: inventory,
        last_worker_dispatched: stats.worker_dispatched,
        last_overlap_count: stats.overlap_count,
        last_session_at: new Date().toISOString(),
      })
      pruneFiles(ledger)
      recordSession(ledger)
      await saveLedgerQueued(ledger)
      return stats
    },
  }
}

export async function runFrontier(
  query: string,
  options: RunFrontierOptions,
): Promise<RunFrontierResult> {
  const enumerate =
    options.listPartitionableDirs ??
    ((cwd: string) => listPartitionableDirs(cwd, options.partitionOptions))
  const inventory = enumerate(options.cwd)

  const ledger = loadLedger(options.cwd)
  const warmStart = ledger.session_count > 0
  applyDecay(ledger)

  const { block: priors } = buildPriorsBlock(ledger)
  const systemPromptAppend = [
    options.systemPromptAppend?.trim(),
    priors,
    FRONTIER_GUIDANCE(inventory),
  ]
    .filter(Boolean)
    .join("\n\n")

  const result = await runOpusOrchestrated({
    cwd: options.cwd,
    sdkQuery: options.sdkQuery,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    onMessage: options.onMessage,
    query,
    algorithm: "frontier",
    agents: buildAgentsMap(["PartitionWorker", "Synthesizer"]),
    allowedSubagents: new Set(["PartitionWorker", "Synthesizer"]),
    systemPromptAppend,
    ledger,
  })

  const stats = buildFrontierStats(
    ledger,
    warmStart,
    inventory,
    result.delegations,
    result.filesTouched.size,
    result.anyMinionFailed,
    priors !== null,
  )
  setAlgorithmState(ledger, "frontier", {
    last_inventory: inventory,
    last_worker_dispatched: stats.worker_dispatched,
    last_overlap_count: stats.overlap_count,
    last_session_at: new Date().toISOString(),
  })
  pruneFiles(ledger)
  recordSession(ledger)
  await saveLedgerQueued(ledger)

  return {
    messages: result.messages,
    stats,
    frontierStats: stats,
    ledger,
  }
}

/** Count files cited by ≥2 workers. */
export function computeOverlap(
  workerTouched: Set<string>[],
): { count: number; files: string[] } {
  const counts = new Map<string, number>()
  for (const set of workerTouched) {
    for (const path of set) counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  const overlap = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([path]) => path)
    .sort()
  return { count: overlap.length, files: overlap }
}

function formatFrontierStats(stats: AlgorithmStats): string[] {
  const s = stats as FrontierStats
  const lines = [
    "Frontier-discounting (Opus-partitioned):",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  inventory (${s.inventory.length} entries):`,
  ]
  for (const dir of s.inventory.slice(0, 10)) lines.push(`    - ${dir}`)
  if (s.inventory.length > 10) lines.push(`    ... +${s.inventory.length - 10} more`)
  lines.push(`  workers Opus dispatched: ${s.worker_dispatched}`)
  lines.push(`  synthesizer delegations: ${s.synthesizer_count}`)
  lines.push(
    `  overlap: ${s.overlap_count} ${s.overlap_count === 1 ? "file" : "files"} touched by ≥2 workers`,
  )
  if (s.overlap_files.length > 0 && s.overlap_files.length <= 5) {
    for (const f of s.overlap_files) lines.push(`    - ${f}`)
  }
  if (s.any_minion_failed) lines.push("  ⚠ at least one worker returned MINION_FAILED")
  if (s.worker_dispatched === 0 && s.inventory.length > 0) {
    lines.push("  ⚠ Opus skipped delegation entirely — partition pattern not exercised")
  }
  return lines
}

function formatFrontierVerdict(stats: AlgorithmStats): string {
  const s = stats as FrontierStats
  return `FRONTIER ${s.worker_dispatched} workers (Opus-chosen), ${s.overlap_count} overlap files, fail=${s.any_minion_failed ? "Y" : "N"}`
}

export const frontierAlgorithm: SwarmAlgorithm = {
  name: "frontier",
  description:
    "Frontier-discounting: surface codebase inventory, let Opus decide partition based on the query, dispatch parallel PartitionWorkers per region. Algorithm measures overlap_count to validate Opus's partition choice.",
  prepare: prepareFrontier,
  formatStats: formatFrontierStats,
  formatVerdict: formatFrontierVerdict,
}

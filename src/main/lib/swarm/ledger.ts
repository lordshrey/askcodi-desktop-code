/**
 * Per-codebase shared ledger. Generalizes the old aco-memory.json into a
 * single file at `<projectRoot>/.askcodi/ledger.json` that every algorithm
 * (ACO, ABC, Consensus, Frontier, future) reads and writes to.
 *
 * The ledger holds three things:
 *
 *   1. **files** — per-file priority + hits + last_subagent attribution.
 *      Same shape as ACO's pheromone memory, but now any algorithm can
 *      bump priorities when its subagents touch files. The result is a
 *      cross-algorithm picture of which files matter on this repo.
 *
 *   2. **delegations** — chronological log of every subagent invocation.
 *      Captures algorithm, subagent_type, prompt summary, result summary,
 *      files touched, duration. Capped at MAX_DELEGATIONS so the file
 *      stays small. Used for cross-session priors and post-hoc analysis.
 *
 *   3. **algorithm_state** — per-algorithm scratch space. ACO stores
 *      decay state, ABC stores last scout candidates, Consensus stores
 *      the last vote distribution, etc. Each algorithm owns its own key.
 *
 * On first read, migrates any existing v1 `.askcodi/memory.json` (the old
 * ACO-only schema) into the v2 ledger so prior pheromone data isn't lost.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

export const LEDGER_VERSION = 2
export const LEDGER_FILE_REL = ".askcodi/ledger.json"
export const LEGACY_MEMORY_FILE_REL = ".askcodi/memory.json"

export const DEFAULT_DECAY = 0.95
export const DEFAULT_BUMP = 0.15
export const PRIORITY_FLOOR = 0.05
export const PRIORITY_CEIL = 1.0
export const MAX_FILE_ENTRIES = 200
export const MAX_DELEGATIONS = 500

export type FileEntry = {
  /** Project-relative POSIX-style path. */
  path: string
  /** Priority in [0, 1]. */
  priority: number
  /** Total bumps received. */
  hits: number
  /** ISO 8601 of last bump. */
  last_hit: string
  /** Which subagent_type last touched this file. Null for ACO-pre-migration entries. */
  last_subagent: string | null
}

export type DelegationRecord = {
  /** Free-form session id from the SDK init message (or a runner-supplied label). */
  session_id: string
  algorithm: string
  subagent_type: string
  /** First ~200 chars of the prompt the parent gave the subagent. */
  prompt_preview: string
  /** First ~500 chars of what the subagent returned. */
  result_summary: string
  files_touched: string[]
  duration_ms: number
  /** ISO 8601 when the delegation finished. */
  ended_at: string
}

export type Ledger = {
  version: number
  project_root: string
  first_seen: string
  last_updated: string
  session_count: number
  files: Record<string, FileEntry>
  delegations: DelegationRecord[]
  algorithm_state: Record<string, unknown>
}

export function ledgerPath(projectRoot: string): string {
  return join(projectRoot, LEDGER_FILE_REL)
}

export function legacyMemoryPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_MEMORY_FILE_REL)
}

export function newLedger(projectRoot: string, now = new Date()): Ledger {
  const iso = now.toISOString()
  return {
    version: LEDGER_VERSION,
    project_root: projectRoot,
    first_seen: iso,
    last_updated: iso,
    session_count: 0,
    files: {},
    delegations: [],
    algorithm_state: {},
  }
}

/** Read v1 memory.json if it exists and convert to v2 ledger shape. Returns null on absence/error. */
function readLegacyMemoryAsLedger(projectRoot: string): Ledger | null {
  let raw: string
  try {
    raw = readFileSync(legacyMemoryPath(projectRoot), "utf-8")
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      version?: number
      first_seen?: string
      last_updated?: string
      session_count?: number
      files?: Record<string, { path: string; priority: number; hits: number; last_hit: string }>
    }
    // Accept v1; reject other versions silently.
    if (parsed.version !== 1) return null
    const ledger = newLedger(projectRoot)
    ledger.first_seen = parsed.first_seen ?? ledger.first_seen
    ledger.last_updated = parsed.last_updated ?? ledger.last_updated
    ledger.session_count = parsed.session_count ?? 0
    for (const [path, e] of Object.entries(parsed.files ?? {})) {
      ledger.files[path] = {
        path: e.path,
        priority: e.priority,
        hits: e.hits,
        last_hit: e.last_hit,
        last_subagent: null, // v1 didn't track this
      }
    }
    return ledger
  } catch {
    return null
  }
}

/**
 * Read the ledger from disk. Order of fallback:
 *   1. Parse `.askcodi/ledger.json` if present and v2.
 *   2. Migrate `.askcodi/memory.json` (v1 ACO-only) into a v2 ledger if present.
 *   3. Return a fresh empty ledger.
 */
export function loadLedger(projectRoot: string): Ledger {
  let raw: string
  try {
    raw = readFileSync(ledgerPath(projectRoot), "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return readLegacyMemoryAsLedger(projectRoot) ?? newLedger(projectRoot)
    }
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Ledger
    if (parsed.version !== LEDGER_VERSION) {
      // Future: handle v3 migration here. For now, version mismatch → fresh.
      return newLedger(projectRoot)
    }
    // Defensive: ensure required fields exist in case of partial writes.
    parsed.files = parsed.files ?? {}
    parsed.delegations = parsed.delegations ?? []
    parsed.algorithm_state = parsed.algorithm_state ?? {}
    return parsed
  } catch (err) {
    console.warn(
      `[ledger] could not parse ${ledgerPath(projectRoot)}; starting fresh. (${(err as Error).message})`,
    )
    return newLedger(projectRoot)
  }
}

/** Write atomically (write-tmp + rename). Compact JSON to halve write/parse time. */
export function saveLedger(ledger: Ledger, now = new Date()): void {
  ledger.last_updated = now.toISOString()
  const p = ledgerPath(ledger.project_root)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(ledger), "utf-8")
  renameSync(tmp, p)
}

/**
 * Per-cwd promise chain so concurrent finalize() calls don't race on the
 * same ledger file. Single Electron main process means an in-memory map
 * is sufficient; we don't need OS-level file locks.
 */
const writeQueue = new Map<string, Promise<void>>()

/**
 * Async-safe wrapper around saveLedger. Serializes concurrent writes per
 * project root so two sub-chats finishing simultaneously don't drop each
 * other's pheromone updates via last-write-wins.
 */
export function saveLedgerQueued(
  ledger: Ledger,
  now = new Date(),
): Promise<void> {
  const key = ledger.project_root
  const prior = writeQueue.get(key) ?? Promise.resolve()
  const next = prior
    .catch(() => {})
    .then(() => {
      saveLedger(ledger, now)
    })
  writeQueue.set(key, next)
  // Clean up after completion so the map doesn't grow unbounded.
  void next.finally(() => {
    if (writeQueue.get(key) === next) writeQueue.delete(key)
  })
  return next
}

/** Multiply every file priority by `rate`. Drop entries below the floor. */
export function applyDecay(
  ledger: Ledger,
  rate: number = DEFAULT_DECAY,
): void {
  const toDelete: string[] = []
  for (const [path, entry] of Object.entries(ledger.files)) {
    entry.priority = Math.min(PRIORITY_CEIL, entry.priority * rate)
    if (entry.priority < PRIORITY_FLOOR) toDelete.push(path)
  }
  for (const path of toDelete) delete ledger.files[path]
}

/** Bump one file. Records the subagent that touched it (so we can diff per-role coverage later). */
export function bumpFile(
  ledger: Ledger,
  filePath: string,
  by: number = DEFAULT_BUMP,
  subagent: string | null = null,
  now = new Date(),
): void {
  const existing = ledger.files[filePath]
  if (existing) {
    existing.priority = Math.min(PRIORITY_CEIL, existing.priority + by)
    existing.hits += 1
    existing.last_hit = now.toISOString()
    if (subagent) existing.last_subagent = subagent
  } else {
    ledger.files[filePath] = {
      path: filePath,
      priority: Math.min(PRIORITY_CEIL, by),
      hits: 1,
      last_hit: now.toISOString(),
      last_subagent: subagent,
    }
  }
}

/** Cap files to top N by priority (drops the lowest). */
export function pruneFiles(
  ledger: Ledger,
  maxEntries: number = MAX_FILE_ENTRIES,
): void {
  const entries = Object.values(ledger.files)
  if (entries.length <= maxEntries) return
  entries.sort((a, b) => b.priority - a.priority)
  const keep = entries.slice(0, maxEntries)
  const next: Record<string, FileEntry> = {}
  for (const e of keep) next[e.path] = e
  ledger.files = next
}

/** Append a delegation; trim oldest entries if over the cap. */
export function appendDelegation(
  ledger: Ledger,
  record: DelegationRecord,
): void {
  ledger.delegations.push(record)
  if (ledger.delegations.length > MAX_DELEGATIONS) {
    ledger.delegations.splice(0, ledger.delegations.length - MAX_DELEGATIONS)
  }
}

/** Top-N file entries by priority, descending. */
export function getTopPriorityFiles(
  ledger: Ledger,
  n: number,
): FileEntry[] {
  return Object.values(ledger.files)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, n)
}

/**
 * Render a priors block the orchestrator can append to the system prompt.
 * Returns null and empty paths when fewer than `minFiles` priority entries
 * exist (cold-start case — the model would just be misled).
 */
export function buildPriorsBlock(
  ledger: Ledger,
  topN: number = 5,
  minFiles: number = 3,
): { block: string | null; paths: string[] } {
  const top = getTopPriorityFiles(ledger, topN)
  if (top.length < minFiles) return { block: null, paths: [] }
  const lines = top.map((e) => {
    const role = e.last_subagent ? `, last touched by ${e.last_subagent}` : ""
    return `  - ${e.path} (priority ${e.priority.toFixed(2)}, ${e.hits} prior ${
      e.hits === 1 ? "hit" : "hits"
    }${role})`
  })
  const block = [
    "## Codebase priors from prior sessions",
    "",
    `Across ${ledger.session_count} prior sessions on this repo, these files have been most frequently relevant:`,
    "",
    ...lines,
    "",
    "Use these as starting hints when the user's query plausibly involves any of them. You are NOT required to read them — only use them as a hint when patterns match. If they're irrelevant, ignore them and search normally.",
  ].join("\n")
  return { block, paths: top.map((e) => e.path) }
}

/** Bump session counter and stamp last_updated. */
export function recordSession(ledger: Ledger, now = new Date()): void {
  ledger.session_count += 1
  ledger.last_updated = now.toISOString()
}

/** Typed getter for per-algorithm scratch space. */
export function getAlgorithmState<T>(
  ledger: Ledger,
  algorithm: string,
): T | undefined {
  return ledger.algorithm_state[algorithm] as T | undefined
}

/** Typed setter for per-algorithm scratch space. */
export function setAlgorithmState<T>(
  ledger: Ledger,
  algorithm: string,
  state: T,
): void {
  ledger.algorithm_state[algorithm] = state
}

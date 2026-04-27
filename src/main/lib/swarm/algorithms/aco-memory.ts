/**
 * Pheromone memory for the ACO swarm algorithm.
 *
 * Per-codebase persistent memory at `<projectRoot>/.askcodi/memory.json`.
 * Each session reads it on entry, updates it on exit. The "pheromone" is
 * a per-file priority score in [0, 1] that decays each session and bumps
 * when a file participates in answering a query.
 *
 * The moat the design doc claims: this file accumulates over sessions in
 * ways Anthropic's stateless `Explore` cannot. Even if Anthropic ships the
 * same algorithm, your colonies are already trained on real user repos.
 *
 * Format is intentionally minimal in v0.2:
 *   - `files`: per-path priority + hit count
 *   - patterns / snippets / cross-session embeddings come in v0.3+
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const MEMORY_FILE_REL = ".askcodi/memory.json"
export const DEFAULT_DECAY = 0.95
export const DEFAULT_BUMP = 0.15
export const PRIORITY_FLOOR = 0.05
export const PRIORITY_CEIL = 1.0
export const MAX_FILE_ENTRIES = 200
export const MEMORY_VERSION = 1

export type FileEntry = {
  /** Project-relative path (POSIX-style). */
  path: string
  /** Pheromone level in [0, 1]. */
  priority: number
  /** Total bumps this file has ever received. */
  hits: number
  /** ISO 8601. */
  last_hit: string
}

export type PheromoneMemory = {
  version: number
  project_root: string
  first_seen: string
  last_updated: string
  session_count: number
  files: Record<string, FileEntry>
}

export function newMemory(projectRoot: string, now = new Date()): PheromoneMemory {
  const iso = now.toISOString()
  return {
    version: MEMORY_VERSION,
    project_root: projectRoot,
    first_seen: iso,
    last_updated: iso,
    session_count: 0,
    files: {},
  }
}

export function memoryPath(projectRoot: string): string {
  return join(projectRoot, MEMORY_FILE_REL)
}

/** Read memory from disk. Returns a fresh empty memory if no file exists. */
export function loadMemory(projectRoot: string): PheromoneMemory {
  const p = memoryPath(projectRoot)
  let raw: string
  try {
    raw = readFileSync(p, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return newMemory(projectRoot)
    }
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as PheromoneMemory
    if (parsed.version !== MEMORY_VERSION) return newMemory(projectRoot)
    return parsed
  } catch (err) {
    console.warn(
      `[aco-memory] Could not parse ${p}; starting fresh. (${(err as Error).message})`,
    )
    return newMemory(projectRoot)
  }
}

/** Write memory to disk atomically (write to .tmp then rename). */
export function saveMemory(memory: PheromoneMemory, now = new Date()): void {
  memory.last_updated = now.toISOString()
  const p = memoryPath(memory.project_root)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(memory, null, 2), "utf-8")
  renameSync(tmp, p)
}

/**
 * Multiply every file priority by `rate`. Removes any file below the
 * floor. Caps at the ceiling defensively. Pure function — call this on
 * a clone before calling `saveMemory` if you want to keep the original.
 */
export function applyDecay(
  memory: PheromoneMemory,
  rate: number = DEFAULT_DECAY,
): void {
  for (const [path, entry] of Object.entries(memory.files)) {
    entry.priority = Math.min(PRIORITY_CEIL, entry.priority * rate)
    if (entry.priority < PRIORITY_FLOOR) {
      delete memory.files[path]
    }
  }
}

/**
 * Bump the priority of one file. Creates the entry if missing.
 * Caps at PRIORITY_CEIL. Increments hit count.
 */
export function bumpFile(
  memory: PheromoneMemory,
  filePath: string,
  by: number = DEFAULT_BUMP,
  now = new Date(),
): void {
  const existing = memory.files[filePath]
  if (existing) {
    existing.priority = Math.min(PRIORITY_CEIL, existing.priority + by)
    existing.hits += 1
    existing.last_hit = now.toISOString()
  } else {
    memory.files[filePath] = {
      path: filePath,
      priority: Math.min(PRIORITY_CEIL, by),
      hits: 1,
      last_hit: now.toISOString(),
    }
  }
}

/**
 * Cap the memory file at the top N entries by priority. Removes the
 * lowest-priority entries to bring file count under the cap.
 */
export function pruneMemory(
  memory: PheromoneMemory,
  maxEntries: number = MAX_FILE_ENTRIES,
): void {
  const entries = Object.values(memory.files)
  if (entries.length <= maxEntries) return
  entries.sort((a, b) => b.priority - a.priority)
  const keep = entries.slice(0, maxEntries)
  const newFiles: Record<string, FileEntry> = {}
  for (const e of keep) newFiles[e.path] = e
  memory.files = newFiles
}

/** Returns the top N file entries by priority, descending. */
export function getTopPriorityFiles(
  memory: PheromoneMemory,
  n: number,
): FileEntry[] {
  return Object.values(memory.files)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, n)
}

/**
 * Convert top-priority files into a priors block the LLM can use. Returns
 * the rendered block plus the file paths it covers (so callers don't
 * re-sort the memory to learn the same answer). When the memory is below
 * `minFiles` (cold start), returns `{ block: null, paths: [] }`.
 */
export function buildPriorsBlock(
  memory: PheromoneMemory,
  topN: number = 5,
  minFiles: number = 3,
): { block: string | null; paths: string[] } {
  const top = getTopPriorityFiles(memory, topN)
  if (top.length < minFiles) return { block: null, paths: [] }

  const lines = top.map(
    (e) =>
      `  - ${e.path} (priority ${e.priority.toFixed(2)}, ${e.hits} prior ${
        e.hits === 1 ? "hit" : "hits"
      })`,
  )
  const block = [
    "## Codebase priors from prior sessions",
    "",
    `Across ${memory.session_count} prior sessions on this repo, these files have been most frequently relevant:`,
    "",
    ...lines,
    "",
    "Use these as a starting point if the user's query plausibly involves any of them. You are NOT required to read these files — only use them as a hint when patterns match. If they're irrelevant, ignore them and search normally.",
  ].join("\n")
  return { block, paths: top.map((e) => e.path) }
}

/** Increment the session counter and stamp last_updated. */
export function recordSession(memory: PheromoneMemory, now = new Date()): void {
  memory.session_count += 1
  memory.last_updated = now.toISOString()
}

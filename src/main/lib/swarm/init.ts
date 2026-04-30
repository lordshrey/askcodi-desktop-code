/**
 * Codebase init pass — one-time scan that seeds the ledger with priors
 * derived from the repo's actual structure, plus pre-creates a few
 * common partition shapes.
 *
 * The point: every codebase has predictable hot spots (auth files,
 * routing, state stores, db schema, IPC bridges, tests). Scanning for
 * these patterns before the first algorithm run gives a fresh repo a
 * warm-start advantage without making us wait for ACO to compound
 * over 5-10 sessions.
 *
 * This module is the pure logic. The CLI wrapper lives in
 * scripts/swarm-init.ts.
 */
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import {
  bumpFile,
  loadLedger,
  recordSession,
  saveLedger,
  setAlgorithmState,
} from "./ledger"
import { INDEX_SKIP_DIRS } from "./path-utils"
import {
  ACO_FRONTIER_STATE_KEY,
  addCachedPartition,
  attributeFileToRegion,
  bumpFileInRegion,
  loadAcoFrontierState,
  type AcoFrontierState,
  type CachedWorkerSpec,
} from "./algorithms/aco-frontier"
import {
  listPartitionableDirs,
  type ListPartitionableOptions,
} from "./algorithms/frontier"

/**
 * Pattern category → one combined regex matching any file in that
 * domain. Combined into a single regex per category (vs an array of
 * regexes) so the inner scan loop is one .test() per category instead
 * of N — meaningful on large repos where this scales as files × patterns.
 */
export const INIT_PATTERNS: Record<PatternCategory, RegExp> = {
  auth:
    /(^|\/)(auth[A-Za-z0-9-]*|Auth[A-Za-z0-9-]*|login[A-Za-z0-9-]*|oauth[A-Za-z0-9-]*|session[A-Za-z0-9-]*|neon[A-Za-z0-9-]*|supabase[A-Za-z0-9-]*|(token|jwt)[A-Za-z0-9-]*)\.(ts|tsx|js|jsx)$/i,
  routing:
    /(^|\/)(router[A-Za-z0-9-]*|Routes|route-tree|App)\.(ts|tsx|js|jsx)$/i,
  state:
    /((^|\/)(contexts|atoms|stores?)\/)|((^|\/)use[A-Z][A-Za-z0-9]*Store\.(ts|tsx)$)/i,
  db:
    /(^|\/)(schema[A-Za-z0-9-]*\.(ts|js|sql)$|(drizzle|migrations?|prisma|models?)\/)/i,
  ipc:
    /(^|\/)((trpc|preload)\/|(ipc|bridge)[A-Za-z0-9-]*\.(ts|js)$)/i,
  tests: /(\.(test|spec)\.(ts|tsx|js|jsx)$)|((^|\/)__tests__\/)/i,
}

export type PatternCategory =
  | "auth"
  | "routing"
  | "state"
  | "db"
  | "ipc"
  | "tests"

/** Walk a directory tree and yield every visible file path (relative to root). */
function* walkFiles(root: string, current: string = root): Generator<string> {
  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue
    if (INDEX_SKIP_DIRS.has(e.name)) continue
    const abs = join(current, e.name)
    if (e.isDirectory()) {
      yield* walkFiles(root, abs)
    } else if (e.isFile()) {
      yield relative(root, abs).replace(/\\/g, "/")
    }
  }
}

export type InitMatches = Record<PatternCategory, string[]>

/** Scan the codebase and return matched file paths per pattern category. */
export function scanCodebase(cwd: string): InitMatches {
  const result: InitMatches = {
    auth: [],
    routing: [],
    state: [],
    db: [],
    ipc: [],
    tests: [],
  }
  const categories = Object.entries(INIT_PATTERNS) as [PatternCategory, RegExp][]
  for (const file of walkFiles(cwd)) {
    for (const [category, re] of categories) {
      if (re.test(file)) result[category].push(file)
    }
  }
  // Sort matches alphabetically for deterministic output.
  for (const k of Object.keys(result) as PatternCategory[]) {
    result[k].sort()
  }
  return result
}

/** Cap on how many files to seed per category (per-region-memory entry cap is independent). */
export const INIT_MAX_FILES_PER_CATEGORY = 30

/** Prior strength for init-seeded files. Modest so real signal can override. */
export const INIT_SEED_PRIORITY = 0.2

/**
 * Build cached partition shapes for detected categories. Conditional on
 * having ≥2 matches in a category — no point caching a partition for
 * something the codebase doesn't have.
 */
export function buildInitCachedPartitions(
  matches: InitMatches,
  inventory: string[],
): { id: string; pattern: string; workers: CachedWorkerSpec[] }[] {
  const out: { id: string; pattern: string; workers: CachedWorkerSpec[] }[] = []

  // Auth audit / refactor — useful when auth files exist.
  if (matches.auth.length >= 2) {
    out.push({
      id: "auth",
      pattern: "auth audit / refactor — providers, routing, consumers",
      workers: [
        {
          label: "providers",
          scope: `auth providers and helpers (e.g., ${matches.auth.slice(0, 3).join(", ")})`,
        },
        {
          label: "routing",
          scope:
            matches.routing.length > 0
              ? `auth-relevant entry points (e.g., ${matches.routing.slice(0, 2).join(", ")})`
              : "entry points and routing (App.*, route definitions)",
        },
        {
          label: "consumers",
          scope: "components or modules that consume auth state",
        },
      ],
    })
  }

  // Cross-tier trace — useful when there's a multi-tier inventory shape.
  const hasTiers =
    inventory.some((i) => /(^|\/)main(\/|$)/.test(i)) &&
    (inventory.some((i) => /(^|\/)renderer(\/|$)/.test(i)) ||
      inventory.some((i) => /(^|\/)preload(\/|$)/.test(i)))
  if (hasTiers) {
    const mainEntry = inventory.find((i) => /(^|\/)main(\/|$)/.test(i))
    const rendererEntry = inventory.find((i) => /(^|\/)renderer(\/|$)/.test(i))
    const preloadEntry = inventory.find((i) => /(^|\/)preload(\/|$)/.test(i))
    out.push({
      id: "tier",
      pattern: "cross-tier trace — main / preload / renderer",
      workers: [
        { label: "main", scope: mainEntry ?? "src/main backend tier" },
        {
          label: "preload",
          scope: preloadEntry ?? "src/preload bridge",
        },
        {
          label: "renderer",
          scope: rendererEntry ?? "src/renderer UI tier",
        },
      ],
    })
  }

  // Persistence flow — useful when DB-related files exist.
  if (matches.db.length >= 2) {
    out.push({
      id: "data",
      pattern: "persistence flow — schema, migrations, DB-touching code",
      workers: [
        {
          label: "schema",
          scope: `schema definitions (e.g., ${matches.db.slice(0, 2).join(", ")})`,
        },
        {
          label: "migrations",
          scope:
            matches.db.find((p) => /migrations|drizzle/.test(p)) ??
            "migrations directory",
        },
        {
          label: "consumers",
          scope: "modules that read/write the database",
        },
      ],
    })
  }

  return out
}

export type InitOptions = {
  cwd: string
  partitionOptions?: ListPartitionableOptions
  /** When true, skip if ledger already shows session activity. Default false. */
  skipIfWarm?: boolean
}

export type InitReport = {
  cwd: string
  inventory: string[]
  matches: InitMatches
  /** Total file paths seeded into region_memory. */
  files_seeded: number
  /** Per-region count of seeded files. */
  per_region_seeded: Record<string, number>
  /** Cached partitions created by init. */
  cached_partitions: string[]
  /** Whether init bailed because the ledger was already warm. */
  skipped: boolean
}

/**
 * Run the init pass: scan codebase, seed per-region pheromones with
 * pattern-derived priors, pre-create common cached partitions. Pure
 * mutation of the ledger; returns a report for the CLI to print.
 */
export function runInit(opts: InitOptions): InitReport {
  const cwd = opts.cwd
  const ledger = loadLedger(cwd)

  if (opts.skipIfWarm && ledger.session_count > 0) {
    return {
      cwd,
      inventory: [],
      matches: { auth: [], routing: [], state: [], db: [], ipc: [], tests: [] },
      files_seeded: 0,
      per_region_seeded: {},
      cached_partitions: [],
      skipped: true,
    }
  }

  const inventory = listPartitionableDirs(cwd, opts.partitionOptions)
  const matches = scanCodebase(cwd)

  // Seed per-region pheromones for matched files.
  const state: AcoFrontierState = loadAcoFrontierState(ledger)
  const perRegionSeeded: Record<string, number> = {}
  let totalSeeded = 0
  const now = new Date()

  for (const [category, files] of Object.entries(matches) as [
    PatternCategory,
    string[],
  ][]) {
    const capped = files.slice(0, INIT_MAX_FILES_PER_CATEGORY)
    for (const file of capped) {
      // Bump the global ledger (ACO consumes this).
      bumpFile(ledger, file, INIT_SEED_PRIORITY, "init", now)
      // Bump per-region pheromones (hybrid + router consume this).
      const region = attributeFileToRegion(file, inventory)
      if (region) {
        bumpFileInRegion(state, region, file, INIT_SEED_PRIORITY, "init", now)
        perRegionSeeded[region] = (perRegionSeeded[region] ?? 0) + 1
      } else {
        perRegionSeeded["(unscoped)"] = (perRegionSeeded["(unscoped)"] ?? 0) + 1
      }
      totalSeeded += 1
    }
  }

  // Pre-create cached partition shapes that match what we found.
  const partitionsToAdd = buildInitCachedPartitions(matches, inventory)
  const partitionIdsAdded: string[] = []
  for (const p of partitionsToAdd) {
    // Skip if already present (idempotent re-run).
    if (state.cached_partitions.find((c) => c.id === p.id)) continue
    addCachedPartition(
      state,
      {
        id: p.id,
        query_pattern: p.pattern,
        workers: p.workers,
        last_overlap_count: 0,
      },
      now,
    )
    partitionIdsAdded.push(p.id)
  }

  setAlgorithmState(ledger, ACO_FRONTIER_STATE_KEY, state)

  // Bump session_count so the priors block renders sensibly. This is the
  // "init session" — algorithms see the ledger as warm-started.
  if (ledger.session_count === 0) recordSession(ledger, now)

  saveLedger(ledger)

  return {
    cwd,
    inventory,
    matches,
    files_seeded: totalSeeded,
    per_region_seeded: perRegionSeeded,
    cached_partitions: partitionIdsAdded,
    skipped: false,
  }
}

#!/usr/bin/env bun
/**
 * One-time codebase init pass for swarm algorithms.
 *
 * Scans the target repo for common patterns (auth, routing, state, db,
 * ipc, tests), seeds the ledger with priors derived from those patterns,
 * and pre-creates 1-3 cached partition shapes for the detected
 * categories. This gives a fresh repo a warm-start advantage so the
 * first ACO/Frontier/Hybrid run isn't fully cold.
 *
 * Usage:
 *   bun run scripts/swarm-init.ts --cwd <path>
 *   bun run scripts/swarm-init.ts --cwd <path> --skip-if-warm
 *   bun run scripts/swarm-init.ts --cwd <path> --container-names src,apps
 *   bun run scripts/swarm-init.ts --cwd <path> --max-depth 3
 *   bun run scripts/swarm-init.ts --cwd <path> --dry-run
 */
import { existsSync } from "node:fs"
import { runInit } from "../src/main/lib/swarm/init"
import { DEFAULT_CONTAINER_NAMES } from "../src/main/lib/swarm/algorithms/frontier"

type Args = {
  cwd: string
  skipIfWarm: boolean
  containerNames?: string[]
  maxDepth?: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { skipIfWarm: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--cwd") out.cwd = next()
    else if (a === "--skip-if-warm") out.skipIfWarm = true
    else if (a === "--container-names")
      out.containerNames = next().split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--max-depth") out.maxDepth = Number(next())
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      printHelp()
      process.exit(2)
    }
  }
  if (!out.cwd) {
    console.error("Missing --cwd <path>")
    printHelp()
    process.exit(2)
  }
  if (!existsSync(out.cwd!)) {
    console.error(`--cwd does not exist: ${out.cwd}`)
    process.exit(1)
  }
  return out as Args
}

function printHelp() {
  console.log(`Usage:
  bun run scripts/swarm-init.ts --cwd <path> [flags]

Required:
  --cwd <path>            Path to the codebase to initialize

Flags:
  --skip-if-warm          Bail if ledger already shows session activity
  --container-names a,b,c Extra container dir names for the partition enumerator
                          (added to defaults: ${[...DEFAULT_CONTAINER_NAMES].slice(0, 6).join(", ")}, ...)
  --max-depth <n>         How deep to descend into containers (default 2)
  --dry-run               Print what init would do without modifying the ledger`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  const partitionOptions: {
    containerNames?: Set<string>
    maxDepth?: number
  } = {}
  if (args.containerNames) {
    partitionOptions.containerNames = new Set([
      ...DEFAULT_CONTAINER_NAMES,
      ...args.containerNames,
    ])
  }
  if (args.maxDepth !== undefined) {
    partitionOptions.maxDepth = args.maxDepth
  }

  if (args.dryRun) {
    console.log("[init] DRY-RUN — would scan and seed but not save")
  }

  const report = runInit({
    cwd: args.cwd,
    partitionOptions:
      Object.keys(partitionOptions).length > 0 ? partitionOptions : undefined,
    skipIfWarm: args.skipIfWarm,
  })

  if (report.skipped) {
    console.log(
      `[init] skipped — ledger at ${args.cwd}/.askcodi/ledger.json already has session activity (use without --skip-if-warm to force re-init)`,
    )
    return
  }

  console.log(`[init] cwd: ${args.cwd}`)
  console.log(`[init] inventory (${report.inventory.length} regions):`)
  for (const r of report.inventory) console.log(`         - ${r}`)

  console.log(`[init] pattern matches:`)
  for (const [category, files] of Object.entries(report.matches)) {
    if (files.length === 0) continue
    console.log(`         ${category}: ${files.length} file(s)`)
    for (const f of files.slice(0, 5)) console.log(`           - ${f}`)
    if (files.length > 5) console.log(`           ... +${files.length - 5} more`)
  }

  console.log(`[init] files seeded: ${report.files_seeded}`)
  for (const [region, count] of Object.entries(report.per_region_seeded).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`         ${region}: ${count}`)
  }

  console.log(
    `[init] cached partitions created: ${report.cached_partitions.length === 0 ? "(none)" : report.cached_partitions.join(", ")}`,
  )

  console.log(`[init] done. Ledger written to ${args.cwd}/.askcodi/ledger.json`)
}

main()

#!/usr/bin/env bun
/**
 * Import legacy test-swarm.ts JSONL outputs into a swarm-suite directory
 * as CellSummary records, so the analyzer can include them alongside
 * fresh suite runs without re-spending tokens.
 *
 * Discovers cells in test-runs/ matching "cmp-{algo}-{queryId}-{label}.jsonl"
 * (the format scripts/aco-compounding.sh wrote). Algorithm name mappings:
 *   cmp-aco-*        → algorithm "aco"
 *   cmp-baseline-*   → algorithm "none"
 *
 * Skips cells that already have a *.summary.json in the target dir, so
 * re-running this script is idempotent.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"
import {
  extractResultMetadata,
  summarizeStream,
  type CellSummary,
} from "../src/main/lib/swarm/suite/cell"

type LegacyCell = {
  /** Source JSONL path. */
  src: string
  algorithm: string
  queryId: string
  label: string
  /** Raw queryText, looked up from the queries file. */
  queryText: string
}

type Args = {
  suiteDir: string
  legacyDir: string
  queriesFile: string
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    legacyDir: "test-runs",
    queriesFile: "scripts/swarm-queries.txt",
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--suite-dir") out.suiteDir = next()
    else if (a === "--legacy-dir") out.legacyDir = next()
    else if (a === "--queries") out.queriesFile = next()
    else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      printHelp()
      process.exit(2)
    }
  }
  if (!out.suiteDir) {
    console.error("Missing --suite-dir")
    printHelp()
    process.exit(2)
  }
  return out as Args
}

function printHelp() {
  console.log(`Usage:
  bun run scripts/import-legacy-cells.ts --suite-dir <path> [--legacy-dir <path>] [--queries <file>]

Reads cmp-*.jsonl from --legacy-dir (default: test-runs) and writes one
.summary.json per cell into --suite-dir, plus copies the .jsonl alongside.`)
}

function loadQueryMap(path: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!existsSync(path)) return map
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
  for (const line of lines) {
    const parts = line.split("|")
    if (parts.length >= 3) map.set(parts[0], parts.slice(2).join("|"))
  }
  return map
}

/** Parse "cmp-{algo}-{queryId}-{label}.jsonl" → LegacyCell stub. Returns null if not a legacy cell. */
function parseLegacyFilename(file: string): {
  algorithm: string
  queryId: string
  label: string
} | null {
  const stem = file.replace(/\.jsonl$/, "")
  // Strip optional ISO timestamp prefix.
  const stripped = stem.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "")
  const m = stripped.match(/^cmp-(aco|baseline)-(Q\d+)-(.+)$/)
  if (!m) return null
  const algorithm = m[1] === "baseline" ? "none" : m[1]
  return { algorithm, queryId: m[2], label: m[3] }
}

/** Read one JSONL into an array of parsed messages, skipping malformed lines. */
function readJsonl(path: string): unknown[] {
  const out: unknown[] = []
  const raw = readFileSync(path, "utf-8")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // Skip malformed; log handles can have torn writes.
    }
  }
  return out
}

/** Pull duration_ms off the trailing `result` message the SDK emits. Returns 0 if not found. */
function extractDurationMs(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: string; duration_ms?: number }
    if (m?.type === "result" && typeof m.duration_ms === "number") {
      return m.duration_ms
    }
  }
  return 0
}

function buildSummary(cell: LegacyCell, messages: unknown[]): CellSummary {
  const stats = summarizeStream(messages)
  const durationMs = extractDurationMs(messages)
  const meta = extractResultMetadata(messages)
  return {
    version: 1,
    algorithm: cell.algorithm,
    query: cell.queryText,
    queryId: cell.queryId,
    durationMs,
    errored: false,
    rawLogPath: cell.src,
    finishedAt: new Date().toISOString(),
    parentMessages: stats.parentMessages,
    delegations: stats.delegations,
    toolCalls: stats.toolCalls,
    swarmFailures: stats.swarmFailures,
    modelTokens: stats.modelTokens,
    totalCostUsd: meta.totalCostUsd,
    durationApiMs: meta.durationApiMs,
    modelUsage: meta.modelUsage,
    // No algorithm-specific stats recoverable from the legacy JSONL.
    algorithmStats: { _source: "legacy-import" },
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.suiteDir)) {
    console.error(`--suite-dir does not exist: ${args.suiteDir}`)
    process.exit(1)
  }
  const queryMap = loadQueryMap(args.queriesFile)

  const files = readdirSync(args.legacyDir).filter((f) => f.endsWith(".jsonl"))
  let imported = 0,
    skipped = 0,
    unmatched = 0
  for (const file of files) {
    const parsed = parseLegacyFilename(file)
    if (!parsed) {
      unmatched++
      continue
    }
    const queryText = queryMap.get(parsed.queryId) ?? `(unknown query ${parsed.queryId})`
    const cell: LegacyCell = {
      src: join(args.legacyDir, file),
      algorithm: parsed.algorithm,
      queryId: parsed.queryId,
      label: parsed.label,
      queryText,
    }

    const targetStem = `${cell.queryId}-${cell.algorithm}`
    const summaryPath = join(args.suiteDir, `${targetStem}.summary.json`)
    const jsonlPath = join(args.suiteDir, `${targetStem}.jsonl`)

    if (existsSync(summaryPath)) {
      console.log(`  [skip] ${basename(file)} → ${targetStem} (already imported)`)
      skipped++
      continue
    }

    const messages = readJsonl(cell.src)
    if (messages.length === 0) {
      console.warn(`  [warn] ${basename(file)} is empty; skipping`)
      continue
    }
    const summary = buildSummary(cell, messages)
    summary.rawLogPath = jsonlPath
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8")
    copyFileSync(cell.src, jsonlPath)
    console.log(
      `  [ok]   ${basename(file)} → ${targetStem} (${messages.length} msgs, ${summary.parentMessages} assistant, ${(summary.durationMs / 1000).toFixed(1)}s)`,
    )
    imported++
  }
  console.log("─".repeat(72))
  console.log(
    `[import] ${imported} imported, ${skipped} skipped, ${unmatched} unmatched (non-cmp files)`,
  )
}

main()

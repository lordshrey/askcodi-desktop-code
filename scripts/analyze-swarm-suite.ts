#!/usr/bin/env bun
/**
 * Read a directory of *.summary.json files produced by run-swarm-suite.ts
 * and emit a markdown comparison report.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import {
  renderReport,
  type ReportOptions,
} from "../src/main/lib/swarm/suite/analyzer"
import type { CellSummary } from "../src/main/lib/swarm/suite/cell"

type Args = {
  suiteDir: string
  out?: string
  title?: string
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--suite-dir") out.suiteDir = next()
    else if (a === "--out") out.out = next()
    else if (a === "--title") out.title = next()
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
  if (!existsSync(out.suiteDir!)) {
    console.error(`--suite-dir does not exist: ${out.suiteDir}`)
    process.exit(1)
  }
  return out as Args
}

function printHelp() {
  console.log(`Usage:
  bun run scripts/analyze-swarm-suite.ts --suite-dir <path> [--out <file>] [--title "..."]

Reads <path>/*.summary.json and writes a markdown report to --out (default: <path>/REPORT.md).`)
}

function loadSummaries(dir: string): CellSummary[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".summary.json"))
  const out: CellSummary[] = []
  for (const f of files) {
    const path = join(dir, f)
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as CellSummary
      out.push(parsed)
    } catch (err) {
      console.warn(`[analyzer] skipping malformed ${f}: ${(err as Error).message}`)
    }
  }
  return out
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const summaries = loadSummaries(args.suiteDir)
  if (summaries.length === 0) {
    console.error(`[analyzer] no *.summary.json files in ${args.suiteDir}`)
    process.exit(1)
  }

  const reportOptions: ReportOptions = {
    title: args.title ?? "Swarm suite report",
    suiteId: basename(args.suiteDir),
  }
  const md = renderReport(summaries, reportOptions)

  const outPath = args.out ?? join(args.suiteDir, "REPORT.md")
  writeFileSync(outPath, md, "utf-8")
  console.log(`[analyzer] ${summaries.length} cells → ${outPath}`)
}

main()

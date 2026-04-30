#!/usr/bin/env bun
/**
 * Run an N×M (algorithm × query) swarm suite against a target repo.
 *
 * Each cell produces:
 *   - a raw .jsonl event log
 *   - a .summary.json with aggregated stats
 * Both land in `test-runs/suite-{ts}/`. Run scripts/analyze-swarm-suite.ts
 * against the same directory to produce a markdown comparison report.
 *
 * Example:
 *   bun run scripts/run-swarm-suite.ts \
 *     --cwd ~/Desktop/Companies/assistiv-labs/second-brain \
 *     --algorithms none,aco,abc,consensus,frontier \
 *     --queries scripts/swarm-queries.txt \
 *     --concurrency 2
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { findSystemClaude } from "../src/main/lib/claude/find-binary"
import {
  algorithmNames,
  getAlgorithm,
} from "../src/main/lib/swarm/algorithms/registry"
import type {
  AlgorithmRunOptions,
  SwarmAlgorithm,
} from "../src/main/lib/swarm/algorithms/algorithm"
import { runSuite, type SuiteCell } from "../src/main/lib/swarm/suite/runner"

type Args = {
  cwd: string
  algorithms: string[]
  queries: { id: string; text: string }[]
  concurrency: number
  claudePath: string
  outDir: string
  /** Frontier-specific: extra container names (in addition to defaults). */
  frontierContainerNames?: string[]
  /** Frontier-specific: max descent depth (default 2). */
  frontierMaxDepth?: number
  /** Hybrid-specific: turn off the MCTS-style beam-partitioning prompt. */
  hybridDisableBeam?: boolean
}

function parseQueriesFile(path: string): { id: string; text: string }[] {
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
  return lines.map((line, i) => {
    // Format: "Q1|wide-overview|the actual query" — same as test-suite.sh
    const parts = line.split("|")
    if (parts.length >= 3) {
      return { id: parts[0], text: parts.slice(2).join("|") }
    }
    return { id: `Q${i + 1}`, text: line }
  })
}

function parseInlineQueries(arr: string[]): { id: string; text: string }[] {
  return arr.map((q, i) => ({ id: `Q${i + 1}`, text: q }))
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { concurrency: 2 }
  const inlineQueries: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--cwd") out.cwd = next()
    else if (a === "--algorithms") out.algorithms = next().split(",").map((s) => s.trim())
    else if (a === "--queries") out.queries = parseQueriesFile(next())
    else if (a === "--query") inlineQueries.push(next())
    else if (a === "--concurrency") out.concurrency = Number(next())
    else if (a === "--claude") out.claudePath = next()
    else if (a === "--out-dir") out.outDir = next()
    else if (a === "--frontier-container-names")
      out.frontierContainerNames = next().split(",").map((s) => s.trim()).filter(Boolean)
    else if (a === "--frontier-max-depth")
      out.frontierMaxDepth = Number(next())
    else if (a === "--hybrid-no-beam") out.hybridDisableBeam = true
    else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      printHelp()
      process.exit(2)
    }
  }
  if (!out.queries && inlineQueries.length > 0) {
    out.queries = parseInlineQueries(inlineQueries)
  }
  if (!out.cwd || !out.algorithms || !out.queries || out.queries.length === 0) {
    console.error("Missing required: --cwd, --algorithms, and --queries (or --query).")
    printHelp()
    process.exit(2)
  }
  for (const name of out.algorithms!) {
    if (!getAlgorithm(name)) {
      console.error(`Unknown algorithm: ${name}. Supported: ${algorithmNames().join(", ")}`)
      process.exit(2)
    }
  }
  if (!out.claudePath) {
    const found = findSystemClaude()
    if (!found) {
      console.error("Could not find a `claude` binary. Pass --claude /path/to/claude.")
      process.exit(1)
    }
    out.claudePath = found
  }
  if (!existsSync(out.cwd!)) {
    console.error(`--cwd does not exist: ${out.cwd}`)
    process.exit(1)
  }
  if (!out.outDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    out.outDir = join(process.cwd(), "test-runs", `suite-${ts}`)
  }
  return out as Args
}

function printHelp() {
  console.log(`Usage:
  bun run scripts/run-swarm-suite.ts --cwd <path> --algorithms <a,b,...> --queries <file> [flags]

Required:
  --cwd <path>             Project folder to run against
  --algorithms <list>      Comma-separated algorithm names (${algorithmNames().join(", ")})
  --queries <file>         File with one query per line, optionally formatted "Q1|label|text"
  OR
  --query "<text>"         Inline query (can repeat for multiple queries)

Flags:
  --concurrency <n>           How many cells to run in parallel (default 2)
  --claude <path>             Path to claude binary (default: auto-detect)
  --out-dir <path>            Output directory (default: ./test-runs/suite-{ts}/)
  --frontier-container-names  Comma-separated extra container dir names for the
                              monorepo-aware enumerator (in addition to
                              defaults like apps/, packages/). Useful when the
                              repo doesn't fit the standard monorepo shape.
  --frontier-max-depth <n>    How deep to descend through containers (default 2)`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.outDir, { recursive: true })

  console.log(`[suite] cwd: ${args.cwd}`)
  console.log(`[suite] algorithms: ${args.algorithms.join(", ")}`)
  console.log(`[suite] queries: ${args.queries.length}`)
  console.log(`[suite] cells: ${args.algorithms.length * args.queries.length}`)
  console.log(`[suite] concurrency: ${args.concurrency}`)
  console.log(`[suite] claude binary: ${args.claudePath}`)
  console.log(`[suite] out dir: ${args.outDir}`)
  console.log("─".repeat(72))

  const sdk = await import("@anthropic-ai/claude-agent-sdk")

  // Build per-algorithm extras. Currently only Frontier accepts options
  // (partition tuning); other algorithms ignore any extras passed.
  const extrasByAlgo: Record<string, Record<string, unknown>> = {}
  if (args.frontierContainerNames || args.frontierMaxDepth !== undefined) {
    const partitionOptions: Record<string, unknown> = {}
    if (args.frontierContainerNames) {
      // Augment defaults rather than replace — algorithm callers usually
      // want apps/+packages/+... AND their extras, not just extras.
      const { DEFAULT_CONTAINER_NAMES } = await import(
        "../src/main/lib/swarm/algorithms/frontier"
      )
      partitionOptions.containerNames = new Set([
        ...DEFAULT_CONTAINER_NAMES,
        ...args.frontierContainerNames,
      ])
    }
    if (args.frontierMaxDepth !== undefined) {
      partitionOptions.maxDepth = args.frontierMaxDepth
    }
    extrasByAlgo.frontier = { partitionOptions }
    extrasByAlgo["aco-frontier"] = { partitionOptions }
    extrasByAlgo["aco-router"] = { partitionOptions }
    console.log(
      `[suite] partition options: containers+=[${args.frontierContainerNames?.join(",") ?? ""}], maxDepth=${args.frontierMaxDepth ?? 2}`,
    )
  }
  if (args.hybridDisableBeam) {
    extrasByAlgo["aco-frontier"] = {
      ...(extrasByAlgo["aco-frontier"] ?? {}),
      withBeam: false,
    }
    console.log("[suite] aco-frontier beam: DISABLED (--hybrid-no-beam)")
  }

  const cells: SuiteCell[] = []
  for (const queryEntry of args.queries) {
    for (const algoName of args.algorithms) {
      const algorithm = getAlgorithm(algoName) as SwarmAlgorithm
      const cellLabel = `${queryEntry.id}-${algoName}`
      const rawLogPath = join(args.outDir, `${cellLabel}.jsonl`)
      cells.push({
        algorithm,
        queryId: queryEntry.id,
        queryText: queryEntry.text,
        rawLogPath,
        extraOptions: extrasByAlgo[algoName],
      })
    }
  }

  // Stream messages straight to disk so a crash doesn't lose data.
  const logHandles = new Map<string, string>()
  for (const cell of cells) logHandles.set(`${cell.queryId}|${cell.algorithm.name}`, cell.rawLogPath)

  const start = Date.now()
  const results = await runSuite(
    cells,
    {
      cwd: args.cwd,
      sdkQuery: sdk.query as AlgorithmRunOptions["sdkQuery"],
      pathToClaudeCodeExecutable: args.claudePath,
      onMessage: (queryId, algorithmName, msg) => {
        const path = logHandles.get(`${queryId}|${algorithmName}`)
        if (path) appendFileSync(path, JSON.stringify(msg) + "\n")
      },
    },
    {
      concurrency: args.concurrency,
      onCellFinish: (summary) => {
        const summaryPath = summary.rawLogPath.replace(/\.jsonl$/, ".summary.json")
        writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8")
        const status = summary.errored
          ? `ERR(${summary.errorMessage?.slice(0, 40) ?? "?"})`
          : `${(summary.durationMs / 1000).toFixed(1)}s`
        console.log(
          `  [done] ${summary.queryId} × ${summary.algorithm}: ${status}`,
        )
      },
    },
  )

  const wallSeconds = ((Date.now() - start) / 1000).toFixed(1)
  const errored = results.filter((r) => r.errored).length
  console.log("─".repeat(72))
  console.log(
    `[suite] done in ${wallSeconds}s — ${results.length - errored}/${results.length} cells succeeded`,
  )
  console.log(`[suite] summaries: ${args.outDir}/*.summary.json`)
  console.log(`[suite] analyze:   bun run scripts/analyze-swarm-suite.ts --suite-dir ${args.outDir}`)
}

main().catch((err) => {
  console.error("[suite] fatal:", err)
  process.exit(1)
})

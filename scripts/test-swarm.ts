#!/usr/bin/env bun
/**
 * Swarm-algorithm iteration harness.
 *
 * Drives @anthropic-ai/claude-agent-sdk against a target repo through a
 * pluggable algorithm (registered in src/main/lib/swarm/algorithms/registry.ts).
 * Captures the raw event stream and prints:
 *   - live ticker (curated by default, full event flow with --verbose)
 *   - SUMMARY block: model/token breakdown, tool calls, delegations,
 *     algorithm-specific stats, one-line verdict
 *
 * Adding a new algorithm = ship one file in src/main/lib/swarm/algorithms/
 * and register it. No edits here required.
 *
 * Auth: the SDK reuses the credentials your `claude` CLI is logged into.
 * If `claude --version` works in your shell, this script will too.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { findSystemClaude } from "../src/main/lib/claude/find-binary"
import {
  algorithmNames,
  getAlgorithm,
  listAlgorithms,
} from "../src/main/lib/swarm/algorithms/registry"
import type {
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "../src/main/lib/swarm/algorithms/algorithm"

// ── arg parsing ──────────────────────────────────────────────────────────

type Args = {
  cwd: string
  query: string
  label: string
  claudePath: string
  verbose: boolean
  algorithm: string
  registerSwarmExplore: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    label: "run",
    verbose: false,
    algorithm: "none",
    registerSwarmExplore: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--cwd") out.cwd = next()
    else if (a === "--query") out.query = next()
    else if (a === "--label") out.label = next()
    else if (a === "--no-swarm") {
      // Back-compat: alias for --algorithm none with no legacy swarm_explore.
      out.algorithm = "none"
      out.registerSwarmExplore = false
    } else if (a === "--register-swarm-explore") {
      // Opt-in to the legacy swarm_explore + routing-policy path. Only
      // useful for reproducing pre-pivot positioning experiments.
      out.registerSwarmExplore = true
    } else if (a === "--claude") out.claudePath = next()
    else if (a === "--verbose" || a === "-v") out.verbose = true
    else if (a === "--algorithm") {
      const v = next()
      if (!getAlgorithm(v)) {
        console.error(
          `Unknown --algorithm value: ${v}. Supported: ${algorithmNames().join(", ")}.`,
        )
        process.exit(2)
      }
      out.algorithm = v
    } else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      printHelp()
      process.exit(2)
    }
  }
  if (!out.cwd || !out.query) {
    console.error("Missing required --cwd or --query.")
    printHelp()
    process.exit(2)
  }
  if (!out.claudePath) {
    const found = findSystemClaude()
    if (!found) {
      console.error("Could not find a `claude` binary. Pass --claude /path/to/claude.")
      process.exit(1)
    }
    out.claudePath = found
  }
  return out as Args
}

function printHelp() {
  const algos = listAlgorithms()
  const algoLines = algos.map(
    (a) => `                         ${a.name.padEnd(8)} ${a.description}`,
  )
  console.log(`Usage:
  bun run scripts/test-swarm.ts --cwd <path> --query "<text>" [flags]

Flags:
  --cwd                       Project folder to run against (required)
  --query                     Prompt to send to the parent model (required)
  --label                     Run label for the log filename (default: "run")
  --algorithm <name>          Swarm algorithm to wrap the SDK call:
${algoLines.join("\n")}
  --no-swarm                  Alias for --algorithm none.
  --register-swarm-explore    Register the legacy v0.1 swarm_explore subagent
                              + routing-policy systemPrompt. Pre-pivot
                              positioning-experiment back-compat.
  --claude <path>             Path to claude binary (default: auto-detect)
  --verbose, -v               Dump full event flow rather than the curated ticker.`)
}

// ── general stats accumulator (algorithm-agnostic) ───────────────────────

type Stats = {
  delegations: Record<string, number>
  modelTokens: Record<
    string,
    { calls: number; input: number; output: number; cacheCreate: number; cacheRead: number }
  >
  parentMessages: number
  toolCalls: Record<string, number>
  swarmFailures: number
}

function newStats(): Stats {
  return {
    delegations: {},
    modelTokens: {},
    parentMessages: 0,
    toolCalls: {},
    swarmFailures: 0,
  }
}

function bump<K extends string>(rec: Record<K, number>, key: K, by: number = 1) {
  rec[key] = (rec[key] ?? 0) + by
}

function recordModelUsage(
  stats: Stats,
  model: string,
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  } | undefined,
) {
  if (!model) return
  const m = (stats.modelTokens[model] ??= {
    calls: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
  })
  m.calls += 1
  m.input += usage?.input_tokens ?? 0
  m.output += usage?.output_tokens ?? 0
  m.cacheCreate += usage?.cache_creation_input_tokens ?? 0
  m.cacheRead += usage?.cache_read_input_tokens ?? 0
}

function classifyModel(name: string): "haiku" | "opus" | "sonnet" | "other" {
  if (name.includes("haiku")) return "haiku"
  if (name.includes("opus")) return "opus"
  if (name.includes("sonnet")) return "sonnet"
  return "other"
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const algorithm = getAlgorithm(args.algorithm)
  if (!algorithm) {
    console.error(`No algorithm registered for "${args.algorithm}".`)
    process.exit(1)
  }

  if (!existsSync(args.cwd)) {
    console.error(`--cwd does not exist: ${args.cwd}`)
    process.exit(1)
  }

  const logDir = join(process.cwd(), "test-runs")
  mkdirSync(logDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const logFile = join(logDir, `${ts}-${args.label}.jsonl`)
  console.log(`[harness] logging to ${logFile}`)
  console.log(`[harness] claude binary: ${args.claudePath}`)
  console.log(`[harness] cwd: ${args.cwd}`)
  console.log(`[harness] query: ${args.query}`)
  console.log(`[harness] algorithm: ${algorithm.name}`)
  if (args.registerSwarmExplore) {
    console.log(`[harness] legacy swarm_explore: ON (--register-swarm-explore)`)
  }
  console.log("─".repeat(72))

  const sdk = await import("@anthropic-ai/claude-agent-sdk")

  const stats = newStats()
  const onMsg = (msg: unknown) => {
    appendFileSync(logFile, JSON.stringify(msg) + "\n")
    inspectMessage(msg, stats, args.verbose)
  }

  // Each algorithm consumes the base AlgorithmRunOptions + whatever extras
  // it defines. Pass the union — algorithms ignore fields they don't know.
  const runOpts: AlgorithmRunOptions & { registerSwarmExplore?: boolean } = {
    cwd: args.cwd,
    sdkQuery: sdk.query as AlgorithmRunOptions["sdkQuery"],
    pathToClaudeCodeExecutable: args.claudePath,
    onMessage: onMsg,
    registerSwarmExplore: args.registerSwarmExplore,
  }
  const result = await algorithm.run(args.query, runOpts)

  printSummary(args, algorithm, result.stats, stats, logFile)
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `…(+${s.length - n} chars)`
}

function inspectMessage(msg: unknown, stats: Stats, verbose: boolean) {
  const m = msg as Record<string, unknown>
  const t = m?.type as string | undefined
  const sub = m?.subtype as string | undefined

  if (verbose) {
    if (t === "system") {
      const keys = Object.keys(m).filter(
        (k) => k !== "type" && k !== "subtype" && k !== "uuid" && k !== "session_id",
      )
      const preview = keys.length
        ? trunc(
            JSON.stringify(Object.fromEntries(keys.map((k) => [k, m[k]]))),
            300,
          )
        : ""
      console.log(`[system/${sub ?? "?"}] ${preview}`)
    } else if (t === "stream_event") {
      const ev = (m.event as Record<string, unknown> | undefined) ?? {}
      const evType = ev.type as string | undefined
      const idx = ev.index as number | undefined
      if (evType && evType !== "content_block_delta") {
        console.log(`[stream_event] ${evType}${idx !== undefined ? ` idx=${idx}` : ""}`)
      }
    }
  }

  if (t === "system" && sub === "init") {
    const list = (m.agents as string[] | undefined) ?? []
    console.log(`[init] model=${m.model ?? "?"} agents=[${list.join(", ")}]`)
    return
  }

  if (t === "system" && sub === "task_started") {
    const ttype = m.task_type ?? "?"
    const desc = String(m.description ?? "").slice(0, verbose ? 200 : 80)
    console.log(`[task_started] type=${ttype} desc="${desc}"`)
    if (verbose && m.prompt) {
      console.log(`  prompt: ${trunc(String(m.prompt), 400)}`)
    }
    return
  }

  if (t === "system" && sub === "task_progress" && verbose) {
    const last = m.last_tool_name ?? "?"
    const usage = (m.usage as Record<string, unknown> | undefined) ?? {}
    console.log(
      `[task_progress] last=${last} tools_used=${usage.tool_uses ?? "?"} tokens=${usage.total_tokens ?? "?"}`,
    )
    return
  }

  if (t === "assistant") {
    stats.parentMessages += 1
    const message = (m.message as Record<string, unknown> | undefined) ?? {}
    const model = message.model as string | undefined
    const usage = message.usage as Record<string, number> | undefined
    if (model) recordModelUsage(stats, model, usage)

    if (verbose) {
      const u = usage ?? {}
      console.log(
        `[assistant] model=${model ?? "?"} parent_tool_use=${m.parent_tool_use_id ?? "(none)"} in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_r=${u.cache_read_input_tokens ?? 0} cache_c=${u.cache_creation_input_tokens ?? 0}`,
      )
    }

    const content = (message.content as Array<Record<string, unknown>> | undefined) ?? []
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type === "tool_use") {
        const name = (b.name as string) ?? "?"
        bump(stats.toolCalls, name)
        const input = (b.input as Record<string, unknown> | undefined) ?? {}
        if (name === "Agent" || name === "Task") {
          const sa = (input.subagent_type as string) ?? "<unknown>"
          bump(stats.delegations, sa)
          console.log(`[delegation] subagent_type=${sa}`)
          if (verbose) {
            console.log(`  description: ${trunc(String(input.description ?? ""), 200)}`)
            console.log(`  prompt:      ${trunc(String(input.prompt ?? ""), 400)}`)
          }
        } else if (name === "Bash") {
          const cmd = String(input.command ?? "").slice(0, verbose ? 240 : 80)
          console.log(`[tool] Bash: ${cmd}`)
        } else if (name === "Read" || name === "Glob" || name === "Grep") {
          const path = input.file_path ?? input.pattern ?? input.path
          console.log(`[tool] ${name}: ${path ?? ""}`)
          if (verbose) {
            console.log(`  input: ${trunc(JSON.stringify(input), 240)}`)
          }
        } else if (verbose) {
          console.log(`[tool] ${name}: ${trunc(JSON.stringify(input), 200)}`)
        }
      } else if (b.type === "text") {
        const text = String(b.text ?? "").trim()
        if (text.startsWith("SWARM_FAILED") || text.startsWith("MINION_FAILED")) {
          stats.swarmFailures += 1
          console.log(`[swarm_failed] ${text.slice(0, 120)}`)
        } else if (verbose && text) {
          console.log(`[text] ${trunc(text, 400)}`)
        }
      } else if (b.type === "thinking" && verbose) {
        const tt = String(b.thinking ?? "").trim()
        if (tt) console.log(`[thinking] ${trunc(tt, 400)}`)
      }
    }
    return
  }

  if (t === "result") {
    const usage = (m.usage as Record<string, number> | undefined) ?? {}
    if (usage) {
      console.log(
        `[result] total_tokens=${usage.input_tokens ?? 0}/${usage.output_tokens ?? 0} cache=${usage.cache_read_input_tokens ?? 0}r/${usage.cache_creation_input_tokens ?? 0}c`,
      )
    }
  }
}

function printSummary(
  args: Args,
  algorithm: SwarmAlgorithm,
  algoStats: AlgorithmStats,
  stats: Stats,
  logFile: string,
) {
  const totalDelegations = Object.values(stats.delegations).reduce((a, b) => a + b, 0)

  let totalIn = 0,
    totalOut = 0,
    totalCacheR = 0,
    totalCacheC = 0
  let haikuCalls = 0,
    haikuIn = 0
  for (const [m, v] of Object.entries(stats.modelTokens)) {
    totalIn += v.input
    totalOut += v.output
    totalCacheR += v.cacheRead
    totalCacheC += v.cacheCreate
    if (classifyModel(m) === "haiku") {
      haikuCalls += v.calls
      haikuIn += v.input
    }
  }

  console.log("\n" + "═".repeat(72))
  console.log(`SUMMARY  (label="${args.label}", algorithm=${algorithm.name})`)
  console.log("═".repeat(72))
  console.log(`Parent assistant messages: ${stats.parentMessages}`)
  console.log(`Total delegations:         ${totalDelegations}`)

  if (totalDelegations > 0) {
    console.log("  By subagent_type:")
    for (const [k, v] of Object.entries(stats.delegations).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(20)} ${v}`)
    }
  } else {
    console.log("  (no Task/Agent delegations issued)")
  }

  if (stats.swarmFailures > 0) {
    console.log(`MINION/SWARM_FAILED sentinels: ${stats.swarmFailures}`)
  }

  console.log("\nTool calls (parent + subagent combined):")
  for (const [name, count] of Object.entries(stats.toolCalls).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(20)} ${count}`)
  }

  console.log("\nModel usage:")
  for (const [model, m] of Object.entries(stats.modelTokens).sort(
    (a, b) => b[1].calls - a[1].calls,
  )) {
    console.log(
      `  ${model.padEnd(32)} calls=${m.calls.toString().padStart(3)} in=${m.input.toString().padStart(7)} out=${m.output.toString().padStart(6)} cache_r=${m.cacheRead.toString().padStart(7)} cache_c=${m.cacheCreate.toString().padStart(6)}`,
    )
  }

  console.log("\nAggregate:")
  console.log(
    `  total_input_tokens   ${totalIn}\n  total_output_tokens  ${totalOut}\n  total_cache_read     ${totalCacheR}\n  total_cache_create   ${totalCacheC}`,
  )
  console.log(`  haiku_calls=${haikuCalls}  haiku_input_tokens=${haikuIn}`)
  console.log(`  raw log: ${logFile}`)

  // Algorithm-specific stats lines (e.g. ACO pheromone summary).
  const algoLines = algorithm.formatStats?.(algoStats) ?? []
  if (algoLines.length > 0) {
    console.log("")
    for (const l of algoLines) console.log(l)
  }

  console.log("═".repeat(72))
  const verdict =
    algorithm.formatVerdict?.(algoStats) ??
    `${algorithm.name.toUpperCase()} run complete`
  console.log(`Verdict: ${verdict}`)
  console.log("═".repeat(72))
}

main().catch((err) => {
  console.error("[harness] fatal:", err)
  process.exit(1)
})

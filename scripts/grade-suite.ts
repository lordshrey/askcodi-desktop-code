#!/usr/bin/env bun
/**
 * Quality grader for swarm-suite results. Reads each cell's final
 * answer from its raw JSONL and asks a Haiku judge to score it 1-5
 * on four dimensions: relevance, specificity, accuracy, completeness.
 *
 * The judge has access to the codebase via Read/Glob/Grep so it can
 * verify factual claims. Outputs `<cell>.grade.json` next to each
 * `<cell>.summary.json`.
 *
 * Usage:
 *   bun run scripts/grade-suite.ts \
 *     --suite-dir test-runs/suite-XYZ \
 *     --cwd ~/path/to/codebase \
 *     [--algorithms aco,frontier] \
 *     [--concurrency 3]
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { basename, join } from "node:path"
import { findSystemClaude } from "../src/main/lib/claude/find-binary"
import { extractResultMetadata } from "../src/main/lib/swarm/suite/cell"
import type { CellSummary } from "../src/main/lib/swarm/suite/cell"

type Args = {
  suiteDir: string
  cwd: string
  algorithms?: Set<string>
  concurrency: number
  claudePath: string
  judgeModel: string
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    concurrency: 3,
    judgeModel: "claude-haiku-4-5-20251001",
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--suite-dir") out.suiteDir = next()
    else if (a === "--cwd") out.cwd = next()
    else if (a === "--concurrency") out.concurrency = Number(next())
    else if (a === "--algorithms")
      out.algorithms = new Set(next().split(",").map((s) => s.trim()).filter(Boolean))
    else if (a === "--claude") out.claudePath = next()
    else if (a === "--judge-model") out.judgeModel = next()
    else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      printHelp()
      process.exit(2)
    }
  }
  if (!out.suiteDir || !out.cwd) {
    console.error("Missing --suite-dir or --cwd.")
    printHelp()
    process.exit(2)
  }
  if (!existsSync(out.suiteDir!)) {
    console.error(`--suite-dir does not exist: ${out.suiteDir}`)
    process.exit(1)
  }
  if (!existsSync(out.cwd!)) {
    console.error(`--cwd does not exist: ${out.cwd}`)
    process.exit(1)
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
  console.log(`Usage:
  bun run scripts/grade-suite.ts --suite-dir <path> --cwd <codebase> [flags]

Required:
  --suite-dir <path>      Directory containing *.summary.json + *.jsonl
  --cwd <path>            Codebase the answers should be verified against

Flags:
  --algorithms <list>     Comma-separated filter (default: all)
  --concurrency <n>       Parallel grader calls (default 3)
  --claude <path>         claude binary (default: auto-detect)
  --judge-model <id>      Haiku model id (default: claude-haiku-4-5-20251001)`)
}

const JUDGE_PROMPT = `You are a code-search answer grader. The user asked a question about a codebase. Another model produced an answer. Your job: score the answer on four dimensions.

You have Read, Glob, and Grep tools. Use them to verify a few factual claims in the candidate answer. Don't be exhaustive — spot-check 2-3 claims that are easy to verify or look most likely to be wrong.

Scoring (1-5 on each dimension):

- **relevance**: does the answer address the question that was asked, or does it drift?
  1 = off-topic; 3 = mostly relevant with some drift; 5 = directly addresses every part of the question.

- **specificity**: does the answer cite concrete file paths, function names, or line numbers?
  1 = vague prose, no cites; 3 = some cites; 5 = every claim has a file:line reference.

- **accuracy**: do factual claims hold up against the codebase?
  1 = obvious errors; 3 = minor inaccuracies or unverified claims; 5 = every spot-checked claim was correct.

- **completeness**: does the answer cover the obvious areas the question implies?
  1 = misses the main thing; 3 = covers the core but skips important context; 5 = covers all natural sub-questions.

Return your grade as a single JSON object on its own line, nothing else, no markdown fences. Use this exact shape:

{"relevance":N,"specificity":N,"accuracy":N,"completeness":N,"justification":"one short sentence; mention the lowest-scored dimension if any score < 4, else 'all-good'"}`

type GradeResult = {
  queryId: string
  algorithm: string
  scores: {
    relevance: number
    specificity: number
    accuracy: number
    completeness: number
  }
  overall: number
  justification: string
  judgeModel: string
  judgeCostUsd?: number
  judgeDurationMs?: number
  judgedAt: string
}

/** Pull the final answer text from a cell's JSONL. Prefers result.result, else concatenates last assistant text blocks. */
function extractFinalAnswer(jsonlPath: string): string {
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean)
  // Walk backwards looking for the trailing result message first.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(lines[i]) as { type?: string; result?: string }
      if (m.type === "result" && typeof m.result === "string" && m.result.trim()) {
        return m.result
      }
    } catch {
      // skip malformed
    }
  }
  // Fallback: concat text blocks from the last assistant message we find.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const m = JSON.parse(lines[i]) as {
        type?: string
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        const parts = m.message!.content!
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text!)
        if (parts.length > 0) return parts.join("\n\n")
      }
    } catch {
      // skip malformed
    }
  }
  return ""
}

/** Try hard to extract a JSON object from a possibly-noisy text response. */
function parseJudgeJSON(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  // Try direct parse first.
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to brace-matching.
  }
  // Find the first '{' and matching '}'.
  const start = trimmed.indexOf("{")
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++
    else if (trimmed[i] === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(1, Math.min(5, Math.round(n)))
}

async function gradeCell(
  cell: CellSummary,
  jsonlPath: string,
  args: Args,
  sdk: { query: Function },
): Promise<GradeResult | null> {
  const answer = extractFinalAnswer(jsonlPath)
  if (!answer) {
    console.warn(
      `  [skip] ${cell.queryId} × ${cell.algorithm}: no answer text recoverable from ${basename(jsonlPath)}`,
    )
    return null
  }

  const userPrompt = `USER QUESTION:\n${cell.query}\n\nCANDIDATE ANSWER:\n${answer}`

  const collected: unknown[] = []
  const start = Date.now()

  try {
    const stream = sdk.query({
      prompt: userPrompt,
      options: {
        cwd: args.cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: args.claudePath,
        model: args.judgeModel,
        allowedTools: ["Read", "Glob", "Grep"],
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: JUDGE_PROMPT,
        },
      },
    })
    for await (const msg of stream) collected.push(msg)
  } catch (err) {
    console.error(
      `  [err]  ${cell.queryId} × ${cell.algorithm}: judge stream failed: ${(err as Error).message}`,
    )
    return null
  }

  // Pull the result message's answer text (the judge's JSON).
  let raw = ""
  for (let i = collected.length - 1; i >= 0; i--) {
    const m = collected[i] as { type?: string; result?: string }
    if (m.type === "result" && typeof m.result === "string") {
      raw = m.result
      break
    }
  }
  if (!raw) {
    // Fallback to last assistant text.
    for (let i = collected.length - 1; i >= 0; i--) {
      const m = collected[i] as {
        type?: string
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        raw = m.message!.content!
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n")
        if (raw) break
      }
    }
  }

  const parsed = parseJudgeJSON(raw)
  if (!parsed) {
    console.error(
      `  [err]  ${cell.queryId} × ${cell.algorithm}: judge returned non-JSON: ${raw.slice(0, 120)}`,
    )
    return null
  }

  const scores = {
    relevance: clamp(Number(parsed.relevance)),
    specificity: clamp(Number(parsed.specificity)),
    accuracy: clamp(Number(parsed.accuracy)),
    completeness: clamp(Number(parsed.completeness)),
  }
  const overall =
    (scores.relevance + scores.specificity + scores.accuracy + scores.completeness) /
    4
  const meta = extractResultMetadata(collected)

  return {
    queryId: cell.queryId,
    algorithm: cell.algorithm,
    scores,
    overall: Math.round(overall * 100) / 100,
    justification: typeof parsed.justification === "string" ? parsed.justification : "",
    judgeModel: args.judgeModel,
    judgeCostUsd: meta.totalCostUsd,
    judgeDurationMs: Date.now() - start,
    judgedAt: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const summaryFiles = readdirSync(args.suiteDir).filter((f) =>
    f.endsWith(".summary.json"),
  )
  const cellsToGrade: { cell: CellSummary; jsonlPath: string; gradePath: string }[] = []
  for (const f of summaryFiles) {
    const summaryPath = join(args.suiteDir, f)
    const cell = JSON.parse(readFileSync(summaryPath, "utf-8")) as CellSummary
    if (cell.errored) continue
    if (args.algorithms && !args.algorithms.has(cell.algorithm)) continue
    const jsonlPath = join(args.suiteDir, f.replace(".summary.json", ".jsonl"))
    const gradePath = join(args.suiteDir, f.replace(".summary.json", ".grade.json"))
    if (!existsSync(jsonlPath)) {
      console.warn(`  [skip] ${cell.queryId} × ${cell.algorithm}: no .jsonl alongside`)
      continue
    }
    if (existsSync(gradePath)) {
      console.log(`  [skip] ${cell.queryId} × ${cell.algorithm}: already graded`)
      continue
    }
    cellsToGrade.push({ cell, jsonlPath, gradePath })
  }

  console.log(`[grade] ${cellsToGrade.length} cells to grade`)
  console.log(`[grade] judge model: ${args.judgeModel}`)
  console.log(`[grade] codebase: ${args.cwd}`)
  console.log(`[grade] concurrency: ${args.concurrency}`)
  console.log("─".repeat(72))

  const sdk = await import("@anthropic-ai/claude-agent-sdk")

  // Workpool with bounded concurrency.
  let nextIndex = 0
  const grades: GradeResult[] = []
  async function worker() {
    while (true) {
      const myIndex = nextIndex++
      if (myIndex >= cellsToGrade.length) return
      const { cell, jsonlPath, gradePath } = cellsToGrade[myIndex]
      const grade = await gradeCell(cell, jsonlPath, args, sdk as { query: Function })
      if (grade) {
        writeFileSync(gradePath, JSON.stringify(grade, null, 2), "utf-8")
        grades.push(grade)
        const ms = grade.judgeDurationMs ?? 0
        const cost = grade.judgeCostUsd ?? 0
        console.log(
          `  [ok]   ${cell.queryId} × ${cell.algorithm.padEnd(13)} overall=${grade.overall.toFixed(2)} (R${grade.scores.relevance} S${grade.scores.specificity} A${grade.scores.accuracy} C${grade.scores.completeness}) ${(ms / 1000).toFixed(1)}s $${cost.toFixed(3)}`,
        )
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(args.concurrency, cellsToGrade.length) },
    () => worker(),
  )
  await Promise.all(workers)

  console.log("─".repeat(72))
  console.log(`[grade] done: ${grades.length}/${cellsToGrade.length} cells graded`)

  // Print algorithm-level averages.
  const byAlgo = new Map<string, GradeResult[]>()
  for (const g of grades) {
    if (!byAlgo.has(g.algorithm)) byAlgo.set(g.algorithm, [])
    byAlgo.get(g.algorithm)!.push(g)
  }
  console.log()
  console.log("Algorithm averages:")
  console.log("  algo          overall  R    S    A    C    cells")
  for (const [algo, gs] of [...byAlgo.entries()].sort()) {
    const avg = (sel: (g: GradeResult) => number) =>
      gs.reduce((s, g) => s + sel(g), 0) / gs.length
    const overall = avg((g) => g.overall)
    const r = avg((g) => g.scores.relevance)
    const s = avg((g) => g.scores.specificity)
    const a = avg((g) => g.scores.accuracy)
    const c = avg((g) => g.scores.completeness)
    console.log(
      `  ${algo.padEnd(13)} ${overall.toFixed(2)}     ${r.toFixed(1)}  ${s.toFixed(1)}  ${a.toFixed(1)}  ${c.toFixed(1)}    ${gs.length}`,
    )
  }
}

main().catch((err) => {
  console.error("[grade] fatal:", err)
  process.exit(1)
})

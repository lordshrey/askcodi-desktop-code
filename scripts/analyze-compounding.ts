#!/usr/bin/env bun
/**
 * Analyzer for the multi-session ACO compounding experiment.
 *
 * Reads the 14 JSONL files produced by aco-compounding.sh (7 queries × 2
 * arms) and produces a markdown report covering:
 *   - Per-query side-by-side: ACO vs baseline (tokens, models, delegations,
 *     tool calls, wall time, memory growth, final-answer first 200 chars)
 *   - Aggregate: total Opus tokens, total Haiku tokens, total wall time
 *   - Compounding signal: did per-query Opus tokens DROP across the ACO
 *     arm as memory grew? Plotted as a per-query trend.
 *   - Memory snapshot deltas between sessions (Q1 → Q7)
 *
 * Output: prints markdown to stdout. Pipe to a file or read directly.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join, basename } from "node:path"

type AssistantMsg = {
  type?: string
  message?: {
    role?: string
    model?: string
    content?: Array<{ type?: string; text?: string; name?: string; input?: any }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  timestamp?: string
}

type RunMetrics = {
  file: string
  arm: "aco" | "baseline"
  qid: string
  qlabel: string
  start_ts: string
  end_ts: string
  wall_time_s: number
  parent_msgs: number
  delegations: Record<string, number>
  total_tool_calls: Record<string, number>
  models: Record<string, { calls: number; in: number; out: number; cache_r: number; cache_c: number }>
  final_text_preview: string
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read: number
  total_cache_create: number
  haiku_calls: number
  opus_calls: number
  opus_share_pct: number
}

const TEST_RUNS_DIR = join(process.cwd(), "test-runs")
const SNAPSHOT_DIR = join(TEST_RUNS_DIR, "_aco-snapshots")

function parseRunFile(filePath: string): RunMetrics {
  const base = basename(filePath, ".jsonl")
  // Expected label form: cmp-<arm>-<qid>-<qlabel>
  // The file prefix is `2026-04-XXX-cmp-...`
  const labelMatch = base.match(/cmp-(aco|baseline)-(Q\d+)-([\w-]+)$/)
  const arm = (labelMatch?.[1] ?? "baseline") as "aco" | "baseline"
  const qid = labelMatch?.[2] ?? "?"
  const qlabel = labelMatch?.[3] ?? "?"

  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean)

  let startTs = ""
  let endTs = ""
  let parentMsgs = 0
  const delegations: Record<string, number> = {}
  const toolCalls: Record<string, number> = {}
  const models: RunMetrics["models"] = {}
  let finalText = ""

  for (const line of lines) {
    let outer: { timestamp?: string; data?: AssistantMsg }
    try {
      outer = JSON.parse(line)
    } catch {
      continue
    }
    const ts = outer.timestamp
    if (ts) {
      if (!startTs) startTs = ts
      endTs = ts
    }
    const d = outer.data ?? (outer as unknown as AssistantMsg)
    if (!d) continue
    if (d.type === "assistant") {
      parentMsgs += 1
      const msg = d.message
      const model = msg?.model ?? ""
      const usage = msg?.usage ?? {}
      if (model) {
        const m = (models[model] ??= {
          calls: 0,
          in: 0,
          out: 0,
          cache_r: 0,
          cache_c: 0,
        })
        m.calls += 1
        m.in += usage.input_tokens ?? 0
        m.out += usage.output_tokens ?? 0
        m.cache_r += usage.cache_read_input_tokens ?? 0
        m.cache_c += usage.cache_creation_input_tokens ?? 0
      }
      for (const block of msg?.content ?? []) {
        if (block?.type === "tool_use") {
          toolCalls[block.name ?? "?"] = (toolCalls[block.name ?? "?"] ?? 0) + 1
          if (block.name === "Agent" || block.name === "Task") {
            const sa = block.input?.subagent_type ?? "?"
            delegations[sa] = (delegations[sa] ?? 0) + 1
          }
        } else if (block?.type === "text" && typeof block.text === "string") {
          // Last assistant text wins as the "final answer"
          finalText = block.text
        }
      }
    }
  }

  let wall = 0
  if (startTs && endTs) {
    wall = (new Date(endTs).getTime() - new Date(startTs).getTime()) / 1000
  }

  let totalIn = 0,
    totalOut = 0,
    totalCacheR = 0,
    totalCacheC = 0
  let haikuCalls = 0,
    opusCalls = 0
  for (const [m, v] of Object.entries(models)) {
    totalIn += v.in
    totalOut += v.out
    totalCacheR += v.cache_r
    totalCacheC += v.cache_c
    if (m.includes("haiku")) haikuCalls += v.calls
    else if (m.includes("opus")) opusCalls += v.calls
  }
  const totalCalls = haikuCalls + opusCalls
  const opusShare = totalCalls > 0 ? Math.round((100 * opusCalls) / totalCalls) : 0

  return {
    file: base + ".jsonl",
    arm,
    qid,
    qlabel,
    start_ts: startTs,
    end_ts: endTs,
    wall_time_s: Math.round(wall * 10) / 10,
    parent_msgs: parentMsgs,
    delegations,
    total_tool_calls: toolCalls,
    models,
    final_text_preview: finalText.slice(0, 250).replace(/\n/g, " "),
    total_input_tokens: totalIn,
    total_output_tokens: totalOut,
    total_cache_read: totalCacheR,
    total_cache_create: totalCacheC,
    haiku_calls: haikuCalls,
    opus_calls: opusCalls,
    opus_share_pct: opusShare,
  }
}

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function loadSnapshots(): { qid: string; fileCount: number; topFiles: string[] }[] {
  if (!existsSync(SNAPSHOT_DIR)) return []
  const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json"))
  files.sort()
  return files.map((f) => {
    const qid = f.replace(/^after-/, "").replace(/\.json$/, "")
    const data = JSON.parse(readFileSync(join(SNAPSHOT_DIR, f), "utf-8"))
    const filesObj = data.files ?? {}
    const top = Object.entries(filesObj)
      .sort(
        ([, a]: any, [, b]: any) => (b.priority ?? 0) - (a.priority ?? 0),
      )
      .slice(0, 5)
      .map(([p]) => p)
    return { qid, fileCount: Object.keys(filesObj).length, topFiles: top }
  })
}

function main() {
  // Find all cmp-* JSONLs
  const allFiles = readdirSync(TEST_RUNS_DIR)
    .filter((f) => /cmp-(aco|baseline)-Q\d+/.test(f))
    .map((f) => join(TEST_RUNS_DIR, f))
    .filter((p) => statSync(p).isFile())

  if (allFiles.length === 0) {
    console.error("No cmp-* run files found in test-runs/. Run aco-compounding.sh first.")
    process.exit(1)
  }

  const runs = allFiles.map(parseRunFile)
  // Group by qid; want { qid, aco, baseline } per row
  const byQid: Record<string, { aco?: RunMetrics; baseline?: RunMetrics }> = {}
  for (const r of runs) {
    byQid[r.qid] ??= {}
    byQid[r.qid][r.arm] = r
  }
  const qids = Object.keys(byQid).sort()

  const snapshots = loadSnapshots()

  // ── Markdown report ────────────────────────────────────────────────────
  const out: string[] = []
  out.push("# ACO Compounding Experiment — Analytics Report")
  out.push("")
  out.push(`Runs analyzed: ${runs.length} (${qids.length} queries × 2 arms)`)
  out.push(`Generated: ${new Date().toISOString()}`)
  out.push("")

  // Per-query comparison table
  out.push("## Per-query comparison")
  out.push("")
  out.push("| QID | Query | Arm | Wall (s) | Opus calls | Haiku calls | Opus % | Total tokens (in/out) | Cache reads | Delegations | Final answer first 100 chars |")
  out.push("|-----|-------|-----|----------|------------|-------------|--------|----------------------|-------------|-------------|-------------------------------|")
  for (const qid of qids) {
    const pair = byQid[qid]
    const qlabel = pair.aco?.qlabel ?? pair.baseline?.qlabel ?? "?"
    for (const arm of ["aco", "baseline"] as const) {
      const r = pair[arm]
      if (!r) {
        out.push(`| ${qid} | ${qlabel} | ${arm} | — | — | — | — | — | — | — | — |`)
        continue
      }
      const dels = Object.entries(r.delegations).map(([k, v]) => `${k}:${v}`).join(", ") || "(none)"
      out.push(
        `| ${qid} | ${qlabel} | **${arm}** | ${r.wall_time_s} | ${r.opus_calls} | ${r.haiku_calls} | ${r.opus_share_pct}% | ${fmtNum(r.total_input_tokens)} / ${fmtNum(r.total_output_tokens)} | ${fmtNum(r.total_cache_read)} | ${dels} | ${r.final_text_preview.slice(0, 100).replace(/\|/g, "\\|")} |`,
      )
    }
  }
  out.push("")

  // Aggregate by arm
  out.push("## Aggregate by arm")
  out.push("")
  const armTotals: Record<string, { runs: number; wall: number; opus: number; haiku: number; tokIn: number; tokOut: number; cacheR: number; cacheC: number }> = {}
  for (const r of runs) {
    const a = (armTotals[r.arm] ??= { runs: 0, wall: 0, opus: 0, haiku: 0, tokIn: 0, tokOut: 0, cacheR: 0, cacheC: 0 })
    a.runs += 1
    a.wall += r.wall_time_s
    a.opus += r.opus_calls
    a.haiku += r.haiku_calls
    a.tokIn += r.total_input_tokens
    a.tokOut += r.total_output_tokens
    a.cacheR += r.total_cache_read
    a.cacheC += r.total_cache_create
  }
  out.push("| Arm | Runs | Wall (s) | Opus calls | Haiku calls | Tokens (in/out) | Cache reads | Cache creates |")
  out.push("|-----|------|----------|------------|-------------|-----------------|-------------|---------------|")
  for (const arm of ["aco", "baseline"] as const) {
    const a = armTotals[arm]
    if (!a) continue
    out.push(
      `| **${arm}** | ${a.runs} | ${a.wall.toFixed(1)} | ${a.opus} | ${a.haiku} | ${fmtNum(a.tokIn)} / ${fmtNum(a.tokOut)} | ${fmtNum(a.cacheR)} | ${fmtNum(a.cacheC)} |`,
    )
  }
  out.push("")

  // Cross-arm deltas
  if (armTotals.aco && armTotals.baseline) {
    out.push("### Deltas (ACO vs baseline)")
    out.push("")
    const opusDelta = armTotals.aco.opus - armTotals.baseline.opus
    const opusDeltaPct = armTotals.baseline.opus > 0 ? Math.round((100 * opusDelta) / armTotals.baseline.opus) : 0
    const haikuDelta = armTotals.aco.haiku - armTotals.baseline.haiku
    const haikuDeltaPct = armTotals.baseline.haiku > 0 ? Math.round((100 * haikuDelta) / armTotals.baseline.haiku) : 0
    const wallDelta = armTotals.aco.wall - armTotals.baseline.wall
    const wallDeltaPct = armTotals.baseline.wall > 0 ? Math.round((100 * wallDelta) / armTotals.baseline.wall) : 0
    out.push(`- **Opus calls:** ACO=${armTotals.aco.opus} vs baseline=${armTotals.baseline.opus} → ${opusDelta >= 0 ? "+" : ""}${opusDelta} (${opusDeltaPct >= 0 ? "+" : ""}${opusDeltaPct}%)`)
    out.push(`- **Haiku calls:** ACO=${armTotals.aco.haiku} vs baseline=${armTotals.baseline.haiku} → ${haikuDelta >= 0 ? "+" : ""}${haikuDelta} (${haikuDeltaPct >= 0 ? "+" : ""}${haikuDeltaPct}%)`)
    out.push(`- **Wall time:** ACO=${armTotals.aco.wall.toFixed(1)}s vs baseline=${armTotals.baseline.wall.toFixed(1)}s → ${wallDelta >= 0 ? "+" : ""}${wallDelta.toFixed(1)}s (${wallDeltaPct >= 0 ? "+" : ""}${wallDeltaPct}%)`)
    out.push(`- **Tokens in:** ACO=${fmtNum(armTotals.aco.tokIn)} vs baseline=${fmtNum(armTotals.baseline.tokIn)}`)
    out.push(`- **Cache reads:** ACO=${fmtNum(armTotals.aco.cacheR)} vs baseline=${fmtNum(armTotals.baseline.cacheR)}`)
    out.push("")
  }

  // Compounding signal — ACO per-query trend
  out.push("## Compounding signal (ACO arm only)")
  out.push("")
  out.push("Does Opus-call count drop as memory accumulates? Q1 should be cold; Q7 should benefit most from priors built up by Q2/Q6.")
  out.push("")
  out.push("| QID | Query | Opus calls | Haiku calls | Total tool calls | Wall (s) | Memory size after run |")
  out.push("|-----|-------|------------|-------------|------------------|----------|----------------------|")
  for (const qid of qids) {
    const r = byQid[qid].aco
    if (!r) continue
    const totalTools = Object.values(r.total_tool_calls).reduce((a, b) => a + b, 0)
    const snap = snapshots.find((s) => s.qid === qid)
    const memSize = snap ? `${snap.fileCount} files` : "n/a"
    out.push(
      `| ${qid} | ${r.qlabel} | ${r.opus_calls} | ${r.haiku_calls} | ${totalTools} | ${r.wall_time_s} | ${memSize} |`,
    )
  }
  out.push("")

  if (snapshots.length > 0) {
    out.push("### Memory growth across ACO sessions")
    out.push("")
    out.push("| After QID | Files in memory | Top 5 by priority |")
    out.push("|-----------|-----------------|-------------------|")
    for (const s of snapshots) {
      out.push(`| ${s.qid} | ${s.fileCount} | ${s.topFiles.map((f) => `\`${f}\``).join(", ")} |`)
    }
    out.push("")
  }

  // Per-query final answer side-by-side
  out.push("## Final-answer quality side-by-side")
  out.push("")
  out.push("First 250 chars of the model's final text per query. Subjective quality eyeball.")
  out.push("")
  for (const qid of qids) {
    const pair = byQid[qid]
    const qlabel = pair.aco?.qlabel ?? pair.baseline?.qlabel
    out.push(`### ${qid} ${qlabel}`)
    out.push("")
    if (pair.aco) {
      out.push(`**ACO:** ${pair.aco.final_text_preview || "(no text)"}`)
      out.push("")
    }
    if (pair.baseline) {
      out.push(`**Baseline:** ${pair.baseline.final_text_preview || "(no text)"}`)
      out.push("")
    }
  }

  console.log(out.join("\n"))
}

main()

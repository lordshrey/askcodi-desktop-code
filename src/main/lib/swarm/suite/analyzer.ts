/**
 * Analyzer: turn an array of CellSummary records into a markdown report
 * comparing algorithms across the same query set.
 *
 * Pure — takes summaries in, returns a markdown string. The caller
 * (scripts/analyze-swarm-suite.ts) handles disk IO.
 */
import { totalTokens, type CellSummary } from "./cell"

export type ReportOptions = {
  /** Optional title for the report. Defaults to "Swarm suite report". */
  title?: string
  /** Suite identifier (timestamp, label, etc.). Shown in the header. */
  suiteId?: string
}

type Cell = CellSummary

function cmpQueryId(a: string, b: string): number {
  // Sort Q1 < Q2 < Q10 numerically when possible, lexicographically otherwise.
  const am = a.match(/^Q(\d+)$/)
  const bm = b.match(/^Q(\d+)$/)
  if (am && bm) return Number(am[1]) - Number(bm[1])
  return a.localeCompare(b)
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function pickAlgos(cells: Cell[]): string[] {
  const algos = new Set<string>()
  for (const c of cells) algos.add(c.algorithm)
  return [...algos].sort()
}

function pickQueries(cells: Cell[]): { id: string; text: string }[] {
  const map = new Map<string, string>()
  for (const c of cells) {
    if (!map.has(c.queryId)) map.set(c.queryId, c.query)
  }
  return [...map.entries()]
    .sort((a, b) => cmpQueryId(a[0], b[0]))
    .map(([id, text]) => ({ id, text }))
}

/** Cross-tabulate cells: cells[queryId][algorithm] = CellSummary. */
function indexCells(cells: Cell[]): Map<string, Map<string, Cell>> {
  const out = new Map<string, Map<string, Cell>>()
  for (const c of cells) {
    if (!out.has(c.queryId)) out.set(c.queryId, new Map())
    out.get(c.queryId)!.set(c.algorithm, c)
  }
  return out
}

function row(cells: (string | number)[]): string {
  return `| ${cells.map((c) => String(c)).join(" | ")} |`
}

function header(cols: string[]): string {
  return `${row(cols)}\n${row(cols.map(() => "---"))}`
}

function sectionLatency(
  algos: string[],
  queries: { id: string; text: string }[],
  index: Map<string, Map<string, Cell>>,
): string {
  const lines = ["## Wall-clock latency", "", header(["Query", ...algos])]
  for (const q of queries) {
    const cells = algos.map((a) => {
      const c = index.get(q.id)?.get(a)
      if (!c) return "—"
      if (c.errored) return "ERR"
      return fmtMs(c.durationMs)
    })
    lines.push(row([q.id, ...cells]))
  }
  return lines.join("\n")
}

function sectionTokens(
  algos: string[],
  queries: { id: string; text: string }[],
  index: Map<string, Map<string, Cell>>,
): string {
  const lines = ["## Token usage (input + output, all models)", "", header(["Query", ...algos])]
  for (const q of queries) {
    const cells = algos.map((a) => {
      const c = index.get(q.id)?.get(a)
      if (!c || c.errored) return c?.errored ? "ERR" : "—"
      const t = totalTokens(c.modelTokens)
      return `${fmtNum(t.input + t.output)}`
    })
    lines.push(row([q.id, ...cells]))
  }
  return lines.join("\n")
}

function sectionCostUSD(
  algos: string[],
  queries: { id: string; text: string }[],
  index: Map<string, Map<string, Cell>>,
): string | null {
  // Only render if at least one cell has a CC-reported cost.
  let anyCost = false
  for (const c of [...index.values()].flatMap((m) => [...m.values()])) {
    if (typeof c.totalCostUsd === "number") {
      anyCost = true
      break
    }
  }
  if (!anyCost) return null

  const lines = [
    "## Cost (USD, reported by Claude Code)",
    "",
    "Direct from `result.total_cost_usd`. Sum across all models in the session.",
    "",
    header(["Query", ...algos]),
  ]
  for (const q of queries) {
    const cells = algos.map((a) => {
      const c = index.get(q.id)?.get(a)
      if (!c) return "—"
      if (c.errored) return "ERR"
      if (typeof c.totalCostUsd !== "number") return "—"
      return `$${c.totalCostUsd.toFixed(2)}`
    })
    lines.push(row([q.id, ...cells]))
  }
  // Per-algorithm totals row.
  const totals = algos.map((a) => {
    let sum = 0
    let any = false
    for (const q of queries) {
      const c = index.get(q.id)?.get(a)
      if (c && typeof c.totalCostUsd === "number") {
        sum += c.totalCostUsd
        any = true
      }
    }
    return any ? `**$${sum.toFixed(2)}**` : "—"
  })
  lines.push(row(["**Total**", ...totals]))
  return lines.join("\n")
}

function sectionHaikuShare(
  algos: string[],
  queries: { id: string; text: string }[],
  index: Map<string, Map<string, Cell>>,
): string {
  const lines = [
    "## Haiku share of token spend",
    "",
    "Higher = more work pushed to Haiku minions, less to Opus parent. The cost-control bet.",
    "",
    header(["Query", ...algos]),
  ]
  for (const q of queries) {
    const cells = algos.map((a) => {
      const c = index.get(q.id)?.get(a)
      if (!c || c.errored) return c?.errored ? "ERR" : "—"
      const t = totalTokens(c.modelTokens)
      const all = t.input + t.output
      if (all === 0) return "0%"
      const haiku = t.byClass.haiku.input + t.byClass.haiku.output
      return `${Math.round((haiku / all) * 100)}%`
    })
    lines.push(row([q.id, ...cells]))
  }
  return lines.join("\n")
}

function sectionFailures(
  algos: string[],
  queries: { id: string; text: string }[],
  index: Map<string, Map<string, Cell>>,
): string {
  const lines = [
    "## Failures (MINION_FAILED / SWARM_FAILED sentinels + cell errors)",
    "",
    header(["Query", ...algos]),
  ]
  let any = false
  for (const q of queries) {
    const cells = algos.map((a) => {
      const c = index.get(q.id)?.get(a)
      if (!c) return "—"
      if (c.errored) {
        any = true
        return `ERR(${c.errorMessage?.slice(0, 30) ?? "?"})`
      }
      if (c.swarmFailures > 0) {
        any = true
        return String(c.swarmFailures)
      }
      return "0"
    })
    lines.push(row([q.id, ...cells]))
  }
  if (!any) lines.push("\n_All cells succeeded with no minion-failure sentinels._")
  return lines.join("\n")
}

function sectionVerdicts(
  algos: string[],
  queries: { id: string; text: string }[],
  index: Map<string, Map<string, Cell>>,
): string {
  const lines = ["## Algorithm verdicts (one-line per cell)", ""]
  for (const q of queries) {
    lines.push(`### ${q.id}`)
    lines.push(`> ${q.text}`)
    lines.push("")
    for (const a of algos) {
      const c = index.get(q.id)?.get(a)
      if (!c) {
        lines.push(`- **${a}**: —`)
        continue
      }
      if (c.errored) {
        lines.push(`- **${a}**: ERROR — ${c.errorMessage ?? "?"}`)
        continue
      }
      // Render compact algorithmStats summary.
      const compact = JSON.stringify(c.algorithmStats)
      lines.push(`- **${a}**: ${fmtMs(c.durationMs)}, ${c.parentMessages} parent msgs — \`${compact.slice(0, 120)}${compact.length > 120 ? "…" : ""}\``)
    }
    lines.push("")
  }
  return lines.join("\n")
}

export function renderReport(
  cells: Cell[],
  options: ReportOptions = {},
): string {
  const title = options.title ?? "Swarm suite report"
  const algos = pickAlgos(cells)
  const queries = pickQueries(cells)
  const index = indexCells(cells)

  if (algos.length === 0 || queries.length === 0) {
    return `# ${title}\n\n_No cells in this suite._\n`
  }

  const header = [
    `# ${title}`,
    "",
    options.suiteId ? `Suite: \`${options.suiteId}\`` : "",
    `Algorithms: ${algos.join(", ")}`,
    `Queries: ${queries.length}`,
    `Cells: ${cells.length}`,
    "",
  ]
    .filter(Boolean)
    .join("\n")

  const costSection = sectionCostUSD(algos, queries, index)
  return [
    header,
    sectionLatency(algos, queries, index),
    "",
    ...(costSection ? [costSection, ""] : []),
    sectionTokens(algos, queries, index),
    "",
    sectionHaikuShare(algos, queries, index),
    "",
    sectionFailures(algos, queries, index),
    "",
    sectionVerdicts(algos, queries, index),
  ].join("\n")
}

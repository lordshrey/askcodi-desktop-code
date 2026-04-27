/**
 * ACO (Ant Colony Optimization) orchestrator with stigmergic memory.
 *
 * Wraps a single SDK query with persistent per-codebase memory at
 * `<projectRoot>/.askcodi/memory.json`. Each session reads it on entry,
 * writes it on exit. The "pheromone" is a per-file priority that decays
 * each session and bumps when a file participates in answering a query.
 *
 * Architectural rule: orchestrator stays on the parent driver (Opus),
 * minions are forced to Haiku via `agents` overrides + a canUseTool
 * guard. See haiku-minions.ts.
 *
 * The SDK call is dependency-injected so tests can mock the stream.
 */
import { resolve as resolvePath } from "node:path"
import {
  applyDecay,
  bumpFile,
  buildPriorsBlock,
  loadMemory,
  pruneMemory,
  recordSession,
  saveMemory,
  type PheromoneMemory,
} from "./aco-memory"
import {
  buildHaikuMinions,
  evaluateHaikuMinionGuard,
} from "../haiku-minions"
import { buildBaseSdkOptions } from "../sdk-options"
import type {
  AlgorithmResult,
  AlgorithmRunOptions,
  AlgorithmStats,
  SwarmAlgorithm,
} from "./algorithm"

export type RunAcoOptions = AlgorithmRunOptions & {
  /** Append to the SDK system prompt alongside the ACO priors block. */
  systemPromptAppend?: string
  /** Override pheromone decay rate (default 0.95). */
  decayRate?: number
  /** Override per-file bump (default 0.15). */
  bumpAmount?: number
}

export type AcoStats = {
  warm_start: boolean
  prior_session_count: number
  files_at_start: number
  files_at_end: number
  files_bumped: number
  priors_injected: boolean
  priors_paths: string[]
}

/** Loose regex for project-relative file paths. Tuned for common code/doc extensions; a few false positives (e.g. `foo.ts` from `foo.ts.bak`) are acceptable noise — they decay if they don't recur. */
const FILE_PATH_RE =
  /(?:^|[\s,()`'"])([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|md|yml|yaml|json|toml|css|scss|html|sh|sql))(?=[\s,():.`'"]|$)/g

/** Path segments that signal build artifacts or vendored deps; never useful as pheromone signal. */
const PATH_BLOCKLIST = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".git/",
  ".next/",
  ".cache/",
  ".turbo/",
  "target/",
  "__pycache__/",
  "venv/",
  ".venv/",
  "vendor/",
  "coverage/",
]

function isBlockedPath(p: string): boolean {
  if (!p || p.trim() === "") return true
  if (p === "/") return true
  for (const blocked of PATH_BLOCKLIST) {
    if (p.includes(blocked)) return true
    if (p === blocked.replace(/\/$/, "")) return true
  }
  return false
}

/**
 * Convert an absolute or already-relative file path into a project-
 * relative POSIX-style path. Falls through unchanged if the path doesn't
 * appear to belong to this project — better to keep noise than silently
 * drop signal.
 */
export function toProjectRelative(filePath: string, projectRoot: string): string {
  if (!filePath) return filePath
  const stripped = stripPrefix(filePath, projectRoot)
  if (stripped !== filePath) return stripped.replace(/\\/g, "/")
  // Symlinks may make filePath start with the resolved root instead.
  const resolvedRoot = resolvePath(projectRoot)
  if (resolvedRoot !== projectRoot) {
    const stripped2 = stripPrefix(filePath, resolvedRoot)
    if (stripped2 !== filePath) return stripped2.replace(/\\/g, "/")
  }
  return filePath
}

function stripPrefix(filePath: string, root: string): string {
  if (!filePath.startsWith(root)) return filePath
  let rel = filePath.slice(root.length)
  if (rel.startsWith("/")) rel = rel.slice(1)
  return rel
}

/** Extract file paths embedded in a string (Grep results, model answer text). */
function extractPathsFromText(s: string, projectRoot: string): string[] {
  if (!s) return []
  const out: string[] = []
  let m: RegExpExecArray | null
  FILE_PATH_RE.lastIndex = 0
  while ((m = FILE_PATH_RE.exec(s)) !== null) {
    const p = m[1]
    if (/^https?:/.test(p)) continue
    const rel = toProjectRelative(p, projectRoot)
    if (isBlockedPath(rel)) continue
    out.push(rel)
  }
  return out
}

/**
 * Walk the SDK message stream and pull file paths from three sources:
 * (1) tool_use args, (2) tool_result content (Grep matches), (3) final
 * assistant text blocks (model citing files in its answer). Returns
 * the unique set of project-relative paths.
 */
export function collectTouchedFiles(
  messages: Iterable<unknown>,
  projectRoot: string,
): Set<string> {
  const touched = new Set<string>()
  for (const msg of messages) {
    const m = msg as {
      type?: string
      message?: { role?: string; content?: unknown[] }
    }
    const role = m.type ?? m.message?.role
    const content = m.message?.content ?? []

    if (role === "assistant") {
      for (const block of content) {
        const b = block as {
          type?: string
          name?: string
          input?: Record<string, unknown>
          text?: string
        }
        if (b.type === "tool_use") {
          const fp = b.input?.file_path
          const pa = b.input?.path
          let candidate: string | null = null
          if (typeof fp === "string" && fp) candidate = fp
          else if (typeof pa === "string" && pa) candidate = pa
          if (candidate) {
            const rel = toProjectRelative(candidate, projectRoot)
            if (!isBlockedPath(rel)) touched.add(rel)
          }
        } else if (b.type === "text" && typeof b.text === "string") {
          for (const p of extractPathsFromText(b.text, projectRoot)) {
            touched.add(p)
          }
        }
      }
    } else if (role === "user") {
      for (const block of content) {
        const b = block as { type?: string; content?: unknown }
        if (b.type !== "tool_result") continue
        let raw = ""
        if (typeof b.content === "string") {
          raw = b.content
        } else if (Array.isArray(b.content)) {
          for (const c of b.content) {
            const t = (c as { text?: string }).text
            if (typeof t === "string") raw += t + "\n"
          }
        }
        for (const p of extractPathsFromText(raw, projectRoot)) {
          touched.add(p)
        }
      }
    }
  }
  return touched
}

function buildSystemPrompt(
  acoPriors: string | null,
  baseAppend?: string,
): { type: "preset"; preset: "claude_code"; append?: string } {
  const parts: string[] = []
  if (baseAppend) parts.push(baseAppend.trim())
  if (acoPriors) parts.push(acoPriors)
  const append = parts.join("\n\n")
  return {
    type: "preset",
    preset: "claude_code",
    append: append || undefined,
  }
}

export type RunAcoResult = AlgorithmResult & {
  acoStats: AcoStats
  memory: PheromoneMemory
}

/**
 * Single ACO-orchestrated query. The swarm intelligence is in the
 * persistent memory across sessions, not in spawning multiple subagents
 * within this session.
 */
export async function runAco(
  query: string,
  options: RunAcoOptions,
): Promise<RunAcoResult> {
  const decayRate = options.decayRate ?? 0.95
  const bumpAmount = options.bumpAmount ?? 0.15

  const memory = loadMemory(options.cwd)
  const warmStart = memory.session_count > 0
  const filesAtStart = Object.keys(memory.files).length

  applyDecay(memory, decayRate)

  const { block: priors, paths: priorsPaths } = buildPriorsBlock(memory)
  const systemPrompt = buildSystemPrompt(priors, options.systemPromptAppend)

  const haikuAgents = buildHaikuMinions()
  const collected: unknown[] = []
  const stream = options.sdkQuery({
    prompt: query,
    options: {
      ...buildBaseSdkOptions(options),
      agents: haikuAgents as unknown as Record<string, unknown>,
      systemPrompt,
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>,
      ) => {
        const denied = evaluateHaikuMinionGuard(toolName, toolInput)
        if (denied) return denied
        return { behavior: "allow" as const }
      },
    },
  })
  for await (const msg of stream) {
    collected.push(msg)
    options.onMessage?.(msg)
  }

  const touched = collectTouchedFiles(collected, options.cwd)
  for (const path of touched) bumpFile(memory, path, bumpAmount)

  pruneMemory(memory)
  recordSession(memory)
  saveMemory(memory)

  const acoStats: AcoStats = {
    warm_start: warmStart,
    prior_session_count: memory.session_count - 1,
    files_at_start: filesAtStart,
    files_at_end: Object.keys(memory.files).length,
    files_bumped: touched.size,
    priors_injected: priors !== null,
    priors_paths: priorsPaths,
  }

  return {
    messages: collected,
    stats: acoStats as AlgorithmStats,
    acoStats,
    memory,
  }
}

function formatAcoStats(stats: AlgorithmStats): string[] {
  const s = stats as AcoStats
  const lines = [
    "ACO pheromone memory:",
    `  start: ${s.warm_start ? "WARM" : "COLD"} (${s.prior_session_count} prior sessions)`,
    `  files tracked: ${s.files_at_start} → ${s.files_at_end}`,
    `  files bumped this session: ${s.files_bumped}`,
    `  priors injected into system prompt: ${s.priors_injected ? "YES" : "no (cold start)"}`,
  ]
  if (s.priors_injected) {
    lines.push("  top priors shown to parent:")
    for (const p of s.priors_paths) lines.push(`    - ${p}`)
  }
  return lines
}

function formatAcoVerdict(stats: AlgorithmStats): string {
  const s = stats as AcoStats
  return s.warm_start
    ? `ACO WARM (${s.prior_session_count} prior sessions, ${s.files_bumped} files bumped this run, priors=${s.priors_injected ? "ON" : "off"})`
    : `ACO COLD START (no prior memory; ${s.files_bumped} files seeded)`
}

export const acoAlgorithm: SwarmAlgorithm = {
  name: "aco",
  description:
    "Ant Colony Optimization: persistent .askcodi/memory.json pheromone trail per project, injected as priors. Memory compounds across sessions on the same codebase.",
  run: (query, options) => runAco(query, options),
  formatStats: formatAcoStats,
  formatVerdict: formatAcoVerdict,
}

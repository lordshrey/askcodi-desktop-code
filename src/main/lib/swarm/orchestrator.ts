/**
 * Opus orchestration helpers.
 *
 * Two layers, picked depending on call site:
 *
 * 1. createOpusObserver(ctx) — for production. Returns the building
 *    blocks (canUseToolGuard, observeMessage, result()) that an
 *    algorithm's prepare() composes into an AlgorithmAugmentation. The
 *    runtime (claude.ts) owns the sdk.query() call; the observer just
 *    watches the stream and bumps the ledger.
 *
 * 2. runOpusOrchestrated(opts) — for the suite runner harness. Wraps
 *    sdk.query() AND the observer in one call, since the suite runner
 *    has no separate runtime layer to compose into.
 *
 * Both share the same observation logic (observeMessage), so changes to
 * file-touch attribution or delegation tracking apply to both at once.
 */
import {
  appendDelegation,
  bumpFile,
  DEFAULT_BUMP,
  type DelegationRecord,
  type Ledger,
} from "./ledger"
import {
  isBlockedPath,
  extractPathsFromText,
  toProjectRelative,
} from "./path-utils"
import { buildBaseSdkOptions } from "./sdk-options"
import type {
  AlgorithmRunOptions,
  DenyVerdict,
  SdkQueryFn,
} from "./algorithms/algorithm"
import type { SwarmAgentDefinition } from "./types"

/** Tool names that count as a delegation. The SDK has called both depending on version. */
const TASK_TOOL_NAMES = new Set(["Task", "Agent"])

/** Tool names whose inputs reference files we should attribute. */
const FILE_TOUCH_TOOL_NAMES = new Set(["Read", "Glob", "Grep"])

export type RunOpusOrchestratedOptions = AlgorithmRunOptions & {
  /** User query passed verbatim to sdk.query(). */
  query: string
  /** Algorithm name (recorded in DelegationRecord.algorithm). */
  algorithm: string
  /** Haiku subagent definitions — Opus calls Task(subagent_type=...) to invoke them. */
  agents: Record<string, SwarmAgentDefinition>
  /** Subagent types Opus is allowed to delegate to. Other names get denied. */
  allowedSubagents: Set<string>
  /** Appended to the system prompt (priors block + algorithm coordination guidance). */
  systemPromptAppend?: string
  /** Ledger — the orchestrator reads it for priors and writes delegation records on close. */
  ledger: Ledger
  /** Optional override session id (otherwise pulled from system/init). */
  sessionId?: string
  /** Per-touch priority bump amount. Default DEFAULT_BUMP from ledger.ts. */
  bumpAmount?: number
}

export type OpusOrchestrationResult = {
  /** Full SDK message stream collected in order (suite runner only). */
  messages: unknown[]
  /** DelegationRecords closed during this run, in completion order. */
  delegations: DelegationRecord[]
  /** Unique project-relative paths touched anywhere this session. */
  filesTouched: Set<string>
  /** Whether at least one delegation closed with the MINION_FAILED sentinel. */
  anyMinionFailed: boolean
}

type OpenDelegation = {
  toolUseId: string
  subagentType: string
  prompt: string
  startedAtMs: number
  filesTouched: Set<string>
}

function extractPathFromInput(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  const fp = input.file_path
  if (typeof fp === "string" && fp) return fp
  const pa = input.path
  if (typeof pa === "string" && pa) return pa
  return null
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const c of content) {
    const t = (c as { text?: string }).text
    if (typeof t === "string") out += t + "\n"
  }
  return out
}

/** True if the result text starts with the MINION_FAILED sentinel (or legacy SWARM_FAILED). */
function isFailureText(text: string): boolean {
  const trimmed = text.trimStart()
  return (
    trimmed.startsWith("MINION_FAILED:") ||
    trimmed.startsWith("SWARM_FAILED:")
  )
}

/**
 * canUseTool guard. Denies Task delegations whose subagent_type isn't in
 * the algorithm's allowlist; returns null (no opinion → fall through) for
 * everything else.
 */
export function enforceAllowedSubagents(
  toolName: string,
  toolInput: Record<string, unknown>,
  allowed: Set<string>,
): DenyVerdict | null {
  if (!TASK_TOOL_NAMES.has(toolName)) return null
  const requested = toolInput.subagent_type
  if (typeof requested !== "string") return null
  if (allowed.has(requested)) return null
  return {
    behavior: "deny",
    message: `Subagent "${requested}" is not registered for this algorithm. Use one of: ${[...allowed].join(", ")}.`,
  }
}

/**
 * Walk the SDK message stream as it arrives. Mutates the open-delegation
 * map and the finalized list. Pure-ish: no IO, no SDK calls. Tested
 * directly by feeding it canned message arrays.
 */
export function observeMessage(
  msg: unknown,
  state: {
    open: Map<string, OpenDelegation>
    finalized: DelegationRecord[]
    parentFilesTouched: Set<string>
    allFilesTouched: Set<string>
    sessionId: { value: string | null }
  },
  options: { cwd: string; algorithm: string; bumpAmount: number; ledger: Ledger; nowMs?: () => number },
): void {
  const m = msg as {
    type?: string
    subtype?: string
    session_id?: string
    message?: { role?: string; content?: unknown[] }
    parent_tool_use_id?: string | null
  }
  const now = options.nowMs ?? Date.now

  // Pick up session_id from system/init for delegation attribution.
  if (m.type === "system" && m.subtype === "init" && m.session_id) {
    if (!state.sessionId.value) state.sessionId.value = m.session_id
  }

  const role = m.type ?? m.message?.role
  const parentToolUseId = m.parent_tool_use_id ?? null

  if (role === "assistant") {
    const content = (m.message?.content as Array<Record<string, unknown>> | undefined) ?? []
    for (const block of content) {
      const b = block as {
        type?: string
        name?: string
        id?: string
        input?: Record<string, unknown>
      }

      // Parent issued a delegation — open a new record.
      if (b.type === "tool_use" && b.name && TASK_TOOL_NAMES.has(b.name) && b.id) {
        const subagent_type = String(b.input?.subagent_type ?? "<unknown>")
        const prompt = String(b.input?.prompt ?? "")
        state.open.set(b.id, {
          toolUseId: b.id,
          subagentType: subagent_type,
          prompt,
          startedAtMs: now(),
          filesTouched: new Set<string>(),
        })
        continue
      }

      // File touch — attribute to delegation if nested, else to parent.
      if (b.type === "tool_use" && b.name && FILE_TOUCH_TOOL_NAMES.has(b.name)) {
        const path = extractPathFromInput(b.input)
        if (!path) continue
        const rel = toProjectRelative(path, options.cwd)
        if (isBlockedPath(rel)) continue
        if (parentToolUseId && state.open.has(parentToolUseId)) {
          state.open.get(parentToolUseId)!.filesTouched.add(rel)
        } else {
          state.parentFilesTouched.add(rel)
        }
        state.allFilesTouched.add(rel)
      }
    }
    return
  }

  if (role === "user") {
    const content = (m.message?.content as Array<Record<string, unknown>> | undefined) ?? []
    for (const block of content) {
      const b = block as {
        type?: string
        tool_use_id?: string
        content?: unknown
      }
      // Mine paths from any tool_result text (covers parent-direct Grep/Read results too).
      if (b.type === "tool_result") {
        const raw = extractToolResultText(b.content)
        for (const p of extractPathsFromText(raw, options.cwd)) {
          state.allFilesTouched.add(p)
          // If this tool_result closes an open delegation, attribute the
          // mined paths to it. Otherwise treat as parent-direct.
          if (b.tool_use_id && state.open.has(b.tool_use_id)) {
            state.open.get(b.tool_use_id)!.filesTouched.add(p)
          } else {
            state.parentFilesTouched.add(p)
          }
        }
        // Close the delegation if this is its tool_result.
        if (b.tool_use_id && state.open.has(b.tool_use_id)) {
          const open = state.open.get(b.tool_use_id)!
          const summary = raw.slice(0, 500)
          const record: DelegationRecord = {
            session_id: state.sessionId.value ?? "unknown",
            algorithm: options.algorithm,
            subagent_type: open.subagentType,
            prompt_preview: open.prompt.slice(0, 200),
            result_summary: summary,
            files_touched: [...open.filesTouched],
            duration_ms: now() - open.startedAtMs,
            ended_at: new Date(now()).toISOString(),
          }
          state.finalized.push(record)
          // Bump each touched file with subagent attribution.
          for (const p of open.filesTouched) {
            bumpFile(options.ledger, p, options.bumpAmount, open.subagentType)
          }
          state.open.delete(b.tool_use_id)
        }
      }
    }
  }
}

export type OpusObserverContext = {
  cwd: string
  algorithm: string
  ledger: Ledger
  allowedSubagents: Set<string>
  bumpAmount?: number
  sessionId?: string
}

export type OpusObserver = {
  /** Compose into the runtime's canUseTool callback. Returns deny verdict or null (no opinion). */
  canUseToolGuard: (
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => DenyVerdict | null
  /** Compose into the runtime's stream loop. Side-effects only. */
  observeMessage: (msg: unknown) => void
  /**
   * Close any open delegations, bump parent-direct files, append all
   * delegation records to the ledger. Returns the run summary.
   * Idempotent — safe to call after error/abort with partial data.
   */
  finalize: () => OpusOrchestrationResult
}

/**
 * Build the observer building blocks. Each algorithm's prepare() calls
 * this once, then passes back the canUseToolGuard/observeMessage/finalize
 * pieces inside its AlgorithmAugmentation.
 */
export function createOpusObserver(ctx: OpusObserverContext): OpusObserver {
  const bumpAmount = ctx.bumpAmount ?? DEFAULT_BUMP
  const state = {
    open: new Map<string, OpenDelegation>(),
    finalized: [] as DelegationRecord[],
    parentFilesTouched: new Set<string>(),
    allFilesTouched: new Set<string>(),
    sessionId: { value: ctx.sessionId ?? null },
  }
  const observeOptions = {
    cwd: ctx.cwd,
    algorithm: ctx.algorithm,
    bumpAmount,
    ledger: ctx.ledger,
  }
  let finalized = false

  return {
    canUseToolGuard(toolName, toolInput) {
      return enforceAllowedSubagents(toolName, toolInput, ctx.allowedSubagents)
    },
    observeMessage(msg) {
      observeMessage(msg, state, observeOptions)
    },
    finalize() {
      if (!finalized) {
        finalized = true
        // Close orphan delegations (defensive — SDK should always send tool_result).
        for (const open of state.open.values()) {
          state.finalized.push({
            session_id: state.sessionId.value ?? "unknown",
            algorithm: ctx.algorithm,
            subagent_type: open.subagentType,
            prompt_preview: open.prompt.slice(0, 200),
            result_summary: "(no tool_result observed — possible stream truncation)",
            files_touched: [...open.filesTouched],
            duration_ms: Date.now() - open.startedAtMs,
            ended_at: new Date().toISOString(),
          })
          for (const p of open.filesTouched) {
            bumpFile(ctx.ledger, p, bumpAmount, open.subagentType)
          }
        }
        state.open.clear()
        // Bump parent-direct file touches under "parent" attribution.
        for (const p of state.parentFilesTouched) {
          bumpFile(ctx.ledger, p, bumpAmount, "parent")
        }
        // Append delegation records to the ledger.
        for (const rec of state.finalized) appendDelegation(ctx.ledger, rec)
      }

      const anyMinionFailed = state.finalized.some((r) => isFailureText(r.result_summary))
      return {
        messages: [],
        delegations: state.finalized,
        filesTouched: state.allFilesTouched,
        anyMinionFailed,
      }
    },
  }
}

/**
 * Suite-runner harness. Wraps sdk.query() AND the observer in one call.
 * Production code (claude.ts) does not use this — it composes the
 * observer into its own sdk.query call via createOpusObserver above.
 */
export async function runOpusOrchestrated(
  options: RunOpusOrchestratedOptions,
): Promise<OpusOrchestrationResult> {
  const observer = createOpusObserver({
    cwd: options.cwd,
    algorithm: options.algorithm,
    ledger: options.ledger,
    allowedSubagents: options.allowedSubagents,
    bumpAmount: options.bumpAmount,
    sessionId: options.sessionId,
  })
  const collected: unknown[] = []

  const stream = options.sdkQuery({
    prompt: options.query,
    options: {
      ...buildBaseSdkOptions(options),
      agents: options.agents as unknown as Record<string, unknown>,
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: options.systemPromptAppend,
      },
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>,
      ) => {
        const denied = observer.canUseToolGuard(toolName, toolInput)
        if (denied) return denied
        return { behavior: "allow" as const }
      },
    },
  })

  for await (const msg of stream) {
    collected.push(msg)
    options.onMessage?.(msg)
    observer.observeMessage(msg)
  }

  const result = observer.finalize()
  return { ...result, messages: collected }
}

// Re-export so algorithm tests don't need a separate import.
export { type SdkQueryFn }

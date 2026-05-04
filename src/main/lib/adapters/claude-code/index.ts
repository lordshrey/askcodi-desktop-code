import * as fs from "node:fs/promises"
import type {
  DesktopAdapter,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterModel,
  AdapterConfigSchema,
} from "../../../../shared/types/adapter"
import { claudeCodeSessionCodec } from "./codec"
import { buildIssuePrompt } from "../_shared/build-issue-prompt"
import { findAdapterBinary } from "../_shared/find-binary"
import { isTransientUpstreamError } from "../_shared/error-classification"
import { createOrchestratorMcpServer } from "../../mcp/orchestrator-server"
import { getDatabase, runtimeAgents } from "../../db"
import { eq } from "drizzle-orm"
import {
  loadFoundingEngineerSystemPrompt,
  isFoundingEngineer,
} from "../../agents/founding-engineer"

// Claude Code adapter for the orchestrator.
//
// execute() drives the @anthropic-ai/claude-agent-sdk directly. This is a separate,
// simpler invocation path than src/main/lib/trpc/routers/claude.ts (the chat UI),
// which has its own complex flow (Ollama support, swarm algorithms, plan-mode
// transcript handling, MCP servers, image attachments, isolated config dirs).
//
// MVP scope here:
//   - One-shot run: build prompt from issue context, call query(), iterate, finalize.
//   - Session resume via runtime.sessionParams (sessionId from prior run's codec).
//   - Streaming text → onLog("stdout"); tool_use/tool_result → onMeta.
//   - Cancellation via abortController bound to ctx.abortSignal.
//   - Permission mode: bypassPermissions (autonomous; user trusts the agent).
//
// Out of scope (deferred):
//   - Plan mode transcript / ExitPlanMode handling
//   - Custom MCP servers + symlinked ~/.claude config dirs
//   - Image attachments
//   - Custom system prompts beyond the issue context

const CLAUDE_CODE_MODELS: AdapterModel[] = [
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    capabilities: ["tool_use", "thinking", "vision"],
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    provider: "anthropic",
    contextWindow: 1_000_000,
    capabilities: ["tool_use", "thinking", "vision"],
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    capabilities: ["tool_use"],
  },
]

// ===========================================================================
// execute() implementation — calls the Claude Agent SDK
// ===========================================================================

// Cached SDK module. Dynamic import because it's pure ESM and Electron's main
// process may evaluate this file under CJS depending on bundler config.
let cachedQuery:
  | typeof import("@anthropic-ai/claude-agent-sdk").query
  | null = null

async function getQuery() {
  if (cachedQuery) return cachedQuery
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  cachedQuery = sdk.query
  return cachedQuery
}

interface SdkAssistantContent {
  type: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
  is_error?: boolean
  tool_use_id?: string
  thinking?: string
}

function modelIdToSdkAlias(model: string): string {
  // The SDK accepts the full model id (e.g., "claude-sonnet-4-5") OR a short
  // alias (sonnet/opus/haiku). Pass the id through as-is.
  return model
}

async function executeClaudeRun(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const query = await getQuery()
  const config = ctx.config as { model?: string; mode?: string; maxTurns?: number }
  const model = modelIdToSdkAlias(config.model ?? "claude-sonnet-4-5")
  const maxTurns = typeof config.maxTurns === "number" ? config.maxTurns : 50
  const mode = config.mode === "plan" ? "plan" : "agent"

  // Map our AbortSignal into the SDK's AbortController so cancellation propagates.
  const abortController = new AbortController()
  if (ctx.abortSignal.aborted) abortController.abort()
  const onAbort = () => abortController.abort()
  ctx.abortSignal.addEventListener("abort", onAbort)

  const prompt = buildIssuePrompt(ctx.context)

  // Resume the prior session if we have one.
  const priorSessionId =
    ctx.runtime.sessionParams && typeof ctx.runtime.sessionParams.sessionId === "string"
      ? ctx.runtime.sessionParams.sessionId
      : null

  // Build the orchestrator MCP server bound to this run's auth context. The
  // calling agent's project scopes default tool inputs (createIssue without an
  // explicit projectId lands in the calling agent's project).
  const db = getDatabase()
  const callingAgent = db
    .select()
    .from(runtimeAgents)
    .where(eq(runtimeAgents.id, ctx.agentId))
    .get()
  const mcpServer = await createOrchestratorMcpServer({
    callingAgentId: ctx.agentId,
    runId: ctx.runId,
    defaultProjectId: callingAgent?.defaultProjectId ?? null,
  })

  // Founding engineer gets the role-specific system prompt prepended.
  const systemPromptAppend =
    callingAgent && isFoundingEngineer(callingAgent)
      ? await loadFoundingEngineerSystemPrompt()
      : null

  await ctx.onMeta({
    type: "lifecycle",
    data: {
      phase: "starting",
      model,
      maxTurns,
      mode,
      resumed: priorSessionId !== null,
      isFounding: callingAgent ? isFoundingEngineer(callingAgent) : false,
    },
  })

  let stream
  try {
    stream = query({
      prompt,
      options: {
        model,
        cwd: ctx.executionTarget.cwd,
        abortController,
        maxTurns,
        permissionMode: mode === "plan" ? "plan" : "bypassPermissions",
        mcpServers: { askcodi: mcpServer },
        ...(systemPromptAppend
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: systemPromptAppend,
              },
            }
          : {}),
        ...(priorSessionId ? { resume: priorSessionId } : {}),
      },
    })
  } catch (error) {
    ctx.abortSignal.removeEventListener("abort", onAbort)
    const err = error as Error
    return {
      status: "failed",
      errorCode: "claude_query_init_failed",
      errorFamily: "permanent",
      error: err.message,
    }
  }

  // Iterate. Capture the final result message; everything else streams to onLog/onMeta.
  type SdkResultMessage = {
    type: "result"
    subtype: string
    result?: string
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens?: number
    }
    session_id?: string
    total_cost_usd?: number
    is_error?: boolean
    stop_reason?: string | null
  }
  let resultMessage: SdkResultMessage | null = null
  let finalSessionId: string | null = priorSessionId
  let cancelled = false

  try {
    for await (const msg of stream as AsyncIterable<unknown>) {
      if (ctx.abortSignal.aborted) {
        cancelled = true
        break
      }
      const m = msg as { type?: string }
      switch (m.type) {
        case "system": {
          // Initial system message includes the new session_id.
          const sys = msg as { session_id?: string; subtype?: string }
          if (sys.session_id) finalSessionId = sys.session_id
          await ctx.onMeta({ type: "system", data: { ...sys } as Record<string, unknown> })
          break
        }
        case "assistant": {
          const am = msg as { message?: { content?: SdkAssistantContent[] }; session_id?: string }
          if (am.session_id) finalSessionId = am.session_id
          for (const block of am.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              await ctx.onLog("stdout", block.text)
            } else if (block.type === "thinking" && block.thinking) {
              await ctx.onMeta({
                type: "thinking",
                data: { content: block.thinking },
              })
            } else if (block.type === "tool_use") {
              await ctx.onMeta({
                type: "tool_call",
                data: {
                  name: block.name,
                  input: block.input,
                  toolUseId: block.tool_use_id,
                },
              })
            }
          }
          break
        }
        case "user": {
          // user messages carry tool_result blocks from the SDK
          const um = msg as { message?: { content?: SdkAssistantContent[] } }
          for (const block of um.message?.content ?? []) {
            if (block.type === "tool_result") {
              const text =
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content)
              await ctx.onMeta({
                type: block.is_error ? "tool_error" : "tool_result",
                data: {
                  toolUseId: block.tool_use_id,
                  content: text.slice(0, 4000),
                  isError: block.is_error ?? false,
                },
              })
              if (block.is_error) {
                await ctx.onLog("stderr", text.slice(0, 4000) + "\n")
              }
            }
          }
          break
        }
        case "result": {
          resultMessage = msg as SdkResultMessage
          if (resultMessage.session_id) finalSessionId = resultMessage.session_id
          break
        }
        default: {
          // Other message types: status, partial_assistant, hook events, etc.
          // Treated as informational meta only.
          await ctx.onMeta({ type: m.type ?? "unknown", data: msg as Record<string, unknown> })
        }
      }
    }
  } catch (error) {
    ctx.abortSignal.removeEventListener("abort", onAbort)
    const err = error as Error & { name?: string }
    if (err.name === "AbortError" || ctx.abortSignal.aborted) {
      cancelled = true
    } else {
      // Classify transient upstream (rate limit, server error) for retry.
      const message = err.message ?? "unknown error"
      const transient = isTransientUpstreamError(message)
      return {
        status: "failed",
        errorCode: transient ? "claude_transient_upstream" : "claude_query_failed",
        errorFamily: transient ? "transient_upstream" : "permanent",
        error: message,
        sessionId: finalSessionId,
        sessionParams: finalSessionId
          ? { sessionId: finalSessionId, cwd: ctx.executionTarget.cwd, mode }
          : null,
      }
    }
  } finally {
    ctx.abortSignal.removeEventListener("abort", onAbort)
  }

  if (cancelled) {
    return {
      status: "failed",
      errorCode: "cancelled",
      errorFamily: "user_cancelled",
      error: "Cancelled by user",
      sessionId: finalSessionId,
      sessionParams: finalSessionId
        ? { sessionId: finalSessionId, cwd: ctx.executionTarget.cwd, mode }
        : null,
    }
  }

  if (!resultMessage) {
    // Stream ended without a result message — treat as failure.
    return {
      status: "failed",
      errorCode: "claude_no_result",
      errorFamily: "permanent",
      error: "Stream ended without a result message",
      sessionId: finalSessionId,
      sessionParams: finalSessionId
        ? { sessionId: finalSessionId, cwd: ctx.executionTarget.cwd, mode }
        : null,
    }
  }

  const usage = resultMessage.usage
  const costCents =
    typeof resultMessage.total_cost_usd === "number"
      ? Math.round(resultMessage.total_cost_usd * 100)
      : 0

  const inputTokens = (usage?.input_tokens ?? 0)
  const cachedInputTokens =
    (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)
  const outputTokens = usage?.output_tokens ?? 0

  return {
    status: resultMessage.subtype === "success" ? "succeeded" : "failed",
    summary: typeof resultMessage.result === "string" ? resultMessage.result.slice(0, 500) : undefined,
    sessionId: finalSessionId,
    sessionParams: finalSessionId
      ? { sessionId: finalSessionId, cwd: ctx.executionTarget.cwd, mode }
      : null,
    usage: usage ? { inputTokens, outputTokens, cachedInputTokens } : null,
    costCents,
    provider: "anthropic",
    model: config.model ?? "claude-sonnet-4-5",
    billingType: "metered_api",
    resultJson: {
      stopReason: resultMessage.stop_reason,
      isError: resultMessage.is_error,
    },
    errorCode: resultMessage.subtype !== "success" ? `claude_${resultMessage.subtype}` : undefined,
    errorFamily: resultMessage.subtype !== "success" ? "permanent" : null,
  }
}

const CONFIG_SCHEMA: AdapterConfigSchema = {
  fields: [
    {
      key: "model",
      label: "Model",
      type: "select",
      required: true,
      defaultValue: "claude-sonnet-4-5",
      options: CLAUDE_CODE_MODELS.map((m) => ({ value: m.id, label: m.label })),
      description: "Which Claude model the agent runs.",
    },
    {
      key: "mode",
      label: "Default mode",
      type: "select",
      defaultValue: "agent",
      options: [
        { value: "agent", label: "Agent (full permissions)" },
        { value: "plan", label: "Plan (read-only)" },
      ],
      description: "Initial mode for new runs. Issues can override per-run.",
    },
    {
      key: "maxTurns",
      label: "Max turns per run",
      type: "number",
      defaultValue: 50,
      description: "Hard limit on agent turns within a single run.",
    },
  ],
}

export const claudeCodeAdapter: DesktopAdapter = {
  type: "claude_code",
  displayName: "Claude Code",
  description: "Anthropic's Claude Code CLI agent. Reads/writes files, runs bash, browses the web.",
  supportsLocalAgentJwt: true,

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    return executeClaudeRun(ctx)
  },

  async testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
    const binary = await findAdapterBinary("claude")
    if (!binary) {
      return {
        ok: false,
        message: "Claude Code binary not found",
        fixHint:
          "Run `bun run claude:download` from the project root, or install Claude Code on your PATH.",
      }
    }
    const cwd = ctx.cwd ?? process.cwd()
    try {
      await fs.access(cwd)
    } catch {
      return {
        ok: false,
        message: `Working directory does not exist: ${cwd}`,
        details: { cwd },
        fixHint: "Pick a project folder that exists on disk.",
      }
    }
    return {
      ok: true,
      message: `Claude Code ready at ${binary}`,
      details: { binary, cwd },
    }
  },

  models: CLAUDE_CODE_MODELS,

  async listModels(): Promise<AdapterModel[]> {
    return CLAUDE_CODE_MODELS
  },

  async detectModel() {
    // Default to the mid-tier model; Phase 6 reads from anthropic_accounts to pick a smarter default.
    return { model: "claude-sonnet-4-5", provider: "anthropic", source: "default" }
  },

  sessionCodec: claudeCodeSessionCodec,

  getConfigSchema(): AdapterConfigSchema {
    return CONFIG_SCHEMA
  },

  agentConfigurationDoc: `# Claude Code agent

This agent runs the Claude Code CLI inside a per-issue git worktree. It can read and
write files, run bash, browse the web, and call MCP tools.

**Models:** sonnet (default), opus, haiku.
**Modes:** agent (full permissions) or plan (read-only investigation).
**Auth:** uses the Anthropic account configured in Settings.
`,
}

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
import { codexSessionCodec } from "./codec"
import { buildIssuePrompt } from "../_shared/build-issue-prompt"
import { findAdapterBinary } from "../_shared/find-binary"
import { isTransientUpstreamError } from "../_shared/error-classification"

// Codex adapter for the orchestrator.
//
// execute() drives @openai/codex-sdk directly. Mirrors the Claude Code adapter's
// scope and shape — issue prompt, streamed turn, callbacks, session resume via
// codec → ThreadId.

const CODEX_MODELS: AdapterModel[] = [
  {
    id: "gpt-5",
    label: "GPT-5",
    provider: "openai",
    contextWindow: 400_000,
    capabilities: ["tool_use", "vision"],
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    provider: "openai",
    contextWindow: 200_000,
    capabilities: ["tool_use"],
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    provider: "openai",
    contextWindow: 64_000,
    capabilities: ["tool_use"],
  },
]

// ===========================================================================
// execute() implementation — calls @openai/codex-sdk
// ===========================================================================

let cachedCodexCtor: typeof import("@openai/codex-sdk").Codex | null = null

async function getCodex() {
  if (cachedCodexCtor) return cachedCodexCtor
  const sdk = await import("@openai/codex-sdk")
  cachedCodexCtor = sdk.Codex
  return cachedCodexCtor
}

async function executeCodexRun(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const Codex = await getCodex()
  const config = ctx.config as { model?: string; reasoningEffort?: string }
  const model = config.model ?? "gpt-5"
  const reasoningEffort = (config.reasoningEffort as
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | undefined) ?? "medium"

  const binary = await findAdapterBinary("codex")
  if (!binary) {
    return {
      status: "failed",
      errorCode: "codex_binary_missing",
      errorFamily: "permanent",
      error: "Codex binary not found",
    }
  }

  const prompt = buildIssuePrompt(ctx.context)

  const priorThreadId =
    ctx.runtime.sessionParams && typeof ctx.runtime.sessionParams.threadId === "string"
      ? ctx.runtime.sessionParams.threadId
      : null

  await ctx.onMeta({
    type: "lifecycle",
    data: {
      phase: "starting",
      model,
      reasoningEffort,
      resumed: priorThreadId !== null,
    },
  })

  const codex = new Codex({ codexPathOverride: binary })
  const threadOptions = {
    model,
    workingDirectory: ctx.executionTarget.cwd,
    sandboxMode: "workspace-write" as const,
    approvalPolicy: "never" as const,
    modelReasoningEffort: reasoningEffort,
    skipGitRepoCheck: true,
  }

  const thread = priorThreadId
    ? codex.resumeThread(priorThreadId, threadOptions)
    : codex.startThread(threadOptions)

  let finalResponse: string | null = null
  let usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null = null
  let cancelled = false
  let threadId: string | null = priorThreadId
  let firstError: string | null = null

  try {
    const { events } = await thread.runStreamed(prompt, { signal: ctx.abortSignal })
    for await (const event of events) {
      if (ctx.abortSignal.aborted) {
        cancelled = true
        break
      }
      switch (event.type) {
        case "thread.started": {
          // Capture threadId via the public getter (event shape varies across versions).
          const id = thread.id
          if (id) threadId = id
          await ctx.onMeta({ type: "thread_started", data: { threadId } })
          break
        }
        case "turn.started":
          await ctx.onMeta({ type: "turn_started", data: {} })
          break
        case "turn.completed":
          usage = event.usage
          await ctx.onMeta({ type: "turn_completed", data: { usage: event.usage } as Record<string, unknown> })
          break
        case "turn.failed":
          firstError = firstError ?? event.error?.message ?? "turn failed"
          await ctx.onMeta({ type: "turn_failed", data: { error: event.error } as Record<string, unknown> })
          break
        case "item.completed":
        case "item.updated":
        case "item.started": {
          const item = event.item
          if (item.type === "agent_message") {
            if (event.type === "item.completed" && item.text) {
              await ctx.onLog("stdout", item.text + "\n")
              finalResponse = item.text
            }
          } else if (item.type === "command_execution") {
            if (event.type === "item.completed") {
              await ctx.onMeta({
                type: "command_execution",
                data: {
                  command: item.command,
                  exitCode: item.exit_code,
                  output: (item.aggregated_output ?? "").slice(0, 4000),
                  status: item.status,
                },
              })
              if (item.aggregated_output) {
                await ctx.onLog(
                  item.exit_code === 0 ? "stdout" : "stderr",
                  item.aggregated_output.slice(0, 4000),
                )
              }
            }
          } else if (item.type === "file_change") {
            if (event.type === "item.completed") {
              await ctx.onMeta({
                type: "file_change",
                data: { changes: item.changes, status: item.status },
              })
            }
          } else if (item.type === "mcp_tool_call") {
            if (event.type === "item.completed") {
              await ctx.onMeta({
                type: "mcp_tool_call",
                data: {
                  server: item.server,
                  tool: item.tool,
                  status: item.status,
                  error: item.error?.message,
                },
              })
            }
          } else if (item.type === "reasoning") {
            if (event.type === "item.completed") {
              await ctx.onMeta({ type: "thinking", data: { content: item.text } })
            }
          } else if (item.type === "web_search") {
            if (event.type === "item.started") {
              await ctx.onMeta({ type: "web_search", data: { query: item.query } })
            }
          } else if (item.type === "todo_list") {
            if (event.type === "item.updated" || event.type === "item.completed") {
              await ctx.onMeta({ type: "todo_list", data: { items: item.items } })
            }
          } else if (item.type === "error") {
            firstError = firstError ?? item.message
            await ctx.onLog("stderr", item.message + "\n")
          }
          break
        }
        case "error":
          firstError = firstError ?? event.message
          await ctx.onLog("stderr", event.message + "\n")
          break
      }
    }
  } catch (error) {
    const err = error as Error & { name?: string }
    if (err.name === "AbortError" || ctx.abortSignal.aborted) {
      cancelled = true
    } else {
      const message = err.message ?? "unknown error"
      const transient = isTransientUpstreamError(message)
      return {
        status: "failed",
        errorCode: transient ? "codex_transient_upstream" : "codex_run_failed",
        errorFamily: transient ? "transient_upstream" : "permanent",
        error: message,
        sessionId: threadId,
        sessionParams: threadId ? { threadId, cwd: ctx.executionTarget.cwd } : null,
      }
    }
  }

  if (!threadId && thread.id) threadId = thread.id

  if (cancelled) {
    return {
      status: "failed",
      errorCode: "cancelled",
      errorFamily: "user_cancelled",
      error: "Cancelled by user",
      sessionId: threadId,
      sessionParams: threadId ? { threadId, cwd: ctx.executionTarget.cwd } : null,
    }
  }

  if (firstError && !finalResponse) {
    return {
      status: "failed",
      errorCode: "codex_run_failed",
      errorFamily: "permanent",
      error: firstError,
      sessionId: threadId,
      sessionParams: threadId ? { threadId, cwd: ctx.executionTarget.cwd } : null,
    }
  }

  // Placeholder pricing — replace with adapter-driven pricing tables when available.
  const costCents = usage
    ? Math.round(
        ((usage.input_tokens ?? 0) * 0.000125 +
          (usage.cached_input_tokens ?? 0) * 0.0000125 +
          (usage.output_tokens ?? 0) * 0.001) * 100,
      )
    : 0

  return {
    status: "succeeded",
    summary: finalResponse ? finalResponse.slice(0, 500) : undefined,
    sessionId: threadId,
    sessionParams: threadId ? { threadId, cwd: ctx.executionTarget.cwd } : null,
    usage: usage
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedInputTokens: usage.cached_input_tokens ?? 0,
        }
      : null,
    costCents,
    provider: "openai",
    model,
    billingType: "metered_api",
    resultJson: { finalResponse },
  }
}


const CONFIG_SCHEMA: AdapterConfigSchema = {
  fields: [
    {
      key: "model",
      label: "Model",
      type: "select",
      required: true,
      defaultValue: "gpt-5",
      options: CODEX_MODELS.map((m) => ({ value: m.id, label: m.label })),
    },
    {
      key: "reasoningEffort",
      label: "Reasoning effort",
      type: "select",
      defaultValue: "medium",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
  ],
}

export const codexAdapter: DesktopAdapter = {
  type: "codex",
  displayName: "Codex",
  description: "OpenAI's Codex CLI. Strong at debugging and structured reasoning.",
  supportsLocalAgentJwt: true,

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    return executeCodexRun(ctx)
  },

  async testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
    const binary = await findAdapterBinary("codex")
    if (!binary) {
      return {
        ok: false,
        message: "Codex binary not found",
        fixHint: "Run `bun run codex:download`, or set CODEX_BINARY to the binary path.",
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
      }
    }
    return { ok: true, message: `Codex ready at ${binary}`, details: { binary, cwd } }
  },

  models: CODEX_MODELS,
  async listModels(): Promise<AdapterModel[]> {
    return CODEX_MODELS
  },

  async detectModel() {
    return { model: "gpt-5", provider: "openai", source: "default" }
  },

  sessionCodec: codexSessionCodec,
  getConfigSchema(): AdapterConfigSchema {
    return CONFIG_SCHEMA
  },

  agentConfigurationDoc: `# Codex agent

OpenAI's Codex CLI inside a per-issue worktree. Best for debugging and structured
reasoning tasks.
`,
}

// Adapter contract — the seam between the orchestrator and a specific agent runtime.
//
// Lifted and simplified from paperclip's ServerAdapterModule (packages/adapter-utils/src/types.ts).
// Single-user; no companyId, no multi-tenant fields.
//
// Lives in src/shared so both main (registry, heartbeat service) and renderer (UI metadata
// for hire/configure flows) can import the types without main-only runtime deps.
//
// The actual adapter implementations live in src/main/adapters/{type}/ — main-only.

// ============ Identity ============
export type AdapterType =
  | "claude_code"
  | "claude_api"
  | "codex"
  | "cursor"
  | "ollama"

export const ADAPTER_TYPES: readonly AdapterType[] = [
  "claude_code",
  "claude_api",
  "codex",
  "cursor",
  "ollama",
] as const

// ============ Models exposed by an adapter ============
export interface AdapterModel {
  id: string                 // canonical id used in agent.adapterConfig.model
  label: string              // human-readable, e.g. "Claude 3.5 Sonnet"
  provider: string           // anthropic | openai | google | xai | ollama | local
  contextWindow?: number
  capabilities?: string[]    // e.g. "tool_use" | "vision" | "thinking"
  pricing?: {
    inputCentsPerMillion: number
    outputCentsPerMillion: number
    cachedInputCentsPerMillion?: number
  }
}

// ============ Execution context (input to adapter.execute) ============
export interface AdapterRuntime {
  // Resume state for the session. Decoded from agent_task_sessions.sessionParamsJson
  // via this adapter's sessionCodec on the way in. Adapter mutates and returns the
  // new state in AdapterExecutionResult.sessionParams.
  sessionId: string | null
  sessionParams: Record<string, unknown> | null
  sessionDisplayId: string | null
  taskKey: string | null
}

export interface AdapterContextPayload {
  // The work unit. Issue title + description + ancestry (project, parent issue).
  // Optional: free-form one-shot calls (no issue) populate only `prompt`.
  issue?: {
    id: string
    title: string
    description?: string | null
    status: string
    identifier: string
  }
  parentIssue?: { id: string; title: string } | null
  project?: {
    id: string
    name: string
    path: string
  }
  prompt?: string                      // optional override / one-shot content
  wakeComment?: string | null          // the comment that triggered the wakeup, if any
  continuationSummary?: string | null  // rolling summary across previous runs
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>
}

export interface AdapterExecutionTarget {
  cwd: string                          // absolute path agent should run in
  projectId?: string
  branch?: string | null
  repoUrl?: string | null
  baseBranch?: string | null
}

export interface AdapterSpawnInfo {
  pid: number
  processGroupId: number | null
  startedAt: string                    // ISO 8601
}

export interface AdapterInvocationMeta {
  type: string                         // e.g. "tool_call" | "thinking" | "system"
  data: Record<string, unknown>
}

export interface AdapterExecutionContext {
  runId: string
  agentId: string
  agentRole: string
  agentName: string
  adapterType: AdapterType
  runtime: AdapterRuntime
  config: Record<string, unknown>      // resolved adapter config (model, env, args, ...)
  context: AdapterContextPayload
  executionTarget: AdapterExecutionTarget
  // Streaming callbacks. Adapters call these as data arrives.
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>
  onMeta: (meta: AdapterInvocationMeta) => Promise<void>
  onSpawn: (info: AdapterSpawnInfo) => Promise<void>
  // Short-lived JWT (1h) the adapter passes to the spawned process so it can call
  // back via the in-process MCP server as this agent. Null if the adapter declared
  // supportsLocalAgentJwt=false.
  authToken: string | null
  // Cancellation signal. Adapters should listen and clean up children promptly.
  abortSignal: AbortSignal
}

// ============ Result (output of adapter.execute) ============
export interface AdapterUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

export interface AdapterExecutionResult {
  status: "succeeded" | "failed" | "timed_out"
  summary?: string                     // one-line "what I did"
  nextAction?: string | null           // what the agent recommends next
  // Encoded session for resume on next run. Will be passed through sessionCodec.serialize().
  sessionId?: string | null
  sessionParams?: Record<string, unknown> | null
  // Cost / usage
  usage?: AdapterUsage | null
  costCents?: number                   // adapter-computed cost; service may override
  provider?: string
  model?: string
  billingType?: "api" | "subscription" | "metered_api" | "subscription_overage" | "unknown"
  // Optional structured payload. Service stores in agent_runs.resultJson.
  resultJson?: Record<string, unknown>
  // Error metadata (when status != "succeeded")
  errorCode?: string                   // e.g. "claude_transient_upstream"
  errorFamily?: "transient_upstream" | "permanent" | "user_cancelled" | null
  error?: string
}

// ============ Environment test (called before allowing hire) ============
export interface AdapterEnvironmentTestContext {
  config: Record<string, unknown>      // proposed adapter config
  cwd?: string                         // optional working directory for the test
}

export interface AdapterEnvironmentTestResult {
  ok: boolean
  message: string                      // human-readable
  details?: Record<string, unknown>    // e.g. { binaryPath, version, modelsAvailable }
  fixHint?: string                     // actionable suggestion when ok=false
}

// ============ Session codec ============
// Pure function pair. Encodes adapter-specific session shape to a JSON-storable record
// and back. Same idea as paperclip's AdapterSessionCodec (§4.2 of paperclip-internals.md).
export interface AdapterSessionCodec {
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null
  deserialize(raw: unknown): Record<string, unknown> | null
  getDisplayId?(params: Record<string, unknown> | null): string | null
}

// ============ Config schema (for hire UI) ============
export interface AdapterConfigField {
  key: string
  label: string
  type: "string" | "number" | "boolean" | "select" | "secret"
  required?: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: unknown
  description?: string
  placeholder?: string
}

export interface AdapterConfigSchema {
  fields: AdapterConfigField[]
}

// ============ The adapter itself ============
export interface DesktopAdapter {
  readonly type: AdapterType
  readonly displayName: string
  readonly description?: string
  // Capability flags
  readonly supportsLocalAgentJwt?: boolean
  // Lifecycle
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>
  // Discovery
  models?: AdapterModel[]
  listModels?(): Promise<AdapterModel[]>
  detectModel?(): Promise<{ model: string; provider: string; source: string } | null>
  // Resume
  sessionCodec?: AdapterSessionCodec
  // Configuration UI
  getConfigSchema?(): AdapterConfigSchema
  agentConfigurationDoc?: string
}

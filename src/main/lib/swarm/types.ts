/**
 * Shared types for the swarm module.
 *
 * The gateway captures fingerprint metadata and quality events asynchronously;
 * v0.1 ships heuristic routing only, learned policy comes in v0.3+.
 */

/**
 * Subset of the Claude Agent SDK's AgentDefinition that swarm code uses.
 * Canonical shape — both subagent-registry (swarm_explore) and haiku-minions
 * (Explore/general-purpose overrides) consume this type.
 */
export type SwarmAgentDefinition = {
  description: string
  tools: string[]
  prompt: string
  model: "haiku" | "sonnet" | "opus" | "inherit"
}

/**
 * Lightweight metadata about a project's repo, captured server-side on first
 * connect. v0.1 explicitly does NOT include parsed import graphs, churn
 * analysis, or README NLP — those require per-language parsers and add
 * unbounded complexity.
 */
export type CodebaseFingerprint = {
  project_id: string
  scanned_at: string // ISO 8601
  language_breakdown: Record<string, number> // extension -> file count
  top_level_dirs: string[]
  package_manifests: Array<{ path: string; type: string }>
  frameworks_detected: string[]
  total_files: number
  total_size_bytes: number
}

export type QualityOutcome =
  | "accepted"
  | "rejected"
  | "swarm_failed"
  | "unknown"

export type QualityDetectionMethod =
  | "task_completion_proxy"
  | "re_search_detection"
  | "explicit_thumbs"

/**
 * One per swarm_explore delegation. Captured at the boundary where the parent
 * receives the subagent's Task-tool result. v0.1 emits with `outcome: 'unknown'`
 * immediately and updates after classification when post-delegation events
 * accumulate.
 */
export type QualityEvent = {
  session_id: string
  tool_call_id: string // Task tool's tool_use_id
  subagent_type: "swarm_explore" // future: review, etc.
  outcome: QualityOutcome
  detection_method: QualityDetectionMethod | null
  latency_ms: number
  input_tokens_haiku: number
  output_tokens_haiku: number
  // counterfactual estimate of frontier tokens that would have been used
  // without the delegation; null when not measurable
  frontier_tokens_saved_estimate: number | null
  emitted_at: string // ISO 8601
}

export const CLAUDE_MODELS = [
  { id: "opus", name: "Opus", version: "4.6" },
  { id: "sonnet", name: "Sonnet", version: "4.6" },
  { id: "haiku", name: "Haiku", version: "4.5" },
]

export type CodexThinkingLevel = "low" | "medium" | "high" | "xhigh"

export type CodexModel = {
  id: string
  name: string
  thinkings: CodexThinkingLevel[]
}

/** Static fallback models — used when the dynamic cache isn't available. */
export const CODEX_MODELS: CodexModel[] = [
  {
    id: "gpt-5.3-codex",
    name: "Codex 5.3",
    thinkings: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.2-codex",
    name: "Codex 5.2",
    thinkings: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.1-codex-max",
    name: "Codex 5.1 Max",
    thinkings: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "Codex 5.1 Mini",
    thinkings: ["medium", "high"],
  },
]

/**
 * Convert dynamic models from the backend (codex.getModels) to the UI format.
 * Falls back to CODEX_MODELS if the dynamic list is empty.
 */
export function resolveCodexModels(
  dynamicModels?: Array<{
    id: string
    name: string
    thinkings: string[]
  }> | null,
): CodexModel[] {
  if (!dynamicModels || dynamicModels.length === 0) {
    return CODEX_MODELS
  }
  return dynamicModels.map((m) => ({
    id: m.id,
    name: m.name,
    thinkings: m.thinkings as CodexThinkingLevel[],
  }))
}

export function formatCodexThinkingLabel(thinking: CodexThinkingLevel): string {
  if (thinking === "xhigh") return "Extra High"
  return thinking.charAt(0).toUpperCase() + thinking.slice(1)
}

// AskCodi models - populated dynamically from API
export type AskCodiModel = {
  id: string
  name: string
}

// Default static list as fallback (populated dynamically via trpc.askcodi.models)
export const ASKCODI_MODELS: AskCodiModel[] = []

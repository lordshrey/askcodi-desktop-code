import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

// "chat" = existing per-project chat UI (default)
// "orchestrator" = paperclip-style multi-agent control plane
export type AppMode = "chat" | "orchestrator"

export const appModeAtom = atomWithStorage<AppMode>("askcodi.appMode", "chat")

export type OrchestratorRoute =
  | "dashboard"
  | "issues"
  | "agents"
  | "activity"

export const orchestratorRouteAtom = atom<OrchestratorRoute>("dashboard")

export const selectedIssueIdAtom = atom<string | null>(null)
export const selectedRuntimeAgentIdAtom = atom<string | null>(null)

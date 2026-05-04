import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

// "chat" = existing per-project chat UI (default)
// "orchestrator" = paperclip-style multi-agent control plane
export type AppMode = "chat" | "orchestrator"

export const appModeAtom = atomWithStorage<AppMode>("askcodi.appMode", "chat")

export type OrchestratorRoute =
  | "board"
  | "fe_chat"
  | "agent"
  | "inbox"
  | "dashboard"
  | "issues"
  | "agents"
  | "activity"
  | "repos"

export const orchestratorRouteAtom = atom<OrchestratorRoute>("board")

export const selectedIssueIdAtom = atom<string | null>(null)
export const selectedRuntimeAgentIdAtom = atom<string | null>(null)

// Chat focused inside the orchestrator main pane. Transient — never persisted.
// Set when the user explicitly opens a thread/task from inside orchestrator;
// cleared on Back, on sidebar route navigation, or on app launch. Distinct
// from selectedAgentChatIdAtom (which is per-window-persisted and drives the
// Solo chat layout) so that a stale persisted chat doesn't silently take
// over orchestrator routes like Board / Dashboard.
export const orchestratorChatIdAtom = atom<string | null>(null)

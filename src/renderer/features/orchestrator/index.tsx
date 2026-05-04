import { useAtomValue } from "jotai"
import { OrchestratorSidebar } from "./sidebar"
import { BoardView } from "./board-view"
import { FeChatView } from "./fe-chat-view"
import { AgentDetailView } from "./agent-detail-view"
import { InboxView } from "./inbox-view"
import { DashboardView } from "./dashboard-view"
import { IssuesView } from "./issues-view"
import { AgentsView } from "./agents-view"
import { ActivityView } from "./activity-view"
import { ReposView } from "./repos-view"
import { IssueDetailView } from "./issue-detail-view"
import { orchestratorRouteAtom, selectedIssueIdAtom } from "./atoms"
import { useEnsureFoundingEngineer } from "./use-ensure-founding-engineer"

/**
 * Orchestrator surface — multi-agent control plane.
 * Mounted as a parallel app mode alongside the existing Solo chat UI.
 *
 * Mode toggle:
 *   appModeAtom = "chat"          → existing AgentsLayout (Solo mode escape hatch)
 *   appModeAtom = "orchestrator"  → this layout (default for paperclip-style work)
 *
 * Routes:
 *   board       → kanban of all issues across all agents (default home)
 *   fe_chat     → multi-thread chat with the Founding Engineer
 *   agent       → per-agent filtered board (uses selectedRuntimeAgentIdAtom)
 *   inbox       → critical agent requests escalated by the FE
 *   dashboard   → metrics tile view (demoted from home)
 *   issues      → flat all-issues list (legacy table view)
 *   agents      → manage hired agents (status, hire, terminate)
 *   activity    → activity log
 *   repos       → repo manager (multi-repo per project)
 *
 * Issue detail takes precedence over the route when an issue is selected — it
 * opens as a chat-first surface that overlays the main pane.
 */
export function OrchestratorLayout() {
  const route = useAtomValue(orchestratorRouteAtom)
  const selectedIssueId = useAtomValue(selectedIssueIdAtom)
  // Auto-hires the Founding Engineer on first project load. Idempotent.
  useEnsureFoundingEngineer()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <OrchestratorSidebar />
      <main className="flex-1 overflow-hidden">
        {selectedIssueId ? (
          <IssueDetailView issueId={selectedIssueId} />
        ) : (
          <>
            {route === "board" && <BoardView />}
            {route === "fe_chat" && <FeChatView />}
            {route === "agent" && <AgentDetailView />}
            {route === "inbox" && <InboxView />}
            {route === "dashboard" && <DashboardView />}
            {route === "issues" && <IssuesView />}
            {route === "agents" && <AgentsView />}
            {route === "activity" && <ActivityView />}
            {route === "repos" && <ReposView />}
          </>
        )}
      </main>
    </div>
  )
}

export { appModeAtom, orchestratorRouteAtom } from "./atoms"

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
import { OrchestratorChatHost } from "./orchestrator-chat-host"
import { orchestratorRouteAtom, selectedIssueIdAtom, orchestratorChatIdAtom } from "./atoms"
import { useEnsureFoundingEngineer } from "./use-ensure-founding-engineer"

/**
 * Orchestrator surface — multi-agent control plane.
 * Mounted as a parallel app mode alongside the existing Solo chat UI.
 *
 * Mode toggle:
 *   appModeAtom = "chat"          → existing AgentsLayout (Solo escape hatch)
 *   appModeAtom = "orchestrator"  → this layout (default for paperclip-style work)
 *
 * Main pane precedence (highest first):
 *   1. selectedIssueId set        → IssueDetailView
 *   2. orchestratorChatId set     → OrchestratorChatHost (embedded ChatView)
 *   3. otherwise                  → route view
 *
 * orchestratorChatId is transient: only set when the user explicitly opens a
 * thread/task. Cleared on Back or sidebar navigation.
 *
 * Routes: board, fe_chat, agent, inbox, dashboard, issues, agents, activity, repos.
 */
export function OrchestratorLayout() {
  const route = useAtomValue(orchestratorRouteAtom)
  const selectedIssueId = useAtomValue(selectedIssueIdAtom)
  const orchestratorChatId = useAtomValue(orchestratorChatIdAtom)
  // Auto-hires the Founding Engineer on first project load. Idempotent.
  useEnsureFoundingEngineer()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <OrchestratorSidebar />
      <main className="flex-1 overflow-hidden">
        {selectedIssueId ? (
          <IssueDetailView issueId={selectedIssueId} />
        ) : orchestratorChatId ? (
          <OrchestratorChatHost />
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

import { useAtomValue } from "jotai"
import { OrchestratorSidebar } from "./sidebar"
import { DashboardView } from "./dashboard-view"
import { IssuesView } from "./issues-view"
import { AgentsView } from "./agents-view"
import { ActivityView } from "./activity-view"
import { IssueDetailView } from "./issue-detail-view"
import { orchestratorRouteAtom, selectedIssueIdAtom } from "./atoms"
import { useEnsureFoundingEngineer } from "./use-ensure-founding-engineer"

/**
 * Orchestrator surface — the paperclip-style multi-agent control plane.
 * Mounted as a parallel app mode alongside the existing chat UI.
 *
 * Mode toggle:
 *   appModeAtom = "chat"          → existing AgentsLayout
 *   appModeAtom = "orchestrator"  → this layout
 *
 * Inside this surface, route is jotai-driven (not URL-based) — fits the
 * Electron single-window model. Future: hash-based routing if deep-linking matters.
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
        {/* Issue detail takes precedence over the route when an issue is selected,
            so clicking a row in any list opens the detail without changing the
            sidebar state. */}
        {selectedIssueId ? (
          <IssueDetailView issueId={selectedIssueId} />
        ) : (
          <>
            {route === "dashboard" && <DashboardView />}
            {route === "issues" && <IssuesView />}
            {route === "agents" && <AgentsView />}
            {route === "activity" && <ActivityView />}
          </>
        )}
      </main>
    </div>
  )
}

export { appModeAtom, orchestratorRouteAtom } from "./atoms"

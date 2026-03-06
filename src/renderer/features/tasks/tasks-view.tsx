import { useState, useMemo, useCallback } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { trpc } from "../../lib/trpc"
import { selectedProjectAtom, desktopViewAtom, selectedAgentChatIdAtom } from "../agents/atoms"
import { cn } from "../../lib/utils"
import { WorkOnTaskDialog } from "./work-on-task-dialog"
import { ExternalLink, ChevronLeft, Loader2, RefreshCw } from "lucide-react"

type Tab = "github" | "linear"
type GithubSubTab = "issues" | "pulls"

export function TasksView() {
  const [activeTab, setActiveTab] = useState<Tab>("github")

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <div className="flex gap-1 bg-muted rounded-md p-0.5">
          <button
            type="button"
            onClick={() => setActiveTab("github")}
            className={cn(
              "px-3 py-1 text-sm rounded-sm transition-colors",
              activeTab === "github"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            GitHub
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("linear")}
            className={cn(
              "px-3 py-1 text-sm rounded-sm transition-colors",
              activeTab === "linear"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Linear
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === "github" ? <GitHubTab /> : <LinearTab />}
      </div>
    </div>
  )
}

// ============================================================================
// GitHub Tab
// ============================================================================

function GitHubTab() {
  const { data: githubStatus } = trpc.integrations.getGithubStatus.useQuery()
  const { data: repos, isLoading: reposLoading } = trpc.tasks.github.listRepos.useQuery(
    undefined,
    { enabled: githubStatus?.isConnected === true }
  )

  const selectedProject = useAtomValue(selectedProjectAtom)
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<GithubSubTab>("issues")
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [workOnItem, setWorkOnItem] = useState<any>(null)

  // Auto-select repo matching current project
  const effectiveRepo = useMemo(() => {
    if (selectedRepo) return selectedRepo
    if (selectedProject?.gitOwner && selectedProject?.gitRepo) {
      const match = `${selectedProject.gitOwner}/${selectedProject.gitRepo}`
      if (repos?.some(r => r.full_name === match)) return match
    }
    return null
  }, [selectedRepo, selectedProject, repos])

  const [owner, repo] = effectiveRepo?.split("/") ?? [null, null]

  if (!githubStatus?.isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-sm">GitHub is not connected.</p>
        <p className="text-xs">Go to Settings &rarr; Integrations to connect your GitHub account.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Repo selector + sub-tabs */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <select
          value={effectiveRepo ?? ""}
          onChange={(e) => {
            setSelectedRepo(e.target.value || null)
            setSelectedItem(null)
          }}
          className="bg-muted border border-border rounded-md px-2 py-1.5 text-sm max-w-[300px] truncate"
        >
          <option value="">Select repository...</option>
          {reposLoading && <option disabled>Loading...</option>}
          {repos?.map((r) => (
            <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
          ))}
        </select>

        {effectiveRepo && (
          <div className="flex gap-1 bg-muted rounded-md p-0.5">
            <button
              type="button"
              onClick={() => { setSubTab("issues"); setSelectedItem(null) }}
              className={cn(
                "px-2.5 py-1 text-xs rounded-sm transition-colors",
                subTab === "issues"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Issues
            </button>
            <button
              type="button"
              onClick={() => { setSubTab("pulls"); setSelectedItem(null) }}
              className={cn(
                "px-2.5 py-1 text-xs rounded-sm transition-colors",
                subTab === "pulls"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Pull Requests
            </button>
          </div>
        )}
      </div>

      {!effectiveRepo ? (
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          Select a repository to browse issues and pull requests
        </div>
      ) : selectedItem ? (
        <GitHubDetailPanel
          owner={owner!}
          repo={repo!}
          item={selectedItem}
          type={subTab}
          onBack={() => setSelectedItem(null)}
          onWorkOn={() => setWorkOnItem(selectedItem)}
        />
      ) : (
        <GitHubList
          owner={owner!}
          repo={repo!}
          type={subTab}
          onSelect={setSelectedItem}
        />
      )}

      {workOnItem && (
        <WorkOnTaskDialog
          open={!!workOnItem}
          onOpenChange={(open) => !open && setWorkOnItem(null)}
          title={workOnItem.title}
          body={workOnItem.body ?? ""}
          sourceUrl={workOnItem.html_url}
          sourceType={subTab === "issues" ? "github-issue" : "github-pr"}
          sourceIdentifier={`#${workOnItem.number}`}
        />
      )}
    </div>
  )
}

function GitHubList({ owner, repo, type, onSelect }: {
  owner: string
  repo: string
  type: GithubSubTab
  onSelect: (item: any) => void
}) {
  const [page, setPage] = useState(1)

  const { data: issues, isLoading: issuesLoading, isFetching: issuesFetching, refetch: refetchIssues } = trpc.tasks.github.listIssues.useQuery(
    { owner, repo, state: "open", page },
    { enabled: type === "issues" }
  )
  const { data: pulls, isLoading: pullsLoading, isFetching: pullsFetching, refetch: refetchPulls } = trpc.tasks.github.listPullRequests.useQuery(
    { owner, repo, state: "open", page },
    { enabled: type === "pulls" }
  )

  const items = type === "issues" ? issues : pulls
  const isLoading = type === "issues" ? issuesLoading : pullsLoading
  const isFetching = type === "issues" ? issuesFetching : pullsFetching
  const refetch = type === "issues" ? refetchIssues : refetchPulls

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!items?.length) {
    return (
      <div className="flex flex-col flex-1">
        <div className="flex items-center justify-end px-6 py-2 border-b border-border">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
            {isFetching ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          No open {type === "issues" ? "issues" : "pull requests"} found
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      {/* Refresh bar */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground">
          {items.length} {type === "issues" ? "issue" : "pull request"}{items.length !== 1 ? "s" : ""}
        </span>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          {isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="divide-y divide-border">
        {items.map((item: any) => (
          <button
            key={item.number}
            type="button"
            onClick={() => onSelect(item)}
            className="w-full text-left px-6 py-3 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-start gap-3">
              <span className="text-xs text-muted-foreground font-mono mt-0.5">
                #{item.number}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{item.title}</span>
                  {type === "pulls" && item.draft && (
                    <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">
                      Draft
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {item.labels?.map((label: any) => (
                    <span
                      key={label.name ?? label.id}
                      className="text-[10px] px-1.5 py-0.5 rounded-full border border-border"
                      style={label.color ? { backgroundColor: `#${label.color}20`, color: `#${label.color}` } : undefined}
                    >
                      {label.name}
                    </span>
                  ))}
                  <span className="text-xs text-muted-foreground">
                    by {item.user?.login}
                  </span>
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-center gap-2 py-4">
        <button
          type="button"
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-3 py-1 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-xs text-muted-foreground">Page {page}</span>
        <button
          type="button"
          onClick={() => setPage(p => p + 1)}
          disabled={!items?.length || items.length < 30}
          className="px-3 py-1 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  )
}

function GitHubDetailPanel({ owner, repo, item, type, onBack, onWorkOn }: {
  owner: string
  repo: string
  item: any
  type: GithubSubTab
  onBack: () => void
  onWorkOn: () => void
}) {
  const { data: detail, isLoading } = type === "issues"
    ? trpc.tasks.github.getIssueDetail.useQuery({ owner, repo, number: item.number })
    : trpc.tasks.github.getPullRequestDetail.useQuery({ owner, repo, number: item.number })

  return (
    <div className="flex-1 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border sticky top-0 bg-background z-10">
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            #{item.number} {item.title}
          </div>
        </div>
        <a
          href={item.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onWorkOn}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          Work on this
        </button>
      </div>

      {/* Body */}
      <div className="px-6 py-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {detail?.body && (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <pre className="whitespace-pre-wrap text-sm text-foreground bg-muted/30 rounded-md p-4 overflow-auto">
                  {detail.body}
                </pre>
              </div>
            )}

            {type === "pulls" && detail?.diff && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground py-2">
                  View Diff
                </summary>
                <pre className="whitespace-pre-wrap bg-muted/30 rounded-md p-3 overflow-auto max-h-[400px] text-[11px]">
                  {detail.diff}
                </pre>
              </details>
            )}

            {/* Comments */}
            {detail?.comments?.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Comments ({detail.comments.length})</h3>
                {detail.comments.slice(-10).map((comment: any) => (
                  <div key={comment.id} className="border border-border rounded-md p-3 space-y-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">{comment.user?.login}</span>
                      <span>{new Date(comment.created_at).toLocaleDateString()}</span>
                    </div>
                    <pre className="whitespace-pre-wrap text-sm">{comment.body}</pre>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Linear Tab
// ============================================================================

function LinearTab() {
  const { data: linearStatus, error: linearStatusError } = trpc.integrations.getLinearStatus.useQuery()
  const { data: teams, isLoading: teamsLoading, error: teamsError } = trpc.tasks.linear.listTeams.useQuery(
    undefined,
    { enabled: linearStatus?.isConnected === true }
  )

  console.log("[TasksView:Linear] linearStatus:", linearStatus, "error:", linearStatusError)
  console.log("[TasksView:Linear] teams:", teams, "teamsLoading:", teamsLoading, "error:", teamsError)

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [workOnItem, setWorkOnItem] = useState<any>(null)

  const effectiveTeamId = selectedTeamId ?? teams?.[0]?.id ?? null
  console.log("[TasksView:Linear] effectiveTeamId:", effectiveTeamId, "selectedTeamId:", selectedTeamId)

  const { data: linearProjects, error: projectsError } = trpc.tasks.linear.listProjects.useQuery(
    { teamId: effectiveTeamId ?? undefined },
    { enabled: !!effectiveTeamId }
  )
  console.log("[TasksView:Linear] linearProjects:", linearProjects, "error:", projectsError)

  if (!linearStatus?.isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-sm">Linear is not connected.</p>
        <p className="text-xs">Go to Settings &rarr; Integrations to connect your Linear account.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <select
          value={effectiveTeamId ?? ""}
          onChange={(e) => {
            setSelectedTeamId(e.target.value || null)
            setSelectedProjectId(null)
            setSelectedItem(null)
          }}
          className="bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
        >
          {teamsLoading && <option disabled>Loading...</option>}
          {teams?.map((t) => (
            <option key={t.id} value={t.id}>{t.name} ({t.key})</option>
          ))}
        </select>

        {linearProjects && linearProjects.length > 0 && (
          <select
            value={selectedProjectId ?? ""}
            onChange={(e) => {
              setSelectedProjectId(e.target.value || null)
              setSelectedItem(null)
            }}
            className="bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
          >
            <option value="">All Projects</option>
            {linearProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {selectedItem ? (
        <LinearDetailPanel
          item={selectedItem}
          onBack={() => setSelectedItem(null)}
          onWorkOn={() => setWorkOnItem(selectedItem)}
        />
      ) : effectiveTeamId ? (
        <LinearList
          teamId={effectiveTeamId}
          projectId={selectedProjectId}
          onSelect={setSelectedItem}
        />
      ) : (
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          Select a team to browse issues
        </div>
      )}

      {workOnItem && (
        <WorkOnTaskDialog
          open={!!workOnItem}
          onOpenChange={(open) => !open && setWorkOnItem(null)}
          title={workOnItem.title}
          body={workOnItem.description ?? ""}
          sourceUrl={workOnItem.url}
          sourceType="linear-ticket"
          sourceIdentifier={workOnItem.identifier}
        />
      )}
    </div>
  )
}

function LinearList({ teamId, projectId, onSelect }: {
  teamId: string
  projectId: string | null
  onSelect: (item: any) => void
}) {
  const { data: issues, isLoading, isFetching, refetch, error: issuesError } = trpc.tasks.linear.listIssues.useQuery({
    teamId,
    projectId: projectId ?? undefined,
    limit: 50,
  })
  console.log("[TasksView:LinearList] teamId:", teamId, "projectId:", projectId, "issues:", issues?.length, "isLoading:", isLoading, "error:", issuesError)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!issues?.length) {
    return (
      <div className="flex flex-col flex-1">
        <div className="flex items-center justify-end px-6 py-2 border-b border-border">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
            {isFetching ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
          No issues found
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      {/* Refresh bar */}
      <div className="flex items-center justify-between px-6 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground">
          {issues.length} issue{issues.length !== 1 ? "s" : ""}
        </span>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          {isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="divide-y divide-border">
        {issues.map((issue: any) => (
          <button
            key={issue.id}
            type="button"
            onClick={() => onSelect(issue)}
            className="w-full text-left px-6 py-3 hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-start gap-3">
              <span className="text-xs text-muted-foreground font-mono mt-0.5">
                {issue.identifier}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">{issue.title}</span>
                <div className="flex items-center gap-2 mt-1">
                  {issue.state && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: issue.state.color ? `${issue.state.color}20` : undefined,
                        color: issue.state.color || undefined,
                      }}
                    >
                      {issue.state.name}
                    </span>
                  )}
                  {issue.priorityLabel && (
                    <span className="text-[10px] text-muted-foreground">
                      {issue.priorityLabel}
                    </span>
                  )}
                  {issue.assignee?.name && (
                    <span className="text-xs text-muted-foreground">
                      {issue.assignee.name}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function LinearDetailPanel({ item, onBack, onWorkOn }: {
  item: any
  onBack: () => void
  onWorkOn: () => void
}) {
  const { data: detail, isLoading } = trpc.tasks.linear.getIssueDetail.useQuery(
    { issueId: item.id }
  )

  return (
    <div className="flex-1 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border sticky top-0 bg-background z-10">
        <button type="button" onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {item.identifier} {item.title}
          </div>
        </div>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onWorkOn}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          Work on this
        </button>
      </div>

      {/* Body */}
      <div className="px-6 py-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {detail?.description && (
              <pre className="whitespace-pre-wrap text-sm text-foreground bg-muted/30 rounded-md p-4 overflow-auto">
                {detail.description}
              </pre>
            )}

            {/* Comments */}
            {detail?.comments?.nodes?.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">Comments ({detail.comments.nodes.length})</h3>
                {detail.comments.nodes.slice(-10).map((comment: any) => (
                  <div key={comment.id} className="border border-border rounded-md p-3 space-y-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium">{comment.user?.name}</span>
                      <span>{new Date(comment.createdAt).toLocaleDateString()}</span>
                    </div>
                    <pre className="whitespace-pre-wrap text-sm">{comment.body}</pre>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

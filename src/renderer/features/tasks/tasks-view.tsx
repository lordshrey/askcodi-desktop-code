import { useState, useMemo, useCallback } from "react"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { trpc } from "../../lib/trpc"
import { selectedProjectAtom, desktopViewAtom, selectedAgentChatIdAtom } from "../agents/atoms"
import { cn } from "../../lib/utils"
import { WorkOnTaskDialog } from "./work-on-task-dialog"
import { ChevronLeft, Clock, ExternalLink, GitBranch, Loader2, RefreshCw, X } from "lucide-react"
import { ResizableSidebar } from "../../components/ui/resizable-sidebar"
import { Popover, PopoverTrigger, PopoverContent } from "../../components/ui/popover"
import { formatTimeAgo } from "../../lib/utils/format-time-ago"

type Tab = "github" | "linear"
type GithubSubTab = "issues" | "pulls"

// ============================================================================
// Tracked Repos Atom
// ============================================================================

export type TrackedRepo = {
  full_name: string  // "owner/repo"
  name: string
  owner: string
}

export const trackedGithubReposAtom = atomWithStorage<TrackedRepo[]>(
  "tasks:trackedGithubRepos",
  [],
  undefined,
  { getOnInit: true },
)

export const githubReposSidebarWidthAtom = atomWithStorage<number>(
  "tasks:githubReposSidebarWidth",
  200,
  undefined,
  { getOnInit: true },
)

// ============================================================================
// Linked chat type for status badges
// ============================================================================

type LinkedChat = {
  id: string
  name: string | null
  sourceUrl: string | null
  sourceIdentifier: string | null
}

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
  const { data: repos } = trpc.tasks.github.listRepos.useQuery(
    undefined,
    { enabled: githubStatus?.isConnected === true }
  )

  const selectedProject = useAtomValue(selectedProjectAtom)
  const [trackedRepos, setTrackedRepos] = useAtom(trackedGithubReposAtom)
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<GithubSubTab>("issues")
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [workOnItem, setWorkOnItem] = useState<any>(null)

  // Auto-select repo: explicit selection > tracked repo matching project > first tracked > project match from full list
  const effectiveRepo = useMemo(() => {
    if (selectedRepo) return selectedRepo
    if (trackedRepos.length > 0 && selectedProject?.gitOwner && selectedProject?.gitRepo) {
      const match = `${selectedProject.gitOwner}/${selectedProject.gitRepo}`
      if (trackedRepos.some(r => r.full_name === match)) return match
    }
    if (trackedRepos.length > 0) return trackedRepos[0].full_name
    if (selectedProject?.gitOwner && selectedProject?.gitRepo) {
      const match = `${selectedProject.gitOwner}/${selectedProject.gitRepo}`
      if (repos?.some(r => r.full_name === match)) return match
    }
    return null
  }, [selectedRepo, selectedProject, repos, trackedRepos])

  const [owner, repo] = effectiveRepo?.split("/") ?? [null, null]

  const handleTrackRepo = useCallback((fullName: string) => {
    const [o, r] = fullName.split("/")
    if (!o || !r) return
    if (trackedRepos.some(tr => tr.full_name === fullName)) return
    setTrackedRepos([...trackedRepos, { full_name: fullName, owner: o, name: r }])
    setSelectedRepo(fullName)
    setSelectedItem(null)
  }, [trackedRepos, setTrackedRepos])

  const handleUntrackRepo = useCallback((fullName: string) => {
    setTrackedRepos(trackedRepos.filter(r => r.full_name !== fullName))
    if (selectedRepo === fullName) setSelectedRepo(null)
  }, [trackedRepos, setTrackedRepos, selectedRepo])

  const untrackedRepos = useMemo(() => {
    return repos?.filter(r => !trackedRepos.some(tr => tr.full_name === r.full_name)) ?? []
  }, [repos, trackedRepos])

  if (!githubStatus?.isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-sm">GitHub is not connected.</p>
        <p className="text-xs">Go to Settings &rarr; Integrations to connect your GitHub account.</p>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Repos Sidebar */}
      <ResizableSidebar
        isOpen={true}
        onClose={() => {}}
        widthAtom={githubReposSidebarWidthAtom}
        minWidth={160}
        maxWidth={300}
        side="left"
        disableClickToClose={true}
        className="border-r border-border"
      >
        <div className="flex flex-col h-full">
          <div className="px-3 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Repositories
          </div>
          <div className="flex-1 overflow-auto px-1.5">
            {trackedRepos.length === 0 ? (
              <div className="px-2 py-4 space-y-3">
                <p className="text-xs text-muted-foreground text-center">No repos pinned</p>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) handleTrackRepo(e.target.value)
                  }}
                  className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs"
                >
                  <option value="">Pin a repo...</option>
                  {untrackedRepos.map((r) => (
                    <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-0.5">
                {trackedRepos.map((tr) => (
                  <button
                    key={tr.full_name}
                    type="button"
                    onClick={() => { setSelectedRepo(tr.full_name); setSelectedItem(null) }}
                    className={cn(
                      "w-full text-left px-3 py-2 text-sm rounded-md transition-colors group",
                      effectiveRepo === tr.full_name ? "bg-foreground/5" : "hover:bg-foreground/5"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate flex-1 text-xs">{tr.full_name}</span>
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); handleUntrackRepo(tr.full_name) }}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Add Repo dropdown at bottom — opens upward */}
          {trackedRepos.length > 0 && (
            <div className="px-1.5 py-2 border-t border-border">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs text-left text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Pin a repo...
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="start" className="p-1 max-h-[240px] overflow-auto w-[var(--radix-popover-trigger-width)]">
                  {untrackedRepos.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No more repos</div>
                  ) : (
                    untrackedRepos.map((r) => (
                      <button
                        key={r.full_name}
                        type="button"
                        onClick={() => handleTrackRepo(r.full_name)}
                        className="w-full text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors truncate"
                      >
                        {r.full_name}
                      </button>
                    ))
                  )}
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      </ResizableSidebar>

      {/* Right Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Sub-tabs header */}
        {effectiveRepo && (
          <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
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
            <span className="text-xs text-muted-foreground truncate">{effectiveRepo}</span>
          </div>
        )}

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
      </div>

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
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)
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

  // Collect source URLs for batch lookup
  const sourceUrls = useMemo(() => {
    if (!items?.length) return []
    return items.map((item: any) => item.html_url as string)
  }, [items])

  const { data: linkedChats } = trpc.chats.getBySourceUrls.useQuery(
    { sourceUrls },
    { enabled: sourceUrls.length > 0 }
  )

  const linkedChatsMap = useMemo(() => {
    if (!linkedChats) return new Map<string, LinkedChat>()
    const map = new Map<string, LinkedChat>()
    for (const chat of linkedChats) {
      if (chat.sourceUrl) map.set(chat.sourceUrl, chat)
    }
    return map
  }, [linkedChats])

  const handleOpenWorkspace = useCallback((chatId: string) => {
    setSelectedChatId(chatId)
    setDesktopView(null)
  }, [setSelectedChatId, setDesktopView])

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
        {items.map((item: any) => {
          const linked = linkedChatsMap.get(item.html_url)
          return (
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
                    {type === "pulls" && item.head?.ref && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                        <GitBranch className="h-2.5 w-2.5" />
                        {item.head.ref}
                      </span>
                    )}
                    {linked && (
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); handleOpenWorkspace(linked.id) }}
                        className="text-[10px] bg-green-500/20 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded-full hover:bg-green-500/30 transition-colors cursor-pointer"
                      >
                        In Workspace
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
                    {item.created_at && (
                      <span className="text-[10px] text-muted-foreground" title={new Date(item.created_at).toLocaleString()}>
                        {formatTimeAgo(item.created_at)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
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
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)

  const { data: detail, isLoading } = type === "issues"
    ? trpc.tasks.github.getIssueDetail.useQuery({ owner, repo, number: item.number })
    : trpc.tasks.github.getPullRequestDetail.useQuery({ owner, repo, number: item.number })

  // Check if this task has a linked workspace
  const { data: linkedChats } = trpc.chats.getBySourceUrls.useQuery(
    { sourceUrls: [item.html_url] },
    { enabled: !!item.html_url }
  )
  const linkedChat = linkedChats?.[0]

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
        {linkedChat ? (
          <>
            <button
              type="button"
              onClick={() => { setSelectedChatId(linkedChat.id); setDesktopView(null) }}
              className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              Open Workspace
            </button>
            <button
              type="button"
              onClick={onWorkOn}
              className="px-3 py-1.5 text-xs font-medium bg-muted text-foreground rounded-md hover:bg-muted/80 transition-colors"
            >
              Work on this
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onWorkOn}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Work on this
          </button>
        )}
      </div>

      {/* Metadata */}
      <div className="px-6 py-3 border-b border-border flex flex-wrap items-center gap-3 text-xs">
        {item.state && (
          <span className={cn(
            "px-2 py-0.5 rounded-full font-medium",
            item.state === "open"
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : "bg-purple-500/15 text-purple-600 dark:text-purple-400"
          )}>
            {item.state}
          </span>
        )}
        {item.user && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {item.user.avatar_url && (
              <img src={item.user.avatar_url} alt="" className="h-4 w-4 rounded-full" />
            )}
            {item.user.login}
          </span>
        )}
        {item.labels?.length > 0 && item.labels.map((label: any) => (
          <span
            key={label.name ?? label.id}
            className="px-1.5 py-0.5 rounded-full text-[10px] border border-border"
            style={label.color ? { backgroundColor: `#${label.color}20`, color: `#${label.color}` } : undefined}
          >
            {label.name}
          </span>
        ))}
        {type === "pulls" && item.head?.ref && (
          <span className="flex items-center gap-1 text-muted-foreground font-mono text-[11px]">
            <GitBranch className="h-3 w-3" />
            {item.head.ref} &larr; {item.base?.ref}
          </span>
        )}
        {item.created_at && (
          <span className="flex items-center gap-1 text-muted-foreground" title={new Date(item.created_at).toLocaleString()}>
            <Clock className="h-3 w-3" />
            created {formatTimeAgo(item.created_at)}
          </span>
        )}
        {item.updated_at && item.updated_at !== item.created_at && (
          <span className="text-muted-foreground" title={new Date(item.updated_at).toLocaleString()}>
            updated {formatTimeAgo(item.updated_at)}
          </span>
        )}
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
                      <span title={new Date(comment.created_at).toLocaleString()}>{formatTimeAgo(comment.created_at)}</span>
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
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)

  const { data: issues, isLoading, isFetching, refetch, error: issuesError } = trpc.tasks.linear.listIssues.useQuery({
    teamId,
    projectId: projectId ?? undefined,
    limit: 50,
  })
  console.log("[TasksView:LinearList] teamId:", teamId, "projectId:", projectId, "issues:", issues?.length, "isLoading:", isLoading, "error:", issuesError)

  // Collect source URLs for batch lookup
  const sourceUrls = useMemo(() => {
    if (!issues?.length) return []
    return issues.map((issue: any) => issue.url as string)
  }, [issues])

  const { data: linkedChats } = trpc.chats.getBySourceUrls.useQuery(
    { sourceUrls },
    { enabled: sourceUrls.length > 0 }
  )

  const linkedChatsMap = useMemo(() => {
    if (!linkedChats) return new Map<string, LinkedChat>()
    const map = new Map<string, LinkedChat>()
    for (const chat of linkedChats) {
      if (chat.sourceUrl) map.set(chat.sourceUrl, chat)
    }
    return map
  }, [linkedChats])

  const handleOpenWorkspace = useCallback((chatId: string) => {
    setSelectedChatId(chatId)
    setDesktopView(null)
  }, [setSelectedChatId, setDesktopView])

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
        {issues.map((issue: any) => {
          const linked = linkedChatsMap.get(issue.url)
          return (
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
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{issue.title}</span>
                    {linked && (
                      <span
                        role="button"
                        onClick={(e) => { e.stopPropagation(); handleOpenWorkspace(linked.id) }}
                        className="text-[10px] bg-green-500/20 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded-full hover:bg-green-500/30 transition-colors cursor-pointer"
                      >
                        In Workspace
                      </span>
                    )}
                  </div>
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
                    {issue.labels?.nodes?.map((label: any) => (
                      <span
                        key={label.id ?? label.name}
                        className="text-[10px] px-1.5 py-0.5 rounded-full border border-border"
                        style={label.color ? { backgroundColor: `${label.color}20`, color: label.color } : undefined}
                      >
                        {label.name}
                      </span>
                    ))}
                    {issue.updatedAt && (
                      <span className="text-[10px] text-muted-foreground" title={new Date(issue.updatedAt).toLocaleString()}>
                        {formatTimeAgo(issue.updatedAt)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LinearDetailPanel({ item, onBack, onWorkOn }: {
  item: any
  onBack: () => void
  onWorkOn: () => void
}) {
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)

  const { data: detail, isLoading } = trpc.tasks.linear.getIssueDetail.useQuery(
    { issueId: item.id }
  )

  // Check if this task has a linked workspace
  const { data: linkedChats } = trpc.chats.getBySourceUrls.useQuery(
    { sourceUrls: [item.url] },
    { enabled: !!item.url }
  )
  const linkedChat = linkedChats?.[0]

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
        {linkedChat ? (
          <>
            <button
              type="button"
              onClick={() => { setSelectedChatId(linkedChat.id); setDesktopView(null) }}
              className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              Open Workspace
            </button>
            <button
              type="button"
              onClick={onWorkOn}
              className="px-3 py-1.5 text-xs font-medium bg-muted text-foreground rounded-md hover:bg-muted/80 transition-colors"
            >
              Work on this
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onWorkOn}
            className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Work on this
          </button>
        )}
      </div>

      {/* Metadata */}
      <div className="px-6 py-3 border-b border-border flex flex-wrap items-center gap-3 text-xs">
        {(item.state || detail?.state) && (() => {
          const state = item.state || detail?.state
          return (
            <span
              className="px-2 py-0.5 rounded-full font-medium"
              style={{
                backgroundColor: state.color ? `${state.color}20` : undefined,
                color: state.color || undefined,
              }}
            >
              {state.name}
            </span>
          )
        })()}
        {item.priorityLabel && (
          <span className="text-muted-foreground">{item.priorityLabel}</span>
        )}
        {item.assignee?.name && (
          <span className="text-muted-foreground">{item.assignee.name}</span>
        )}
        {item.labels?.nodes?.map((label: any) => (
          <span
            key={label.id ?? label.name}
            className="px-1.5 py-0.5 rounded-full text-[10px] border border-border"
            style={label.color ? { backgroundColor: `${label.color}20`, color: label.color } : undefined}
          >
            {label.name}
          </span>
        ))}
        {item.createdAt && (
          <span className="flex items-center gap-1 text-muted-foreground" title={new Date(item.createdAt).toLocaleString()}>
            <Clock className="h-3 w-3" />
            created {formatTimeAgo(item.createdAt)}
          </span>
        )}
        {item.updatedAt && item.updatedAt !== item.createdAt && (
          <span className="text-muted-foreground" title={new Date(item.updatedAt).toLocaleString()}>
            updated {formatTimeAgo(item.updatedAt)}
          </span>
        )}
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
                      <span title={new Date(comment.createdAt).toLocaleString()}>{formatTimeAgo(comment.createdAt)}</span>
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

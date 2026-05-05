import { useAtom } from "jotai"
import { useMemo, useState } from "react"
import {
  ArrowLeft,
  Loader2,
  Play,
  Bot,
  User as UserIcon,
  ChevronRight,
  ChevronLeft,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { selectedIssueIdAtom } from "./atoms"
import { IssueChatHost } from "./issue-chat-host"
import { RunConsole } from "./run-console"
import {
  ISSUE_STATUS_META,
  RUN_STATUS_DOT,
  isTerminalIssueStatus,
  timeAgo,
} from "./status-meta"

type IssueDetailData = RouterOutputs["issues"]["get"]
type RunRow = NonNullable<IssueDetailData>["runs"][number]
type AgentRow = RouterOutputs["runtimeAgents"]["list"][number]

function StatusBadge({ status }: { status: string }) {
  const meta = ISSUE_STATUS_META[status] ?? ISSUE_STATUS_META.backlog
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border border-border bg-background/50 px-2 py-0.5 text-xs", meta.color)}>
      <meta.Icon className="h-3 w-3" />
      {meta.label}
    </span>
  )
}

function AgentChip({ agent }: { agent: AgentRow | undefined }) {
  if (!agent) return <span className="text-xs text-muted-foreground">unassigned</span>
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold">
        {agent.icon ?? agent.name.slice(0, 2).toUpperCase()}
      </span>
      {agent.name}
      {agent.isFounding && (
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] uppercase text-amber-400">
          founding
        </span>
      )}
    </span>
  )
}

interface IssueDetailViewProps {
  issueId: string
}

/**
 * Issue surface. Layout:
 *   ┌─ Header ─────────────────────────────────────┐
 *   │ Issue meta + Run button                       │
 *   ├──────────────────────────────────┬───────────┤
 *   │  CHAT (embedded ChatView via     │  Side     │
 *   │  IssueChatHost; multi-chat tab   │  panel:   │
 *   │  strip when ≥ 2 chats; one chat  │  Plan/    │
 *   │  per "agent session" on this     │  Diff/    │
 *   │  issue)                          │  Runs/    │
 *   │                                  │  Comments │
 *   └──────────────────────────────────┴───────────┘
 *
 * Comments stay readable in a Comments side-panel tab — they arrive from the
 * MCP `addComment` tool and represent durable annotations from agents. The
 * chat surface is for conversation; the Comments tab is the audit trail.
 *
 * Side panel collapses to a thin gutter to give chat full width.
 */
export function IssueDetailView({ issueId }: IssueDetailViewProps) {
  const [, setSelectedIssueId] = useAtom(selectedIssueIdAtom)
  const utils = trpc.useUtils()

  const { data, isLoading } = trpc.issues.get.useQuery(
    { id: issueId },
    {
      refetchInterval: (q) => {
        const d = q.state.data as RouterOutputs["issues"]["get"]
        if (!d) return 5000
        if (!isTerminalIssueStatus(d.issue.status)) return 5000
        const liveRun = d.runs.find(
          (r) => r.status === "running" || r.status === "queued",
        )
        return liveRun ? 5000 : false
      },
      refetchIntervalInBackground: false,
    },
  )
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery()
  const agentById = useMemo(() => {
    const m = new Map<string, AgentRow>()
    for (const a of agents) m.set(a.id, a)
    return m
  }, [agents])

  const runMutation = trpc.issues.run.useMutation({
    onSuccess: () => {
      void utils.issues.list.invalidate()
      void utils.issues.get.invalidate({ id: issueId })
      void utils.agentRuns.list.invalidate()
    },
  })

  const [sideTab, setSideTab] = useState<"plan" | "diff" | "runs" | "comments" | "details">("plan")
  const [sideCollapsed, setSideCollapsed] = useState(false)

  if (isLoading || !data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {isLoading ? "Loading..." : "Issue not found"}
      </div>
    )
  }

  const { issue, comments, runs, documents, blockers } = data
  const assignee = issue.assigneeRuntimeAgentId
    ? agentById.get(issue.assigneeRuntimeAgentId)
    : undefined
  const planDoc = documents.find((d) => d.key === "plan")
  const otherDocs = documents.filter((d) => d.key !== "plan")
  const canRun = !!issue.assigneeRuntimeAgentId && issue.status !== "done" && issue.status !== "cancelled"
  const liveRun = runs.find((r) => r.status === "running" || r.status === "queued")

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <button
          type="button"
          onClick={() => setSelectedIssueId(null)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        {canRun && (
          <Button
            size="sm"
            className="gap-1.5"
            disabled={runMutation.isPending}
            onClick={() => runMutation.mutate({ issueId })}
          >
            {runMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Run
          </Button>
        )}
      </header>

      <div className="border-b border-border px-6 py-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
          <StatusBadge status={issue.status} />
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground capitalize">{issue.priority}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <AgentChip agent={assignee} />
          <span className="ml-auto text-xs text-muted-foreground">
            Updated {timeAgo(issue.updatedAt)}
          </span>
        </div>
        <h1 className="text-xl font-semibold leading-tight">{issue.title}</h1>
      </div>

      {/* Two-column body: chat left, side panel right */}
      <div className="flex flex-1 overflow-hidden">
        {/* CHAT (primary): IssueChatHost mounts ChatView for the issue's chats. */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <IssueChatHost issueId={issueId} />
        </div>

        {/* Side panel: Plan / Diff / Runs / Comments / Details */}
        <div
          className={cn(
            "flex flex-col border-l border-border transition-all",
            sideCollapsed ? "w-10" : "w-[400px]",
          )}
        >
          <button
            type="button"
            onClick={() => setSideCollapsed((v) => !v)}
            className="flex items-center justify-center border-b border-border py-2 text-muted-foreground hover:bg-muted/40"
            title={sideCollapsed ? "Expand panel" : "Collapse panel"}
          >
            {sideCollapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {!sideCollapsed && (
            <Tabs value={sideTab} onValueChange={(v) => setSideTab(v as typeof sideTab)} className="flex flex-1 flex-col overflow-hidden">
              <TabsList className="h-9 w-full justify-start rounded-none border-b border-border bg-transparent px-2">
                <TabsTrigger value="plan" className="text-xs data-[state=active]:bg-muted">
                  Plan {planDoc && <span className="ml-1 text-[9px] text-muted-foreground">v{planDoc.revision}</span>}
                </TabsTrigger>
                <TabsTrigger value="diff" className="text-xs data-[state=active]:bg-muted">
                  Diff
                </TabsTrigger>
                <TabsTrigger value="runs" className="text-xs data-[state=active]:bg-muted">
                  Runs {runs.length > 0 && <span className="ml-1 text-[9px] text-muted-foreground">{runs.length}</span>}
                </TabsTrigger>
                <TabsTrigger value="comments" className="text-xs data-[state=active]:bg-muted">
                  Comments {comments.length > 0 && <span className="ml-1 text-[9px] text-muted-foreground">{comments.length}</span>}
                </TabsTrigger>
                <TabsTrigger value="details" className="text-xs data-[state=active]:bg-muted">
                  Details
                </TabsTrigger>
              </TabsList>

              <TabsContent value="plan" className="mt-0 flex-1 overflow-y-auto border-0 p-4">
                {planDoc ? (
                  <>
                    <div className="mb-3 text-[11px] text-muted-foreground">
                      Revision {planDoc.revision} · updated {timeAgo(planDoc.updatedAt)}
                    </div>
                    <div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                      {planDoc.content}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground italic">
                    No plan yet. The agent will write one with{" "}
                    <code className="rounded bg-muted px-1 py-0.5">askcodi__upsertIssueDocument</code>.
                  </div>
                )}
              </TabsContent>

              <TabsContent value="diff" className="mt-0 flex-1 overflow-hidden border-0 p-0">
                <DiffPanel
                  issueId={issueId}
                  agentId={issue.assigneeRuntimeAgentId ?? null}
                  hasLiveRun={!!liveRun}
                />
              </TabsContent>

              <TabsContent value="runs" className="mt-0 flex-1 overflow-y-auto border-0 p-4">
                {liveRun && (
                  <div className="mb-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className={cn("h-2 w-2 rounded-full", RUN_STATUS_DOT[liveRun.status])} />
                      <span className="text-[10px] font-medium uppercase tracking-wider">Live run</span>
                    </div>
                    <RunConsole runId={liveRun.id} />
                  </div>
                )}
                {runs.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">No runs yet.</div>
                ) : (
                  <ul className="space-y-2">
                    {runs.map((r) => (
                      <RunRow key={r.id} run={r} />
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="comments" className="mt-0 flex-1 overflow-y-auto border-0 p-4">
                {comments.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">
                    No comments. Agents post here via{" "}
                    <code className="rounded bg-muted px-1 py-0.5">askcodi__addComment</code>.
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {comments.map((c) => {
                      const author = c.authorRuntimeAgentId
                        ? agentById.get(c.authorRuntimeAgentId)
                        : undefined
                      return (
                        <li
                          key={c.id}
                          className={cn(
                            "rounded-lg border p-2.5 text-xs",
                            c.isFromUser
                              ? "border-primary/30 bg-primary/5"
                              : "border-border bg-card/30",
                          )}
                        >
                          <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            {c.isFromUser ? (
                              <>
                                <UserIcon className="h-2.5 w-2.5" />
                                <span>You</span>
                              </>
                            ) : (
                              <>
                                <Bot className="h-2.5 w-2.5" />
                                <span>{author?.name ?? "(deleted agent)"}</span>
                              </>
                            )}
                            <span>·</span>
                            <span>{timeAgo(c.createdAt)}</span>
                          </div>
                          <div className="whitespace-pre-wrap leading-relaxed">{c.body}</div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="details" className="mt-0 flex-1 overflow-y-auto border-0 p-4">
                {issue.description && (
                  <section className="mb-4">
                    <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Description
                    </h3>
                    <div className="whitespace-pre-wrap text-xs leading-relaxed">{issue.description}</div>
                  </section>
                )}
                {blockers.length > 0 && (
                  <section className="mb-4">
                    <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Blocked by
                    </h3>
                    <ul className="space-y-1 text-xs">
                      {blockers.map((b) => (
                        <li key={b.blocker.id} className="flex items-center gap-2">
                          <StatusBadge status={b.blocker.status} />
                          <span className="font-mono text-[10px] text-muted-foreground">{b.blocker.identifier}</span>
                          <span className="truncate">{b.blocker.title}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {otherDocs.length > 0 && (
                  <section>
                    <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Documents
                    </h3>
                    <ul className="space-y-1 text-xs text-muted-foreground">
                      {otherDocs.map((d) => (
                        <li key={d.id}>
                          <span className="font-mono">{d.key}</span> · v{d.revision} · {timeAgo(d.updatedAt)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  )
}

function DiffPanel({
  issueId,
  agentId,
  hasLiveRun,
}: {
  issueId: string
  agentId: string | null
  hasLiveRun: boolean
}) {
  const { data: worktrees = [] } = trpc.agentWorktrees.list.useQuery(
    { issueId, openOnly: true },
    { enabled: !!agentId },
  )
  // Schema enforces ≤ 1 open worktree per (agent, repo, issue) via the
  // agent_worktrees_open_uq partial unique index — taking [0] is safe.
  const worktree = worktrees[0]
  // Only poll the diff while a run is in flight; once terminal, the diff is
  // static until the next run starts.
  const { data: diffData } = trpc.agentWorktrees.diff.useQuery(
    worktree ? { worktreeId: worktree.id } : ({ worktreeId: "" } as { worktreeId: string }),
    {
      enabled: !!worktree,
      refetchInterval: hasLiveRun ? 5000 : false,
      refetchIntervalInBackground: false,
    },
  )

  if (!agentId) {
    return (
      <div className="p-4 text-xs text-muted-foreground italic">
        Assign an agent to this issue to track changes.
      </div>
    )
  }
  if (!worktree) {
    return (
      <div className="p-4 text-xs text-muted-foreground italic">
        No worktree yet. The agent provisions one when they start work on this issue.
      </div>
    )
  }
  if (!diffData) {
    return <div className="p-4 text-xs text-muted-foreground italic">Loading diff…</div>
  }
  if ("error" in diffData && diffData.error) {
    return <div className="p-4 text-xs text-red-400">Diff failed: {diffData.error}</div>
  }
  if (diffData.bytes === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground italic">
        No changes yet on branch <code className="rounded bg-muted px-1">{worktree.branch}</code>.
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
        <span className="font-mono">{worktree.branch}</span> ↔ <span className="font-mono">{worktree.baseBranch}</span>
        {diffData.truncated && <span className="ml-2 text-amber-500">truncated at 256kB</span>}
      </div>
      <pre className="flex-1 overflow-auto whitespace-pre p-3 font-mono text-[10px] leading-relaxed">
        {diffData.diff}
      </pre>
    </div>
  )
}

function RunRow({ run }: { run: RunRow }) {
  const [expanded, setExpanded] = useState(false)
  const usage = run.usageJson
  return (
    <li className="rounded-lg border border-border bg-card/30 p-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", RUN_STATUS_DOT[run.status])} />
        <span className="text-xs capitalize">{run.status.replace("_", " ")}</span>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {run.startedAt
            ? `${Math.max(1, Math.round((+new Date(run.finishedAt ?? new Date()) - +new Date(run.startedAt)) / 1000))}s`
            : "queued"}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-1.5 text-[10px]">
          {run.error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-1.5 text-red-400">
              {run.errorCode && <span className="font-mono">[{run.errorCode}]</span>} {run.error}
            </div>
          )}
          {usage && (
            <div className="text-muted-foreground tabular-nums">
              {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out
            </div>
          )}
        </div>
      )}
    </li>
  )
}

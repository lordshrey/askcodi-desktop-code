import { useAtom } from "jotai"
import { useMemo, useState } from "react"
import {
  ArrowLeft,
  Loader2,
  Play,
  Send,
  Bot,
  User as UserIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { selectedIssueIdAtom } from "./atoms"
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

export function IssueDetailView({ issueId }: IssueDetailViewProps) {
  const [, setSelectedIssueId] = useAtom(selectedIssueIdAtom)
  const utils = trpc.useUtils()

  const { data, isLoading } = trpc.issues.get.useQuery(
    { id: issueId },
    {
      // Stop polling once the issue is terminal AND no run is in flight — saves
      // 5 SQLite reads per 5s while a closed issue is just being read.
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
  const updateMutation = trpc.issues.update.useMutation({
    onSuccess: () => {
      void utils.issues.list.invalidate()
      void utils.issues.get.invalidate({ id: issueId })
    },
  })
  const addCommentMutation = trpc.issues.addComment.useMutation({
    onSuccess: () => {
      void utils.issues.get.invalidate({ id: issueId })
      setNewComment("")
    },
  })

  const [newComment, setNewComment] = useState("")
  const [activeTab, setActiveTab] = useState("overview")

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
          Back to issues
        </button>
        <div className="flex items-center gap-2">
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
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
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

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1">
          <div className="border-b border-border px-6">
            <TabsList className="h-9 bg-transparent p-0">
              <TabsTrigger value="overview" className="data-[state=active]:bg-muted">
                Overview
              </TabsTrigger>
              <TabsTrigger value="plan" className="data-[state=active]:bg-muted">
                Plan {planDoc && <span className="ml-1 text-[10px] text-muted-foreground">v{planDoc.revision}</span>}
              </TabsTrigger>
              <TabsTrigger value="comments" className="data-[state=active]:bg-muted">
                Comments {comments.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground">{comments.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="runs" className="data-[state=active]:bg-muted">
                Runs {runs.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground">{runs.length}</span>}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-0 border-0 p-6">
            {issue.description ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{issue.description}</div>
            ) : (
              <div className="text-sm text-muted-foreground italic">No description.</div>
            )}

            {blockers.length > 0 && (
              <section className="mt-6">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Blocked by
                </h3>
                <ul className="space-y-1 text-sm">
                  {blockers.map((b) => (
                    <li key={b.blocker.id} className="flex items-center gap-2">
                      <StatusBadge status={b.blocker.status} />
                      <span className="font-mono text-xs text-muted-foreground">{b.blocker.identifier}</span>
                      <span>{b.blocker.title}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {otherDocs.length > 0 && (
              <section className="mt-6">
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Documents
                </h3>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {otherDocs.map((d) => (
                    <li key={d.id}>
                      <span className="font-mono text-xs">{d.key}</span> · v{d.revision} · {timeAgo(d.updatedAt)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </TabsContent>

          <TabsContent value="plan" className="mt-0 border-0 p-6">
            {planDoc ? (
              <>
                <div className="mb-3 text-xs text-muted-foreground">
                  Revision {planDoc.revision} · updated {timeAgo(planDoc.updatedAt)}
                </div>
                <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{planDoc.content}</div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground italic">
                The assigned agent hasn't written a plan yet. They'll typically call{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">askcodi__upsertIssueDocument</code> with{" "}
                key="plan" once they understand the work.
              </div>
            )}
          </TabsContent>

          <TabsContent value="comments" className="mt-0 border-0">
            <div className="px-6 pb-3 pt-6">
              {comments.length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No comments yet.</div>
              ) : (
                <ul className="space-y-3">
                  {comments.map((c) => {
                    const author = c.authorRuntimeAgentId
                      ? agentById.get(c.authorRuntimeAgentId)
                      : undefined
                    return (
                      <li key={c.id} className="rounded-lg border border-border bg-card/30 p-3">
                        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {c.isFromUser ? (
                            <>
                              <UserIcon className="h-3 w-3" />
                              <span>You</span>
                            </>
                          ) : (
                            <>
                              <Bot className="h-3 w-3" />
                              <span>{author?.name ?? "(deleted agent)"}</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{timeAgo(c.createdAt)}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-sm">{c.body}</div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-border px-6 py-3">
              <Textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add a comment..."
                className="min-h-[80px] text-sm"
              />
              <div className="mt-2 flex justify-end">
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={addCommentMutation.isPending || newComment.trim().length === 0}
                  onClick={() =>
                    addCommentMutation.mutate({ issueId, body: newComment.trim() })
                  }
                >
                  {addCommentMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Comment
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="runs" className="mt-0 border-0 p-6">
            {liveRun && (
              <section className="mb-6">
                <div className="mb-2 flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", RUN_STATUS_DOT[liveRun.status])} />
                  <span className="text-sm font-medium">Live run · {liveRun.status}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {liveRun.startedAt ? `started ${timeAgo(liveRun.startedAt)}` : "queued"}
                  </span>
                </div>
                <RunConsole runId={liveRun.id} />
              </section>
            )}

            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              History
            </h3>
            {runs.length === 0 ? (
              <div className="text-sm text-muted-foreground italic">No runs yet. Click Run to start one.</div>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function RunRow({ run }: { run: RunRow }) {
  const [expanded, setExpanded] = useState(false)
  const usage = run.usageJson
  return (
    <li className="rounded-lg border border-border bg-card/30 p-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={cn("h-2 w-2 rounded-full", RUN_STATUS_DOT[run.status])} />
        <span className="text-sm capitalize">{run.status.replace("_", " ")}</span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs text-muted-foreground">
          {run.startedAt
            ? `${timeAgo(run.startedAt)}${run.finishedAt ? ` · ${Math.max(1, Math.round((+new Date(run.finishedAt) - +new Date(run.startedAt)) / 1000))}s` : ""}`
            : `queued ${timeAgo(run.createdAt)}`}
        </span>
        {usage && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-2 text-xs">
          {run.error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-red-400">
              {run.errorCode ? <span className="font-mono">[{run.errorCode}]</span> : null} {run.error}
            </div>
          )}
          {run.stdoutExcerpt && (
            <div>
              <div className="mb-1 text-muted-foreground">stdout (last)</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-background/50 p-2 font-mono text-[11px] leading-relaxed">
                {run.stdoutExcerpt}
              </pre>
            </div>
          )}
          {run.stderrExcerpt && (
            <div>
              <div className="mb-1 text-muted-foreground">stderr (last)</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-red-500/20 bg-red-500/5 p-2 font-mono text-[11px] leading-relaxed">
                {run.stderrExcerpt}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

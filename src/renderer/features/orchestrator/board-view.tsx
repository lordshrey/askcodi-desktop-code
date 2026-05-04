import { useMemo, useState } from "react"
import { useSetAtom, useAtomValue } from "jotai"
import { Plus, Search, Play } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { selectedIssueIdAtom, selectedRuntimeAgentIdAtom } from "./atoms"
import { NewIssueDialog } from "./new-issue-dialog"
import { ISSUE_STATUS_META, timeAgo } from "./status-meta"

type IssueRow = RouterOutputs["issues"]["list"][number]
type AgentRow = RouterOutputs["runtimeAgents"]["list"][number]

const PRIORITY_DOT: Record<string, string> = {
  urgent: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-muted-foreground",
}

// Columns shown on the kanban board, left-to-right.
const COLUMNS: { status: string; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
]

interface BoardViewProps {
  /** When set, only issues assigned to this agent are shown. Used by the
   *  per-agent surface to scope the board. */
  filterAgentId?: string | null
  /** Optional title override (e.g. "Sara's Tasks"). */
  title?: string
}

/**
 * Kanban-style project board. Replaces the dashboard as the orchestrator home.
 *
 * Default mode = all issues across all agents. Agent-scoped mode (when
 * `filterAgentId` is set) shows only that agent's issues.
 */
export function BoardView({ filterAgentId, title }: BoardViewProps = {}) {
  const [search, setSearch] = useState("")
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const setSelectedIssueId = useSetAtom(selectedIssueIdAtom)
  const selectedAgentId = useAtomValue(selectedRuntimeAgentIdAtom)
  const effectiveFilter = filterAgentId ?? selectedAgentId

  const { data: issues = [] } = trpc.issues.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery()
  const utils = trpc.useUtils()
  const runMutation = trpc.issues.run.useMutation({
    onSuccess: () => {
      void utils.issues.list.invalidate()
      void utils.agentRuns.list.invalidate()
    },
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let result = issues
    if (effectiveFilter) {
      result = result.filter((i) => i.assigneeRuntimeAgentId === effectiveFilter)
    }
    if (q) {
      result = result.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.identifier.toLowerCase().includes(q) ||
          (i.description ?? "").toLowerCase().includes(q),
      )
    }
    return result
  }, [issues, search, effectiveFilter])

  const byColumn = useMemo(() => {
    const m = new Map<string, IssueRow[]>()
    for (const col of COLUMNS) m.set(col.status, [])
    for (const issue of filtered) {
      const list = m.get(issue.status) ?? m.get("backlog")!
      list.push(issue)
    }
    return m
  }, [filtered])

  const agentById = useMemo(() => {
    const m = new Map<string, AgentRow>()
    for (const a of agents) m.set(a.id, a)
    return m
  }, [agents])

  const headerTitle = title ?? "Project Board"

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold uppercase tracking-wider">{headerTitle}</h1>
        <div className="text-xs text-muted-foreground">
          {filtered.length} of {issues.length}
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-border px-6 py-2">
        <Button size="sm" variant="default" className="gap-1.5" onClick={() => setNewIssueOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New Issue
        </Button>
        <div className="relative ml-2 flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search issues..."
            className="h-9 pl-8 text-sm"
          />
        </div>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full gap-3 p-3">
          {COLUMNS.map((col) => {
            const items = byColumn.get(col.status) ?? []
            const meta = ISSUE_STATUS_META[col.status]!
            return (
              <div
                key={col.status}
                className="flex h-full w-72 shrink-0 flex-col rounded-lg border border-border bg-card/30"
              >
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider">
                    <meta.Icon className={cn("h-3.5 w-3.5", meta.color)} />
                    {col.label}
                  </div>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                    {items.length}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  {items.length === 0 ? (
                    <div className="px-2 py-3 text-[11px] italic text-muted-foreground/60">
                      Nothing here.
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {items.map((issue) => {
                        const assignee = issue.assigneeRuntimeAgentId
                          ? agentById.get(issue.assigneeRuntimeAgentId)
                          : null
                        return (
                          <li
                            key={issue.id}
                            className="cursor-pointer rounded-md border border-border bg-background/60 p-2 text-xs hover:border-foreground/30"
                            onClick={() => setSelectedIssueId(issue.id)}
                          >
                            <div className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  PRIORITY_DOT[issue.priority] ?? PRIORITY_DOT.medium,
                                )}
                              />
                              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                                {issue.identifier}
                              </span>
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                {timeAgo(issue.updatedAt)}
                              </span>
                            </div>
                            <div className="mt-1 line-clamp-2 text-[12px] leading-snug">
                              {issue.title}
                            </div>
                            <div className="mt-2 flex items-center gap-1.5">
                              {assignee && (
                                <span
                                  className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold"
                                  title={assignee.name}
                                >
                                  {assignee.icon ?? assignee.name.slice(0, 2).toUpperCase()}
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground">
                                {assignee?.name ?? "Unassigned"}
                              </span>
                              {issue.assigneeRuntimeAgentId &&
                                issue.status !== "done" &&
                                issue.status !== "cancelled" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="ml-auto h-6 w-6 p-0"
                                    disabled={runMutation.isPending}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      runMutation.mutate({ issueId: issue.id })
                                    }}
                                    title="Run agent on this issue"
                                  >
                                    <Play className="h-3 w-3" />
                                  </Button>
                                )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <NewIssueDialog open={newIssueOpen} onOpenChange={setNewIssueOpen} />
    </div>
  )
}

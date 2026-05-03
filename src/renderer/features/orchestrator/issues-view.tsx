import { useMemo, useState } from "react"
import { useSetAtom } from "jotai"
import { Plus, Search, Play, Circle, CircleDot, CircleCheck, CircleX, CircleDashed } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { selectedIssueIdAtom } from "./atoms"
import { NewIssueDialog } from "./new-issue-dialog"
import { formatTimeAgo } from "@/lib/utils/format-time-ago"

type IssueRow = RouterOutputs["issues"]["list"][number]
type AgentRow = RouterOutputs["runtimeAgents"]["list"][number]

const STATUS_META: Record<string, { Icon: typeof Circle; color: string; label: string }> = {
  backlog: { Icon: Circle, color: "text-muted-foreground", label: "Backlog" },
  todo: { Icon: Circle, color: "text-rose-400", label: "Todo" },
  in_progress: { Icon: CircleDot, color: "text-amber-400", label: "In progress" },
  in_review: { Icon: CircleDashed, color: "text-blue-400", label: "In review" },
  blocked: { Icon: CircleX, color: "text-red-500", label: "Blocked" },
  done: { Icon: CircleCheck, color: "text-emerald-500", label: "Done" },
  cancelled: { Icon: CircleX, color: "text-muted-foreground", label: "Cancelled" },
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-amber-500",
  low: "bg-muted-foreground",
}

const timeAgo = (d: Date | string | null | undefined) =>
  formatTimeAgo(d, { suffix: " ago", nullLabel: "—" })

export function IssuesView() {
  const [search, setSearch] = useState("")
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const setSelectedId = useSetAtom(selectedIssueIdAtom)

  const { data: issues = [], refetch } = trpc.issues.list.useQuery(undefined, {
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
    if (!q) return issues
    return issues.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.identifier.toLowerCase().includes(q) ||
        (i.description ?? "").toLowerCase().includes(q),
    )
  }, [issues, search])

  // Group: roots first, then their children. Single-level nesting for MVP.
  const tree = useMemo(() => {
    const byParent = new Map<string | null, typeof issues>()
    for (const issue of filtered) {
      const key = issue.parentId ?? null
      if (!byParent.has(key)) byParent.set(key, [])
      byParent.get(key)!.push(issue)
    }
    const roots = byParent.get(null) ?? []
    return { byParent, roots }
  }, [filtered])

  const agentById = useMemo(() => {
    const m = new Map<string, (typeof agents)[number]>()
    for (const a of agents) m.set(a.id, a)
    return m
  }, [agents])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold uppercase tracking-wider">Issues</h1>
      </header>

      <div className="flex items-center gap-2 border-b border-border px-6 py-2">
        <Button
          size="sm"
          variant="default"
          className="gap-1.5"
          onClick={() => setNewIssueOpen(true)}
        >
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
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {issues.length}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {issues.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="text-sm text-muted-foreground">No issues yet.</div>
            <div className="max-w-sm text-xs text-muted-foreground/70">
              Create your first issue to give an agent something to work on. The agent runs in
              a per-issue git worktree so changes are isolated.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {tree.roots.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                children={tree.byParent.get(issue.id) ?? []}
                agentById={agentById}
                onSelect={(id) => setSelectedId(id)}
                onRun={(id) => runMutation.mutate({ issueId: id })}
                runDisabled={runMutation.isPending}
              />
            ))}
          </ul>
        )}
      </div>

      <NewIssueDialog open={newIssueOpen} onOpenChange={setNewIssueOpen} />
    </div>
  )
}

interface IssueRowProps {
  issue: IssueRow
  children: IssueRow[]
  agentById: Map<string, AgentRow>
  onSelect: (id: string) => void
  onRun: (id: string) => void
  runDisabled: boolean
  depth?: number
}

function IssueRow({
  issue,
  children,
  agentById,
  onSelect,
  onRun,
  runDisabled,
  depth = 0,
}: IssueRowProps) {
  const meta = STATUS_META[issue.status] ?? STATUS_META.backlog
  const assignee = issue.assigneeRuntimeAgentId ? agentById.get(issue.assigneeRuntimeAgentId) : null
  return (
    <>
      <li
        className="flex items-center gap-3 px-6 py-2 text-sm hover:bg-muted/40 cursor-pointer"
        style={{ paddingLeft: `${1.5 + depth * 1.5}rem` }}
        onClick={() => onSelect(issue.id)}
      >
        <span className={cn("h-2 w-2 rounded-full", PRIORITY_DOT[issue.priority] ?? PRIORITY_DOT.medium)} />
        <meta.Icon className={cn("h-4 w-4", meta.color)} />
        <span className="font-mono text-xs text-muted-foreground tabular-nums w-16">
          {issue.identifier}
        </span>
        <span className="flex-1 truncate">{issue.title}</span>
        {assignee && (
          <span
            className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold"
            title={assignee.name}
          >
            {assignee.icon ?? assignee.name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">
          {timeAgo(issue.updatedAt)}
        </span>
        {issue.assigneeRuntimeAgentId && issue.status !== "done" && issue.status !== "cancelled" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            disabled={runDisabled}
            onClick={(e) => {
              e.stopPropagation()
              onRun(issue.id)
            }}
            title="Run agent on this issue"
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
      </li>
      {children.map((child) => (
        <IssueRow
          key={child.id}
          issue={child}
          children={[]}
          agentById={agentById}
          onSelect={onSelect}
          onRun={onRun}
          runDisabled={runDisabled}
          depth={depth + 1}
        />
      ))}
    </>
  )
}

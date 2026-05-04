import { Bot, Briefcase, DollarSign, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import { useSetAtom } from "jotai"
import { orchestratorRouteAtom } from "./atoms"
import { timeAgo } from "./status-meta"

function StatCard({
  label,
  value,
  hint,
  Icon,
  accent = "text-foreground",
}: {
  label: string
  value: string
  hint?: string
  Icon: typeof Bot
  accent?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className={cn("text-2xl font-semibold tabular-nums", accent)}>{value}</div>
          <div className="text-sm text-foreground">{label}</div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
    </div>
  )
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const RUN_STATUS_LABEL: Record<string, (finishedAt: Date | string | null | undefined) => string> = {
  running: () => "Running",
  succeeded: (t) => `Finished ${timeAgo(t)}`,
  failed: (t) => `Failed ${timeAgo(t)}`,
  cancelled: (t) => `Cancelled ${timeAgo(t)}`,
  timed_out: (t) => `Timed out ${timeAgo(t)}`,
  queued: () => "Queued",
  scheduled_retry: () => "Scheduled retry",
}

export function DashboardView() {
  const setRoute = useSetAtom(orchestratorRouteAtom)
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery()
  const { data: issues = [] } = trpc.issues.list.useQuery()
  const { data: recentRuns = [] } = trpc.agentRuns.list.useQuery({ limit: 6 })

  const runningAgents = agents.filter((a) => a.status === "running").length
  const pausedAgents = agents.filter((a) => a.status === "paused").length
  const errorAgents = agents.filter((a) => a.status === "terminated").length
  const inProgressIssues = issues.filter(
    (i) => i.status === "in_progress" || i.status === "in_review",
  ).length
  const blockedIssues = issues.filter((i) => i.status === "blocked").length

  // Cost rollup: sum cumulative spent across agents (already in agent_runtime_state via heartbeat)
  const monthSpendCents = agents.reduce(
    (sum, a) => sum + (a.spentMonthlyCents ?? 0),
    0,
  )
  const totalBudgetCents = agents.reduce(
    (sum, a) => sum + (a.budgetMonthlyCents ?? 0),
    0,
  )

  const noAgents = agents.length === 0

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold uppercase tracking-wider">Dashboard</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {noAgents && (
          <div className="mb-6 flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="text-amber-500">⚠</div>
              <div className="text-sm">
                <span className="font-medium">You have no agents.</span>{" "}
                <span className="text-muted-foreground">
                  Hire one to start running issues.
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setRoute("agents")}
              className="text-sm font-medium text-amber-500 hover:underline"
            >
              Create one here →
            </button>
          </div>
        )}

        {/* Recent runs section — paperclip Dashboard.tsx pattern */}
        {recentRuns.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Recent runs
            </h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {recentRuns.slice(0, 4).map((run) => {
                const agent = agents.find((a) => a.id === run.runtimeAgentId)
                return (
                  <div
                    key={run.id}
                    className="rounded-lg border border-border bg-card/50 p-3"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded bg-muted text-[10px] font-semibold">
                        {agent?.icon ?? agent?.name.slice(0, 2).toUpperCase() ?? "?"}
                      </div>
                      <span className="text-sm font-medium">{agent?.name ?? "(deleted)"}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {(RUN_STATUS_LABEL[run.status] ?? (() => run.status))(run.finishedAt)}
                      </span>
                    </div>
                    {run.issueId && (
                      <div className="rounded border border-border bg-background/50 px-2 py-1.5 text-xs">
                        Issue {run.issueId.slice(0, 8)}…
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Stat grid */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Agents enabled"
            value={String(agents.length)}
            hint={`${runningAgents} running, ${pausedAgents} paused, ${errorAgents} terminated`}
            Icon={Bot}
          />
          <StatCard
            label="Issues in progress"
            value={String(inProgressIssues)}
            hint={`${blockedIssues} blocked`}
            Icon={Briefcase}
          />
          <StatCard
            label="Month spend"
            value={formatCents(monthSpendCents)}
            hint={totalBudgetCents > 0 ? `of ${formatCents(totalBudgetCents)} budgeted` : "Unlimited budget"}
            Icon={DollarSign}
          />
          <StatCard
            label="Pending approvals"
            value="0"
            hint="Awaiting board review"
            Icon={ShieldCheck}
          />
        </section>
      </div>
    </div>
  )
}

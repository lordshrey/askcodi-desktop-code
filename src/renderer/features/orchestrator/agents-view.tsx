import { useState } from "react"
import { Bot, Plus, Pause, Play, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import { HireAgentDialog } from "./hire-agent-dialog"

const STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  running: "bg-emerald-500 animate-pulse",
  paused: "bg-amber-400",
  terminated: "bg-red-500",
  pending_approval: "bg-blue-400",
}

const TABS: { value: string; label: string; filter: (status: string) => boolean }[] = [
  { value: "all", label: "All", filter: () => true },
  { value: "active", label: "Active", filter: (s) => s === "idle" || s === "running" },
  { value: "paused", label: "Paused", filter: (s) => s === "paused" },
  { value: "error", label: "Terminated", filter: (s) => s === "terminated" },
]

export function AgentsView() {
  const [tab, setTab] = useState("all")
  const [hireOpen, setHireOpen] = useState(false)
  const utils = trpc.useUtils()
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })

  const updateMutation = trpc.runtimeAgents.update.useMutation({
    onSuccess: () => {
      void utils.runtimeAgents.list.invalidate()
    },
  })
  const terminateMutation = trpc.runtimeAgents.terminate.useMutation({
    onSuccess: () => {
      void utils.runtimeAgents.list.invalidate()
    },
  })

  const filtered = agents.filter((a) => TABS.find((t) => t.value === tab)?.filter(a.status) ?? true)

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold uppercase tracking-wider">Agents</h1>
      </header>

      <div className="flex items-center gap-1 border-b border-border px-6 py-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={cn(
              "rounded-md px-3 py-1 text-sm transition-colors",
              tab === t.value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto">
          <Button size="sm" className="gap-1.5" onClick={() => setHireOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Agent
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {agents.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Bot className="h-12 w-12 text-muted-foreground/50" />
            <div className="text-sm text-muted-foreground">
              Create your first agent to get started.
            </div>
            <Button size="sm" className="gap-1.5" onClick={() => setHireOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              New Agent
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((agent) => (
              <div
                key={agent.id}
                className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:border-border/80"
              >
                <div className="mb-3 flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-sm font-semibold">
                    {agent.icon ?? agent.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {agent.title || agent.role}
                    </div>
                  </div>
                  <span
                    className={cn("h-2 w-2 rounded-full", STATUS_DOT[agent.status])}
                    title={agent.status}
                  />
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Adapter</div>
                    <div className="font-mono">{agent.adapterType}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Autonomy</div>
                    <div>{agent.autonomyMode}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Spent</div>
                    <div className="tabular-nums">${(agent.spentMonthlyCents / 100).toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Budget</div>
                    <div className="tabular-nums">
                      {agent.budgetMonthlyCents
                        ? `$${(agent.budgetMonthlyCents / 100).toFixed(2)}`
                        : "—"}
                    </div>
                  </div>
                </div>

                <div className="flex gap-1">
                  {agent.status === "paused" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-1 gap-1 text-xs"
                      disabled={updateMutation.isPending}
                      onClick={() =>
                        updateMutation.mutate({ id: agent.id, status: "idle" })
                      }
                    >
                      <Play className="h-3 w-3" />
                      Resume
                    </Button>
                  ) : agent.status !== "terminated" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-1 gap-1 text-xs"
                      disabled={updateMutation.isPending}
                      onClick={() =>
                        updateMutation.mutate({ id: agent.id, status: "paused" })
                      }
                    >
                      <Pause className="h-3 w-3" />
                      Pause
                    </Button>
                  ) : null}
                  {agent.status !== "terminated" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      title="Terminate"
                      disabled={terminateMutation.isPending}
                      onClick={() => {
                        if (confirm(`Terminate ${agent.name}? This cannot be undone.`)) {
                          terminateMutation.mutate({ id: agent.id })
                        }
                      }}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <HireAgentDialog open={hireOpen} onOpenChange={setHireOpen} />
    </div>
  )
}

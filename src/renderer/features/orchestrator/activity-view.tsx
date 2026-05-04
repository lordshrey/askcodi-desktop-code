import { trpc } from "@/lib/trpc"
import { timeAgo } from "./status-meta"

const ACTOR_BADGE: Record<string, string> = {
  user: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  agent: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  system: "bg-muted/50 text-muted-foreground border-border",
  plugin: "bg-purple-500/10 text-purple-400 border-purple-500/30",
}

function summarizeAction(action: string): string {
  const [entity, verb] = action.split(".")
  if (!verb) return action
  const verbHuman = verb.replace(/_/g, " ")
  return `${verbHuman} ${entity.replace(/_/g, " ")}`
}

export function ActivityView() {
  const { data: events = [], isLoading } = trpc.activity.feed.useQuery(undefined, {
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <h1 className="text-sm font-semibold uppercase tracking-wider">Activity</h1>
      </header>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading...</div>
        ) : events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="text-sm text-muted-foreground">
              No activity yet.
            </div>
            <div className="mt-1 max-w-sm text-xs text-muted-foreground/70">
              Every mutation in the orchestrator (issue checkout, run start, comment, hire)
              writes a row here. The feed is your forensic log.
            </div>
          </div>
        ) : (
          <ol className="divide-y divide-border font-mono text-xs">
            {events.map((e) => (
              <li key={e.id} className="px-6 py-2 hover:bg-muted/30">
                <div className="flex items-baseline gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground tabular-nums">
                    {timeAgo(e.createdAt)}
                  </span>
                  <span
                    className={`inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[10px] uppercase ${
                      ACTOR_BADGE[e.actorType] ?? ACTOR_BADGE.system
                    }`}
                  >
                    {e.actorType}
                  </span>
                  <span className="text-foreground">{summarizeAction(e.action)}</span>
                  <span className="text-muted-foreground">→ {e.entityType}/{e.entityId.slice(0, 8)}…</span>
                </div>
                {e.details && Object.keys(e.details).length > 0 && (
                  <div className="ml-22 mt-1 truncate pl-2 text-muted-foreground/80">
                    {JSON.stringify(e.details).slice(0, 200)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

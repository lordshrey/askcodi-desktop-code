import { useState } from "react"
import { useSetAtom } from "jotai"
import { AlertTriangle, Check, X, ExternalLink } from "lucide-react"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { selectedIssueIdAtom } from "./atoms"
import { timeAgo } from "./status-meta"
import { toast } from "sonner"

type RequestRow = RouterOutputs["agentRequests"]["list"][number]

/**
 * Human inbox — agent requests with severity=critical that the FE deferred to
 * the human. Each card shows the asking agent, the question, optional context,
 * and Approve / Reject buttons.
 */
export function InboxView() {
  const setSelectedIssueId = useSetAtom(selectedIssueIdAtom)
  const utils = trpc.useUtils()
  const { data: requests = [] } = trpc.agentRequests.list.useQuery(
    { inboxOnly: true },
    { refetchInterval: 5000, refetchIntervalInBackground: false },
  )
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery()
  const agentById = new Map(agents.map((a) => [a.id, a]))

  const resolveMutation = trpc.agentRequests.resolve.useMutation({
    onSuccess: () => {
      void utils.agentRequests.list.invalidate()
      void utils.agentRequests.inboxCount.invalidate()
      toast.success("Resolved")
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider">Inbox</h1>
          <p className="text-xs text-muted-foreground">
            Critical decisions the founding engineer escalated. Approve, reject, or write back.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">{requests.length} waiting</div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {requests.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Check className="h-8 w-8 text-emerald-500/60" />
            <div className="text-sm text-muted-foreground">Inbox is empty.</div>
            <div className="max-w-sm text-xs text-muted-foreground/70">
              The founding engineer is handling routine questions. You'll only see things here
              when something genuinely needs your call.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {requests.map((req) => (
              <RequestCard
                key={req.id}
                req={req}
                fromAgentName={agentById.get(req.fromAgentId)?.name ?? "(unknown agent)"}
                onResolve={(resolution, decision) =>
                  resolveMutation.mutate({
                    id: req.id,
                    resolution,
                    decision,
                    resolutionBy: "human",
                  })
                }
                onOpenIssue={(id) => setSelectedIssueId(id)}
                isResolving={resolveMutation.isPending}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RequestCard({
  req,
  fromAgentName,
  onResolve,
  onOpenIssue,
  isResolving,
}: {
  req: RequestRow
  fromAgentName: string
  onResolve: (resolution: string, decision: "approved" | "rejected") => void
  onOpenIssue: (id: string) => void
  isResolving: boolean
}) {
  const [response, setResponse] = useState("")
  const contextEntries = Object.entries((req.context ?? {}) as Record<string, unknown>)

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold">{fromAgentName}</span>
        {req.kind && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {req.kind}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(req.createdAt)}</span>
        {req.issueId && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => onOpenIssue(req.issueId!)}
          >
            <ExternalLink className="mr-1 h-3 w-3" /> Issue
          </Button>
        )}
      </div>

      <div className="mb-3 whitespace-pre-wrap text-sm">{req.body}</div>

      {contextEntries.length > 0 && (
        <details className="mb-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Context ({contextEntries.length})
          </summary>
          <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 text-[11px]">
            {JSON.stringify(req.context, null, 2)}
          </pre>
        </details>
      )}

      <Textarea
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        placeholder="Write your answer / decision. Sent back to the agent."
        className="min-h-[60px] text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!response.trim() || isResolving}
          onClick={() => onResolve(response.trim(), "approved")}
        >
          <Check className="mr-1 h-3.5 w-3.5" /> Approve & send
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isResolving}
          onClick={() =>
            onResolve(response.trim() || "Do not proceed.", "rejected")
          }
        >
          <X className="mr-1 h-3.5 w-3.5" /> Reject
        </Button>
      </div>
    </div>
  )
}

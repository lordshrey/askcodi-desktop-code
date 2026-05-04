import { useAtomValue } from "jotai"
import { trpc } from "@/lib/trpc"
import { selectedRuntimeAgentIdAtom } from "./atoms"
import { BoardView } from "./board-view"

/**
 * Per-agent surface. The board is filtered to issues assigned to this agent;
 * everything else (chat, diff, runs) lives inside the issue detail view that
 * opens when the user clicks a card.
 */
export function AgentDetailView() {
  const agentId = useAtomValue(selectedRuntimeAgentIdAtom)
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery()
  const agent = agentId ? agents.find((a) => a.id === agentId) : null

  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select an agent from the sidebar.
      </div>
    )
  }

  return <BoardView filterAgentId={agent.id} title={`${agent.name}'s Tasks`} />
}

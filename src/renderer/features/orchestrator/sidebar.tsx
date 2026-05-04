import { useAtom, useSetAtom, useAtomValue } from "jotai"
import {
  LayoutDashboard,
  ListTodo,
  Bot,
  Activity,
  ArrowLeftRight,
  Plus,
  Inbox,
  FolderGit2,
  KanbanSquare,
  MessageSquare,
  Crown,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  appModeAtom,
  orchestratorRouteAtom,
  selectedRuntimeAgentIdAtom,
  type OrchestratorRoute,
} from "./atoms"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { selectedProjectAtom } from "@/features/agents/atoms"
import { AGENT_STATUS_DOT } from "./status-meta"

type AgentListRow = RouterOutputs["runtimeAgents"]["list"][number]

interface NavItem {
  route: OrchestratorRoute
  label: string
  Icon: typeof LayoutDashboard
}

const PRIMARY: NavItem[] = [
  { route: "board", label: "Project Board", Icon: KanbanSquare },
  { route: "fe_chat", label: "Founding Engineer", Icon: Crown },
]

const SYSTEM: NavItem[] = [
  { route: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { route: "issues", label: "All Issues", Icon: ListTodo },
  { route: "repos", label: "Repos", Icon: FolderGit2 },
  { route: "activity", label: "Activity", Icon: Activity },
  { route: "agents", label: "Agents (manage)", Icon: Bot },
]

interface SidebarLinkProps extends NavItem {
  active: boolean
  onClick: () => void
  badge?: number
}

function SidebarLink({ label, Icon, active, onClick, badge }: SidebarLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="rounded bg-amber-500/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950">
          {badge}
        </span>
      )}
    </button>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </div>
  )
}

export function OrchestratorSidebar() {
  const [route, setRoute] = useAtom(orchestratorRouteAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const [selectedAgentId, setSelectedAgentId] = useAtom(selectedRuntimeAgentIdAtom)
  const project = useAtomValue(selectedProjectAtom)

  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
  const runningCount = agents.filter((a) => a.status === "running").length

  // FE has its own top-level "Founding Engineer" tab; the agents list shows
  // hired teammates only.
  const teamAgents = agents.filter((a) => !a.isFounding && a.status !== "terminated")

  const { data: repos = [] } = trpc.projectRepos.list.useQuery(
    project ? { projectId: project.id } : ({} as { projectId: string }),
    { enabled: !!project },
  )

  const { data: inboxCount = 0 } = trpc.agentRequests.inboxCount.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })

  function selectAgent(id: string) {
    setSelectedAgentId(id)
    setRoute("agent")
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-background/50">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
            AC
          </div>
          <span className="text-sm font-semibold">AskCodi</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setAppMode("chat")}
          title="Switch to Solo chat mode"
        >
          <ArrowLeftRight className="mr-1 h-3 w-3" />
          Solo
        </Button>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {PRIMARY.map((item) => (
          <SidebarLink
            key={item.route}
            {...item}
            active={route === item.route}
            onClick={() => {
              setSelectedAgentId(null)
              setRoute(item.route)
            }}
          />
        ))}

        <SidebarLink
          route="inbox"
          label="Inbox"
          Icon={Inbox}
          active={route === "inbox"}
          badge={inboxCount}
          onClick={() => {
            setSelectedAgentId(null)
            setRoute("inbox")
          }}
        />

        {teamAgents.length > 0 && <SectionHeading>Team</SectionHeading>}
        {teamAgents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            active={route === "agent" && selectedAgentId === agent.id}
            onClick={() => selectAgent(agent.id)}
          />
        ))}

        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start gap-2 text-muted-foreground"
          onClick={() => {
            setSelectedAgentId(null)
            setRoute("agents")
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Hire / manage
        </Button>

        <SectionHeading>System</SectionHeading>
        {SYSTEM.map((item) => (
          <SidebarLink
            key={item.route}
            {...item}
            active={route === item.route}
            onClick={() => {
              setSelectedAgentId(null)
              setRoute(item.route)
            }}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>
            {agents.length} agents
            {project && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAgentId(null)
                    setRoute("repos")
                  }}
                  className="hover:text-foreground hover:underline"
                  title="Manage repos"
                >
                  {repos.length} repo{repos.length === 1 ? "" : "s"}
                </button>
              </>
            )}
          </span>
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {runningCount} running
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

interface AgentRowProps {
  agent: AgentListRow
  active: boolean
  onClick: () => void
}

function AgentRow({ agent, active, onClick }: AgentRowProps) {
  const initials = agent.icon ?? agent.name.slice(0, 2).toUpperCase()
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", AGENT_STATUS_DOT[agent.status] ?? AGENT_STATUS_DOT.idle)} />
      <span className="flex h-5 w-5 items-center justify-center rounded bg-muted text-[10px] font-semibold">
        {initials}
      </span>
      <span className="flex-1 truncate text-left">{agent.name}</span>
    </button>
  )
}

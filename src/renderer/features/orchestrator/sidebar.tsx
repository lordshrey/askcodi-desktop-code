import { useAtom, useSetAtom } from "jotai"
import {
  LayoutDashboard,
  ListTodo,
  Bot,
  Activity,
  ArrowLeftRight,
  Plus,
  Inbox,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  appModeAtom,
  orchestratorRouteAtom,
  type OrchestratorRoute,
} from "./atoms"
import { trpc } from "@/lib/trpc"

interface NavItem {
  route: OrchestratorRoute
  label: string
  Icon: typeof LayoutDashboard
}

const PRIMARY: NavItem[] = [
  { route: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
]

const WORK: NavItem[] = [
  { route: "issues", label: "Issues", Icon: ListTodo },
]

const SYSTEM: NavItem[] = [
  { route: "agents", label: "Agents", Icon: Bot },
  { route: "activity", label: "Activity", Icon: Activity },
]

interface SidebarLinkProps extends NavItem {
  active: boolean
  onClick: () => void
}

function SidebarLink({ label, Icon, active, onClick }: SidebarLinkProps) {
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
      {label}
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

  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  })
  const runningCount = agents.filter((a) => a.status === "running").length

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
          title="Switch to chat mode"
        >
          <ArrowLeftRight className="mr-1 h-3 w-3" />
          Chat
        </Button>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <Button
          variant="default"
          size="sm"
          className="mb-2 w-full justify-start gap-2"
          onClick={() => setRoute("issues")}
        >
          <Plus className="h-4 w-4" />
          New Issue
        </Button>

        {PRIMARY.map((item) => (
          <SidebarLink
            key={item.route}
            {...item}
            active={route === item.route}
            onClick={() => setRoute(item.route)}
          />
        ))}

        <SidebarLink
          route="dashboard"
          label="Inbox"
          Icon={Inbox}
          active={false}
          onClick={() => setRoute("dashboard")}
        />

        <SectionHeading>Work</SectionHeading>
        {WORK.map((item) => (
          <SidebarLink
            key={item.route}
            {...item}
            active={route === item.route}
            onClick={() => setRoute(item.route)}
          />
        ))}

        <SectionHeading>System</SectionHeading>
        {SYSTEM.map((item) => (
          <SidebarLink
            key={item.route}
            {...item}
            active={route === item.route}
            onClick={() => setRoute(item.route)}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>{agents.length} agents</span>
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

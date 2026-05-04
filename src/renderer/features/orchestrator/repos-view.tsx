import { useState } from "react"
import { useAtomValue } from "jotai"
import { Plus, Star, StarOff, Trash2, FolderGit2, Github, Gitlab } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import { selectedProjectAtom } from "@/features/agents/atoms"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"

const ROLE_OPTIONS = [
  { value: "frontend", label: "Frontend" },
  { value: "backend", label: "Backend" },
  { value: "extension", label: "Extension" },
  { value: "shared", label: "Shared" },
  { value: "infra", label: "Infra" },
  { value: "docs", label: "Docs" },
  { value: "primary", label: "Primary" },
  { value: "other", label: "Other" },
] as const

type Role = (typeof ROLE_OPTIONS)[number]["value"]

function ProviderIcon({ provider }: { provider: string | null }) {
  if (provider === "github") return <Github className="h-3.5 w-3.5" />
  if (provider === "gitlab") return <Gitlab className="h-3.5 w-3.5" />
  return <FolderGit2 className="h-3.5 w-3.5" />
}

export function ReposView() {
  const project = useAtomValue(selectedProjectAtom)
  const utils = trpc.useUtils()
  const [pendingPath, setPendingPath] = useState<{
    path: string
    name: string
    gitInfo: { remoteUrl: string | null; provider: string | null }
  } | null>(null)
  const [pendingRole, setPendingRole] = useState<Role>("backend")

  // No polling — repos only change via mutations, and React Query invalidations
  // cover those paths.
  const { data: repos = [] } = trpc.projectRepos.list.useQuery(
    project ? { projectId: project.id } : ({} as { projectId: string }),
    { enabled: !!project },
  )

  const pickMutation = trpc.projectRepos.pickFolder.useMutation({
    onSuccess: (result) => {
      if (result) setPendingPath(result)
    },
    onError: (err) => toast.error(err.message),
  })
  const addMutation = trpc.projectRepos.add.useMutation({
    onSuccess: () => {
      void utils.projectRepos.list.invalidate()
      setPendingPath(null)
      toast.success("Repo attached")
    },
    onError: (err) => toast.error(err.message),
  })
  const setPrimaryMutation = trpc.projectRepos.setPrimary.useMutation({
    onSuccess: () => void utils.projectRepos.list.invalidate(),
    onError: (err) => toast.error(err.message),
  })
  const updateMutation = trpc.projectRepos.update.useMutation({
    onSuccess: () => void utils.projectRepos.list.invalidate(),
  })
  const removeMutation = trpc.projectRepos.remove.useMutation({
    onSuccess: () => {
      void utils.projectRepos.list.invalidate()
      toast.success("Repo removed")
    },
    onError: (err) => toast.error(err.message),
  })

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to manage its repos.
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider">Repos</h1>
          <p className="text-xs text-muted-foreground">
            Connect frontend, backend, and other repos to {project.name}.
          </p>
        </div>
        <Button size="sm" onClick={() => pickMutation.mutate()} disabled={pickMutation.isPending}>
          <Plus className="mr-1 h-4 w-4" /> Add repo
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {pendingPath && (
          <div className="mb-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
            <div className="mb-3 flex items-center gap-2">
              <ProviderIcon provider={pendingPath.gitInfo.provider} />
              <span className="font-mono text-xs text-muted-foreground">{pendingPath.path}</span>
            </div>
            <div className="flex items-center gap-2">
              <Select value={pendingRole} onValueChange={(v) => setPendingRole(v as Role)}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value} className="text-xs">
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() =>
                  addMutation.mutate({
                    projectId: project.id,
                    path: pendingPath.path,
                    name: pendingPath.name,
                    role: pendingRole,
                    gitInfo: {
                      remoteUrl: pendingPath.gitInfo.remoteUrl,
                      provider: pendingPath.gitInfo.provider,
                    },
                  })
                }
                disabled={addMutation.isPending}
              >
                Attach
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingPath(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {repos.length === 0 && !pendingPath && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No repos attached yet. Click <strong>Add repo</strong> to connect one.
          </div>
        )}

        <div className="space-y-2">
          {repos.map((repo) => (
            <div
              key={repo.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border bg-card/50 px-4 py-3",
                repo.isPrimary ? "border-primary/40" : "border-border",
              )}
            >
              <ProviderIcon provider={repo.gitProvider} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{repo.name}</span>
                  {repo.isPrimary && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                      Primary
                    </span>
                  )}
                  {repo.role && !repo.isPrimary && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {repo.role}
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">{repo.path}</div>
                {repo.gitRemoteUrl && (
                  <div className="truncate text-[11px] text-muted-foreground/80">
                    {repo.gitOwner ? `${repo.gitOwner}/${repo.gitRepo}` : repo.gitRemoteUrl}
                  </div>
                )}
              </div>
              <Select
                value={repo.role ?? ""}
                onValueChange={(v) =>
                  updateMutation.mutate({ id: repo.id, role: (v || null) as Role | null })
                }
              >
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r.value} value={r.value} className="text-xs">
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {repo.isPrimary ? (
                <Button size="icon" variant="ghost" disabled title="Primary repo">
                  <Star className="h-4 w-4 fill-current text-primary" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Make primary"
                  onClick={() => setPrimaryMutation.mutate({ id: repo.id })}
                >
                  <StarOff className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                title="Remove repo"
                onClick={() => {
                  if (confirm(`Remove "${repo.name}" from this project?`)) {
                    removeMutation.mutate({ id: repo.id })
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

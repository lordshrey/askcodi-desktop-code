import {
  FolderPlus,
  Folder,
  Globe,
  Loader2,
  ArrowLeft,
} from "lucide-react"
import { useState } from "react"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
import { trpc } from "../../../lib/trpc"
import type { SelectedProject } from "../../agents/atoms"

type RepoStepProps = {
  onComplete: (project: NonNullable<SelectedProject>) => void
}

type Mode = "menu" | "quick-start" | "clone"

function projectToSelected(p: {
  id: string
  name: string
  path: string
  gitRemoteUrl?: string | null
  gitProvider?: string | null
  gitOwner?: string | null
  gitRepo?: string | null
}): NonNullable<SelectedProject> {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    gitRemoteUrl: p.gitRemoteUrl ?? null,
    gitProvider: (p.gitProvider as
      | "github"
      | "gitlab"
      | "bitbucket"
      | null
      | undefined) ?? null,
    gitOwner: p.gitOwner ?? null,
    gitRepo: p.gitRepo ?? null,
  }
}

export function RepoStep({ onComplete }: RepoStepProps) {
  const [mode, setMode] = useState<Mode>("menu")
  const [error, setError] = useState<string | null>(null)

  // Quick start state
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [repoName, setRepoName] = useState("")

  // Clone state
  const [cloneUrl, setCloneUrl] = useState("")

  const pickDirMutation = trpc.projects.pickDirectory.useMutation()
  const quickStartMutation = trpc.projects.quickStart.useMutation()
  const openFolderMutation = trpc.projects.openFolder.useMutation()
  const cloneMutation = trpc.projects.cloneFromGitHub.useMutation()

  const handleOpenLocal = async () => {
    setError(null)
    try {
      const project = await openFolderMutation.mutateAsync()
      if (project) onComplete(projectToSelected(project))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open folder")
    }
  }

  const handlePickParentDir = async () => {
    setError(null)
    try {
      const result = await pickDirMutation.mutateAsync({
        title: "Pick a parent folder",
        buttonLabel: "Select",
      })
      if (result?.path) setParentDir(result.path)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to pick folder")
    }
  }

  const handleQuickStart = async () => {
    setError(null)
    if (!parentDir) {
      setError("Pick a parent folder first")
      return
    }
    if (!repoName.trim()) {
      setError("Enter a repo name")
      return
    }
    try {
      const project = await quickStartMutation.mutateAsync({
        parentDir,
        name: repoName.trim(),
      })
      if (project) onComplete(projectToSelected(project))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create repo")
    }
  }

  const handleClone = async () => {
    setError(null)
    if (!cloneUrl.trim()) {
      setError("Enter a repo URL")
      return
    }
    try {
      const project = await cloneMutation.mutateAsync({
        repoUrl: cloneUrl.trim(),
      })
      if (project) onComplete(projectToSelected(project))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clone repo")
    }
  }

  return (
    <div className="mx-auto w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-lg">
      {mode !== "menu" && (
        <button
          type="button"
          onClick={() => {
            setMode("menu")
            setError(null)
          }}
          className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Back
        </button>
      )}

      <h1 className="mb-6 font-display text-2xl font-bold tracking-tight text-foreground">
        Add a repository
      </h1>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {mode === "menu" && (
        <div className="space-y-4">
          {/* Big quick start tile */}
          <button
            type="button"
            onClick={() => setMode("quick-start")}
            className="group flex w-full flex-col items-start gap-2 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <FolderPlus className="size-5 text-foreground" />
            <div>
              <div className="font-display text-sm font-semibold text-foreground">
                Quick start
              </div>
              <div className="text-xs text-muted-foreground">
                Create a new local repo for me
              </div>
            </div>
          </button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            OR
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleOpenLocal}
              disabled={openFolderMutation.isPending}
              className="h-auto flex-col gap-1.5 py-4"
            >
              {openFolderMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Folder className="size-4" />
              )}
              <span className="text-xs">Open local repo</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMode("clone")}
              className="h-auto flex-col gap-1.5 py-4"
            >
              <Globe className="size-4" />
              <span className="text-xs">Clone from URL</span>
            </Button>
          </div>
        </div>
      )}

      {mode === "quick-start" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Parent folder
            </label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={parentDir ?? ""}
                placeholder="No folder selected"
                className="flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handlePickParentDir}
                disabled={pickDirMutation.isPending}
              >
                {pickDirMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  "Pick"
                )}
              </Button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Repo name
            </label>
            <Input
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="my-new-project"
              className="text-xs"
            />
            <div className="mt-1 text-xs text-muted-foreground">
              Letters, numbers, dot, dash, underscore.
            </div>
          </div>

          <Button
            type="button"
            onClick={handleQuickStart}
            disabled={
              !parentDir || !repoName.trim() || quickStartMutation.isPending
            }
            className="w-full"
          >
            {quickStartMutation.isPending ? (
              <>
                <Loader2 className="mr-2 size-3.5 animate-spin" /> Creating…
              </>
            ) : (
              "Create repo"
            )}
          </Button>
        </div>
      )}

      {mode === "clone" && (
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Repo URL
            </label>
            <Input
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="text-xs"
            />
            <div className="mt-1 text-xs text-muted-foreground">
              GitHub HTTPS, SSH, or owner/repo. Cloned to ~/.askcodi/repos/.
            </div>
          </div>

          <Button
            type="button"
            onClick={handleClone}
            disabled={!cloneUrl.trim() || cloneMutation.isPending}
            className="w-full"
          >
            {cloneMutation.isPending ? (
              <>
                <Loader2 className="mr-2 size-3.5 animate-spin" /> Cloning…
              </>
            ) : (
              "Clone repo"
            )}
          </Button>
        </div>
      )}
    </div>
  )
}

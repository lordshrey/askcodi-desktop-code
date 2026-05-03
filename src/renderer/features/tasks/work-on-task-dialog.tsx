import { useState, useCallback, useMemo } from "react"
import { useSetAtom, useAtomValue } from "jotai"
import { trpc } from "../../lib/trpc"
import { selectedAgentChatIdAtom, desktopViewAtom, selectedProjectAtom, lastSelectedAgentIdAtom, pendingActiveSubChatIdAtom } from "../agents/atoms"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog"
import { Button } from "../../components/ui/button"
import { Loader2 } from "lucide-react"
import { cn } from "../../lib/utils"
import { CLAUDE_MODELS, resolveCodexModels } from "../agents/lib/models"

type ProviderId = "claude-code" | "codex" | "askcodi"
type WorkspaceMode = "new" | "existing"

const PROVIDER_OPTIONS: { id: ProviderId; label: string }[] = [
  { id: "askcodi", label: "AskCodi" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
]

interface WorkOnTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: string
  sourceUrl: string
  sourceType: "github-issue" | "github-pr" | "linear-ticket"
  sourceIdentifier: string
}

export function WorkOnTaskDialog({
  open,
  onOpenChange,
  title,
  body,
  sourceUrl,
  sourceType,
  sourceIdentifier,
}: WorkOnTaskDialogProps) {
  const { data: projectsList } = trpc.projects.list.useQuery()
  const selectedProject = useAtomValue(selectedProjectAtom)
  const lastSelectedAgentId = useAtomValue(lastSelectedAgentIdAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)
  const setPendingActiveSubChatId = useSetAtom(pendingActiveSubChatIdAtom)
  const utils = trpc.useUtils()

  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("new")
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    selectedProject?.id ?? ""
  )
  const [existingChatId, setExistingChatId] = useState<string>("")
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(
    (lastSelectedAgentId as ProviderId) || "askcodi"
  )
  const [selectedModelId, setSelectedModelId] = useState<string>("")
  const [additionalInstructions, setAdditionalInstructions] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Fetch existing chats for "existing workspace" mode
  const { data: chatsList } = trpc.chats.list.useQuery(
    { projectId: selectedProjectId },
    { enabled: !!selectedProjectId && workspaceMode === "existing" }
  )

  // Fetch AskCodi models
  const { data: askCodiModelsData } = trpc.askcodi.models.useQuery(undefined, {
    enabled: selectedProvider === "askcodi",
    staleTime: 5 * 60 * 1000,
  })

  // Dynamic Codex models from CLI cache
  const { data: codexModelsData } = trpc.codex.getModels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  })
  const codexModels = useMemo(
    () => resolveCodexModels(codexModelsData?.models),
    [codexModelsData],
  )

  // Model options based on selected provider
  const modelOptions = useMemo(() => {
    switch (selectedProvider) {
      case "claude-code":
        return CLAUDE_MODELS.map((m) => ({ id: m.id, label: `${m.name} ${m.version}` }))
      case "codex":
        return codexModels.map((m) => ({ id: m.id, label: m.name }))
      case "askcodi":
        return (askCodiModelsData ?? []).map((m: { id: string; name: string }) => ({
          id: m.id,
          label: m.name,
        }))
      default:
        return []
    }
  }, [selectedProvider, codexModels, askCodiModelsData])

  // Reset model when provider changes
  const handleProviderChange = useCallback((provider: ProviderId) => {
    setSelectedProvider(provider)
    setSelectedModelId("")
  }, [])

  const createMutation = trpc.externalTasks.createFromExternal.useMutation()
  const createSubChatMutation = trpc.chats.createSubChat.useMutation()
  const setSourceFieldsMutation = trpc.chats.setSourceFields.useMutation()

  const handleSubmit = useCallback(async () => {
    if (!selectedProjectId) return
    if (workspaceMode === "existing" && !existingChatId) return
    setIsSubmitting(true)

    try {
      const effectiveModel = selectedModelId || undefined

      if (workspaceMode === "new") {
        // Create new workspace
        const result = await createMutation.mutateAsync({
          projectId: selectedProjectId,
          title,
          body,
          sourceUrl,
          sourceType,
          sourceIdentifier,
          additionalInstructions: additionalInstructions.trim() || undefined,
          provider: selectedProvider,
          model: effectiveModel,
        })

        setSelectedChatId(result.chatId)
      } else {
        // Add as new sub-chat to existing workspace
        const sourceLabel =
          sourceType === "github-issue"
            ? "GitHub Issue"
            : sourceType === "github-pr"
              ? "Pull Request"
              : "Linear Ticket"

        const truncatedBody =
          body.length > 4000 ? body.slice(0, 4000) + "\n\n... (truncated)" : body

        let taskMessage = `Work on the following ${sourceLabel}:

## ${title} (${sourceIdentifier})
**Source:** ${sourceUrl}

## Description
${truncatedBody}`

        if (additionalInstructions.trim()) {
          taskMessage += `\n\n---\n${additionalInstructions.trim()}`
        }

        taskMessage += `\n\nAnalyze this and implement the necessary changes.`

        const newSubChat = await createSubChatMutation.mutateAsync({
          chatId: existingChatId,
          name: `[${sourceIdentifier}] ${title}`.slice(0, 100),
          mode: "agent",
          initialMessage: taskMessage,
          provider: selectedProvider,
        })

        // Link existing workspace to this task if not already linked
        await setSourceFieldsMutation.mutateAsync({
          chatId: existingChatId,
          sourceUrl,
          sourceType,
          sourceIdentifier,
        }).catch(() => {}) // non-critical, don't block on failure

        // Tell the chat component to activate this new sub-chat tab
        setPendingActiveSubChatId(newSubChat.id)
        await utils.chats.get.invalidate({ id: existingChatId })
        setSelectedChatId(existingChatId)
      }

      setDesktopView(null)
      onOpenChange(false)
    } catch (err) {
      console.error("Failed to create workspace:", err)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    selectedProjectId,
    workspaceMode,
    existingChatId,
    selectedModelId,
    title,
    body,
    sourceUrl,
    sourceType,
    sourceIdentifier,
    additionalInstructions,
    selectedProvider,
    createMutation,
    createSubChatMutation,
    setSourceFieldsMutation,
    utils,
    setPendingActiveSubChatId,
    setSelectedChatId,
    setDesktopView,
    onOpenChange,
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-sm">Work on Task</DialogTitle>
          <DialogDescription className="text-xs truncate">
            {sourceIdentifier} {title}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* New vs Existing workspace toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Workspace</label>
            <div className="flex gap-1 bg-muted rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setWorkspaceMode("new")}
                className={cn(
                  "flex-1 px-3 py-1.5 text-xs rounded-sm transition-colors",
                  workspaceMode === "new"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                New workspace
              </button>
              <button
                type="button"
                onClick={() => setWorkspaceMode("existing")}
                className={cn(
                  "flex-1 px-3 py-1.5 text-xs rounded-sm transition-colors",
                  workspaceMode === "existing"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Existing workspace
              </button>
            </div>
          </div>

          {/* Project selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Project</label>
            <select
              value={selectedProjectId}
              onChange={(e) => {
                setSelectedProjectId(e.target.value)
                setExistingChatId("")
              }}
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">Select a project...</option>
              {projectsList?.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {p.path}</option>
              ))}
            </select>
          </div>

          {/* Existing workspace selector (only when "existing" mode) */}
          {workspaceMode === "existing" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Select workspace</label>
              <select
                value={existingChatId}
                onChange={(e) => setExistingChatId(e.target.value)}
                className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
                disabled={!selectedProjectId}
              >
                <option value="">Select a workspace...</option>
                {chatsList?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || "Untitled"}
                  </option>
                ))}
              </select>
              {selectedProjectId && chatsList && chatsList.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No tasks found. Switch to "New task" to create one.
                </p>
              )}
            </div>
          )}

          {/* Provider selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">AI Provider</label>
            <select
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value as ProviderId)}
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* Model selection */}
          {modelOptions.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Model</label>
              <select
                value={selectedModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
              >
                <option value="">Default</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Additional instructions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              Additional Instructions <span className="text-muted-foreground">(optional)</span>
            </label>
            <textarea
              value={additionalInstructions}
              onChange={(e) => setAdditionalInstructions(e.target.value)}
              placeholder="e.g., Focus on the backend changes only, write tests..."
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[80px] resize-y"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              !selectedProjectId ||
              (workspaceMode === "existing" && !existingChatId) ||
              isSubmitting
            }
            onClick={handleSubmit}
          >
            {isSubmitting && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
            {workspaceMode === "new" ? "Create Task" : "Add to Task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

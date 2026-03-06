import { useState, useCallback } from "react"
import { useSetAtom, useAtomValue } from "jotai"
import { trpc } from "../../lib/trpc"
import { selectedAgentChatIdAtom, desktopViewAtom, selectedProjectAtom } from "../agents/atoms"
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
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)

  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    selectedProject?.id ?? ""
  )
  const [additionalInstructions, setAdditionalInstructions] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  const createMutation = trpc.tasks.createFromExternal.useMutation()

  const handleCreate = useCallback(async () => {
    if (!selectedProjectId) return
    setIsCreating(true)
    try {
      const result = await createMutation.mutateAsync({
        projectId: selectedProjectId,
        title,
        body,
        sourceUrl,
        sourceType,
        sourceIdentifier,
        additionalInstructions: additionalInstructions.trim() || undefined,
      })

      // Navigate to the new chat
      setSelectedChatId(result.chatId)
      setDesktopView(null) // Return to chat view
      onOpenChange(false)
    } catch (err) {
      console.error("Failed to create workspace:", err)
    } finally {
      setIsCreating(false)
    }
  }, [selectedProjectId, title, body, sourceUrl, sourceType, sourceIdentifier, additionalInstructions, createMutation, setSelectedChatId, setDesktopView, onOpenChange])

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
          {/* Project selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Project</label>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-sm"
            >
              <option value="">Select a project...</option>
              {projectsList?.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {p.path}</option>
              ))}
            </select>
          </div>

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
            disabled={!selectedProjectId || isCreating}
            onClick={handleCreate}
          >
            {isCreating && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
            Create Workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

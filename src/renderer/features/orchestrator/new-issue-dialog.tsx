import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { trpc } from "@/lib/trpc"

interface NewIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NewIssueDialog({ open, onOpenChange }: NewIssueDialogProps) {
  const utils = trpc.useUtils()
  const { data: projects = [] } = trpc.projects.list.useQuery(undefined, {
    enabled: open,
  })
  const { data: agents = [] } = trpc.runtimeAgents.list.useQuery(undefined, {
    enabled: open,
  })

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [projectId, setProjectId] = useState<string>("")
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium")
  const [assigneeId, setAssigneeId] = useState<string>("none")

  // Default to first project on open
  useEffect(() => {
    if (open && projects.length > 0 && !projectId) {
      setProjectId(projects[0].id)
    }
  }, [open, projects, projectId])

  // Reset on close
  useEffect(() => {
    if (!open) {
      setTitle("")
      setDescription("")
      setProjectId("")
      setPriority("medium")
      setAssigneeId("none")
    }
  }, [open])

  const createMutation = trpc.issues.create.useMutation({
    onSuccess: () => {
      void utils.issues.list.invalidate()
      onOpenChange(false)
    },
  })

  const canSubmit =
    title.trim().length > 0 && projectId.length > 0 && !createMutation.isPending

  const onSubmit = () => {
    createMutation.mutate({
      projectId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      status: assigneeId !== "none" ? "todo" : "backlog",
      assigneeRuntimeAgentId: assigneeId !== "none" ? assigneeId : null,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="issue-title">Title</Label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to happen?"
              className="mt-1.5"
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="issue-description">Description</Label>
            <Textarea
              id="issue-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional. Markdown supported. The agent uses this as the primary brief."
              className="mt-1.5 min-h-[120px] font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="issue-project">Project</Label>
              {projects.length === 0 ? (
                <p className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
                  No projects yet. Create one in chat mode first.
                </p>
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="issue-project" className="mt-1.5">
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div>
              <Label htmlFor="issue-priority">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                <SelectTrigger id="issue-priority" className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="issue-assignee">Assignee</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger id="issue-assignee" className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned (backlog)</SelectItem>
                {agents
                  .filter((a) => a.status !== "terminated")
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.title ? ` — ${a.title}` : ` (${a.role})`}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Assigning to an agent puts the issue in "todo" — they wake up immediately if their
              autonomy mode is event or higher.
            </p>
          </div>

          {createMutation.error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {createMutation.error.message}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {createMutation.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Create issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

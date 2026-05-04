import { useState } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { Plus, MessageSquare, Archive, ExternalLink } from "lucide-react"
import { trpc } from "@/lib/trpc"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  selectedProjectAtom,
  selectedAgentChatIdAtom,
} from "@/features/agents/atoms"
import { appModeAtom } from "./atoms"
import { timeAgo } from "./status-meta"
import { toast } from "sonner"

/**
 * Founding Engineer chat tab.
 *
 * UX:
 * - Multi-thread (Slack-DM style). Each thread is a `chats` row with kind="fe_thread".
 * - "Open" button on a thread switches the app to chat mode with that thread
 *   loaded. The full chat UI (composer, streaming, sub-chats) comes for free.
 * - "Back to orchestrator" toggle in the chat sidebar returns the user.
 *
 * Why we don't embed the chat UI here: ActiveChat is a deep integration with
 * its own sidebar, sub-chat tabs, file viewer, etc. Embedding it would either
 * fork the surface or pull in chat-mode-specific state. The dual-mode toggle
 * already works; we lean on it.
 */
export function FeChatView() {
  const project = useAtomValue(selectedProjectAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const utils = trpc.useUtils()
  const [creating, setCreating] = useState(false)
  const [draftTitle, setDraftTitle] = useState("")

  const { data: threads = [] } = trpc.feThreads.list.useQuery(
    project ? { projectId: project.id } : ({} as { projectId: string }),
    { enabled: !!project, refetchInterval: 5000, refetchIntervalInBackground: false },
  )

  const createMutation = trpc.feThreads.create.useMutation({
    onSuccess: (thread) => {
      void utils.feThreads.list.invalidate()
      setCreating(false)
      setDraftTitle("")
      // Open immediately
      setSelectedChatId(thread.id)
      setAppMode("chat")
    },
    onError: (err) => toast.error(err.message),
  })

  const archiveMutation = trpc.feThreads.archive.useMutation({
    onSuccess: () => void utils.feThreads.list.invalidate(),
  })

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to chat with the Founding Engineer.
      </div>
    )
  }

  function openThread(id: string) {
    setSelectedChatId(id)
    setAppMode("chat")
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider">Founding Engineer</h1>
          <p className="text-xs text-muted-foreground">
            Chat threads with the lead. Each thread can spawn issues for the team.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="mr-1 h-4 w-4" /> New thread
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {creating && (
          <div className="mb-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
            <Input
              autoFocus
              placeholder="What are you thinking about? (e.g. “Add Stripe webhook”)"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftTitle.trim()) {
                  createMutation.mutate({ projectId: project.id, title: draftTitle.trim() })
                }
                if (e.key === "Escape") {
                  setCreating(false)
                  setDraftTitle("")
                }
              }}
            />
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={!draftTitle.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate({ projectId: project.id, title: draftTitle.trim() })}
              >
                Start thread
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setDraftTitle("") }}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {threads.length === 0 && !creating && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No threads yet. Start one to talk to the Founding Engineer about the project.
          </div>
        )}

        <div className="space-y-2">
          {threads.map((thread) => (
            <div
              key={thread.id}
              className="group flex items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-3 hover:border-foreground/20"
            >
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              <button
                type="button"
                onClick={() => openThread(thread.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-sm font-medium">{thread.name ?? "Untitled thread"}</div>
                <div className="text-xs text-muted-foreground">
                  Updated {timeAgo(thread.updatedAt)}
                </div>
              </button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openThread(thread.id)}
                className="opacity-0 group-hover:opacity-100"
              >
                <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open
              </Button>
              <Button
                size="icon"
                variant="ghost"
                title="Archive thread"
                onClick={() => {
                  if (confirm("Archive this thread?")) archiveMutation.mutate({ id: thread.id })
                }}
              >
                <Archive className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

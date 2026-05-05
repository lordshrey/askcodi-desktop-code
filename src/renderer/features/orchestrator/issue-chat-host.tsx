import { useEffect, useState, useMemo } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import { Plus, Loader2, Archive, MessageSquare } from "lucide-react"
import { trpc, type RouterOutputs } from "@/lib/trpc"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChatView } from "../agents/main/active-chat"
import { selectedAgentChatIdAtom } from "../agents/atoms"
import { chatSourceModeAtom } from "../../lib/atoms"
import { useChatClaim } from "../../lib/hooks/use-chat-claim"
import { toast } from "sonner"

type IssueChat = RouterOutputs["issueChats"]["list"][number]

/**
 * Embeds ChatView for the chats attached to an orchestrator issue.
 *
 *   Header (issue meta) ─ owned by parent IssueDetailView
 *   ─────────────────────────────────────────────────────
 *   Chat tab strip (only shown when ≥ 2 chats)
 *   ─────────────────────────────────────────────────────
 *   ChatView (hideHeader; the issue view supplies its own)
 *
 * Single-chat issues skip the tab strip entirely so the surface stays clean.
 *
 * Per-window claim: matches the pattern in OrchestratorChatHost — claims the
 * active chat so streaming events deliver to this window. Releases on unmount
 * or active-chat switch.
 *
 * Empty state: if the issue has no chats yet (legacy issues created before the
 * unified flow shipped), shows a single "Start a chat" button that creates the
 * first one.
 */
export function IssueChatHost({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils()
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const chatSourceMode = useAtomValue(chatSourceModeAtom)

  const { data: chats = [], isLoading } = trpc.issueChats.list.useQuery(
    { issueId },
    { refetchInterval: 5000, refetchIntervalInBackground: false },
  )

  const [activeChatId, setActiveChatId] = useState<string | null>(null)

  // Default the active chat to the most recent one. When the list arrives or
  // changes (e.g., new chat created), pick the first if nothing is selected
  // OR if the selected one disappeared (archived).
  useEffect(() => {
    if (chats.length === 0) {
      setActiveChatId(null)
      return
    }
    if (!activeChatId || !chats.some((c) => c.id === activeChatId)) {
      setActiveChatId(chats[0].id)
    }
  }, [chats, activeChatId])

  // Mirror to selectedAgentChatId while mounted — ChatView reads that atom
  // for cross-component coordination (sub-chat tabs, composer, streaming).
  useEffect(() => {
    if (activeChatId) setSelectedChatId(activeChatId)
  }, [activeChatId, setSelectedChatId])

  useChatClaim(activeChatId, {
    onConflict: () => setActiveChatId(null),
  })

  const createMutation = trpc.issueChats.create.useMutation({
    onSuccess: (chat) => {
      void utils.issueChats.list.invalidate({ issueId })
      setActiveChatId(chat.id)
    },
    onError: (err) => toast.error(err.message),
  })

  const archiveMutation = trpc.issueChats.archive.useMutation({
    onSuccess: () => {
      void utils.issueChats.list.invalidate({ issueId })
    },
  })

  const showTabs = chats.length > 1

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading chat…
      </div>
    )
  }

  if (chats.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <div className="italic">No chat yet on this issue.</div>
        <Button
          size="sm"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate({ issueId })}
        >
          {createMutation.isPending ? (
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
          ) : (
            <MessageSquare className="mr-1.5 h-3 w-3" />
          )}
          Start a chat
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {showTabs && (
        <ChatTabStrip
          chats={chats}
          activeChatId={activeChatId}
          onSelect={setActiveChatId}
          onArchive={(id) => archiveMutation.mutate({ id })}
          onNew={() => createMutation.mutate({ issueId })}
          createPending={createMutation.isPending}
        />
      )}
      {!showTabs && (
        <NewChatBar
          onNew={() => createMutation.mutate({ issueId })}
          createPending={createMutation.isPending}
        />
      )}
      <div className="flex-1 overflow-hidden">
        {activeChatId && (
          <ChatView
            key={`${chatSourceMode}-${activeChatId}`}
            chatId={activeChatId}
            isSidebarOpen={false}
            onToggleSidebar={() => {}}
            hideHeader
          />
        )}
      </div>
    </div>
  )
}

function ChatTabStrip({
  chats,
  activeChatId,
  onSelect,
  onArchive,
  onNew,
  createPending,
}: {
  chats: IssueChat[]
  activeChatId: string | null
  onSelect: (id: string) => void
  onArchive: (id: string) => void
  onNew: () => void
  createPending: boolean
}) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-card/20 px-2 py-1">
      <div className="flex flex-1 items-center gap-1 overflow-x-auto">
        {chats.map((c) => (
          <ChatTab
            key={c.id}
            chat={c}
            active={c.id === activeChatId}
            onSelect={() => onSelect(c.id)}
            onArchive={() => onArchive(c.id)}
          />
        ))}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-xs"
        disabled={createPending}
        onClick={onNew}
        title="New chat on this issue"
      >
        {createPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        Chat
      </Button>
    </div>
  )
}

function ChatTab({
  chat,
  active,
  onSelect,
  onArchive,
}: {
  chat: IssueChat
  active: boolean
  onSelect: () => void
  onArchive: () => void
}) {
  const label = useMemo(() => {
    if (chat.name && chat.name.length > 0) return chat.name
    return chat.createdAt ? new Date(chat.createdAt).toLocaleString() : "(unnamed)"
  }, [chat.name, chat.createdAt])

  return (
    <div
      className={cn(
        "group flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
        active ? "border-primary/40 bg-primary/10 text-foreground" : "border-border bg-background/50 text-muted-foreground hover:bg-muted/40",
      )}
    >
      <button type="button" onClick={onSelect} className="max-w-[180px] truncate text-left">
        {label}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onArchive()
        }}
        className="opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        title="Archive chat"
      >
        <Archive className="h-3 w-3" />
      </button>
    </div>
  )
}

function NewChatBar({
  onNew,
  createPending,
}: {
  onNew: () => void
  createPending: boolean
}) {
  return (
    <div className="flex items-center justify-end border-b border-border bg-card/20 px-2 py-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 gap-1 text-xs"
        disabled={createPending}
        onClick={onNew}
        title="New chat on this issue"
      >
        {createPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
        Chat
      </Button>
    </div>
  )
}

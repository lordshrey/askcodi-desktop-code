import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { useEffect } from "react"
import { selectedAgentChatIdAtom } from "../agents/atoms"
import { chatSourceModeAtom } from "../../lib/atoms"
import { useChatClaim } from "../../lib/hooks/use-chat-claim"
import { ChatView } from "../agents/main/active-chat"
import { orchestratorChatIdAtom } from "./atoms"

/**
 * Hosts <ChatView> inside OrchestratorLayout when a thread is explicitly
 * opened from the FE thread tab. Issue-attached chats use IssueChatHost
 * instead (mounted from IssueDetailView).
 *
 * Source of truth: orchestratorChatIdAtom (transient, never persisted) — kept
 * separate from selectedAgentChatIdAtom (per-window-persisted, drives Solo) so
 * a stale chat from a prior session can't silently take over orchestrator
 * routes. ChatView still reads selectedAgentChatIdAtom for cross-component
 * coordination, so we mirror it while mounted.
 *
 * Embedded mode: preview/diff/terminal callbacks are intentionally undefined
 * so those buttons hide. The plan sidebar (atom-driven internal) still works.
 * Power users use the Solo toggle for the full surface.
 */
export function OrchestratorChatHost() {
  const [orchestratorChatId, setOrchestratorChatId] = useAtom(orchestratorChatIdAtom)
  const setSelectedChatId = useSetAtom(selectedAgentChatIdAtom)
  const chatSourceMode = useAtomValue(chatSourceModeAtom)

  useEffect(() => {
    if (orchestratorChatId) setSelectedChatId(orchestratorChatId)
  }, [orchestratorChatId, setSelectedChatId])

  useChatClaim(orchestratorChatId, {
    onConflict: () => setOrchestratorChatId(null),
  })

  if (!orchestratorChatId) return null

  return (
    <ChatView
      key={`${chatSourceMode}-${orchestratorChatId}`}
      chatId={orchestratorChatId}
      isSidebarOpen={false}
      onToggleSidebar={() => {}}
      onBackToChats={() => setOrchestratorChatId(null)}
    />
  )
}

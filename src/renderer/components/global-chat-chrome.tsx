import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { useCallback } from "react"
import { ClaudeLoginModal } from "./dialogs/claude-login-modal"
import { AskCodiLoginModal } from "./dialogs/askcodi-login-modal"
import { CodexLoginModal } from "./dialogs/codex-login-modal"
import { QueueProcessor } from "../features/agents/components/queue-processor"
import { useAgentsHotkeys } from "../features/agents/lib/agents-hotkeys-manager"
import { toggleSearchAtom } from "../features/agents/search"
import {
  selectedAgentChatIdAtom,
  selectedDraftIdAtom,
  showNewChatFormAtom,
  desktopViewAtom,
  fileSearchDialogOpenAtom,
} from "../features/agents/atoms"
import {
  agentsSidebarOpenAtom,
  agentsSettingsDialogActiveTabAtom,
  betaKanbanEnabledAtom,
  claudeLoginModalConfigAtom,
  customHotkeysAtom,
} from "../lib/atoms"
import { appModeAtom, orchestratorChatIdAtom } from "../features/orchestrator/atoms"

/**
 * Chat chrome that must mount in BOTH "chat" and "orchestrator" app modes.
 *
 * Lifted out of AgentsLayout so the embedded ChatView inside the orchestrator
 * gets:
 *   - QueueProcessor: drains queued messages for active sub-chats.
 *   - Login modals (Claude / AskCodi / Codex): appear when an agent demands
 *     auth, regardless of which layout the chat is hosted in.
 *   - useAgentsHotkeys: ⌘Enter, ⌘F, ⌘P, etc. work over the embedded chat.
 *
 * Hotkey scope: only enabled when there is a chat to act on (Solo mode is
 * always such, orchestrator only when a chat is selected). Prevents surprise
 * behavior on routes like board/inbox/agents that have no chat context.
 */
export function GlobalChatChrome() {
  const appMode = useAtomValue(appModeAtom)
  const orchestratorChatId = useAtomValue(orchestratorChatIdAtom)
  const claudeLoginModalConfig = useAtomValue(claudeLoginModalConfigAtom)
  const customHotkeysConfig = useAtomValue(customHotkeysAtom)
  const betaKanbanEnabled = useAtomValue(betaKanbanEnabledAtom)

  const [selectedChatId, setSelectedChatId] = useAtom(selectedAgentChatIdAtom)
  const setSelectedDraftId = useSetAtom(selectedDraftIdAtom)
  const setShowNewChatForm = useSetAtom(showNewChatFormAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)
  const [, setSidebarOpen] = useAtom(agentsSidebarOpenAtom)
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom)
  const setFileSearchDialogOpen = useSetAtom(fileSearchDialogOpenAtom)
  const toggleChatSearch = useSetAtom(toggleSearchAtom)

  const setSidebarOpenSafe = useCallback(
    (open: boolean | ((prev: boolean) => boolean)) => setSidebarOpen(open),
    [setSidebarOpen],
  )

  // Scope hotkeys to a *visible* chat surface. Solo always shows one when in
  // "chat" mode; orchestrator only shows one when orchestratorChatIdAtom is
  // explicitly set. Tying to selectedAgentChatIdAtom would falsely fire on
  // routes like Board/Inbox/Dashboard while a stale persisted chat ID lingers.
  const hotkeysEnabled = appMode === "chat" || orchestratorChatId != null

  useAgentsHotkeys(
    {
      setSelectedChatId,
      setSelectedDraftId,
      setShowNewChatForm,
      setDesktopView,
      setSidebarOpen: setSidebarOpenSafe,
      setSettingsActiveTab,
      setFileSearchDialogOpen,
      toggleChatSearch,
      selectedChatId,
      customHotkeysConfig,
      betaKanbanEnabled,
    },
    { enabled: hotkeysEnabled },
  )

  return (
    <>
      <QueueProcessor />
      <ClaudeLoginModal
        hideCustomModelSettingsLink={
          claudeLoginModalConfig.hideCustomModelSettingsLink
        }
        autoStartAuth={claudeLoginModalConfig.autoStartAuth}
      />
      <CodexLoginModal />
      <AskCodiLoginModal />
    </>
  )
}

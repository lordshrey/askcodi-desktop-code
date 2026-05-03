import { useSetAtom } from "jotai"
import { LayoutGrid } from "lucide-react"
import { appModeAtom } from "./atoms"

/**
 * Floating toggle that switches chat mode → orchestrator mode.
 * Rendered only when appMode === "chat" (the parent decides). The reverse
 * direction is handled inside the orchestrator sidebar's "Chat" button.
 */
export function ChatToOrchestratorToggle() {
  const setMode = useSetAtom(appModeAtom)
  return (
    <button
      type="button"
      onClick={() => setMode("orchestrator")}
      className="fixed bottom-4 left-4 z-50 inline-flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur transition-all hover:border-border hover:bg-background hover:text-foreground"
      title="Switch to orchestrator (multi-agent control plane)"
    >
      <LayoutGrid className="h-3.5 w-3.5" />
      Orchestrator
    </button>
  )
}

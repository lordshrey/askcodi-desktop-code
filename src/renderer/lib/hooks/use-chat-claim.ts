import { useEffect, useRef } from "react"
import { toast } from "sonner"

/**
 * Per-window chat ownership lock. Streaming subscriptions deliver events to
 * whichever window owns the chat; without claiming, embedded surfaces silently
 * drop events even when the chat renders.
 *
 * Mirrors the claim-then-release pattern in agents-sidebar.tsx so embedded
 * hosts (orchestrator chat host, future surfaces) get the same behavior.
 *
 * Pass null to release without claiming a new chat.
 */
export function useChatClaim(
  chatId: string | null,
  options: { onConflict?: () => void } = {},
) {
  const claimedRef = useRef<string | null>(null)
  const onConflictRef = useRef(options.onConflict)
  onConflictRef.current = options.onConflict

  useEffect(() => {
    if (!window.desktopApi?.claimChat) return
    if (!chatId) return

    let cancelled = false
    const target = chatId
    const previous = claimedRef.current

    void window.desktopApi.claimChat(target).then(async (result) => {
      if (cancelled) {
        if (result.ok) await window.desktopApi?.releaseChat?.(target)
        return
      }
      if (!result.ok) {
        toast.info("This chat is already open in another window", {
          description: "Switching to that window.",
          duration: 3000,
        })
        await window.desktopApi?.focusChatOwner?.(target)
        onConflictRef.current?.()
        return
      }
      claimedRef.current = target
      if (previous && previous !== target) {
        await window.desktopApi?.releaseChat?.(previous)
      }
    })

    return () => {
      cancelled = true
    }
  }, [chatId])

  useEffect(() => {
    return () => {
      const claimed = claimedRef.current
      if (claimed) {
        void window.desktopApi?.releaseChat?.(claimed)
        claimedRef.current = null
      }
    }
  }, [])
}

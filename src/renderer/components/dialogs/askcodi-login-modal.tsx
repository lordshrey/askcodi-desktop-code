"use client"

import { useAtom, useSetAtom } from "jotai"
import { X } from "lucide-react"
import { useEffect, useRef } from "react"
import { pendingAuthRetryMessageAtom } from "../../features/agents/atoms"
import { useAskCodiLoginFlow } from "../../features/agents/hooks/use-askcodi-login-flow"
import {
  agentsSettingsDialogActiveTabAtom,
  agentsSettingsDialogOpenAtom,
  askCodiLoginModalOpenAtom,
  type SettingsTab,
} from "../../lib/atoms"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
} from "../ui/alert-dialog"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Logo } from "../ui/logo"

export function AskCodiLoginModal() {
  const [open, setOpen] = useAtom(askCodiLoginModalOpenAtom)
  const setSettingsOpen = useSetAtom(agentsSettingsDialogOpenAtom)
  const setSettingsActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom)
  const [pendingAuthRetry, setPendingAuthRetry] = useAtom(
    pendingAuthRetryMessageAtom,
  )
  const didInitRef = useRef(false)
  const isAuthRetryFlow = pendingAuthRetry?.provider === "askcodi"

  const {
    state,
    apiKeyInput,
    error,
    isValidating,
    saveApiKey,
    reset,
    setApiKeyInput,
  } = useAskCodiLoginFlow()

  useEffect(() => {
    if (!open) {
      didInitRef.current = false
      return
    }

    if (!didInitRef.current) {
      didInitRef.current = true
      reset()
    }
  }, [open, reset])

  useEffect(() => {
    if (!open || state !== "success") return

    if (pendingAuthRetry?.provider === "askcodi" && !pendingAuthRetry.readyToRetry) {
      setPendingAuthRetry({ ...pendingAuthRetry, readyToRetry: true })
    }

    setOpen(false)
  }, [open, state, pendingAuthRetry, setOpen, setPendingAuthRetry])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && pendingAuthRetry?.provider === "askcodi" && !pendingAuthRetry.readyToRetry) {
      setPendingAuthRetry(null)
    }
    setOpen(nextOpen)
  }

  const handleOpenModelsSettings = () => {
    if (pendingAuthRetry?.provider === "askcodi" && !pendingAuthRetry.readyToRetry) {
      setPendingAuthRetry(null)
    }
    setSettingsActiveTab("models" as SettingsTab)
    setSettingsOpen(true)
    setOpen(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="w-[380px] p-6">
        <AlertDialogCancel className="absolute right-4 top-4 h-6 w-6 p-0 border-0 bg-transparent hover:bg-muted rounded-sm opacity-70 hover:opacity-100">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </AlertDialogCancel>

        <div className="space-y-8">
          <div className="text-center space-y-4">
            <div className="flex items-center justify-center gap-2 p-2 mx-auto w-max rounded-full border border-border">
              <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center">
                <Logo className="w-5 h-5" fill="white" />
              </div>
            </div>
            <div className="space-y-1">
              <h1 className="text-base font-semibold tracking-tight">Connect AskCodi</h1>
              <p className="text-sm text-muted-foreground">
                Enter your AskCodi API key to get started
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {error && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}

            <Input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKeyInput.trim()) {
                  void saveApiKey()
                }
              }}
              placeholder="Enter your API key..."
              className="font-mono"
              autoFocus
            />
            <Button
              onClick={() => void saveApiKey()}
              disabled={isValidating || apiKeyInput.trim().length === 0}
              className="w-full"
            >
              {isValidating ? "Validating..." : "Connect"}
            </Button>
          </div>
        </div>

        {isAuthRetryFlow && (
          <div className="text-center !mt-2">
            <button
              type="button"
              onClick={handleOpenModelsSettings}
              className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
            >
              Manage API key in Settings
            </button>
          </div>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

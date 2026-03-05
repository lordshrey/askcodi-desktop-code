import { useAtom } from "jotai"
import { useCallback, useState } from "react"
import { toast } from "sonner"
import { askCodiApiKeyAtom } from "../../../lib/atoms"
import { trpc } from "../../../lib/trpc"

export type AskCodiLoginFlowState =
  | "idle"
  | "validating"
  | "success"
  | "error"

export function useAskCodiLoginFlow() {
  const [state, setState] = useState<AskCodiLoginFlowState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [storedApiKey, setStoredApiKey] = useAtom(askCodiApiKeyAtom)
  const [apiKeyInput, setApiKeyInput] = useState<string>(storedApiKey)
  const validateMutation = trpc.askcodi.validateApiKey.useMutation()
  const trpcUtils = trpc.useUtils()

  const saveApiKey = useCallback(async () => {
    const trimmed = apiKeyInput.trim()
    if (!trimmed) {
      setState("error")
      setError("Please enter an API key")
      return false
    }

    setState("validating")
    setError(null)

    try {
      const result = await validateMutation.mutateAsync({ apiKey: trimmed })
      if (result.success) {
        setStoredApiKey(trimmed)
        await trpcUtils.askcodi.getAuthStatus.invalidate()
        await trpcUtils.askcodi.models.invalidate()
        setState("success")
        toast.success("AskCodi connected successfully")
        return true
      } else {
        setState("error")
        setError(result.error || "Invalid API key")
        toast.error(result.error || "Invalid API key")
        return false
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to validate API key"
      setState("error")
      setError(message)
      toast.error(message)
      return false
    }
  }, [apiKeyInput, validateMutation, setStoredApiKey, trpcUtils])

  const reset = useCallback(() => {
    setState("idle")
    setError(null)
    setApiKeyInput(storedApiKey)
  }, [storedApiKey])

  return {
    state,
    apiKeyInput,
    error,
    isValidating: state === "validating",
    saveApiKey,
    reset,
    setApiKeyInput,
  }
}

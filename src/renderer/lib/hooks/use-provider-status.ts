import { trpc } from "../trpc"

export type ProviderStatus = {
  claudeDetected: boolean
  codexDetected: boolean
  codexState: string | undefined
  askCodiConnected: boolean
  askCodiUserEmail: string | null
  hasAnyProvider: boolean
  isLoading: boolean
}

/**
 * Single source of truth for whether the user has connected each agent.
 * Driven by real backend state (Claude CLI config / integration / system token,
 * Codex integration, AskCodi gateway key) rather than localStorage flags.
 *
 * Used by both the boot gate (App.tsx) to decide between dashboard and wizard
 * and by the onboarding Agents step to drive the per-card status badges.
 * React Query dedupes on query keys, so calling this from multiple components
 * does not multiply network round-trips.
 */
export function useProviderStatus(): ProviderStatus {
  const claudeEnvQuery = trpc.claudeCode.hasExistingCliConfig.useQuery(
    undefined,
    { refetchOnWindowFocus: true },
  )
  const claudeIntegrationQuery = trpc.claudeCode.getIntegration.useQuery(
    undefined,
    { refetchOnWindowFocus: true },
  )
  const claudeSystemTokenQuery = trpc.claudeCode.getSystemToken.useQuery(
    undefined,
    { refetchOnWindowFocus: true },
  )
  const codexQuery = trpc.codex.getIntegration.useQuery(undefined, {
    refetchOnWindowFocus: true,
  })
  const askCodiStatusQuery = trpc.askcodi.getAuthStatus.useQuery(undefined, {
    refetchOnWindowFocus: true,
  })

  const claudeDetected =
    !!claudeEnvQuery.data?.hasConfig ||
    !!claudeIntegrationQuery.data?.isConnected ||
    !!claudeSystemTokenQuery.data?.token

  const codexState = codexQuery.data?.state
  const codexDetected =
    codexState === "connected_chatgpt" || codexState === "connected_api_key"

  const askCodiConnected = !!askCodiStatusQuery.data?.authenticated
  const askCodiUserEmail = askCodiStatusQuery.data?.user?.email ?? null

  const isLoading =
    claudeEnvQuery.isLoading ||
    claudeIntegrationQuery.isLoading ||
    claudeSystemTokenQuery.isLoading ||
    codexQuery.isLoading ||
    askCodiStatusQuery.isLoading

  return {
    claudeDetected,
    codexDetected,
    codexState,
    askCodiConnected,
    askCodiUserEmail,
    hasAnyProvider: claudeDetected || codexDetected || askCodiConnected,
    isLoading,
  }
}

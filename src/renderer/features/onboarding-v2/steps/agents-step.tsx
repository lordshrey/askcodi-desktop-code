import { useSetAtom } from "jotai"
import { Check, Loader2, Sparkles } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { cn } from "../../../lib/utils"
import {
  agentsLoginModalOpenAtom,
  anthropicOnboardingCompletedAtom,
  apiKeyOnboardingCompletedAtom,
  billingMethodAtom,
  codexLoginModalOpenAtom,
  codexOnboardingCompletedAtom,
  type BillingMethod,
} from "../../../lib/atoms"
import { useProviderStatus } from "../../../lib/hooks/use-provider-status"

type AgentsStepProps = {
  onNext: () => void
}

export function AgentsStep({ onNext }: AgentsStepProps) {
  const setBillingMethod = useSetAtom(billingMethodAtom)
  const setAnthropicCompleted = useSetAtom(anthropicOnboardingCompletedAtom)
  const setCodexCompleted = useSetAtom(codexOnboardingCompletedAtom)
  const setApiKeyCompleted = useSetAtom(apiKeyOnboardingCompletedAtom)

  const setClaudeModalOpen = useSetAtom(agentsLoginModalOpenAtom)
  const setCodexModalOpen = useSetAtom(codexLoginModalOpenAtom)

  const {
    claudeDetected,
    codexDetected,
    codexState,
    askCodiConnected,
    askCodiUserEmail,
    hasAnyProvider,
    isLoading,
  } = useProviderStatus()

  const handleContinue = () => {
    // Per-provider completion atoms stay in sync with detected state so the
    // rest of the app reflects reality on the dashboard.
    if (claudeDetected) setAnthropicCompleted(true)
    if (codexDetected) setCodexCompleted(true)
    if (askCodiConnected) setApiKeyCompleted(true)

    // Billing method picks the highest-priority connected provider.
    const codexBilling: BillingMethod =
      codexState === "connected_api_key" ? "codex-api-key" : "codex-subscription"
    const billing: BillingMethod = claudeDetected
      ? "claude-subscription"
      : codexDetected
        ? codexBilling
        : askCodiConnected
          ? "askcodi"
          : null

    if (billing) setBillingMethod(billing)
    onNext()
  }

  return (
    <div className="mx-auto w-full max-w-2xl rounded-xl border border-border bg-card p-8 shadow-lg">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Connect your coding agents
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          AskCodi is connected automatically. Add Claude or Codex to use those
          agents directly with your existing subscription. You can connect more
          later from Settings.
        </p>
      </div>

      <div className="mb-6 flex flex-col gap-3">
        <ProviderCard
          name="AskCodi"
          tagline={
            askCodiUserEmail
              ? `Signed in as ${askCodiUserEmail}`
              : "Routes through the AskCodi gateway"
          }
          status={
            isLoading ? "loading" : askCodiConnected ? "connected" : "needs-reauth"
          }
          actionLabel="Sign in again"
          onAction={() => {
            // Older auth.dat files have no gateway key — re-OAuth recovers.
            void window.desktopApi?.startAuthFlow?.()
          }}
        />
        <ProviderCard
          name="Claude Code"
          tagline="Anthropic's flagship coding agent"
          status={
            isLoading ? "loading" : claudeDetected ? "connected" : "disconnected"
          }
          actionLabel="Connect"
          onAction={() => setClaudeModalOpen(true)}
        />
        <ProviderCard
          name="Codex"
          tagline="OpenAI's long-running coding agent"
          status={
            isLoading ? "loading" : codexDetected ? "connected" : "disconnected"
          }
          actionLabel="Connect"
          onAction={() => setCodexModalOpen(true)}
        />
      </div>

      <Button
        type="button"
        onClick={handleContinue}
        disabled={!hasAnyProvider}
        className="w-full"
      >
        Continue
      </Button>

      {!hasAnyProvider && !isLoading && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Connect at least one agent to continue.
        </p>
      )}
    </div>
  )
}

type ProviderStatus = "loading" | "connected" | "disconnected" | "needs-reauth"

type ProviderCardProps = {
  name: string
  tagline: string
  status: ProviderStatus
  actionLabel: string
  onAction: () => void
}

function ProviderCard({
  name,
  tagline,
  status,
  actionLabel,
  onAction,
}: ProviderCardProps) {
  const showAction = status === "disconnected" || status === "needs-reauth"
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-background p-4 transition-colors",
        status === "connected"
          ? "border-primary/40 bg-primary/5"
          : "border-border",
      )}
    >
      <Sparkles className="size-4 shrink-0 text-foreground" />
      <div className="min-w-0 flex-1">
        <div className="font-display text-sm font-semibold text-foreground">
          {name}
        </div>
        <div className="truncate text-xs text-muted-foreground">{tagline}</div>
      </div>

      {status === "loading" && (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Checking…
        </span>
      )}
      {status === "connected" && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          <Check className="size-3" /> Connected
        </span>
      )}
      {showAction && (
        <Button type="button" size="sm" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}

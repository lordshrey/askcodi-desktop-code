import { useSetAtom } from "jotai"
import { Check, Loader2, Sparkles } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Button } from "../../../components/ui/button"
import { Input } from "../../../components/ui/input"
import { cn } from "../../../lib/utils"
import {
  agentsLoginModalOpenAtom,
  anthropicOnboardingCompletedAtom,
  apiKeyOnboardingCompletedAtom,
  askCodiApiKeyAtom,
  billingMethodAtom,
  codexLoginModalOpenAtom,
  codexOnboardingCompletedAtom,
  type BillingMethod,
} from "../../../lib/atoms"
import { trpc } from "../../../lib/trpc"

type AgentsStepProps = {
  onNext: () => void
}

type Provider = "claude" | "codex" | "askcodi"

export function AgentsStep({ onNext }: AgentsStepProps) {
  const setBillingMethod = useSetAtom(billingMethodAtom)
  const setAnthropicCompleted = useSetAtom(anthropicOnboardingCompletedAtom)
  const setCodexCompleted = useSetAtom(codexOnboardingCompletedAtom)
  const setApiKeyCompleted = useSetAtom(apiKeyOnboardingCompletedAtom)
  const setAskCodiApiKey = useSetAtom(askCodiApiKeyAtom)

  const setClaudeModalOpen = useSetAtom(agentsLoginModalOpenAtom)
  const setCodexModalOpen = useSetAtom(codexLoginModalOpenAtom)

  const [selected, setSelected] = useState<Provider | null>(null)
  const [showAskCodiForm, setShowAskCodiForm] = useState(false)
  const [askCodiKeyInput, setAskCodiKeyInput] = useState("")
  const [askCodiValidated, setAskCodiValidated] = useState(false)
  const [askCodiError, setAskCodiError] = useState<string | null>(null)

  // ── Detection queries ─────────────────────────────────────────────────
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

  const claudeDetected = useMemo(() => {
    if (claudeEnvQuery.data?.hasConfig) return true
    if (claudeIntegrationQuery.data?.isConnected) return true
    if (claudeSystemTokenQuery.data?.token) return true
    return false
  }, [
    claudeEnvQuery.data,
    claudeIntegrationQuery.data,
    claudeSystemTokenQuery.data,
  ])

  const codexState = codexQuery.data?.state
  const codexDetected =
    codexState === "connected_chatgpt" || codexState === "connected_api_key"

  const validateAskCodiKey = trpc.askcodi.validateApiKey.useMutation()

  const handleValidateAskCodi = async () => {
    setAskCodiError(null)
    const trimmed = askCodiKeyInput.trim()
    if (!trimmed) {
      setAskCodiError("Please enter an API key")
      return
    }
    try {
      const result = await validateAskCodiKey.mutateAsync({ apiKey: trimmed })
      if (result.success) {
        setAskCodiApiKey(trimmed)
        setAskCodiValidated(true)
        setSelected("askcodi")
      } else {
        setAskCodiError(result.error || "Invalid API key")
      }
    } catch (error) {
      setAskCodiError(
        error instanceof Error ? error.message : "Validation failed",
      )
    }
  }

  // ── Continue logic ────────────────────────────────────────────────────
  const canContinue =
    selected === "claude" ||
    selected === "codex" ||
    (selected === "askcodi" && askCodiValidated)

  const handleContinue = () => {
    let billing: BillingMethod = null

    if (selected === "claude") {
      billing = "claude-subscription"
      setAnthropicCompleted(true)
    } else if (selected === "codex") {
      billing = codexState === "connected_api_key"
        ? "codex-api-key"
        : "codex-subscription"
      setCodexCompleted(true)
    } else if (selected === "askcodi") {
      billing = "askcodi"
      setApiKeyCompleted(true)
    }

    if (billing) {
      setBillingMethod(billing)
      onNext()
    }
  }

  // Auto-select the first detected provider once detection finishes, so
  // users with an existing local login can hit Continue immediately.
  useEffect(() => {
    if (selected !== null) return
    if (claudeDetected) {
      setSelected("claude")
    } else if (codexDetected) {
      setSelected("codex")
    }
  }, [selected, claudeDetected, codexDetected])

  return (
    <div className="mx-auto w-full max-w-2xl rounded-xl border border-border bg-card p-8 shadow-lg">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Set up your coding agent
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          AskCodi uses your local Claude or Codex login. Billing goes through
          your Anthropic or OpenAI account.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProviderCard
          name="Claude Code"
          tagline="Anthropic's flagship coding agent"
          detected={claudeDetected}
          loading={
            claudeEnvQuery.isLoading ||
            claudeIntegrationQuery.isLoading ||
            claudeSystemTokenQuery.isLoading
          }
          selected={selected === "claude"}
          onSelect={() => claudeDetected && setSelected("claude")}
          onSignIn={() => setClaudeModalOpen(true)}
        />
        <ProviderCard
          name="Codex"
          tagline="OpenAI's long-running coding agent"
          detected={codexDetected}
          loading={codexQuery.isLoading}
          selected={selected === "codex"}
          onSelect={() => codexDetected && setSelected("codex")}
          onSignIn={() => setCodexModalOpen(true)}
        />
      </div>

      {/* AskCodi key fallback */}
      <div className="mb-6">
        {!showAskCodiForm ? (
          <button
            type="button"
            onClick={() => setShowAskCodiForm(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Using Bedrock, Vertex, or another provider? Use an AskCodi API key →
          </button>
        ) : (
          <div className="rounded-md border border-border bg-muted/20 p-3">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              AskCodi API key
            </label>
            <div className="flex gap-2">
              <Input
                type="password"
                value={askCodiKeyInput}
                onChange={(e) => {
                  setAskCodiKeyInput(e.target.value)
                  setAskCodiValidated(false)
                  setAskCodiError(null)
                }}
                placeholder="ac_..."
                className="flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleValidateAskCodi}
                disabled={validateAskCodiKey.isPending}
              >
                {validateAskCodiKey.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : askCodiValidated ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  "Validate"
                )}
              </Button>
            </div>
            {askCodiError && (
              <div className="mt-2 text-xs text-destructive">{askCodiError}</div>
            )}
            {askCodiValidated && (
              <div className="mt-2 text-xs text-primary">
                ✓ Key validated. Click Continue to finish.
              </div>
            )}
          </div>
        )}
      </div>

      <Button
        type="button"
        onClick={handleContinue}
        disabled={!canContinue}
        className="w-full"
      >
        Continue
      </Button>
    </div>
  )
}

type ProviderCardProps = {
  name: string
  tagline: string
  detected: boolean
  loading: boolean
  selected: boolean
  onSelect: () => void
  onSignIn: () => void
}

function ProviderCard({
  name,
  tagline,
  detected,
  loading,
  selected,
  onSelect,
  onSignIn,
}: ProviderCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-background p-4 transition-colors",
        selected
          ? "border-primary/60 bg-primary/5"
          : detected
            ? "border-border hover:border-primary/40 cursor-pointer"
            : "border-border opacity-90",
      )}
      onClick={detected ? onSelect : undefined}
    >
      <div className="flex items-start gap-2">
        <Sparkles className="size-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          <div className="font-display text-sm font-semibold text-foreground">
            {name}
          </div>
          <div className="text-xs text-muted-foreground">{tagline}</div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Checking…
          </span>
        ) : detected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            <Check className="size-3" /> Login detected
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation()
              onSignIn()
            }}
          >
            Sign in
          </Button>
        )}
      </div>
    </div>
  )
}

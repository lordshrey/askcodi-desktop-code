import { Github, Check, ExternalLink, Loader2 } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { trpc } from "../../../lib/trpc"

type GithubStepProps = {
  onNext: () => void
}

export function GithubStep({ onNext }: GithubStepProps) {
  // Polling interval keeps the status fresh while the user completes the
  // browser OAuth flow. Once connected, polling is harmless (data is cached).
  const statusQuery = trpc.integrations.getGithubStatus.useQuery(undefined, {
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  })

  const connectMutation = trpc.integrations.connectGithub.useMutation()

  const isConnected = statusQuery.data?.isConnected ?? false
  const username = statusQuery.data?.username
  const isLoadingStatus = statusQuery.isLoading
  const isConnecting = connectMutation.isPending

  const handleConnect = async () => {
    try {
      await connectMutation.mutateAsync()
      // Browser opens; the polling query above picks up the new status.
    } catch (error) {
      console.error("[GithubStep] connect error:", error)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-lg">
      <div className="mb-6 flex items-center gap-3">
        <Github className="size-6 text-foreground" />
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Connect GitHub
        </h1>
      </div>

      <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
        Connect your GitHub account so AskCodi can read your repos for
        future PR and issue features. Your credentials live with GitHub —
        we only store an access token.
      </p>

      {/* Status banner */}
      <div className="mb-6">
        {isLoadingStatus && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking GitHub status…
          </div>
        )}

        {!isLoadingStatus && isConnected && username && (
          <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground">
            <Check className="size-4 text-primary" />
            Connected as <strong className="font-semibold">{username}</strong>
          </div>
        )}

        {!isLoadingStatus && !isConnected && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            GitHub is not connected. You can skip and add it later from
            Settings.
          </div>
        )}

        {connectMutation.error && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {connectMutation.error.message}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3">
        {!isConnected && (
          <Button
            type="button"
            variant="outline"
            onClick={handleConnect}
            disabled={isConnecting}
            className="w-full"
          >
            {isConnecting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Opening browser…
              </>
            ) : (
              <>
                <ExternalLink className="mr-2 size-4" />
                Connect GitHub
              </>
            )}
          </Button>
        )}

        <Button
          type="button"
          onClick={onNext}
          className="w-full"
          disabled={isLoadingStatus}
        >
          {isConnected ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </div>
  )
}

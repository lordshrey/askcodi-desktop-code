"use client"

import { useEffect } from "react"
import { trpc } from "../../../lib/trpc"
import { GitHubIcon } from "../../../icons"

function LinearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" fill="currentColor">
      <path d="M1.22541 61.5228c-.97027-2.0258-.49419-4.4688 1.17771-6.1407l34.4386-34.4386c1.6718-1.6719 4.1148-2.14799 6.1406-1.17771 1.1746.56266 2.3162 1.18962 3.4198 1.87746L2.9398 65.1063c-.68784-1.1036-1.3148-2.2452-1.87739-3.4196-.00099-.0125-.0131-.0189-.01965-.0189-.00568 0-.01019.0063-.01019.0153-.01297.0021-.02594.0021-.03891 0zm6.2SEDq4.39.11c1.53 2.97 3.33 5.79 5.36 8.42L56.5849 20.5638c-2.6262-2.0322-5.4462-3.8337-8.4258-5.3652L5.6155 57.7427a46.1654 46.1654 0 0 1-.0541-3.1536l.00109-.0663zM12.1539 67.6268c1.8022 2.4744 3.8244 4.78 6.0338 6.8892 2.1117 2.1092 4.4148 4.0353 6.89 5.8375l47.5417-47.5417c-1.7953-2.4815-3.7957-4.7945-5.977-6.9212-2.0716-2.0222-4.3184-3.88-6.7178-5.5506L12.1539 67.6268zm17.5875 16.1017c2.6244 1.521 5.3909 2.8093 8.2711 3.8396l35.2963-35.2963c-1.0244-2.88-2.3072-5.6459-3.8221-8.2717L29.7414 83.7285zm12.3953 4.8892c2.7685.7672 5.6316 1.2752 8.5646 1.501l27.2324-27.2324c-.2201-2.9329-.7224-5.796-1.4844-8.5646L42.1367 88.6177zm12.9855 1.4883c3.2439-.061 6.4316-.4818 9.5195-1.2579l17.958-17.958c.783-3.0879 1.2102-6.2756 1.2778-9.5195L55.1222 90.1060zm15.1424-3.3025c2.5102-1.046 4.9032-2.3204 7.1512-3.8006l6.8925-6.8925c1.4875-2.2481 2.7629-4.6416 3.8147-7.1519L72.2646 86.8035zm11.6856-8.7849c1.3753-2.0838 2.5616-4.2926 3.5384-6.607l.7021-.7021c2.3193-1.0044 4.5213-2.1907 6.607-3.5383l-10.8475 10.8474zm5.2858-11.6186c.5765-1.9003.9922-3.8572 1.2357-5.8592l4.6234-4.6234c1.9934-.2485 3.9519-.6614 5.8499-1.2385l-11.709 11.7211zm1.2246-10.9746c-.0617-2.5128-.3655-4.974-.9056-7.3597l8.2654-8.2654c2.3949.5341 4.8529.8397 7.3597.9098l-14.7195 14.7153zm-1.5993-12.4658c-.7754-2.3267-1.7645-4.5594-2.9501-6.675l5.4-5.4c2.1277 1.1806 4.3485 2.169 6.675 2.95l-9.125 9.125zm-5.8744-11.2175c-1.4693-1.9222-3.0973-3.7134-4.8708-5.3596l2.0444-2.0444c1.6462 1.7735 3.4374 3.4015 5.3596 4.8708l-2.5332 2.5332zM22.2389 2.1693c-1.5813-.7637-3.465-.5107-4.7753.6998l-.1788.1788c-.3122.3123-.5782.6666-.7879 1.0531l-1.2095 1.2095c-.1875.1875-.1875.4916 0 .6791l80.3849 80.3849c.1875.1875.4916.1875.6791 0l1.2095-1.2095c.3867-.2097.7409-.4758 1.0531-.7879l.1788-.1788c1.2104-1.3104 1.4635-3.194.6998-4.7753L22.2389 2.1693z" />
    </svg>
  )
}

export function AgentsIntegrationsTab() {
  const { data: githubStatus, isLoading: githubLoading } = trpc.integrations.getGithubStatus.useQuery()
  const { data: linearStatus, isLoading: linearLoading } = trpc.integrations.getLinearStatus.useQuery()

  const trpcUtils = trpc.useUtils()

  // Listen for OAuth completion from main process
  useEffect(() => {
    const cleanup = window.desktopApi.onIntegrationConnected((platform) => {
      if (platform === "github") {
        trpcUtils.integrations.getGithubStatus.invalidate()
      } else if (platform === "linear") {
        trpcUtils.integrations.getLinearStatus.invalidate()
      }
    })
    return cleanup
  }, [trpcUtils])

  const connectGithub = trpc.integrations.connectGithub.useMutation()

  const disconnectGithub = trpc.integrations.disconnectGithub.useMutation({
    onSuccess: () => {
      trpcUtils.integrations.getGithubStatus.invalidate()
    },
  })

  const connectLinear = trpc.integrations.connectLinear.useMutation()

  const disconnectLinear = trpc.integrations.disconnectLinear.useMutation({
    onSuccess: () => {
      trpcUtils.integrations.getLinearStatus.invalidate()
    },
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col space-y-1.5 text-center sm:text-left">
        <h3 className="text-sm font-semibold text-foreground">Integrations</h3>
        <p className="text-xs text-muted-foreground">
          Connect external services to browse and work on tasks.
        </p>
      </div>

      {/* Integration cards */}
      <div className="bg-background rounded-lg border border-border overflow-hidden">
        {/* GitHub */}
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <GitHubIcon className="h-5 w-5 flex-shrink-0" />
            <div className="flex flex-col space-y-1">
              <span className="text-sm font-medium text-foreground">GitHub</span>
              {githubStatus?.isConnected ? (
                <span className="text-xs text-muted-foreground">
                  Connected as <span className="font-medium text-foreground">{githubStatus.username}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Browse and work on PRs, issues, and more
                </span>
              )}
            </div>
          </div>
          {githubLoading ? (
            <div className="h-8 w-20 bg-muted animate-pulse rounded-md flex-shrink-0" />
          ) : githubStatus?.isConnected ? (
            <button
              onClick={() => disconnectGithub.mutate()}
              disabled={disconnectGithub.isPending}
              className="h-8 px-3 rounded-md text-sm font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex-shrink-0"
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => connectGithub.mutate()}
              disabled={connectGithub.isPending}
              className="h-8 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex-shrink-0"
            >
              Connect
            </button>
          )}
        </div>

        {/* Linear */}
        <div className="flex items-center justify-between p-4 border-t border-border">
          <div className="flex items-center gap-3">
            <LinearIcon className="h-5 w-5 flex-shrink-0" />
            <div className="flex flex-col space-y-1">
              <span className="text-sm font-medium text-foreground">Linear</span>
              {linearStatus?.isConnected ? (
                <span className="text-xs text-muted-foreground">
                  Connected as <span className="font-medium text-foreground">{linearStatus.username}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Browse and work on Linear issues and tickets
                </span>
              )}
            </div>
          </div>
          {linearLoading ? (
            <div className="h-8 w-20 bg-muted animate-pulse rounded-md flex-shrink-0" />
          ) : linearStatus?.isConnected ? (
            <button
              onClick={() => disconnectLinear.mutate()}
              disabled={disconnectLinear.isPending}
              className="h-8 px-3 rounded-md text-sm font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors flex-shrink-0"
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => connectLinear.mutate()}
              disabled={connectLinear.isPending}
              className="h-8 px-3 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex-shrink-0"
            >
              Connect
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

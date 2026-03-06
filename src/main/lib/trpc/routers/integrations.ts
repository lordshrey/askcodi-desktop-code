import { z } from "zod"
import { publicProcedure, router } from "../index"
import {
  openGitHubOAuth,
  openLinearOAuth,
  exchangeGitHubCode,
  exchangeLinearCode,
  getIntegration,
  deleteIntegration,
} from "../../integrations/oauth"

export const integrationsRouter = router({
  getGithubStatus: publicProcedure.query(() => {
    const integration = getIntegration("github")
    if (!integration) {
      return { isConnected: false, username: null, connectedAt: null }
    }
    return {
      isConnected: true,
      username: integration.platformUsername,
      connectedAt: integration.connectedAt?.toISOString() ?? null,
    }
  }),

  getLinearStatus: publicProcedure.query(() => {
    const integration = getIntegration("linear")
    if (!integration) {
      return { isConnected: false, username: null, connectedAt: null }
    }
    return {
      isConnected: true,
      username: integration.platformUsername,
      connectedAt: integration.connectedAt?.toISOString() ?? null,
    }
  }),

  connectGithub: publicProcedure.mutation(() => {
    openGitHubOAuth()
    return { success: true }
  }),

  connectLinear: publicProcedure.mutation(() => {
    openLinearOAuth()
    return { success: true }
  }),

  disconnectGithub: publicProcedure.mutation(() => {
    deleteIntegration("github")
    return { success: true }
  }),

  disconnectLinear: publicProcedure.mutation(() => {
    deleteIntegration("linear")
    return { success: true }
  }),

  handleOAuthCallback: publicProcedure
    .input(z.object({
      platform: z.enum(["github", "linear"]),
      code: z.string(),
    }))
    .mutation(async ({ input }) => {
      if (input.platform === "github") {
        await exchangeGitHubCode(input.code)
      } else {
        await exchangeLinearCode(input.code)
      }
      return { success: true }
    }),
})

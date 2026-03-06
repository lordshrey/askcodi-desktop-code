import { z } from "zod"
import { publicProcedure, router } from "../index"
import { GitHubAPI } from "../../integrations/github-api"
import { LinearAPI } from "../../integrations/linear-api"
import { getDatabase, chats, subChats, projects } from "../../db"
import { eq } from "drizzle-orm"
import { createId } from "../../db/utils"

const githubRouter = router({
  listRepos: publicProcedure.query(() => {
    const api = GitHubAPI.fromIntegration()
    if (!api) throw new Error("GitHub not connected")
    return api.getUserRepos()
  }),

  listIssues: publicProcedure
    .input(z.object({
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional(),
      page: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const api = GitHubAPI.fromIntegration()
      if (!api) throw new Error("GitHub not connected")
      return api.listIssues(input.owner, input.repo, input.state, input.page)
    }),

  listPullRequests: publicProcedure
    .input(z.object({
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional(),
      page: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const api = GitHubAPI.fromIntegration()
      if (!api) throw new Error("GitHub not connected")
      return api.listPullRequests(input.owner, input.repo, input.state, input.page)
    }),

  getIssueDetail: publicProcedure
    .input(z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
    }))
    .query(async ({ input }) => {
      const api = GitHubAPI.fromIntegration()
      if (!api) throw new Error("GitHub not connected")
      const [issue, comments] = await Promise.all([
        api.getIssue(input.owner, input.repo, input.number),
        api.getIssueComments(input.owner, input.repo, input.number),
      ])
      return { ...issue, comments }
    }),

  getPullRequestDetail: publicProcedure
    .input(z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
    }))
    .query(async ({ input }) => {
      const api = GitHubAPI.fromIntegration()
      if (!api) throw new Error("GitHub not connected")
      const [pr, diff] = await Promise.all([
        api.getPullRequest(input.owner, input.repo, input.number),
        api.getPullRequestDiff(input.owner, input.repo, input.number),
      ])
      return { ...pr, diff }
    }),
})

const linearRouter = router({
  listTeams: publicProcedure.query(async () => {
    console.log("[Tasks:Linear] listTeams called")
    const api = LinearAPI.fromIntegration()
    if (!api) {
      console.error("[Tasks:Linear] listTeams - Linear not connected (no integration found)")
      throw new Error("Linear not connected")
    }
    const teams = await api.getTeams()
    console.log("[Tasks:Linear] listTeams returning:", teams.length, "teams")
    return teams
  }),

  listProjects: publicProcedure
    .input(z.object({ teamId: z.string().optional() }))
    .query(async ({ input }) => {
      console.log("[Tasks:Linear] listProjects called:", input)
      const api = LinearAPI.fromIntegration()
      if (!api) {
        console.error("[Tasks:Linear] listProjects - Linear not connected")
        throw new Error("Linear not connected")
      }
      const projects = await api.getProjects(input.teamId)
      console.log("[Tasks:Linear] listProjects returning:", projects.length, "projects")
      return projects
    }),

  listIssues: publicProcedure
    .input(z.object({
      teamId: z.string().optional(),
      projectId: z.string().optional(),
      limit: z.number().optional(),
    }))
    .query(async ({ input }) => {
      console.log("[Tasks:Linear] listIssues called:", input)
      const api = LinearAPI.fromIntegration()
      if (!api) {
        console.error("[Tasks:Linear] listIssues - Linear not connected")
        throw new Error("Linear not connected")
      }
      const issues = await api.getTeamIssues(input.teamId, input.projectId, input.limit)
      console.log("[Tasks:Linear] listIssues returning:", issues.length, "issues")
      return issues
    }),

  getIssueDetail: publicProcedure
    .input(z.object({ issueId: z.string() }))
    .query(async ({ input }) => {
      const api = LinearAPI.fromIntegration()
      if (!api) throw new Error("Linear not connected")
      return api.getIssueDetail(input.issueId)
    }),
})

export const tasksRouter = router({
  github: githubRouter,
  linear: linearRouter,

  createFromExternal: publicProcedure
    .input(z.object({
      projectId: z.string(),
      title: z.string(),
      body: z.string(),
      sourceUrl: z.string(),
      sourceType: z.enum(["github-issue", "github-pr", "linear-ticket"]),
      sourceIdentifier: z.string(),
      additionalInstructions: z.string().optional(),
      model: z.string().optional(),
      provider: z.enum(["claude-code", "codex", "askcodi"]).optional(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()

      // Verify project exists
      const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get()
      if (!project) throw new Error("Project not found")

      const sourceLabel = input.sourceType === "github-issue" ? "GitHub Issue"
        : input.sourceType === "github-pr" ? "Pull Request"
        : "Linear Ticket"

      // Truncate body to ~4000 chars
      const truncatedBody = input.body.length > 4000
        ? input.body.slice(0, 4000) + "\n\n... (truncated)"
        : input.body

      let initialMessage = `Work on the following ${sourceLabel}:

## ${input.title} (${input.sourceIdentifier})
**Source:** ${input.sourceUrl}

## Description
${truncatedBody}`

      if (input.additionalInstructions) {
        initialMessage += `\n\n---\n${input.additionalInstructions}`
      }

      initialMessage += `\n\nAnalyze this and implement the necessary changes.`

      const chatId = createId()
      const subChatId = createId()
      const chatName = `[${input.sourceIdentifier}] ${input.title}`.slice(0, 100)

      // Create chat with worktreePath set to project path so the agent can start
      db.insert(chats).values({
        id: chatId,
        name: chatName,
        projectId: input.projectId,
        worktreePath: project.path,
      }).run()

      // Create sub-chat with initial message in AI SDK format
      const metadata: Record<string, string> = {}
      if (input.model) metadata.model = input.model
      if (input.provider) metadata.provider = input.provider

      const messages = JSON.stringify([{
        id: `msg-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text: initialMessage }],
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      }])

      db.insert(subChats).values({
        id: subChatId,
        name: "Main",
        chatId,
        mode: "agent",
        messages,
      }).run()

      return { chatId, subChatId }
    }),
})

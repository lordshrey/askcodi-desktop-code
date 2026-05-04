import { router } from "../index"
import { projectsRouter } from "./projects"
import { chatsRouter } from "./chats"
import { claudeRouter } from "./claude"
import { claudeCodeRouter } from "./claude-code"
import { appSettingsRouter } from "./app-settings"
import { anthropicAccountsRouter } from "./anthropic-accounts"
import { ollamaRouter } from "./ollama"
import { codexRouter } from "./codex"
import { askcodiRouter } from "./askcodi"
import { terminalRouter } from "./terminal"
import { externalRouter } from "./external"
import { filesRouter } from "./files"
import { debugRouter } from "./debug"
import { skillsRouter } from "./skills"
import { agentDefinitionsRouter } from "./agent-definitions"
import { worktreeConfigRouter } from "./worktree-config"
import { sandboxImportRouter } from "./sandbox-import"
import { commandsRouter } from "./commands"
import { voiceRouter } from "./voice"
import { pluginsRouter } from "./plugins"
import { integrationsRouter } from "./integrations"
import { externalTasksRouter } from "./external-tasks"
import { runtimeAgentsRouter } from "./runtime-agents"
import { projectReposRouter } from "./project-repos"
import { feThreadsRouter } from "./fe-threads"
import { issuesRouter } from "./issues"
import { agentRunsRouter } from "./agent-runs"
import { agentRequestsRouter } from "./agent-requests"
import { agentWorktreesRouter } from "./agent-worktrees"
import { activityRouter } from "./activity"
import { createGitRouter } from "../../git"
import { BrowserWindow } from "electron"

/**
 * Create the main app router
 * Uses getter pattern to avoid stale window references
 */
export function createAppRouter(getWindow: () => BrowserWindow | null) {
  return router({
    projects: projectsRouter,
    chats: chatsRouter,
    claude: claudeRouter,
    claudeCode: claudeCodeRouter,
    claudeSettings: appSettingsRouter,
    anthropicAccounts: anthropicAccountsRouter,
    ollama: ollamaRouter,
    codex: codexRouter,
    askcodi: askcodiRouter,
    terminal: terminalRouter,
    external: externalRouter,
    files: filesRouter,
    debug: debugRouter,
    skills: skillsRouter,
    agentDefinitions: agentDefinitionsRouter,
    worktreeConfig: worktreeConfigRouter,
    sandboxImport: sandboxImportRouter,
    commands: commandsRouter,
    voice: voiceRouter,
    plugins: pluginsRouter,
    integrations: integrationsRouter,
    externalTasks: externalTasksRouter,
    // Orchestrator surface (paperclip-style)
    runtimeAgents: runtimeAgentsRouter,
    projectRepos: projectReposRouter,
    feThreads: feThreadsRouter,
    issues: issuesRouter,
    agentRuns: agentRunsRouter,
    agentRequests: agentRequestsRouter,
    agentWorktrees: agentWorktreesRouter,
    activity: activityRouter,
    // Git operations - named "changes" to match Superset API
    changes: createGitRouter(),
  })
}

/**
 * Export the router type for client usage
 */
export type AppRouter = ReturnType<typeof createAppRouter>

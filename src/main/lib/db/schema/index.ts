import { index, sqliteTable, text, integer, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { relations } from "drizzle-orm"
import { createId } from "../utils"
import { issues } from "./issues"

// ============ PROJECTS ============
export const projects = sqliteTable("projects", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  // Git remote info (extracted from local .git)
  gitRemoteUrl: text("git_remote_url"),
  gitProvider: text("git_provider"), // "github" | "gitlab" | "bitbucket" | null
  gitOwner: text("git_owner"),
  gitRepo: text("git_repo"),
  // Custom project icon (absolute path to local image file)
  iconPath: text("icon_path"),
  // Linear integration mapping
  linearTeamId: text("linear_team_id"),
  linearProjectId: text("linear_project_id"),
})

export const projectsRelations = relations(projects, ({ many }) => ({
  chats: many(chats),
}))

// ============ CHATS ============
export const chats = sqliteTable("chats", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name"),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  // Worktree fields (for git isolation per chat)
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  baseBranch: text("base_branch"),
  // PR tracking fields
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  // Source tracking (links chat to external task)
  sourceUrl: text("source_url"),
  sourceType: text("source_type"),        // "github-issue" | "github-pr" | "linear-ticket"
  sourceIdentifier: text("source_identifier"), // "#42" or "ENG-123"
  // Plugin mode (scopes agent to a specific plugin's capabilities)
  pluginId: text("plugin_id"),            // Plugin source identifier, e.g. "official:stripe-dev"
  // Chat kind:
  //   "solo"       — traditional 1:1 user↔Claude chat (Solo mode; default; backwards-compat).
  //   "thread"     — issue-less orchestrator thread (FE answers; was "fe_thread").
  //   "issue_chat" — chat attached to an orchestrator issue; many per issue.
  kind: text("kind").notNull().default("solo"), // ChatKind
  // Issue link. Null for solo and thread; set for issue_chat. CASCADE so deleting an
  // issue cleans up its chats — matches the rest of the orchestrator schema.
  issueId: text("issue_id").references((): AnySQLiteColumn => issues.id, { onDelete: "cascade" }),
}, (table) => [
  index("chats_worktree_path_idx").on(table.worktreePath),
  index("chats_source_url_idx").on(table.sourceUrl),
  index("chats_kind_idx").on(table.kind),
  index("chats_issue_id_idx").on(table.issueId),
])

export const chatsRelations = relations(chats, ({ one, many }) => ({
  project: one(projects, {
    fields: [chats.projectId],
    references: [projects.id],
  }),
  issue: one(issues, {
    fields: [chats.issueId],
    references: [issues.id],
  }),
  subChats: many(subChats),
}))

export const CHAT_KIND = {
  SOLO: "solo",
  THREAD: "thread",
  ISSUE_CHAT: "issue_chat",
} as const
export type ChatKind = (typeof CHAT_KIND)[keyof typeof CHAT_KIND]

// ============ SUB-CHATS ============
export const subChats = sqliteTable("sub_chats", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name"),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  sessionId: text("session_id"), // Claude SDK session ID for resume
  streamId: text("stream_id"), // Track in-progress streams
  mode: text("mode").notNull().default("agent"), // "plan" | "agent"
  messages: text("messages").notNull().default("[]"), // JSON array
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
})

export const subChatsRelations = relations(subChats, ({ one }) => ({
  chat: one(chats, {
    fields: [subChats.chatId],
    references: [chats.id],
  }),
}))

// ============ CLAUDE CODE CREDENTIALS ============
// Stores encrypted OAuth token for Claude Code integration
// DEPRECATED: Use anthropicAccounts for multi-account support
export const claudeCodeCredentials = sqliteTable("claude_code_credentials", {
  id: text("id").primaryKey().default("default"), // Single row, always "default"
  oauthToken: text("oauth_token").notNull(), // Encrypted with safeStorage
  connectedAt: integer("connected_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  userId: text("user_id"), // Desktop auth user ID (for reference)
})

// ============ ANTHROPIC ACCOUNTS (Multi-account support) ============
// Stores multiple Anthropic OAuth accounts for quick switching
export const anthropicAccounts = sqliteTable("anthropic_accounts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  email: text("email"), // User's email from OAuth (if available)
  displayName: text("display_name"), // User-editable label
  oauthToken: text("oauth_token").notNull(), // Encrypted with safeStorage
  connectedAt: integer("connected_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  desktopUserId: text("desktop_user_id"), // Reference to askcodi.com user
})

// Tracks which Anthropic account is currently active
export const anthropicSettings = sqliteTable("anthropic_settings", {
  id: text("id").primaryKey().default("singleton"), // Single row
  activeAccountId: text("active_account_id"), // References anthropicAccounts.id
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
})

// ============ INTEGRATIONS (OAuth tokens for GitHub/Linear) ============
export const integrations = sqliteTable("integrations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  platform: text("platform").notNull(), // "github" | "linear"
  accessToken: text("access_token").notNull(), // Encrypted via safeStorage
  refreshToken: text("refresh_token"), // Encrypted, nullable
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }),
  scope: text("scope"), // OAuth scopes granted
  platformUserId: text("platform_user_id"),
  platformUsername: text("platform_username"),
  connectedAt: integer("connected_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(
    () => new Date(),
  ),
})

// ============ TYPE EXPORTS ============
export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type Chat = typeof chats.$inferSelect
export type NewChat = typeof chats.$inferInsert
export type SubChat = typeof subChats.$inferSelect
export type NewSubChat = typeof subChats.$inferInsert
export type ClaudeCodeCredential = typeof claudeCodeCredentials.$inferSelect
export type NewClaudeCodeCredential = typeof claudeCodeCredentials.$inferInsert
export type AnthropicAccount = typeof anthropicAccounts.$inferSelect
export type NewAnthropicAccount = typeof anthropicAccounts.$inferInsert
export type AnthropicSettings = typeof anthropicSettings.$inferSelect
export type Integration = typeof integrations.$inferSelect
export type NewIntegration = typeof integrations.$inferInsert

// ============ ORCHESTRATOR TABLES (paperclip-style) ============
// Tables added for the agent orchestrator. Each lives in its own file for clarity.
// Re-exported here so existing import paths (`from "../db"` / `from "./schema"`) keep working.
export * from "./project-repos"
export * from "./runtime-agents"
export * from "./agent-worktrees"
export * from "./agent-requests"
export * from "./issues"
export * from "./issue-relations"
export * from "./issue-comments"
export * from "./issue-documents"
export * from "./issue-work-products"
export * from "./agent-wakeup-requests"
export * from "./agent-runs"
export * from "./agent-run-events"
export * from "./agent-task-sessions"
export * from "./agent-runtime-state"
export * from "./cost-events"
export * from "./activity-log"

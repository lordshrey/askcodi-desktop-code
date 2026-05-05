import { eq } from "drizzle-orm"
import { getDatabase, chats, subChats, projects, CHAT_KIND, type Chat, type ChatKind } from "../db"

// Shared chat-creation primitive used by feThreads.create, issueChats.create,
// and externalTasks.createFromExternal. Three callers were repeating the same
// "insert chat + insert one initial sub-chat" dance with subtle differences
// in field set; this collapses them.
//
// Worktree default policy:
//   - thread     → worktreePath = project.path  (FE talks about the project)
//   - issue_chat → worktreePath = null  (the agent's per-issue worktree wins)
//   - solo       → worktreePath = null unless caller passes one (back-compat)
// Callers can override by passing worktreePath explicitly.

export interface CreateChatInput {
  projectId: string
  kind: ChatKind
  name?: string | null
  issueId?: string | null
  worktreePath?: string | null
  sourceUrl?: string | null
  sourceType?: string | null
  sourceIdentifier?: string | null
  initialMessages?: string  // JSON-encoded messages array; defaults to "[]"
  subChatMode?: "plan" | "agent"
}

export interface CreateChatResult {
  chat: Chat
  subChatId: string
}

export function createChatWithInitialSubChat(input: CreateChatInput): CreateChatResult {
  const db = getDatabase()

  let worktreePath = input.worktreePath ?? null
  if (worktreePath === null && input.kind === CHAT_KIND.THREAD) {
    const project = db.select({ path: projects.path }).from(projects).where(eq(projects.id, input.projectId)).get()
    if (!project) throw new Error("Project not found")
    worktreePath = project.path
  }

  const chat = db
    .insert(chats)
    .values({
      projectId: input.projectId,
      name: input.name ?? null,
      kind: input.kind,
      issueId: input.issueId ?? null,
      worktreePath,
      sourceUrl: input.sourceUrl ?? null,
      sourceType: input.sourceType ?? null,
      sourceIdentifier: input.sourceIdentifier ?? null,
    })
    .returning()
    .get()

  const subChat = db
    .insert(subChats)
    .values({
      chatId: chat.id,
      mode: input.subChatMode ?? "agent",
      messages: input.initialMessages ?? "[]",
    })
    .returning()
    .get()

  return { chat, subChatId: subChat.id }
}

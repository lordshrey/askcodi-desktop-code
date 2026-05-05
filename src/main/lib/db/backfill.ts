import { eq, and, isNull, notInArray, sql } from "drizzle-orm"
import type { drizzle } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"
import { CHAT_KIND, chats, projects, subChats } from "./schema"

type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * One-shot backfill for thread chat rows created before the create-path
 * seeded worktreePath + an initial sub-chat. Idempotent — only writes for
 * rows still missing those fields.
 *
 * Replaces per-request lazy repair, which ran on every fe-chat-view list
 * refetch (every 5s) and every chat.get call.
 *
 * Renamed from backfillFeThreads when CHAT_KIND.FE_THREAD was renamed to
 * CHAT_KIND.THREAD; SQL-level rename happens in migration 0016.
 */
export function backfillThreads(db: Db): void {
  const missingWorktree = db
    .select({ id: chats.id, projectId: chats.projectId })
    .from(chats)
    .where(and(eq(chats.kind, CHAT_KIND.THREAD), isNull(chats.worktreePath)))
    .all()

  for (const row of missingWorktree) {
    const project = db
      .select({ path: projects.path })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .get()
    if (!project) continue
    db.update(chats)
      .set({ worktreePath: project.path })
      .where(eq(chats.id, row.id))
      .run()
  }

  const subChattedIds = db
    .selectDistinct({ chatId: subChats.chatId })
    .from(subChats)
    .all()
    .map((r) => r.chatId)

  const missingSubChat = db
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        eq(chats.kind, CHAT_KIND.THREAD),
        subChattedIds.length > 0
          ? notInArray(chats.id, subChattedIds)
          : sql`1 = 1`,
      ),
    )
    .all()

  for (const row of missingSubChat) {
    db.insert(subChats)
      .values({ chatId: row.id, mode: "agent", messages: "[]" })
      .run()
  }
}

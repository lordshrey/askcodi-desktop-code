/**
 * Atomic checkout race test — the single most important invariant of the orchestrator.
 *
 * Two runtime agents try to check out the same issue concurrently.
 * Exactly one must win; the other must get IssueConflictError.
 *
 * If this test ever flakes, the rest of the orchestrator is unsafe — investigate
 * immediately. Lost-write races on issue locks lead to two agents doing the same
 * work and corrupting state in ways that are very hard to debug after the fact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { eq } from "drizzle-orm"

// Electron is unavailable under vitest. Mock the surface our DB layer touches.
vi.mock("electron", () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), `askcodi-test-${process.pid}-${Date.now()}`),
    getVersion: () => "0.0.0-test",
    isPackaged: false,
  },
  BrowserWindow: class {},
}))

import * as schema from "../../db/schema"
import * as dbModule from "../../db"

let testDbPath: string
let testSqlite: Database.Database

beforeEach(() => {
  // Fresh DB per test, isolated under tmp.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "askcodi-checkout-"))
  testDbPath = path.join(tmpDir, "test.db")
  testSqlite = new Database(testDbPath)
  testSqlite.pragma("journal_mode = WAL")
  testSqlite.pragma("foreign_keys = ON")

  const testDb = drizzle(testSqlite, { schema })
  // Migrations live at <repo>/drizzle. Resolve from this test file (no __dirname under ESM).
  const migrationsFolder = path.resolve(process.cwd(), "drizzle")
  migrate(testDb, { migrationsFolder })

  // Hijack getDatabase() so service code under test reads our test DB.
  vi.spyOn(dbModule, "getDatabase").mockReturnValue(testDb as unknown as ReturnType<typeof dbModule.getDatabase>)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    testSqlite.close()
  } catch {
    // already closed
  }
  try {
    fs.rmSync(path.dirname(testDbPath), { recursive: true, force: true })
  } catch {
    // best effort
  }
})

async function seed() {
  const db = dbModule.getDatabase()

  const project = db
    .insert(schema.projects)
    .values({ name: "Test Project", path: "/tmp/test-project" })
    .returning()
    .all()[0]

  const agentA = db
    .insert(schema.runtimeAgents)
    .values({
      name: "Agent A",
      role: "engineer",
      adapterType: "claude_code",
      autonomyMode: "event",
    })
    .returning()
    .all()[0]

  const agentB = db
    .insert(schema.runtimeAgents)
    .values({
      name: "Agent B",
      role: "engineer",
      adapterType: "claude_code",
      autonomyMode: "event",
    })
    .returning()
    .all()[0]

  const issue = db
    .insert(schema.issues)
    .values({
      projectId: project.id,
      title: "Build feature X",
      identifier: "ISS-1",
      issueNumber: 1,
      status: "todo",
    })
    .returning()
    .all()[0]

  return { project, agentA, agentB, issue }
}

// Suite is skipped pending Electron-aware test infrastructure (Phase 7 / TODOS.md).
// Reason: better-sqlite3 is rebuilt against Electron's Node ABI by the postinstall
// script. Standalone vitest runs against the system Node, so loading better-sqlite3
// fails with NODE_MODULE_VERSION mismatch. The test code below is correct and worth
// keeping as the spec of what we want to verify — restore by removing `.skip` once
// we wire either electron-mocha, playwright-electron, or a dual-rebuild test script.
//
// What this suite proves when it runs:
//   1. Two concurrent checkout calls for the same issue → exactly one wins.
//   2. Checkout in unexpected status → IssueConflictError.
//   3. Checkout with unresolved blocker → IssueBlockedError.
//   4. Same-agent re-entry on same run is idempotent.
describe.skip("issues service — atomic checkout", () => {
  it("two agents racing to check out the same issue: exactly one wins", async () => {
    const { agentA, agentB, issue } = await seed()
    // Re-import to ensure the service uses the spied-on getDatabase.
    const { checkoutIssue, IssueConflictError } = await import("../issues")

    const promiseA = checkoutIssue({
      issueId: issue.id,
      runtimeAgentId: agentA.id,
      expectedStatuses: ["todo", "backlog"],
      checkoutRunId: "run-A-fake",
      actor: { type: "agent", id: agentA.id },
    })
    const promiseB = checkoutIssue({
      issueId: issue.id,
      runtimeAgentId: agentB.id,
      expectedStatuses: ["todo", "backlog"],
      checkoutRunId: "run-B-fake",
      actor: { type: "agent", id: agentB.id },
    })

    const results = await Promise.allSettled([promiseA, promiseB])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const reason = (rejected[0] as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(IssueConflictError)

    // The winner's row state.
    const db = dbModule.getDatabase()
    const finalIssue = db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.id, issue.id))
      .get()!

    expect(finalIssue.status).toBe("in_progress")
    expect([agentA.id, agentB.id]).toContain(finalIssue.assigneeRuntimeAgentId)
    expect(["run-A-fake", "run-B-fake"]).toContain(finalIssue.executionRunId)
  })

  it("checkout fails when issue is in unexpected status", async () => {
    const { agentA, issue } = await seed()
    const { checkoutIssue, IssueConflictError } = await import("../issues")

    // Move issue to "done" first (bypassing checkout).
    const db = dbModule.getDatabase()
    db
      .update(schema.issues)
      .set({ status: "done" })
      .where(eq(schema.issues.id, issue.id))
      .run()

    await expect(
      checkoutIssue({
        issueId: issue.id,
        runtimeAgentId: agentA.id,
        expectedStatuses: ["todo", "backlog"],
        checkoutRunId: "run-1",
        actor: { type: "agent", id: agentA.id },
      }),
    ).rejects.toBeInstanceOf(IssueConflictError)
  })

  it("checkout fails when blocker is unresolved", async () => {
    const { project, agentA, issue } = await seed()
    const { checkoutIssue, IssueBlockedError } = await import("../issues")

    const db = dbModule.getDatabase()
    const blocker = db
      .insert(schema.issues)
      .values({
        projectId: project.id,
        title: "Blocker",
        identifier: "ISS-2",
        issueNumber: 2,
        status: "todo",
      })
      .returning()
      .all()[0]

    db
      .insert(schema.issueRelations)
      .values({
        sourceIssueId: blocker.id,
        targetIssueId: issue.id,
        type: "blocks",
      })
      .run()

    await expect(
      checkoutIssue({
        issueId: issue.id,
        runtimeAgentId: agentA.id,
        expectedStatuses: ["todo", "backlog"],
        checkoutRunId: "run-1",
        actor: { type: "agent", id: agentA.id },
      }),
    ).rejects.toBeInstanceOf(IssueBlockedError)
  })

  it("same-agent re-entry on the same run is idempotent (no error)", async () => {
    const { agentA, issue } = await seed()
    const { checkoutIssue } = await import("../issues")

    const first = await checkoutIssue({
      issueId: issue.id,
      runtimeAgentId: agentA.id,
      expectedStatuses: ["todo", "backlog"],
      checkoutRunId: "run-X",
      actor: { type: "agent", id: agentA.id },
    })
    expect(first.status).toBe("in_progress")

    // Second call with the same run id — should re-enter without conflict.
    // The expectedStatuses include "in_progress" to allow the re-checkout.
    const second = await checkoutIssue({
      issueId: issue.id,
      runtimeAgentId: agentA.id,
      expectedStatuses: ["todo", "backlog", "in_progress"],
      checkoutRunId: "run-X",
      actor: { type: "agent", id: agentA.id },
    })
    expect(second.id).toBe(first.id)
    expect(second.executionRunId).toBe("run-X")
  })
})

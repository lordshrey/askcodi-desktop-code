/**
 * Tests for the scaffoldQuickStartDir helper used by projects.quickStart.
 *
 * Runs against a real temp directory so we actually verify git init + file
 * writes happen. Does NOT depend on Electron, DB, or tRPC context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// The helper pulls in electron indirectly via neighbour modules. Stub electron.
vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getVersion: () => "0.0.0-test",
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

// The router module pulls in DB, analytics, tRPC context helpers — stub them
// at import boundaries so the module evaluates cleanly.
vi.mock("../../../db", () => ({
  getDatabase: vi.fn(),
  projects: {},
}))

vi.mock("../../../analytics", () => ({
  trackProjectOpened: vi.fn(),
}))

vi.mock("../../../git", () => ({
  getGitRemoteInfo: vi.fn().mockResolvedValue({
    remoteUrl: null,
    provider: null,
    owner: null,
    repo: null,
  }),
}))

vi.mock("../../../cli", () => ({
  getLaunchDirectory: vi.fn(),
}))

vi.mock("../../index", () => ({
  router: (x: unknown) => x,
  publicProcedure: {
    input: () => ({ mutation: () => ({}), query: () => ({}) }),
    query: () => ({}),
    mutation: () => ({}),
  },
}))

import { scaffoldQuickStartDir } from "../projects"

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quickstart-test-"))
})

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
})

describe("scaffoldQuickStartDir", () => {
  it("creates the target directory with git init and a README", async () => {
    const targetDir = await scaffoldQuickStartDir(workDir, "my-app")

    expect(targetDir).toBe(join(workDir, "my-app"))
    expect(existsSync(targetDir)).toBe(true)
    expect(existsSync(join(targetDir, ".git"))).toBe(true)

    const readme = await readFile(join(targetDir, "README.md"), "utf-8")
    expect(readme).toContain("# my-app")
    expect(readme).toContain("Created by AskCodi.")
  })

  it("creates the parent dir recursively if it does not exist", async () => {
    const nested = join(workDir, "nested", "deeper")
    const targetDir = await scaffoldQuickStartDir(nested, "fresh-repo")

    expect(existsSync(targetDir)).toBe(true)
    expect(existsSync(join(targetDir, ".git"))).toBe(true)
  })

  it("throws if the target directory already exists", async () => {
    await scaffoldQuickStartDir(workDir, "first-repo")
    await expect(
      scaffoldQuickStartDir(workDir, "first-repo"),
    ).rejects.toThrow(/already exists/i)
  })

  it("does not make any commits (README should be untracked)", async () => {
    // If we ever regress and add a commit, this test breaks — which is
    // the point: `git commit` requires user.email on clean machines.
    const targetDir = await scaffoldQuickStartDir(workDir, "untracked-repo")
    const simpleGit = (await import("simple-git")).default
    const log = await simpleGit(targetDir).log().catch((e) => {
      // On an empty repo with no commits, git log fails — that's what we want.
      return { total: 0, error: e }
    })
    expect((log as { total: number }).total).toBe(0)
  })
})

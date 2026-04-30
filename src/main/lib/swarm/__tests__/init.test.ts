/**
 * Init pass tests. Verify pattern detection, ledger seeding, conditional
 * cached-partition creation, and idempotent re-runs.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  buildInitCachedPartitions,
  runInit,
  scanCodebase,
} from "../init"
import { loadLedger } from "../ledger"
import { loadAcoFrontierState } from "../algorithms/aco-frontier"

const tempRoots: string[] = []
function makeRepo(layout: Record<string, "dir" | "file">): string {
  const root = mkdtempSync(join(tmpdir(), "init-test-"))
  tempRoots.push(root)
  const entries = Object.entries(layout).sort(
    (a, b) => a[0].split("/").length - b[0].split("/").length,
  )
  for (const [path, kind] of entries) {
    const abs = join(root, path)
    if (kind === "dir") mkdirSync(abs, { recursive: true })
    else {
      mkdirSync(join(abs, ".."), { recursive: true })
      writeFileSync(abs, "")
    }
  }
  return root
}

afterEach(() => {
  while (tempRoots.length) {
    const r = tempRoots.pop()!
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe("scanCodebase", () => {
  it("identifies auth files", () => {
    const root = makeRepo({
      "src/auth/auth-store.ts": "file",
      "src/auth/AuthContext.tsx": "file",
      "src/lib/neonClient.ts": "file",
      "src/components/Button.tsx": "file",
    })
    const m = scanCodebase(root)
    expect(m.auth.sort()).toEqual([
      "src/auth/AuthContext.tsx",
      "src/auth/auth-store.ts",
      "src/lib/neonClient.ts",
    ])
  })

  it("identifies routing files", () => {
    const root = makeRepo({
      "src/App.tsx": "file",
      "src/router.ts": "file",
      "src/Routes.tsx": "file",
      "src/util.ts": "file",
    })
    const m = scanCodebase(root)
    expect(m.routing.sort()).toEqual([
      "src/App.tsx",
      "src/Routes.tsx",
      "src/router.ts",
    ])
  })

  it("identifies state files (contexts/atoms/stores)", () => {
    const root = makeRepo({
      "src/contexts/UserContext.tsx": "file",
      "src/atoms/sessionAtom.ts": "file",
      "src/store/index.ts": "file",
      "src/util.ts": "file",
    })
    const m = scanCodebase(root)
    expect(m.state.length).toBeGreaterThanOrEqual(3)
    expect(m.state.includes("src/util.ts")).toBe(false)
  })

  it("identifies db files (schema, migrations, drizzle)", () => {
    const root = makeRepo({
      "src/db/schema.ts": "file",
      "drizzle/0001_init.sql": "file",
      "src/util.ts": "file",
    })
    const m = scanCodebase(root)
    expect(m.db.length).toBeGreaterThanOrEqual(2)
  })

  it("identifies ipc files (trpc, preload, bridge)", () => {
    const root = makeRepo({
      "src/main/lib/trpc/router.ts": "file",
      "src/preload/index.ts": "file",
      "src/main/ipc-bridge.ts": "file",
      "src/util.ts": "file",
    })
    const m = scanCodebase(root)
    expect(m.ipc.length).toBeGreaterThanOrEqual(3)
  })

  it("identifies tests", () => {
    const root = makeRepo({
      "src/foo.test.ts": "file",
      "src/__tests__/bar.ts": "file",
      "src/baz.spec.tsx": "file",
      "src/util.ts": "file",
    })
    const m = scanCodebase(root)
    expect(m.tests.length).toBeGreaterThanOrEqual(3)
  })

  it("skips node_modules / dist / build / .git", () => {
    const root = makeRepo({
      "src/auth.ts": "file",
      "node_modules/foo/auth.ts": "file",
      "dist/auth.js": "file",
      ".git/HEAD": "file",
    })
    const m = scanCodebase(root)
    expect(m.auth).toEqual(["src/auth.ts"])
  })

  it("returns empty arrays when nothing matches", () => {
    const root = makeRepo({
      "README.md": "file",
      "src/util.ts": "file",
    })
    const m = scanCodebase(root)
    expect(m.auth).toEqual([])
    expect(m.routing).toEqual([])
  })
})

describe("buildInitCachedPartitions", () => {
  const emptyMatches = {
    auth: [] as string[],
    routing: [] as string[],
    state: [] as string[],
    db: [] as string[],
    ipc: [] as string[],
    tests: [] as string[],
  }

  it("creates auth partition only when ≥2 auth files exist", () => {
    const ps = buildInitCachedPartitions(
      { ...emptyMatches, auth: ["a.ts"] },
      ["src"],
    )
    expect(ps.find((p) => p.id === "auth")).toBeUndefined()

    const ps2 = buildInitCachedPartitions(
      { ...emptyMatches, auth: ["a.ts", "b.ts"] },
      ["src"],
    )
    expect(ps2.find((p) => p.id === "auth")).toBeDefined()
  })

  it("creates tier partition when inventory has main + renderer or preload", () => {
    const ps = buildInitCachedPartitions(emptyMatches, [
      "src/main",
      "src/renderer",
      "src/preload",
    ])
    const tier = ps.find((p) => p.id === "tier")
    expect(tier).toBeDefined()
    expect(tier!.workers.length).toBe(3)
  })

  it("does NOT create tier partition for a flat repo", () => {
    const ps = buildInitCachedPartitions(emptyMatches, ["src", "tests"])
    expect(ps.find((p) => p.id === "tier")).toBeUndefined()
  })

  it("creates data partition when ≥2 db files exist", () => {
    const ps = buildInitCachedPartitions(
      { ...emptyMatches, db: ["schema.ts", "drizzle/0001.sql"] },
      ["src"],
    )
    expect(ps.find((p) => p.id === "data")).toBeDefined()
  })
})

describe("runInit", () => {
  function makeAuthRepo(): string {
    return makeRepo({
      "src/main/auth-store.ts": "file",
      "src/main/auth-manager.ts": "file",
      "src/main/lib/neon.ts": "file",
      "src/preload/index.ts": "file",
      "src/renderer/App.tsx": "file",
      "src/renderer/contexts/UserContext.tsx": "file",
      "src/main/lib/db/schema.ts": "file",
      "drizzle/0001_init.sql": "file",
      "src/util.ts": "file",
      "package.json": "file",
    })
  }

  it("seeds region_memory + global ledger from detected patterns", () => {
    const root = makeAuthRepo()
    const report = runInit({ cwd: root })

    expect(report.skipped).toBe(false)
    expect(report.files_seeded).toBeGreaterThan(0)
    expect(report.matches.auth.length).toBeGreaterThanOrEqual(3)
    expect(report.matches.db.length).toBeGreaterThanOrEqual(2)
    expect(report.matches.state.length).toBeGreaterThanOrEqual(1)

    // Ledger should have files attributed to regions (where we have inventory).
    const ledger = loadLedger(root)
    expect(Object.keys(ledger.files).length).toBeGreaterThan(0)
    // Init bumps include auth files.
    const authFile = "src/main/auth-store.ts"
    expect(ledger.files[authFile]?.last_subagent).toBe("init")
    expect(ledger.files[authFile]?.priority).toBeCloseTo(0.2)
  })

  it("creates cached partitions for detected categories", () => {
    const root = makeAuthRepo()
    const report = runInit({
      cwd: root,
      partitionOptions: { containerNames: new Set(["src"]) },
    })

    expect(report.cached_partitions.sort()).toEqual(["auth", "data", "tier"])

    const state = loadAcoFrontierState(loadLedger(root))
    expect(state.cached_partitions.length).toBe(3)
    const ids = state.cached_partitions.map((p) => p.id).sort()
    expect(ids).toEqual(["auth", "data", "tier"])
  })

  it("bumps session_count to 1 so subsequent algorithms see warm start", () => {
    const root = makeAuthRepo()
    runInit({ cwd: root, partitionOptions: { containerNames: new Set(["src"]) } })
    const ledger = loadLedger(root)
    expect(ledger.session_count).toBe(1)
  })

  it("is idempotent on re-run (priority increases but partitions don't duplicate)", () => {
    const root = makeAuthRepo()
    runInit({ cwd: root, partitionOptions: { containerNames: new Set(["src"]) } })
    const beforeSize = (loadAcoFrontierState(loadLedger(root))).cached_partitions
      .length

    runInit({ cwd: root, partitionOptions: { containerNames: new Set(["src"]) } })
    const afterSize = (loadAcoFrontierState(loadLedger(root))).cached_partitions
      .length

    // Same partitions — no duplicates.
    expect(afterSize).toBe(beforeSize)
  })

  it("respects skipIfWarm when ledger already has session activity", () => {
    const root = makeAuthRepo()
    runInit({ cwd: root, partitionOptions: { containerNames: new Set(["src"]) } }) // bumps session_count to 1

    const report2 = runInit({ cwd: root, skipIfWarm: true })
    expect(report2.skipped).toBe(true)
    expect(report2.files_seeded).toBe(0)
  })

  it("returns per-region seeded counts", () => {
    const root = makeAuthRepo()
    const report = runInit({
      cwd: root,
      partitionOptions: { containerNames: new Set(["src"]) },
    })
    // src/main should have multiple seeded files (auth-store, auth-manager, lib/neon, db/schema)
    const mainCount = report.per_region_seeded["src/main"] ?? 0
    expect(mainCount).toBeGreaterThan(0)
  })

  it("handles a repo with no matched patterns (no-op)", () => {
    const root = makeRepo({
      "src/util.ts": "file",
      "src/helper.ts": "file",
      "README.md": "file",
    })
    const report = runInit({ cwd: root })
    expect(report.files_seeded).toBe(0)
    expect(report.cached_partitions).toEqual([])
  })
})

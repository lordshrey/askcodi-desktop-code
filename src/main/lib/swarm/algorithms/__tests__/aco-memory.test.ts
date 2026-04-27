/**
 * Pure-logic tests for the ACO pheromone memory module.
 * Uses a temp directory per test to exercise real disk IO.
 */
import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  applyDecay,
  bumpFile,
  buildPriorsBlock,
  getTopPriorityFiles,
  loadMemory,
  memoryPath,
  newMemory,
  pruneMemory,
  recordSession,
  saveMemory,
  DEFAULT_BUMP,
  DEFAULT_DECAY,
  PRIORITY_CEIL,
  PRIORITY_FLOOR,
  MAX_FILE_ENTRIES,
} from "../aco-memory"

const tempDirs: string[] = []
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aco-mem-test-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe("loadMemory / saveMemory", () => {
  it("returns fresh memory when no file exists", () => {
    const root = makeTempProject()
    const m = loadMemory(root)
    expect(m.session_count).toBe(0)
    expect(m.files).toEqual({})
    expect(m.project_root).toBe(root)
  })

  it("round-trips memory through disk", () => {
    const root = makeTempProject()
    const m = newMemory(root)
    bumpFile(m, "src/foo.ts")
    bumpFile(m, "src/bar.ts", 0.4)
    saveMemory(m)
    const loaded = loadMemory(root)
    expect(loaded.files["src/foo.ts"]?.priority).toBeCloseTo(DEFAULT_BUMP)
    expect(loaded.files["src/bar.ts"]?.priority).toBeCloseTo(0.4)
  })

  it("creates the .askcodi directory if missing", () => {
    const root = makeTempProject()
    const m = newMemory(root)
    saveMemory(m)
    expect(existsSync(memoryPath(root))).toBe(true)
  })

  it("returns fresh memory when JSON is malformed", () => {
    const root = makeTempProject()
    // Write garbage to the memory path.
    const m = newMemory(root)
    saveMemory(m)
    const fs = require("node:fs")
    fs.writeFileSync(memoryPath(root), "{ not valid json", "utf-8")
    const loaded = loadMemory(root)
    expect(loaded.session_count).toBe(0)
    expect(loaded.files).toEqual({})
  })

  it("returns fresh memory on version mismatch", () => {
    const root = makeTempProject()
    const m = newMemory(root)
    saveMemory(m)
    // Mutate version on disk.
    const raw = JSON.parse(readFileSync(memoryPath(root), "utf-8"))
    raw.version = 999
    require("node:fs").writeFileSync(
      memoryPath(root),
      JSON.stringify(raw),
      "utf-8",
    )
    const loaded = loadMemory(root)
    expect(loaded.session_count).toBe(0)
  })
})

describe("bumpFile", () => {
  it("creates a new entry", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "src/a.ts")
    expect(m.files["src/a.ts"]).toMatchObject({
      path: "src/a.ts",
      priority: DEFAULT_BUMP,
      hits: 1,
    })
  })

  it("increments existing priority and hits", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "src/a.ts", 0.2)
    bumpFile(m, "src/a.ts", 0.3)
    expect(m.files["src/a.ts"].priority).toBeCloseTo(0.5)
    expect(m.files["src/a.ts"].hits).toBe(2)
  })

  it("caps priority at the ceiling", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "src/a.ts", 5)
    expect(m.files["src/a.ts"].priority).toBe(PRIORITY_CEIL)
  })

  it("stamps last_hit timestamp", () => {
    const m = newMemory("/tmp/x")
    const t = new Date("2026-04-27T12:00:00Z")
    bumpFile(m, "src/a.ts", 0.1, t)
    expect(m.files["src/a.ts"].last_hit).toBe(t.toISOString())
  })
})

describe("applyDecay", () => {
  it("multiplies all priorities by the rate", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "a", 0.4)
    bumpFile(m, "b", 0.8)
    applyDecay(m, 0.5)
    expect(m.files["a"].priority).toBeCloseTo(0.2)
    expect(m.files["b"].priority).toBeCloseTo(0.4)
  })

  it("removes entries that fall below the floor", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "tiny", 0.06)
    bumpFile(m, "big", 0.5)
    applyDecay(m, 0.5) // tiny: 0.03 (below floor) → removed
    expect(m.files["tiny"]).toBeUndefined()
    expect(m.files["big"]).toBeDefined()
  })

  it("uses default rate when not specified", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "a", 0.5)
    applyDecay(m)
    expect(m.files["a"].priority).toBeCloseTo(0.5 * DEFAULT_DECAY)
  })
})

describe("getTopPriorityFiles", () => {
  it("returns top N sorted by priority", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "low", 0.1)
    bumpFile(m, "high", 0.9)
    bumpFile(m, "mid", 0.5)
    const top = getTopPriorityFiles(m, 2)
    expect(top.map((e) => e.path)).toEqual(["high", "mid"])
  })

  it("returns fewer than N if memory is sparse", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "only", 0.5)
    const top = getTopPriorityFiles(m, 5)
    expect(top.length).toBe(1)
  })
})

describe("pruneMemory", () => {
  it("caps to top N entries by priority", () => {
    const m = newMemory("/tmp/x")
    for (let i = 0; i < 10; i++) bumpFile(m, `f${i}`, (i + 1) * 0.05)
    pruneMemory(m, 3)
    expect(Object.keys(m.files).length).toBe(3)
    // The highest-priority entries should remain.
    expect(m.files["f9"]).toBeDefined()
    expect(m.files["f8"]).toBeDefined()
    expect(m.files["f7"]).toBeDefined()
    expect(m.files["f0"]).toBeUndefined()
  })

  it("is a no-op when below the cap", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "only", 0.5)
    pruneMemory(m, 100)
    expect(m.files["only"]).toBeDefined()
  })

  it("uses MAX_FILE_ENTRIES by default", () => {
    const m = newMemory("/tmp/x")
    for (let i = 0; i < MAX_FILE_ENTRIES + 5; i++) {
      bumpFile(m, `f${i}`, 0.5 + i * 0.001)
    }
    pruneMemory(m)
    expect(Object.keys(m.files).length).toBe(MAX_FILE_ENTRIES)
  })
})

describe("buildPriorsBlock", () => {
  it("returns block: null and empty paths when memory has fewer than minFiles entries", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "a")
    bumpFile(m, "b")
    const r = buildPriorsBlock(m, 5, 3)
    expect(r.block).toBeNull()
    expect(r.paths).toEqual([])
  })

  it("returns a block string and the list of top paths when memory is warm", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "a", 0.9)
    bumpFile(m, "b", 0.6)
    bumpFile(m, "c", 0.3)
    bumpFile(m, "d", 0.1)
    const r = buildPriorsBlock(m, 3, 3)
    expect(r.block).toBeTruthy()
    expect(r.paths).toEqual(["a", "b", "c"])
    // d is below top-3 cutoff
    expect(r.block).not.toContain(" d ")
  })

  it("includes session count in the preamble", () => {
    const m = newMemory("/tmp/x")
    bumpFile(m, "a")
    bumpFile(m, "b")
    bumpFile(m, "c")
    m.session_count = 7
    const r = buildPriorsBlock(m)
    expect(r.block).toContain("7 prior sessions")
  })
})

describe("recordSession", () => {
  it("increments session_count and updates timestamp", () => {
    const m = newMemory("/tmp/x")
    expect(m.session_count).toBe(0)
    const t = new Date("2027-01-01T00:00:00Z")
    recordSession(m, t)
    expect(m.session_count).toBe(1)
    expect(m.last_updated).toBe(t.toISOString())
  })
})

/**
 * Ledger persistence tests. Covers:
 *   - fresh load / round-trip / corrupt JSON / version mismatch
 *   - bump + decay + prune for files
 *   - append + cap for delegations
 *   - per-algorithm state get/set
 *   - migration from v1 .askcodi/memory.json
 *   - priors block rendering
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  appendDelegation,
  applyDecay,
  bumpFile,
  buildPriorsBlock,
  getAlgorithmState,
  getTopPriorityFiles,
  ledgerPath,
  legacyMemoryPath,
  loadLedger,
  newLedger,
  pruneFiles,
  recordSession,
  saveLedger,
  setAlgorithmState,
  DEFAULT_BUMP,
  DEFAULT_DECAY,
  LEDGER_VERSION,
  MAX_DELEGATIONS,
  MAX_FILE_ENTRIES,
  PRIORITY_CEIL,
  type DelegationRecord,
} from "../ledger"

const tempDirs: string[] = []
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-test-"))
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

function makeDelegation(overrides: Partial<DelegationRecord> = {}): DelegationRecord {
  return {
    session_id: "s1",
    algorithm: "abc",
    subagent_type: "Scout",
    prompt_preview: "find auth files",
    result_summary: "found 3 candidates",
    files_touched: ["src/auth.ts"],
    duration_ms: 4200,
    ended_at: "2026-04-28T00:00:00Z",
    ...overrides,
  }
}

describe("loadLedger / saveLedger", () => {
  it("returns fresh ledger when no file exists", () => {
    const root = makeTempProject()
    const l = loadLedger(root)
    expect(l.session_count).toBe(0)
    expect(l.files).toEqual({})
    expect(l.delegations).toEqual([])
    expect(l.algorithm_state).toEqual({})
    expect(l.version).toBe(LEDGER_VERSION)
  })

  it("round-trips through disk", () => {
    const root = makeTempProject()
    const l = newLedger(root)
    bumpFile(l, "src/foo.ts", 0.4, "Scout")
    appendDelegation(l, makeDelegation())
    setAlgorithmState(l, "abc", { last_scout: ["src/foo.ts"] })
    saveLedger(l)

    const loaded = loadLedger(root)
    expect(loaded.files["src/foo.ts"]?.priority).toBeCloseTo(0.4)
    expect(loaded.files["src/foo.ts"]?.last_subagent).toBe("Scout")
    expect(loaded.delegations.length).toBe(1)
    expect(getAlgorithmState<{ last_scout: string[] }>(loaded, "abc")?.last_scout).toEqual([
      "src/foo.ts",
    ])
  })

  it("creates the .askcodi directory if missing", () => {
    const root = makeTempProject()
    saveLedger(newLedger(root))
    expect(existsSync(ledgerPath(root))).toBe(true)
  })

  it("returns fresh ledger when JSON is malformed", () => {
    const root = makeTempProject()
    saveLedger(newLedger(root))
    writeFileSync(ledgerPath(root), "{ not valid json", "utf-8")
    const loaded = loadLedger(root)
    expect(loaded.session_count).toBe(0)
    expect(loaded.files).toEqual({})
  })

  it("returns fresh ledger on version mismatch", () => {
    const root = makeTempProject()
    saveLedger(newLedger(root))
    const raw = JSON.parse(readFileSync(ledgerPath(root), "utf-8"))
    raw.version = 999
    writeFileSync(ledgerPath(root), JSON.stringify(raw), "utf-8")
    const loaded = loadLedger(root)
    expect(loaded.session_count).toBe(0)
  })

  it("backfills missing optional fields on partial writes", () => {
    const root = makeTempProject()
    mkdirSync(join(root, ".askcodi"))
    writeFileSync(
      ledgerPath(root),
      JSON.stringify({
        version: LEDGER_VERSION,
        project_root: root,
        first_seen: "2026-04-28T00:00:00Z",
        last_updated: "2026-04-28T00:00:00Z",
        session_count: 1,
        files: { "x.ts": { path: "x.ts", priority: 0.5, hits: 1, last_hit: "...", last_subagent: null } },
        // delegations + algorithm_state intentionally omitted
      }),
      "utf-8",
    )
    const loaded = loadLedger(root)
    expect(loaded.delegations).toEqual([])
    expect(loaded.algorithm_state).toEqual({})
    expect(loaded.files["x.ts"]).toBeDefined()
  })
})

describe("v1 memory.json migration", () => {
  it("migrates v1 file priorities into a v2 ledger when ledger.json missing", () => {
    const root = makeTempProject()
    mkdirSync(join(root, ".askcodi"))
    writeFileSync(
      legacyMemoryPath(root),
      JSON.stringify({
        version: 1,
        project_root: root,
        first_seen: "2026-04-01T00:00:00Z",
        last_updated: "2026-04-27T00:00:00Z",
        session_count: 7,
        files: {
          "src/a.ts": { path: "src/a.ts", priority: 0.85, hits: 6, last_hit: "..." },
          "src/b.ts": { path: "src/b.ts", priority: 0.4, hits: 2, last_hit: "..." },
        },
      }),
      "utf-8",
    )
    const loaded = loadLedger(root)
    expect(loaded.version).toBe(LEDGER_VERSION)
    expect(loaded.session_count).toBe(7)
    expect(loaded.files["src/a.ts"]?.priority).toBeCloseTo(0.85)
    expect(loaded.files["src/a.ts"]?.last_subagent).toBeNull()
    expect(loaded.delegations).toEqual([])
    expect(loaded.first_seen).toBe("2026-04-01T00:00:00Z")
  })

  it("ignores legacy memory.json when ledger.json already exists", () => {
    const root = makeTempProject()
    const l = newLedger(root)
    l.session_count = 99
    saveLedger(l)
    // Write a v1 memory.json that would, if migrated, override session_count.
    writeFileSync(
      legacyMemoryPath(root),
      JSON.stringify({ version: 1, session_count: 1, files: {} }),
      "utf-8",
    )
    const loaded = loadLedger(root)
    expect(loaded.session_count).toBe(99)
  })

  it("returns fresh when legacy file has wrong version", () => {
    const root = makeTempProject()
    mkdirSync(join(root, ".askcodi"))
    writeFileSync(
      legacyMemoryPath(root),
      JSON.stringify({ version: 0, files: {} }),
      "utf-8",
    )
    const loaded = loadLedger(root)
    expect(loaded.session_count).toBe(0)
  })
})

describe("bumpFile", () => {
  it("creates a new entry with subagent attribution", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "src/a.ts", 0.2, "Voter")
    expect(l.files["src/a.ts"]).toMatchObject({
      path: "src/a.ts",
      priority: 0.2,
      hits: 1,
      last_subagent: "Voter",
    })
  })

  it("increments existing priority + hits + updates last_subagent", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "src/a.ts", 0.2, "Scout")
    bumpFile(l, "src/a.ts", 0.3, "Recruit")
    expect(l.files["src/a.ts"].priority).toBeCloseTo(0.5)
    expect(l.files["src/a.ts"].hits).toBe(2)
    expect(l.files["src/a.ts"].last_subagent).toBe("Recruit")
  })

  it("caps at PRIORITY_CEIL", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "src/a.ts", 5)
    expect(l.files["src/a.ts"].priority).toBe(PRIORITY_CEIL)
  })

  it("preserves last_subagent when bump call passes null", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "src/a.ts", 0.2, "Scout")
    bumpFile(l, "src/a.ts", 0.1, null)
    expect(l.files["src/a.ts"].last_subagent).toBe("Scout")
  })
})

describe("applyDecay", () => {
  it("multiplies priorities and drops entries below floor", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "tiny", 0.06)
    bumpFile(l, "big", 0.5)
    applyDecay(l, 0.5)
    expect(l.files["tiny"]).toBeUndefined()
    expect(l.files["big"]).toBeDefined()
  })

  it("uses default decay when not specified", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "a", 0.5)
    applyDecay(l)
    expect(l.files["a"].priority).toBeCloseTo(0.5 * DEFAULT_DECAY)
  })
})

describe("pruneFiles", () => {
  it("caps to top N by priority", () => {
    const l = newLedger("/tmp/x")
    for (let i = 0; i < 10; i++) bumpFile(l, `f${i}`, (i + 1) * 0.05)
    pruneFiles(l, 3)
    expect(Object.keys(l.files).length).toBe(3)
    expect(l.files["f9"]).toBeDefined()
    expect(l.files["f0"]).toBeUndefined()
  })

  it("uses MAX_FILE_ENTRIES default", () => {
    const l = newLedger("/tmp/x")
    for (let i = 0; i < MAX_FILE_ENTRIES + 5; i++) {
      bumpFile(l, `f${i}`, 0.5 + i * 0.001)
    }
    pruneFiles(l)
    expect(Object.keys(l.files).length).toBe(MAX_FILE_ENTRIES)
  })
})

describe("delegations log", () => {
  it("appends in order", () => {
    const l = newLedger("/tmp/x")
    appendDelegation(l, makeDelegation({ subagent_type: "Scout" }))
    appendDelegation(l, makeDelegation({ subagent_type: "Recruit" }))
    expect(l.delegations.map((d) => d.subagent_type)).toEqual(["Scout", "Recruit"])
  })

  it("trims oldest entries when over MAX_DELEGATIONS", () => {
    const l = newLedger("/tmp/x")
    for (let i = 0; i < MAX_DELEGATIONS + 10; i++) {
      appendDelegation(l, makeDelegation({ session_id: `s${i}` }))
    }
    expect(l.delegations.length).toBe(MAX_DELEGATIONS)
    // First retained should be s10 (s0..s9 dropped).
    expect(l.delegations[0].session_id).toBe("s10")
  })
})

describe("algorithm_state", () => {
  it("typed get/set round-trips arbitrary state", () => {
    type AbcState = { last_scout_candidates: string[]; recruits_dispatched: number }
    const l = newLedger("/tmp/x")
    setAlgorithmState<AbcState>(l, "abc", {
      last_scout_candidates: ["src/a.ts"],
      recruits_dispatched: 3,
    })
    expect(getAlgorithmState<AbcState>(l, "abc")?.recruits_dispatched).toBe(3)
  })

  it("returns undefined for missing keys", () => {
    const l = newLedger("/tmp/x")
    expect(getAlgorithmState(l, "nonexistent")).toBeUndefined()
  })

  it("does not collide across algorithms", () => {
    const l = newLedger("/tmp/x")
    setAlgorithmState(l, "abc", { v: 1 })
    setAlgorithmState(l, "consensus", { v: 2 })
    expect(getAlgorithmState<{ v: number }>(l, "abc")?.v).toBe(1)
    expect(getAlgorithmState<{ v: number }>(l, "consensus")?.v).toBe(2)
  })
})

describe("buildPriorsBlock", () => {
  it("returns null when fewer than minFiles entries", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "a", 0.4)
    bumpFile(l, "b", 0.4)
    const r = buildPriorsBlock(l, 5, 3)
    expect(r.block).toBeNull()
    expect(r.paths).toEqual([])
  })

  it("returns block + paths when warm", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "a", 0.9, "Scout")
    bumpFile(l, "b", 0.6, "Voter")
    bumpFile(l, "c", 0.3)
    const r = buildPriorsBlock(l, 3, 3)
    expect(r.block).toBeTruthy()
    expect(r.paths).toEqual(["a", "b", "c"])
    // Subagent attribution surfaces in block text when present.
    expect(r.block).toContain("last touched by Scout")
    expect(r.block).toContain("last touched by Voter")
  })

  it("includes session count in preamble", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "a")
    bumpFile(l, "b")
    bumpFile(l, "c")
    l.session_count = 7
    const r = buildPriorsBlock(l)
    expect(r.block).toContain("7 prior sessions")
  })
})

describe("recordSession + getTopPriorityFiles", () => {
  it("recordSession increments and stamps", () => {
    const l = newLedger("/tmp/x")
    expect(l.session_count).toBe(0)
    recordSession(l, new Date("2027-01-01T00:00:00Z"))
    expect(l.session_count).toBe(1)
    expect(l.last_updated).toBe("2027-01-01T00:00:00.000Z")
  })

  it("getTopPriorityFiles sorts and slices", () => {
    const l = newLedger("/tmp/x")
    bumpFile(l, "low", 0.1)
    bumpFile(l, "high", 0.9)
    bumpFile(l, "mid", 0.5)
    expect(getTopPriorityFiles(l, 2).map((e) => e.path)).toEqual(["high", "mid"])
  })
})

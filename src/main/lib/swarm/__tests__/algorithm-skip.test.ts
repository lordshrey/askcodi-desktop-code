/**
 * Tests for algorithm-decides-its-own-skip semantics.
 *
 * Currently only "none" returns {skip: true} unconditionally. The other
 * algorithms participate (return augmentation) regardless of plan/ollama
 * mode — those flags are surfaced in ctx so each algorithm can opt in to
 * skip behavior in the future without touching the runtime.
 *
 * The point of these tests: lock in the contract that algorithms own
 * their skip decisions. Adding skip behavior to an algorithm later is a
 * one-file change; the runtime keeps its dumb if (skip) → vanilla branch.
 */
import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acoAlgorithm } from "../algorithms/aco"
import { noneAlgorithm } from "../algorithms/none"
import type { AlgorithmContext } from "../algorithms/algorithm"

function makeCtx(overrides: Partial<AlgorithmContext> = {}): AlgorithmContext {
  const cwd = mkdtempSync(join(tmpdir(), "skip-"))
  mkdirSync(cwd, { recursive: true })
  return {
    cwd,
    planMode: false,
    ollama: false,
    isResume: false,
    ...overrides,
  }
}

describe("algorithm skip semantics", () => {
  it("'none' always skips (acts as the vanilla baseline)", async () => {
    const ctx = makeCtx()
    try {
      const aug = await Promise.resolve(noneAlgorithm.prepare("query", ctx))
      expect(aug.skip).toBe(true)
      expect(aug.skipReason).toBeTruthy()
    } finally {
      rmSync(ctx.cwd, { recursive: true, force: true })
    }
  })

  it("'none' skips even in plan mode + ollama + resume", async () => {
    const ctx = makeCtx({ planMode: true, ollama: true, isResume: true })
    try {
      const aug = await Promise.resolve(noneAlgorithm.prepare("q", ctx))
      expect(aug.skip).toBe(true)
    } finally {
      rmSync(ctx.cwd, { recursive: true, force: true })
    }
  })

  it("'aco' participates (no skip) by default — algorithm owns the decision", async () => {
    const ctx = makeCtx()
    try {
      const aug = await Promise.resolve(acoAlgorithm.prepare("q", ctx))
      // The contract: aco's prepare returns full augmentation (no skip).
      // Adding skip rules to aco later is a one-file change.
      expect(aug.skip).not.toBe(true)
      expect(aug.systemPromptAppend).toBeDefined()
      expect(aug.observeMessage).toBeDefined()
      expect(aug.finalize).toBeDefined()
    } finally {
      rmSync(ctx.cwd, { recursive: true, force: true })
    }
  })

  it("'aco' receives planMode/ollama/isResume in ctx (algorithm can read them)", async () => {
    // We can't directly assert ctx is read, but we lock the contract in
    // the type system: AlgorithmContext exposes those fields, and the
    // runtime passes them through (verified by claude.ts wiring tests).
    const ctx = makeCtx({ planMode: true, ollama: true, isResume: true })
    try {
      const aug = await Promise.resolve(acoAlgorithm.prepare("q", ctx))
      // Same shape regardless — aco currently doesn't skip.
      expect(aug.skip).not.toBe(true)
    } finally {
      rmSync(ctx.cwd, { recursive: true, force: true })
    }
  })
})

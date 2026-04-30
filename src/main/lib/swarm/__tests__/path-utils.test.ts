/**
 * Path utility tests. Pure-logic; no IO.
 */
import { describe, expect, it } from "vitest"
import {
  extractPathsFromText,
  isBlockedPath,
  toProjectRelative,
} from "../path-utils"

describe("toProjectRelative", () => {
  it("strips an absolute project-rooted path", () => {
    expect(toProjectRelative("/repo/root/src/a.ts", "/repo/root")).toBe("src/a.ts")
  })

  it("returns relative paths unchanged", () => {
    expect(toProjectRelative("src/a.ts", "/repo/root")).toBe("src/a.ts")
  })

  it("handles trailing slash on root", () => {
    expect(toProjectRelative("/repo/root/src/a.ts", "/repo/root/")).toBe("src/a.ts")
  })

  it("returns unchanged when path is outside the project root", () => {
    expect(toProjectRelative("/somewhere/else/x.ts", "/repo/root")).toBe(
      "/somewhere/else/x.ts",
    )
  })

  it("handles empty input gracefully", () => {
    expect(toProjectRelative("", "/repo/root")).toBe("")
  })
})

describe("isBlockedPath", () => {
  it("blocks empty and root paths", () => {
    expect(isBlockedPath("")).toBe(true)
    expect(isBlockedPath("   ")).toBe(true)
    expect(isBlockedPath("/")).toBe(true)
  })

  it("blocks node_modules and common build dirs at any depth", () => {
    expect(isBlockedPath("node_modules/foo/index.js")).toBe(true)
    expect(isBlockedPath("apps/web/node_modules/x.js")).toBe(true)
    expect(isBlockedPath("dist/bundle.js")).toBe(true)
    expect(isBlockedPath("build/output.js")).toBe(true)
    expect(isBlockedPath(".git/HEAD")).toBe(true)
  })

  it("allows real source paths", () => {
    expect(isBlockedPath("src/auth.ts")).toBe(false)
    expect(isBlockedPath("apps/web/src/index.ts")).toBe(false)
  })
})

describe("extractPathsFromText", () => {
  it("extracts file paths with common extensions", () => {
    const text = "see src/auth.ts and lib/billing.ts for details"
    expect(extractPathsFromText(text, "/repo")).toEqual([
      "src/auth.ts",
      "lib/billing.ts",
    ])
  })

  it("ignores URLs", () => {
    const text = "https://example.com/path/foo.ts is unrelated"
    expect(extractPathsFromText(text, "/repo")).toEqual([])
  })

  it("strips blocked paths", () => {
    const text = "node_modules/junk/index.js and src/real.ts"
    expect(extractPathsFromText(text, "/repo")).toEqual(["src/real.ts"])
  })

  it("handles Grep-style file:line:content output", () => {
    const text = "frontend/src/auth.ts:42:user login"
    expect(extractPathsFromText(text, "/repo")).toEqual(["frontend/src/auth.ts"])
  })

  it("handles empty / null inputs", () => {
    expect(extractPathsFromText("", "/repo")).toEqual([])
  })
})

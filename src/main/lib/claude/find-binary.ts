/**
 * System-binary lookup. Pure-Node helper (no Electron dependency) so scripts
 * and the main process can both use it.
 */
import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Returns the absolute path to `name` (e.g. "claude", "codex"), or null if
 * not found. Checks `extraPaths`, then standard install locations, then
 * `which`/`where` (catches nvm, asdf, mise, etc.).
 */
export function findSystemBinary(
  name: string,
  extraPaths: string[] = [],
): string | null {
  const binaryName = process.platform === "win32" ? `${name}.exe` : name
  const candidates = [
    ...extraPaths,
    join(homedir(), ".local", "bin", binaryName),
    `/usr/local/bin/${binaryName}`,
    `/opt/homebrew/bin/${binaryName}`,
    join(homedir(), "bin", binaryName),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  try {
    const which = process.platform === "win32" ? "where" : "which"
    const out = execSync(`${which} ${binaryName}`, {
      encoding: "utf8",
      timeout: 3000,
    })
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (first && existsSync(first)) return first
  } catch {
    // not on PATH
  }
  return null
}

/** @deprecated use `findSystemBinary("claude")` */
export function findSystemClaude(): string | null {
  return findSystemBinary("claude")
}

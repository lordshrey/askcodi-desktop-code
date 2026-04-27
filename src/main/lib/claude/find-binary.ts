/**
 * Locate a system-installed `claude` binary. Pure-Node helper (no
 * electron dependency) so scripts and the Electron main process can both
 * use it.
 */
import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Returns the absolute path to a `claude` binary, or null if none found.
 * Checks common install locations first, then `which claude` as a fallback
 * (catches custom install dirs from nvm, asdf, mise, etc.).
 */
export function findSystemClaude(): string | null {
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude"
  const candidates = [
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

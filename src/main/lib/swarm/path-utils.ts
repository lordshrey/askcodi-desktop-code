/**
 * Path utilities shared across swarm algorithms. Extracted from aco.ts
 * because Frontier and Consensus also need to extract project-relative
 * file paths from minion text and tool results, with the same blocklist.
 */
import { resolve as resolvePath } from "node:path"

/** Loose regex for project-relative file paths. Tuned for common code/doc extensions; a few false positives (e.g. `foo.ts` from `foo.ts.bak`) are acceptable noise — they decay if they don't recur. */
export const FILE_PATH_RE =
  /(?:^|[\s,()`'"])([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|md|yml|yaml|json|toml|css|scss|html|sh|sql))(?=[\s,():.`'"]|$)/g

/** Directory names skipped by codebase walks (init scan, frontier inventory). */
export const INDEX_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".git",
  ".next",
  ".cache",
  ".turbo",
  ".vscode",
  ".idea",
  "target",
  "__pycache__",
  "venv",
  ".venv",
  "vendor",
  "coverage",
  ".askcodi",
])

/** Path segments that signal build artifacts or vendored deps; never useful as pheromone signal. */
export const PATH_BLOCKLIST = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".git/",
  ".next/",
  ".cache/",
  ".turbo/",
  "target/",
  "__pycache__/",
  "venv/",
  ".venv/",
  "vendor/",
  "coverage/",
]

export function isBlockedPath(p: string): boolean {
  if (!p || p.trim() === "") return true
  if (p === "/") return true
  for (const blocked of PATH_BLOCKLIST) {
    if (p.includes(blocked)) return true
    if (p === blocked.replace(/\/$/, "")) return true
  }
  return false
}

function stripPrefix(filePath: string, root: string): string {
  if (!filePath.startsWith(root)) return filePath
  let rel = filePath.slice(root.length)
  if (rel.startsWith("/")) rel = rel.slice(1)
  return rel
}

/**
 * Convert an absolute or already-relative file path into a project-
 * relative POSIX-style path. Falls through unchanged if the path doesn't
 * appear to belong to this project — better to keep noise than silently
 * drop signal.
 */
export function toProjectRelative(filePath: string, projectRoot: string): string {
  if (!filePath) return filePath
  const stripped = stripPrefix(filePath, projectRoot)
  if (stripped !== filePath) return stripped.replace(/\\/g, "/")
  // Symlinks may make filePath start with the resolved root instead.
  const resolvedRoot = resolvePath(projectRoot)
  if (resolvedRoot !== projectRoot) {
    const stripped2 = stripPrefix(filePath, resolvedRoot)
    if (stripped2 !== filePath) return stripped2.replace(/\\/g, "/")
  }
  return filePath
}

/** Extract project-relative file paths embedded in a string (Grep results, model answer text). */
export function extractPathsFromText(s: string, projectRoot: string): string[] {
  if (!s) return []
  const out: string[] = []
  let m: RegExpExecArray | null
  FILE_PATH_RE.lastIndex = 0
  while ((m = FILE_PATH_RE.exec(s)) !== null) {
    const p = m[1]
    if (/^https?:/.test(p)) continue
    const rel = toProjectRelative(p, projectRoot)
    if (isBlockedPath(rel)) continue
    out.push(rel)
  }
  return out
}

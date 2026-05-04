import * as fs from "node:fs/promises"
import * as path from "node:path"

// Project-context loader.
//
// Builds a compact summary of the project the agent is about to work in:
//   - README (first ~4 KB)
//   - package.json (description + scripts + key deps)
//   - File tree (top-level + 2 levels deep, ignoring node_modules / dist / .git)
//
// This goes into the AdapterContextPayload.continuationSummary slot so it
// appears in the agent's first prompt without requiring schema changes.

const MAX_README_BYTES = 4 * 1024
const MAX_TREE_ENTRIES = 80
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo",
  ".cache", "coverage", ".vscode", ".idea", "__pycache__", "venv", ".venv",
])

interface ProjectContext {
  hasReadme: boolean
  readmeExcerpt: string | null
  packageDescription: string | null
  scripts: string[]
  topLevelDeps: string[]
  fileTree: string
}

async function readReadme(projectPath: string): Promise<string | null> {
  for (const name of ["README.md", "README.MD", "Readme.md", "readme.md", "README"]) {
    try {
      const full = path.join(projectPath, name)
      const buf = await fs.readFile(full)
      const text = buf.toString("utf8")
      return text.length > MAX_README_BYTES ? text.slice(0, MAX_README_BYTES) + "\n…(truncated)" : text
    } catch {
      // try next
    }
  }
  return null
}

async function readPackageJson(projectPath: string): Promise<{
  description: string | null
  scripts: string[]
  topLevelDeps: string[]
}> {
  try {
    const full = path.join(projectPath, "package.json")
    const buf = await fs.readFile(full, "utf8")
    const pkg = JSON.parse(buf) as {
      description?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 20)
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ].slice(0, 30)
    return { description: pkg.description ?? null, scripts, topLevelDeps: deps }
  } catch {
    return { description: null, scripts: [], topLevelDeps: [] }
  }
}

async function readFileTree(projectPath: string): Promise<string> {
  const entries: string[] = []
  async function walk(dir: string, depth: number, prefix: string): Promise<void> {
    if (depth > 2 || entries.length >= MAX_TREE_ENTRIES) return
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    names.sort()
    for (const name of names) {
      if (entries.length >= MAX_TREE_ENTRIES) break
      if (name.startsWith(".") && depth === 0) continue
      if (IGNORE_DIRS.has(name)) continue
      const full = path.join(dir, name)
      let stat: import("fs").Stats
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        entries.push(`${prefix}${name}/`)
        await walk(full, depth + 1, prefix + "  ")
      } else {
        entries.push(`${prefix}${name}`)
      }
    }
  }
  await walk(projectPath, 0, "")
  if (entries.length >= MAX_TREE_ENTRIES) {
    entries.push("…(truncated)")
  }
  return entries.join("\n")
}

export async function buildProjectContext(projectPath: string): Promise<ProjectContext> {
  const [readme, pkg, tree] = await Promise.all([
    readReadme(projectPath),
    readPackageJson(projectPath),
    readFileTree(projectPath),
  ])
  return {
    hasReadme: readme !== null,
    readmeExcerpt: readme,
    packageDescription: pkg.description,
    scripts: pkg.scripts,
    topLevelDeps: pkg.topLevelDeps,
    fileTree: tree,
  }
}

/**
 * Render the context as a markdown block suitable for the agent's first prompt.
 * Returns null if there's nothing useful to include.
 *
 * Cached per projectPath with a 5-minute TTL. Heartbeat builds this on every run;
 * without the cache a 50-run session would walk the file tree 50 times for data
 * that essentially never changes within a session.
 */
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000
const contextMdCache = new Map<string, { md: string | null; cachedAtMs: number }>()

export async function buildProjectContextMarkdown(projectPath: string): Promise<string | null> {
  const cached = contextMdCache.get(projectPath)
  if (cached && Date.now() - cached.cachedAtMs < CONTEXT_CACHE_TTL_MS) {
    return cached.md
  }
  const ctx = await buildProjectContext(projectPath)
  const sections: string[] = []
  if (ctx.packageDescription) {
    sections.push(`**Description:** ${ctx.packageDescription}`)
  }
  if (ctx.scripts.length > 0) {
    sections.push(`**Scripts:** ${ctx.scripts.join(", ")}`)
  }
  if (ctx.topLevelDeps.length > 0) {
    sections.push(`**Dependencies (top-level):** ${ctx.topLevelDeps.join(", ")}`)
  }
  if (ctx.readmeExcerpt) {
    sections.push(`## README\n${ctx.readmeExcerpt}`)
  }
  if (ctx.fileTree) {
    sections.push(`## File tree\n\`\`\`\n${ctx.fileTree}\n\`\`\``)
  }
  const md = sections.length === 0 ? null : `# Project context\n\n${sections.join("\n\n")}`
  contextMdCache.set(projectPath, { md, cachedAtMs: Date.now() })
  return md
}

/** Test helper. Force the next call to rebuild. */
export function __invalidateProjectContextCache(projectPath?: string): void {
  if (projectPath) contextMdCache.delete(projectPath)
  else contextMdCache.clear()
}

import { tool } from "ai"
import { z } from "zod"
import { execSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { getClaudeShellEnvironment } from "../claude/env"

/**
 * Create AskCodi tools for the AI SDK streamText call.
 * Tools are scoped to a project directory (cwd).
 * Plan mode restricts to read-only tools.
 */
/**
 * Wrap a tool's execute function with logging
 */
function withLogging<T extends { execute: (...args: any[]) => any }>(name: string, t: T): T {
  const original = t.execute
  return {
    ...t,
    execute: async (...args: any[]) => {
      console.log(`[askcodi-tool] Executing "${name}" with args:`, JSON.stringify(args[0]).slice(0, 500))
      try {
        const result = await original(...args)
        const resultStr = JSON.stringify(result).slice(0, 300)
        console.log(`[askcodi-tool] "${name}" result:`, resultStr)
        return result
      } catch (error) {
        console.error(`[askcodi-tool] "${name}" THREW:`, error)
        throw error
      }
    },
  }
}

export function createAskCodiTools(cwd: string, mode: "plan" | "agent") {
  const readOnlyTools = {
    Read: tool({
      description:
        "Read a file from the filesystem. Returns the file contents. The file_path should be relative to the project root or absolute.",
      inputSchema: z.object({
        file_path: z.string().describe("Path to the file to read"),
        offset: z
          .number()
          .optional()
          .describe("Line number to start reading from (1-based)"),
        limit: z
          .number()
          .optional()
          .describe("Maximum number of lines to read"),
      }),
      execute: async ({ file_path, offset, limit }) => {
        const resolvedPath = resolve(cwd, file_path)
        if (!existsSync(resolvedPath)) {
          return { error: `File not found: ${file_path}` }
        }
        try {
          const content = readFileSync(resolvedPath, "utf-8")
          const lines = content.split("\n")
          const startLine = offset ? Math.max(0, offset - 1) : 0
          const endLine = limit ? startLine + limit : lines.length
          const sliced = lines.slice(startLine, endLine)
          const numbered = sliced.map(
            (line, i) => `${String(startLine + i + 1).padStart(6)} ${line}`,
          )
          return { content: numbered.join("\n") }
        } catch (error) {
          return { error: `Failed to read file: ${(error as Error).message}` }
        }
      },
    }),

    Glob: tool({
      description:
        "Find files matching a glob pattern. Returns matching file paths relative to the project root.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern to match files (e.g. '**/*.ts')"),
        path: z
          .string()
          .optional()
          .describe("Directory to search in (relative to project root)"),
      }),
      execute: async ({ pattern, path: searchPath }) => {
        const searchDir = searchPath ? resolve(cwd, searchPath) : cwd
        try {
          // Use find command with basic glob support
          const result = execSync(
            `find ${JSON.stringify(searchDir)} -type f -name ${JSON.stringify(pattern.includes("/") ? pattern.split("/").pop() || "*" : pattern)} 2>/dev/null | head -200`,
            { encoding: "utf-8", timeout: 10000, cwd },
          )
          const files = result
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((f) => relative(cwd, f))
          return { files }
        } catch {
          return { files: [] }
        }
      },
    }),

    Grep: tool({
      description:
        "Search for a pattern in files using regex. Returns matching file paths and lines.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z
          .string()
          .optional()
          .describe("File or directory to search in"),
        glob: z
          .string()
          .optional()
          .describe("Glob pattern to filter files (e.g. '*.ts')"),
        include_content: z
          .boolean()
          .optional()
          .describe("Whether to include matching line content"),
      }),
      execute: async ({ pattern, path: searchPath, glob: globFilter, include_content }) => {
        const searchDir = searchPath ? resolve(cwd, searchPath) : cwd
        try {
          let cmd = `grep -rn --include='${globFilter || "*"}' -E ${JSON.stringify(pattern)} ${JSON.stringify(searchDir)} 2>/dev/null | head -100`
          const result = execSync(cmd, {
            encoding: "utf-8",
            timeout: 15000,
            cwd,
          })
          const lines = result.trim().split("\n").filter(Boolean)
          if (include_content) {
            const matches = lines.map((line) => {
              const match = line.match(/^(.+?):(\d+):(.*)$/)
              if (match) {
                return {
                  file: relative(cwd, match[1]),
                  line: parseInt(match[2], 10),
                  content: match[3],
                }
              }
              return { file: line, line: 0, content: "" }
            })
            return { matches }
          }
          const files = [...new Set(lines.map((l) => {
            const match = l.match(/^(.+?):/)
            return match ? relative(cwd, match[1]) : l
          }))]
          return { files }
        } catch {
          return { files: [], matches: [] }
        }
      },
    }),

    WebSearch: tool({
      description:
        "Search the web for information. Returns search results with titles, URLs, and snippets.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
      }),
      execute: async ({ query }) => {
        // Placeholder - would integrate with a search API
        return {
          note: "Web search is not yet implemented for AskCodi provider",
          query,
        }
      },
    }),

    WebFetch: tool({
      description: "Fetch content from a URL and return it as text.",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch"),
      }),
      execute: async ({ url }) => {
        try {
          const response = await fetch(url, {
            headers: { "User-Agent": "AskCodi-Desktop/1.0" },
          })
          if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}` }
          }
          const text = await response.text()
          // Truncate to avoid token limits
          return { content: text.slice(0, 50000) }
        } catch (error) {
          return { error: `Fetch failed: ${(error as Error).message}` }
        }
      },
    }),

    ListDirectory: tool({
      description:
        "List files and directories in a given path. Returns names with type indicators.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Directory path relative to project root"),
      }),
      execute: async ({ path: dirPath }) => {
        const resolvedPath = dirPath ? resolve(cwd, dirPath) : cwd
        try {
          const entries = readdirSync(resolvedPath, { withFileTypes: true })
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }))
          return { items }
        } catch (error) {
          return { error: `Failed to list directory: ${(error as Error).message}` }
        }
      },
    }),
  }

  if (mode === "plan") {
    const logged: Record<string, any> = {}
    for (const [k, v] of Object.entries(readOnlyTools)) {
      logged[k] = withLogging(k, v as any)
    }
    return logged
  }

  // Agent mode: include write tools
  const writeTools = {
    Bash: tool({
      description:
        "Execute a bash command in the project directory. Returns stdout and stderr.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default: 120000)"),
      }),
      execute: async ({ command, timeout }) => {
        const env = await getClaudeShellEnvironment(cwd)
        return new Promise((resolvePromise) => {
          let stdout = ""
          let stderr = ""
          const proc = spawn("bash", ["-c", command], {
            cwd,
            env: { ...process.env, ...env },
            timeout: timeout || 120000,
          })

          proc.stdout?.on("data", (data) => {
            stdout += data.toString()
          })
          proc.stderr?.on("data", (data) => {
            stderr += data.toString()
          })
          proc.on("close", (code) => {
            resolvePromise({
              exitCode: code,
              stdout: stdout.slice(0, 50000),
              stderr: stderr.slice(0, 10000),
            })
          })
          proc.on("error", (error) => {
            resolvePromise({
              exitCode: 1,
              stdout: "",
              stderr: error.message,
            })
          })
        })
      },
    }),

    Write: tool({
      description: "Write content to a file, creating it if it doesn't exist.",
      inputSchema: z.object({
        file_path: z.string().describe("Path to the file to write"),
        content: z.string().describe("Content to write to the file"),
      }),
      execute: async ({ file_path, content }) => {
        const resolvedPath = resolve(cwd, file_path)
        try {
          const dir = resolve(resolvedPath, "..")
          if (!existsSync(dir)) {
            const { mkdirSync } = require("fs")
            mkdirSync(dir, { recursive: true })
          }
          writeFileSync(resolvedPath, content, "utf-8")
          return { success: true, path: file_path }
        } catch (error) {
          return { error: `Failed to write file: ${(error as Error).message}` }
        }
      },
    }),

    Edit: tool({
      description:
        "Replace a specific string in a file with new content. The old_string must be unique in the file.",
      inputSchema: z.object({
        file_path: z.string().describe("Path to the file to edit"),
        old_string: z.string().describe("The exact text to replace"),
        new_string: z.string().describe("The replacement text"),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const resolvedPath = resolve(cwd, file_path)
        if (!existsSync(resolvedPath)) {
          return { error: `File not found: ${file_path}` }
        }
        try {
          const content = readFileSync(resolvedPath, "utf-8")
          const occurrences = content.split(old_string).length - 1
          if (occurrences === 0) {
            return { error: "old_string not found in file" }
          }
          if (occurrences > 1) {
            return {
              error: `old_string found ${occurrences} times. It must be unique. Provide more context.`,
            }
          }
          const newContent = content.replace(old_string, new_string)
          writeFileSync(resolvedPath, newContent, "utf-8")
          return { success: true, path: file_path }
        } catch (error) {
          return { error: `Failed to edit file: ${(error as Error).message}` }
        }
      },
    }),
  }

  const allTools = { ...readOnlyTools, ...writeTools }
  const logged: Record<string, any> = {}
  for (const [k, v] of Object.entries(allTools)) {
    logged[k] = withLogging(k, v as any)
  }
  return logged
}

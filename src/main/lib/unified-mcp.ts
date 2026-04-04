/**
 * Unified MCP server resolution layer.
 * Both Claude and Codex providers use this module to discover and merge MCP servers
 * from all sources (JSON config, project .mcp.json, plugins, and Codex CLI TOML).
 */

import * as fs from "fs/promises"
import * as os from "os"
import path from "path"
import {
  getMergedGlobalMcpServers,
  getMergedLocalProjectMcpServers,
  readClaudeDirConfig,
  readProjectMcpJson,
  resolveProjectPathFromWorktree,
  type ClaudeConfig,
  type McpServerConfig,
} from "./claude-config"
import { discoverPluginMcpServers } from "./plugins"
import {
  getApprovedPluginMcpServers,
  getEnabledPlugins,
} from "./trpc/routers/claude-settings"

// ---------------------------------------------------------------------------
// Caching infrastructure (moved from claude.ts)
// ---------------------------------------------------------------------------

/** Tracks which MCP servers are working (have tools). Shared across providers. */
export const workingMcpServers = new Map<string, boolean>()

const GLOBAL_SCOPE = "__global__"

export function mcpCacheKey(
  scope: string | null,
  serverName: string,
): string {
  return `${scope ?? GLOBAL_SCOPE}::${serverName}`
}

/** Cache for ~/.claude.json reads (keyed by file path, invalidated by mtime). */
export const mcpConfigCache = new Map<
  string,
  { config: Record<string, any> | undefined; mtime: number }
>()

/** Cache for .mcp.json reads (keyed by file path, invalidated by mtime). */
export const projectMcpJsonCache = new Map<
  string,
  { servers: Record<string, McpServerConfig>; mtime: number }
>()

/**
 * Read a project's .mcp.json with mtime-based caching.
 */
export async function readProjectMcpJsonCached(
  projectPath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const mcpJsonPath = path.join(projectPath, ".mcp.json")
    const stats = await fs.stat(mcpJsonPath).catch(() => null)
    if (!stats) return {}

    const cached = projectMcpJsonCache.get(mcpJsonPath)
    if (cached && cached.mtime === stats.mtimeMs) {
      return cached.servers
    }

    const servers = await readProjectMcpJson(projectPath)
    projectMcpJsonCache.set(mcpJsonPath, {
      servers,
      mtime: stats.mtimeMs,
    })
    return servers
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// MCP resolution: JSON sources (Claude-native)
// ---------------------------------------------------------------------------

/**
 * Resolve MCP servers from all JSON-based sources (app-managed).
 * Sources: ~/.claude.json, ~/.claude/.claude.json, ~/.claude/mcp.json, .mcp.json, plugins.
 * Priority: project > global > plugin.
 */
export async function resolveUnifiedMcpServers(
  lookupPath: string,
): Promise<Record<string, McpServerConfig>> {
  const claudeJsonSource = path.join(os.homedir(), ".claude.json")
  const stats = await fs.stat(claudeJsonSource).catch(() => null)
  const currentMtime = stats?.mtimeMs ?? 0

  // Get or refresh cached config
  let claudeConfig: any
  const cached = mcpConfigCache.get(claudeJsonSource)
  if (cached && cached.mtime === currentMtime && currentMtime > 0) {
    claudeConfig = cached.config
  } else if (stats) {
    claudeConfig = JSON.parse(await fs.readFile(claudeJsonSource, "utf-8"))
    mcpConfigCache.set(claudeJsonSource, {
      config: claudeConfig,
      mtime: currentMtime,
    })
  } else {
    claudeConfig = {}
  }

  // Read ~/.claude/.claude.json
  let chatClaudeDirConfig: ClaudeConfig = {}
  try {
    chatClaudeDirConfig = await readClaudeDirConfig()
  } catch {
    /* ignore */
  }

  // Merge global servers from all user-level sources
  const globalServers = await getMergedGlobalMcpServers(
    claudeConfig,
    chatClaudeDirConfig,
  )

  // Merge per-project servers from config files
  const projectConfigServers = await getMergedLocalProjectMcpServers(
    lookupPath,
    claudeConfig,
    chatClaudeDirConfig,
  )

  // Read .mcp.json from project root
  const projectMcpJsonServers = await readProjectMcpJsonCached(lookupPath)

  // Per-project config servers override .mcp.json
  const projectServers = { ...projectMcpJsonServers, ...projectConfigServers }

  // Load plugin MCP servers (filtered by enabled plugins and approval)
  const [enabledPluginSources, pluginMcpConfigs, approvedServers] =
    await Promise.all([
      getEnabledPlugins(),
      discoverPluginMcpServers(),
      getApprovedPluginMcpServers(),
    ])

  const pluginServers: Record<string, McpServerConfig> = {}
  for (const pConfig of pluginMcpConfigs) {
    if (enabledPluginSources.includes(pConfig.pluginSource)) {
      for (const [name, serverConfig] of Object.entries(
        pConfig.mcpServers,
      )) {
        if (!globalServers[name] && !projectServers[name]) {
          const identifier = `${pConfig.pluginSource}:${name}`
          if (approvedServers.includes(identifier)) {
            pluginServers[name] = serverConfig
          }
        }
      }
    }
  }

  // Priority: project > global > plugin
  return {
    ...pluginServers,
    ...globalServers,
    ...projectServers,
  }
}

// ---------------------------------------------------------------------------
// Filtering to working servers
// ---------------------------------------------------------------------------

/**
 * Filter MCP servers to only those known to be working (have tools).
 * Servers not yet in the cache are included (they haven't been probed yet).
 */
export function filterWorkingMcpServers(
  allServers: Record<string, McpServerConfig>,
  projectServers: Record<string, McpServerConfig>,
  lookupPath: string,
): Record<string, McpServerConfig> {
  if (workingMcpServers.size === 0) {
    return allServers
  }

  const filtered: Record<string, McpServerConfig> = {}
  const resolvedProjectPath =
    resolveProjectPathFromWorktree(lookupPath) || lookupPath

  for (const [name, srvConfig] of Object.entries(allServers)) {
    const scope = name in projectServers ? resolvedProjectPath : null
    const cacheKey = mcpCacheKey(scope, name)
    // Include if working or not yet probed
    if (
      workingMcpServers.get(cacheKey) === true ||
      !workingMcpServers.has(cacheKey)
    ) {
      filtered[name] = srvConfig
    }
  }

  const skipped =
    Object.keys(allServers).length - Object.keys(filtered).length
  if (skipped > 0) {
    console.log(`[MCP] Filtered out ${skipped} non-working MCP(s)`)
  }

  return filtered
}

// ---------------------------------------------------------------------------
// Codex SDK config conversion
// ---------------------------------------------------------------------------

interface CodexMcpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  bearer_token_env_var?: string
  http_headers?: Record<string, string>
  startup_timeout_sec?: number
  tool_timeout_sec?: number
  enabled?: boolean
}

/**
 * Convert app-managed McpServerConfig records to Codex SDK's CodexConfigObject format.
 * Strips OAuth tokens and other Claude-specific fields.
 */
export function toCodexSdkMcpConfig(
  servers: Record<string, McpServerConfig>,
): Record<string, CodexMcpServerConfig> {
  const result: Record<string, CodexMcpServerConfig> = {}

  for (const [name, config] of Object.entries(servers)) {
    const codexConfig: CodexMcpServerConfig = { enabled: true }

    if (config.command) {
      // Stdio server
      codexConfig.command = config.command
      if (config.args) codexConfig.args = config.args as string[]
      if (config.env && typeof config.env === "object") {
        codexConfig.env = config.env as Record<string, string>
      }
    } else if (config.url) {
      // HTTP server
      codexConfig.url = config.url
      // Strip OAuth tokens — never pass _oauth to Codex
      if (config.headers && typeof config.headers === "object") {
        codexConfig.http_headers = config.headers as Record<string, string>
      }
    }

    result[name] = codexConfig
  }

  return result
}

/**
 * Build a CodexConfigObject with mcp_servers from merged sources.
 * Used when creating a Codex SDK instance.
 * Returns Record<string, any> to match CodexConfigObject's index signature.
 */
export function toCodexSdkConfig(
  servers: Record<string, McpServerConfig>,
): Record<string, any> {
  return {
    mcp_servers: toCodexSdkMcpConfig(servers),
  }
}

// ---------------------------------------------------------------------------
// Cache clearing
// ---------------------------------------------------------------------------

export function clearMcpCaches(): void {
  workingMcpServers.clear()
  mcpConfigCache.clear()
  projectMcpJsonCache.clear()
}

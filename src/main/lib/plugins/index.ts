import * as fs from "fs/promises"
import type { Dirent } from "fs"
import * as path from "path"
import * as os from "os"
import type { McpServerConfig } from "../claude-config"
import { isDirentDirectory } from "../fs/dirent"

export interface PluginInfo {
  name: string
  version: string
  description?: string
  path: string
  source: string // e.g., "marketplace:plugin-name"
  marketplace: string // e.g., "claude-plugins-official"
  category?: string
  homepage?: string
  tags?: string[]
}

interface MarketplacePlugin {
  name: string
  version?: string
  description?: string
  source: string | { source: string; url: string }
  category?: string
  homepage?: string
  tags?: string[]
}

interface MarketplaceJson {
  name: string
  plugins: MarketplacePlugin[]
}

export interface PluginMcpConfig {
  pluginSource: string // e.g., "ccsetup:ccsetup"
  mcpServers: Record<string, McpServerConfig>
}

// Cache for plugin discovery results
let pluginCache: { plugins: PluginInfo[]; timestamp: number } | null = null
let mcpCache: { configs: PluginMcpConfig[]; timestamp: number } | null = null
const CACHE_TTL_MS = 30000 // 30 seconds - plugins don't change often during a session

/**
 * Clear plugin caches (for testing/manual invalidation)
 */
export function clearPluginCache() {
  pluginCache = null
  mcpCache = null
}

/**
 * Discover all installed plugins from ~/.claude/plugins/marketplaces/
 * Returns array of plugin info with paths to their component directories
 * Results are cached for 30 seconds to avoid repeated filesystem scans
 */
export async function discoverInstalledPlugins(): Promise<PluginInfo[]> {
  // Return cached result if still valid
  if (pluginCache && Date.now() - pluginCache.timestamp < CACHE_TTL_MS) {
    return pluginCache.plugins
  }

  const plugins: PluginInfo[] = []
  const marketplacesDir = path.join(os.homedir(), ".claude", "plugins", "marketplaces")

  try {
    await fs.access(marketplacesDir)
  } catch {
    pluginCache = { plugins, timestamp: Date.now() }
    return plugins
  }

  let marketplaces: Dirent[]
  try {
    marketplaces = await fs.readdir(marketplacesDir, { withFileTypes: true })
  } catch {
    pluginCache = { plugins, timestamp: Date.now() }
    return plugins
  }

  for (const marketplace of marketplaces) {
    if (marketplace.name.startsWith(".")) continue

    const isMarketplaceDir = await isDirentDirectory(
      marketplacesDir,
      marketplace,
    )
    if (!isMarketplaceDir) continue

    const marketplacePath = path.join(marketplacesDir, marketplace.name)
    const marketplaceJsonPath = path.join(marketplacePath, ".claude-plugin", "marketplace.json")

    try {
      const content = await fs.readFile(marketplaceJsonPath, "utf-8")

      let marketplaceJson: MarketplaceJson
      try {
        marketplaceJson = JSON.parse(content)
      } catch {
        continue
      }

      if (!Array.isArray(marketplaceJson.plugins)) {
        continue
      }

      for (const plugin of marketplaceJson.plugins) {
        // Validate plugin.source exists
        if (!plugin.source) continue

        // source can be a string path or an object { source: "url", url: "..." }
        const sourcePath = typeof plugin.source === "string" ? plugin.source : null
        if (!sourcePath) continue

        const pluginPath = path.resolve(marketplacePath, sourcePath)
        try {
          const pluginStat = await fs.stat(pluginPath)
          if (!pluginStat.isDirectory()) continue
          plugins.push({
            name: plugin.name,
            version: plugin.version || "0.0.0",
            description: plugin.description,
            path: pluginPath,
            source: `${marketplaceJson.name}:${plugin.name}`,
            marketplace: marketplaceJson.name,
            category: plugin.category,
            homepage: plugin.homepage,
            tags: plugin.tags,
          })
        } catch {
          // Plugin directory not found, skip
        }
      }
    } catch {
      // No marketplace.json, skip silently (expected for non-plugin directories)
    }
  }

  pluginCache = { plugins, timestamp: Date.now() }
  return plugins
}

/**
 * Get component paths for a plugin (commands, skills, agents directories)
 */
export function getPluginComponentPaths(plugin: PluginInfo) {
  return {
    commands: path.join(plugin.path, "commands"),
    skills: path.join(plugin.path, "skills"),
    agents: path.join(plugin.path, "agents"),
  }
}

/**
 * Discover MCP server configs from all installed plugins
 * Reads .mcp.json from each plugin directory
 * Results are cached for 30 seconds to avoid repeated filesystem scans
 */
export async function discoverPluginMcpServers(): Promise<PluginMcpConfig[]> {
  // Return cached result if still valid
  if (mcpCache && Date.now() - mcpCache.timestamp < CACHE_TTL_MS) {
    return mcpCache.configs
  }

  const plugins = await discoverInstalledPlugins()
  const configs: PluginMcpConfig[] = []

  for (const plugin of plugins) {
    const mcpJsonPath = path.join(plugin.path, ".mcp.json")
    try {
      const content = await fs.readFile(mcpJsonPath, "utf-8")
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content)
      } catch {
        continue
      }

      // Support two formats:
      // Format A (flat): { "server-name": { "command": "...", ... } }
      // Format B (nested): { "mcpServers": { "server-name": { ... } } }
      const serversObj =
        parsed.mcpServers &&
        typeof parsed.mcpServers === "object" &&
        !Array.isArray(parsed.mcpServers)
          ? (parsed.mcpServers as Record<string, unknown>)
          : parsed

      const validServers: Record<string, McpServerConfig> = {}
      for (const [name, config] of Object.entries(serversObj)) {
        if (config && typeof config === "object" && !Array.isArray(config)) {
          validServers[name] = config as McpServerConfig
        }
      }

      if (Object.keys(validServers).length > 0) {
        configs.push({
          pluginSource: plugin.source,
          mcpServers: validServers,
        })
      }
    } catch {
      // No .mcp.json file, skip silently (this is expected for most plugins)
    }
  }

  // Cache the result
  mcpCache = { configs, timestamp: Date.now() }
  return configs
}

// ============ PLUGIN SCOPE (Plugin Mode) ============

/**
 * Unified plugin manifest (plugin.json).
 * Supports both the new ~/.askcodi/plugins/ format and legacy .claude-plugin/ format.
 */
export interface PluginManifest {
  name: string
  version?: string
  description?: string
  author?: string | { name: string; email?: string }
  category?: string
  tags?: string[]
  // Skills: either a directory path (legacy/bundled) or array of skill names (reference model)
  skills?: string | string[]
  // Agents: either a directory path (legacy/bundled) or array of agent names (reference model)
  agents?: string | string[]
  // Commands: either a directory path (legacy/bundled) or array of command names
  commands?: string | string[]
  // MCP servers: path to .mcp.json file
  mcpServers?: string
  interface?: {
    icon?: string
    systemPromptAppend?: string
    displayName?: string
    shortDescription?: string
  }
}

/**
 * Resolved plugin scope — everything needed to scope an agent session to a single plugin.
 *
 * Two models supported:
 * - Directory (bundled plugins): skills/agents live physically inside the plugin folder
 * - Reference (playlist model): plugin.json lists skill/agent names, resolved from discovery paths
 */
export interface PluginScope {
  pluginPath: string
  pluginName: string
  pluginSource: string
  // Directory-based (bundled plugins from git)
  skillsDir: string | null
  agentsDir: string | null
  commandsDir: string | null
  // Reference-based (playlist model — names to look up from discovery paths)
  skillRefs: string[]
  agentRefs: string[]
  commandRefs: string[]
  // MCP servers (always from plugin's .mcp.json)
  mcpServers: Record<string, McpServerConfig>
  systemPromptAppend?: string
}

/**
 * Resolve the full scope of a plugin by its source identifier.
 * Reads the plugin manifest and resolves all component paths + MCP servers.
 */
export async function resolvePluginScope(
  pluginSource: string,
): Promise<PluginScope | null> {
  const plugins = await discoverInstalledPlugins()
  const plugin = plugins.find((p) => p.source === pluginSource)
  if (!plugin) return null

  // Try to read unified plugin.json manifest first
  const manifestPath = path.join(plugin.path, "plugin.json")
  let manifest: PluginManifest | null = null
  try {
    const raw = await fs.readFile(manifestPath, "utf-8")
    manifest = JSON.parse(raw)
  } catch {
    // No plugin.json — use component path conventions
  }

  // Resolve skills: either directory (bundled) or references (playlist model)
  let skillsDir: string | null = null
  let skillRefs: string[] = []
  if (Array.isArray(manifest?.skills)) {
    // Reference model: plugin lists skill names
    skillRefs = manifest.skills as string[]
  } else {
    // Directory model: skills physically in plugin folder
    const skillsCandidates = [
      typeof manifest?.skills === "string" ? path.join(plugin.path, manifest.skills) : null,
      path.join(plugin.path, "skills"),
    ].filter(Boolean) as string[]
    for (const candidate of skillsCandidates) {
      try {
        await fs.access(candidate)
        skillsDir = candidate
        break
      } catch { /* not found */ }
    }
  }

  // Resolve agents: either directory or references
  let agentsDir: string | null = null
  let agentRefs: string[] = []
  if (Array.isArray(manifest?.agents)) {
    agentRefs = manifest.agents as string[]
  } else {
    const agentsCandidates = [
      typeof manifest?.agents === "string" ? path.join(plugin.path, manifest.agents) : null,
      path.join(plugin.path, "agents"),
    ].filter(Boolean) as string[]
    for (const candidate of agentsCandidates) {
      try {
        await fs.access(candidate)
        agentsDir = candidate
        break
      } catch { /* not found */ }
    }
  }

  // Resolve commands: either directory or references
  let commandsDir: string | null = null
  let commandRefs: string[] = []
  if (Array.isArray(manifest?.commands)) {
    commandRefs = manifest.commands as string[]
  } else {
    const commandsCandidates = [
      typeof manifest?.commands === "string" ? path.join(plugin.path, manifest.commands) : null,
      path.join(plugin.path, "commands"),
    ].filter(Boolean) as string[]
    for (const candidate of commandsCandidates) {
      try {
        await fs.access(candidate)
        commandsDir = candidate
        break
      } catch { /* not found */ }
    }
  }

  // Resolve MCP servers
  let mcpServers: Record<string, McpServerConfig> = {}
  const mcpJsonPath = manifest?.mcpServers
    ? path.join(plugin.path, manifest.mcpServers)
    : path.join(plugin.path, ".mcp.json")
  try {
    const mcpContent = await fs.readFile(mcpJsonPath, "utf-8")
    const parsed = JSON.parse(mcpContent)
    const serversObj =
      parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
        ? parsed.mcpServers
        : parsed
    for (const [name, config] of Object.entries(serversObj)) {
      if (config && typeof config === "object" && !Array.isArray(config)) {
        mcpServers[name] = config as McpServerConfig
      }
    }
  } catch {
    // No MCP config
  }

  return {
    pluginPath: plugin.path,
    pluginName: manifest?.name ?? plugin.name,
    pluginSource: plugin.source,
    skillsDir,
    agentsDir,
    commandsDir,
    skillRefs,
    agentRefs,
    commandRefs,
    mcpServers,
    systemPromptAppend: manifest?.interface?.systemPromptAppend,
  }
}

/**
 * Discover plugins from the new ~/.askcodi/plugins/ directory.
 * Each marketplace subdirectory contains plugin folders with plugin.json manifests.
 */
export async function discoverUnifiedPlugins(): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = []
  const pluginsDir = path.join(os.homedir(), ".askcodi", "plugins")

  try {
    await fs.access(pluginsDir)
  } catch {
    return plugins
  }

  let marketplaces: Dirent[]
  try {
    marketplaces = await fs.readdir(pluginsDir, { withFileTypes: true })
  } catch {
    return plugins
  }

  for (const marketplace of marketplaces) {
    if (!(await isDirentDirectory(pluginsDir, marketplace))) continue

    const marketplaceDir = path.join(pluginsDir, marketplace.name)
    let pluginDirs: Dirent[]
    try {
      pluginDirs = await fs.readdir(marketplaceDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const pluginDir of pluginDirs) {
      if (!(await isDirentDirectory(marketplaceDir, pluginDir))) continue

      const pluginPath = path.join(marketplaceDir, pluginDir.name)
      const manifestPath = path.join(pluginPath, "plugin.json")

      try {
        const raw = await fs.readFile(manifestPath, "utf-8")
        const manifest: PluginManifest = JSON.parse(raw)

        plugins.push({
          name: manifest.name || pluginDir.name,
          version: manifest.version || "0.0.0",
          description: manifest.description,
          path: pluginPath,
          source: `${marketplace.name}:${manifest.name || pluginDir.name}`,
          marketplace: marketplace.name,
          category: manifest.category,
          tags: manifest.tags,
        })
      } catch {
        // No valid plugin.json, skip
      }
    }
  }

  return plugins
}

/**
 * Discover ALL plugins from both legacy and unified paths.
 * Returns combined list, deduplicating by source identifier.
 */
export async function discoverAllPlugins(): Promise<PluginInfo[]> {
  const [legacy, unified] = await Promise.all([
    discoverInstalledPlugins(),
    discoverUnifiedPlugins(),
  ])

  // Unified plugins take precedence on name conflict
  const seen = new Set<string>()
  const combined: PluginInfo[] = []

  for (const p of unified) {
    seen.add(p.source)
    combined.push(p)
  }
  for (const p of legacy) {
    if (!seen.has(p.source)) {
      combined.push(p)
    }
  }

  return combined
}

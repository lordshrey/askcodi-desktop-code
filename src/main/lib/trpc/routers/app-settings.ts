import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { z } from "zod"
import { router, publicProcedure } from "../index"

// App-level settings (unified across all providers)
const APP_SETTINGS_PATH = path.join(os.homedir(), ".askcodi", "settings.json")
// Legacy path for backward compatibility migration
const LEGACY_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json")

// Cache for enabled plugins to avoid repeated filesystem reads
let enabledPluginsCache: { plugins: string[]; timestamp: number } | null = null
const ENABLED_PLUGINS_CACHE_TTL_MS = 5000 // 5 seconds

// Cache for approved plugin MCP servers
let approvedMcpCache: { servers: string[]; timestamp: number } | null = null
const APPROVED_MCP_CACHE_TTL_MS = 5000 // 5 seconds

/**
 * Invalidate the enabled plugins cache
 * Call this when enabledPlugins setting changes
 */
export function invalidateEnabledPluginsCache(): void {
  enabledPluginsCache = null
}

/**
 * Invalidate the approved MCP servers cache
 * Call this when approvedPluginMcpServers setting changes
 */
export function invalidateApprovedMcpCache(): void {
  approvedMcpCache = null
}

/**
 * Read app settings.json file.
 * Checks ~/.askcodi/settings.json first, falls back to legacy ~/.claude/settings.json.
 * On first read from legacy, migrates to new path.
 */
async function readAppSettings(): Promise<Record<string, unknown>> {
  // Try new path first
  try {
    const content = await fs.readFile(APP_SETTINGS_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    // New path doesn't exist, try legacy
  }

  // Try legacy path and migrate if found
  try {
    const content = await fs.readFile(LEGACY_SETTINGS_PATH, "utf-8")
    const settings = JSON.parse(content)
    // Migrate: write to new path
    try {
      await writeAppSettings(settings)
    } catch {
      // Migration write failed, still return the data
    }
    return settings
  } catch {
    return {}
  }
}

/**
 * Get list of enabled plugin identifiers from settings.json
 * Plugins are DISABLED by default — only plugins explicitly in this list are active.
 * Returns empty array if no plugins have been enabled.
 * Results are cached for 5 seconds to reduce filesystem reads.
 */
export async function getEnabledPlugins(): Promise<string[]> {
  // Return cached result if still valid
  if (enabledPluginsCache && Date.now() - enabledPluginsCache.timestamp < ENABLED_PLUGINS_CACHE_TTL_MS) {
    return enabledPluginsCache.plugins
  }

  const settings = await readAppSettings()
  const plugins = Array.isArray(settings.enabledPlugins) ? settings.enabledPlugins as string[] : []

  enabledPluginsCache = { plugins, timestamp: Date.now() }
  return plugins
}

/**
 * Get list of approved plugin MCP server identifiers from settings.json
 * Format: "{pluginSource}:{serverName}" e.g., "ccsetup:ccsetup:context7"
 * Returns empty array if no approved servers
 * Results are cached for 5 seconds to reduce filesystem reads
 */
export async function getApprovedPluginMcpServers(): Promise<string[]> {
  // Return cached result if still valid
  if (approvedMcpCache && Date.now() - approvedMcpCache.timestamp < APPROVED_MCP_CACHE_TTL_MS) {
    return approvedMcpCache.servers
  }

  const settings = await readAppSettings()
  const servers = Array.isArray(settings.approvedPluginMcpServers)
    ? settings.approvedPluginMcpServers as string[]
    : []

  approvedMcpCache = { servers, timestamp: Date.now() }
  return servers
}

/**
 * Check if a plugin MCP server is approved
 */
export async function isPluginMcpApproved(pluginSource: string, serverName: string): Promise<boolean> {
  const approved = await getApprovedPluginMcpServers()
  const identifier = `${pluginSource}:${serverName}`
  return approved.includes(identifier)
}

/**
 * Write app settings.json file.
 * Writes to ~/.askcodi/settings.json (creates directory if needed).
 */
async function writeAppSettings(settings: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(APP_SETTINGS_PATH)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(APP_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8")
}

export const appSettingsRouter = router({
  /**
   * Get the includeCoAuthoredBy setting
   * Returns true if setting is not explicitly set to false
   */
  getIncludeCoAuthoredBy: publicProcedure.query(async () => {
    const settings = await readAppSettings()
    // Default is true (include co-authored-by)
    // Only return false if explicitly set to false
    return settings.includeCoAuthoredBy !== false
  }),

  /**
   * Set the includeCoAuthoredBy setting
   */
  setIncludeCoAuthoredBy: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const settings = await readAppSettings()

      if (input.enabled) {
        // Remove the setting to use default (true)
        delete settings.includeCoAuthoredBy
      } else {
        // Explicitly set to false to disable
        settings.includeCoAuthoredBy = false
      }

      await writeAppSettings(settings)
      return { success: true }
    }),

  /**
   * Get list of enabled plugins
   * Plugins are disabled by default — only explicitly enabled ones are active.
   */
  getEnabledPlugins: publicProcedure.query(async () => {
    return await getEnabledPlugins()
  }),

  /**
   * Set a plugin's enabled state
   * Plugins are disabled by default — adding to enabledPlugins activates them.
   */
  setPluginEnabled: publicProcedure
    .input(
      z.object({
        pluginSource: z.string(),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const settings = await readAppSettings()
      const enabledPlugins = Array.isArray(settings.enabledPlugins)
        ? (settings.enabledPlugins as string[])
        : []

      if (input.enabled && !enabledPlugins.includes(input.pluginSource)) {
        enabledPlugins.push(input.pluginSource)
      } else if (!input.enabled) {
        const index = enabledPlugins.indexOf(input.pluginSource)
        if (index > -1) enabledPlugins.splice(index, 1)
      }

      settings.enabledPlugins = enabledPlugins
      await writeAppSettings(settings)
      invalidateEnabledPluginsCache()
      return { success: true }
    }),

  /**
   * Get list of approved plugin MCP servers
   */
  getApprovedPluginMcpServers: publicProcedure.query(async () => {
    return await getApprovedPluginMcpServers()
  }),

  /**
   * Approve a plugin MCP server
   * Identifier format: "{pluginSource}:{serverName}"
   */
  approvePluginMcpServer: publicProcedure
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ input }) => {
      const settings = await readAppSettings()
      const approved = Array.isArray(settings.approvedPluginMcpServers)
        ? (settings.approvedPluginMcpServers as string[])
        : []

      if (!approved.includes(input.identifier)) {
        approved.push(input.identifier)
      }

      settings.approvedPluginMcpServers = approved
      await writeAppSettings(settings)
      invalidateApprovedMcpCache()
      return { success: true }
    }),

  /**
   * Revoke approval for a plugin MCP server
   * Identifier format: "{pluginSource}:{serverName}"
   */
  revokePluginMcpServer: publicProcedure
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ input }) => {
      const settings = await readAppSettings()
      const approved = Array.isArray(settings.approvedPluginMcpServers)
        ? (settings.approvedPluginMcpServers as string[])
        : []

      const index = approved.indexOf(input.identifier)
      if (index > -1) {
        approved.splice(index, 1)
      }

      settings.approvedPluginMcpServers = approved
      await writeAppSettings(settings)
      invalidateApprovedMcpCache()
      return { success: true }
    }),

  /**
   * Approve all MCP servers from a plugin
   * Takes the pluginSource (e.g., "ccsetup:ccsetup") and list of server names
   */
  approveAllPluginMcpServers: publicProcedure
    .input(z.object({
      pluginSource: z.string(),
      serverNames: z.array(z.string()),
    }))
    .mutation(async ({ input }) => {
      const settings = await readAppSettings()
      const approved = Array.isArray(settings.approvedPluginMcpServers)
        ? (settings.approvedPluginMcpServers as string[])
        : []

      for (const serverName of input.serverNames) {
        const identifier = `${input.pluginSource}:${serverName}`
        if (!approved.includes(identifier)) {
          approved.push(identifier)
        }
      }

      settings.approvedPluginMcpServers = approved
      await writeAppSettings(settings)
      invalidateApprovedMcpCache()
      return { success: true }
    }),

  /**
   * Revoke all MCP servers from a plugin
   * Removes all identifiers matching "{pluginSource}:*"
   */
  revokeAllPluginMcpServers: publicProcedure
    .input(z.object({
      pluginSource: z.string(),
    }))
    .mutation(async ({ input }) => {
      const settings = await readAppSettings()
      const approved = Array.isArray(settings.approvedPluginMcpServers)
        ? (settings.approvedPluginMcpServers as string[])
        : []

      const prefix = `${input.pluginSource}:`
      settings.approvedPluginMcpServers = approved.filter((id) => !id.startsWith(prefix))
      await writeAppSettings(settings)
      invalidateApprovedMcpCache()
      return { success: true }
    }),
})

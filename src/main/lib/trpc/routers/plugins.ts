import { router, publicProcedure } from "../index"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execSync } from "child_process"
import matter from "gray-matter"
import { resolveDirentType } from "../../fs/dirent"
import {
  discoverInstalledPlugins,
  discoverAllPlugins,
  getPluginComponentPaths,
  discoverPluginMcpServers,
  clearPluginCache,
  resolvePluginScope,
} from "../../plugins"
import { getEnabledPlugins } from "./app-settings"
import { z } from "zod"

interface PluginComponent {
  name: string
  description?: string
}

interface PluginWithComponents {
  name: string
  version: string
  description?: string
  path: string
  source: string // e.g., "ccsetup:ccsetup"
  marketplace: string
  category?: string
  homepage?: string
  tags?: string[]
  isDisabled: boolean
  components: {
    commands: PluginComponent[]
    skills: PluginComponent[]
    agents: PluginComponent[]
    mcpServers: string[]
  }
}

/**
 * Validate entry name for security (prevent path traversal)
 */
function isValidEntryName(name: string): boolean {
  return !name.includes("..") && !name.includes("/") && !name.includes("\\")
}

/**
 * Scan commands directory and return component info
 */
async function scanPluginCommands(dir: string): Promise<PluginComponent[]> {
  const components: PluginComponent[] = []

  try {
    await fs.access(dir)
  } catch {
    return components
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!isValidEntryName(entry.name)) continue

      const fullPath = path.join(dir, entry.name)
      const { isDirectory, isFile } = await resolveDirentType(dir, entry)

      if (isDirectory) {
        // Recursively scan nested directories for namespaced commands
        const nested = await scanPluginCommands(fullPath)
        components.push(...nested)
      } else if (isFile && entry.name.endsWith(".md")) {
        try {
          const content = await fs.readFile(fullPath, "utf-8")
          const { data } = matter(content)
          const baseName = entry.name.replace(/\.md$/, "")
          components.push({
            name: typeof data.name === "string" ? data.name : baseName,
            description:
              typeof data.description === "string" ? data.description : undefined,
          })
        } catch {
          // Skip files that can't be read
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return components
}

/**
 * Scan skills directory and return component info
 */
async function scanPluginSkills(dir: string): Promise<PluginComponent[]> {
  const components: PluginComponent[] = []

  try {
    await fs.access(dir)
  } catch {
    return components
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!isValidEntryName(entry.name)) continue

      const { isDirectory } = await resolveDirentType(dir, entry)
      if (!isDirectory) continue

      const skillMdPath = path.join(dir, entry.name, "SKILL.md")
      try {
        const content = await fs.readFile(skillMdPath, "utf-8")
        const { data } = matter(content)
        components.push({
          name: typeof data.name === "string" ? data.name : entry.name,
          description:
            typeof data.description === "string" ? data.description : undefined,
        })
      } catch {
        // Skill directory doesn't have SKILL.md - skip
      }
    }
  } catch {
    // Directory read failed
  }

  return components
}

/**
 * Scan agents directory and return component info
 */
async function scanPluginAgents(dir: string): Promise<PluginComponent[]> {
  const components: PluginComponent[] = []

  try {
    await fs.access(dir)
  } catch {
    return components
  }

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.name.endsWith(".md") || !isValidEntryName(entry.name)) continue

      const { isFile } = await resolveDirentType(dir, entry)
      if (!isFile) continue

      const fullPath = path.join(dir, entry.name)
      try {
        const content = await fs.readFile(fullPath, "utf-8")
        const { data } = matter(content)
        const baseName = entry.name.replace(/\.md$/, "")
        components.push({
          name: typeof data.name === "string" ? data.name : baseName,
          description:
            typeof data.description === "string" ? data.description : undefined,
        })
      } catch {
        // Skip files that can't be read
      }
    }
  } catch {
    // Directory read failed
  }

  return components
}

export const pluginsRouter = router({
  /**
   * List all installed plugins with their components and disabled status
   */
  list: publicProcedure.query(async (): Promise<PluginWithComponents[]> => {
    const [installedPlugins, enabledPlugins, mcpConfigs] = await Promise.all([
      discoverInstalledPlugins(),
      getEnabledPlugins(),
      discoverPluginMcpServers(),
    ])

    // Build a map of plugin source -> MCP server names
    const pluginMcpMap = new Map<string, string[]>()
    for (const config of mcpConfigs) {
      pluginMcpMap.set(config.pluginSource, Object.keys(config.mcpServers))
    }

    // Scan components for each plugin in parallel
    const pluginsWithComponents = await Promise.all(
      installedPlugins.map(async (plugin) => {
        const paths = getPluginComponentPaths(plugin)

        const [commands, skills, agents] = await Promise.all([
          scanPluginCommands(paths.commands),
          scanPluginSkills(paths.skills),
          scanPluginAgents(paths.agents),
        ])

        return {
          name: plugin.name,
          version: plugin.version,
          description: plugin.description,
          path: plugin.path,
          source: plugin.source,
          marketplace: plugin.marketplace,
          category: plugin.category,
          homepage: plugin.homepage,
          tags: plugin.tags,
          isDisabled: !enabledPlugins.includes(plugin.source),
          components: {
            commands,
            skills,
            agents,
            mcpServers: pluginMcpMap.get(plugin.source) || [],
          },
        }
      })
    )

    return pluginsWithComponents
  }),

  /**
   * Clear plugin cache (forces re-scan on next list)
   */
  clearCache: publicProcedure.mutation(async () => {
    clearPluginCache()
    return { success: true }
  }),

  /**
   * Create a new plugin with plugin.json manifest.
   * Creates at ~/.askcodi/plugins/local/{name}/
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
        description: z.string().optional(),
        category: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {

      const pluginDir = path.join(
        os.homedir(),
        ".askcodi",
        "plugins",
        "local",
        input.name,
      )
      await fs.mkdir(pluginDir, { recursive: true })

      const manifest = {
        name: input.name,
        version: "1.0.0",
        description: input.description || "",
        category: input.category || "custom",
        skills: [] as string[],
        agents: [] as string[],
        commands: [] as string[],
      }

      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify(manifest, null, 2),
        "utf-8",
      )

      clearPluginCache()
      return {
        success: true,
        source: `local:${input.name}`,
        path: pluginDir,
      }
    }),

  /**
   * Update a plugin's skill/agent/command references.
   * This is the "playlist" model: assign existing skills/agents to a plugin.
   */
  updateRefs: publicProcedure
    .input(
      z.object({
        pluginSource: z.string(),
        skills: z.array(z.string()).optional(),
        agents: z.array(z.string()).optional(),
        commands: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const allPlugins = await discoverAllPlugins()
      const plugin = allPlugins.find((p) => p.source === input.pluginSource)
      if (!plugin) throw new Error(`Plugin not found: ${input.pluginSource}`)

      const manifestPath = path.join(plugin.path, "plugin.json")
      let manifest: Record<string, unknown> = {}
      try {
        const raw = await fs.readFile(manifestPath, "utf-8")
        manifest = JSON.parse(raw)
      } catch {
        // No existing manifest, create one
        manifest = { name: plugin.name, version: "1.0.0" }
      }

      if (input.skills !== undefined) manifest.skills = input.skills
      if (input.agents !== undefined) manifest.agents = input.agents
      if (input.commands !== undefined) manifest.commands = input.commands

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8")
      clearPluginCache()
      return { success: true }
    }),

  /**
   * Delete/uninstall a plugin.
   * Only removes plugins from ~/.askcodi/plugins/ (not legacy Claude plugins).
   */
  uninstall: publicProcedure
    .input(z.object({ pluginSource: z.string() }))
    .mutation(async ({ input }) => {

      const allPlugins = await discoverAllPlugins()
      const plugin = allPlugins.find((p) => p.source === input.pluginSource)
      if (!plugin) throw new Error(`Plugin not found: ${input.pluginSource}`)

      // Only allow deleting AskCodi plugins, not legacy Claude ones
      const askcodiBase = path.join(os.homedir(), ".askcodi", "plugins")
      if (!plugin.path.startsWith(askcodiBase)) {
        throw new Error("Cannot uninstall legacy plugins. Remove them from ~/.claude/plugins/ manually.")
      }

      await fs.rm(plugin.path, { recursive: true, force: true })
      clearPluginCache()
      return { success: true }
    }),

  /**
   * Get resolved plugin scope for plugin mode.
   */
  getPluginScope: publicProcedure
    .input(z.object({ pluginSource: z.string() }))
    .query(async ({ input }) => {
      return resolvePluginScope(input.pluginSource)
    }),

  /**
   * List plugins available for plugin mode (enabled only, lightweight).
   */
  listForPluginMode: publicProcedure.query(async () => {
    const allPlugins = await discoverAllPlugins()
    const enabledSources = await getEnabledPlugins()

    return allPlugins
      .filter((p) => enabledSources.includes(p.source))
      .map((p) => ({
        source: p.source,
        name: p.name,
        description: p.description,
        category: p.category,
      }))
  }),

  /**
   * Install a plugin from a git URL.
   * Clones the repo (or a sparse subdirectory) into ~/.askcodi/plugins/git/{name}/
   */
  installFromUrl: publicProcedure
    .input(
      z.object({
        url: z.string().url(),
        name: z.string().optional(), // Override plugin name (defaults to repo name)
        subdirectory: z.string().optional(), // If the plugin is in a subdirectory of the repo
      }),
    )
    .mutation(async ({ input }) => {


      const repoName =
        input.name ||
        input.url
          .replace(/\.git$/, "")
          .split("/")
          .pop() ||
        "unknown-plugin"

      const pluginsDir = path.join(os.homedir(), ".askcodi", "plugins", "git")
      await fs.mkdir(pluginsDir, { recursive: true })

      const targetDir = path.join(pluginsDir, repoName)

      // Remove existing if present
      try {
        await fs.rm(targetDir, { recursive: true, force: true })
      } catch {
        // Doesn't exist
      }

      try {
        if (input.subdirectory) {
          // Sparse clone — only the subdirectory
          execSync(
            `git clone --depth 1 --sparse "${input.url}" "${targetDir}"`,
            { timeout: 60000, stdio: "pipe" },
          )
          execSync(
            `git -C "${targetDir}" sparse-checkout set "${input.subdirectory}"`,
            { timeout: 30000, stdio: "pipe" },
          )

          // If subdirectory specified, the plugin content is inside it
          // Check if it has plugin.json or .claude-plugin/plugin.json at the subdirectory level
          const subDir = path.join(targetDir, input.subdirectory)
          const hasUnifiedManifest = await fs
            .access(path.join(subDir, "plugin.json"))
            .then(() => true)
            .catch(() => false)
          const hasLegacyManifest = await fs
            .access(path.join(subDir, ".claude-plugin", "plugin.json"))
            .then(() => true)
            .catch(() => false)

          // If the subdirectory IS the plugin, symlink it up
          if (hasUnifiedManifest || hasLegacyManifest) {
            // Move subdirectory content to target
            const tmpDir = `${targetDir}-tmp`
            await fs.rename(targetDir, tmpDir)
            await fs.rename(path.join(tmpDir, input.subdirectory), targetDir)
            await fs.rm(tmpDir, { recursive: true, force: true })
          }
        } else {
          // Full clone
          execSync(`git clone --depth 1 "${input.url}" "${targetDir}"`, {
            timeout: 60000,
            stdio: "pipe",
          })
        }

        // If the repo has a plugins/ subdirectory with multiple plugins, scan them
        const pluginsSubdir = path.join(targetDir, "plugins")
        let installedPlugins: string[] = []
        try {
          const entries = await fs.readdir(pluginsSubdir, {
            withFileTypes: true,
          })
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const pluginPath = path.join(pluginsSubdir, entry.name)
            const hasManifest =
              (await fs
                .access(path.join(pluginPath, "plugin.json"))
                .then(() => true)
                .catch(() => false)) ||
              (await fs
                .access(
                  path.join(pluginPath, ".claude-plugin", "plugin.json"),
                )
                .then(() => true)
                .catch(() => false))

            if (hasManifest) {
              // Symlink each plugin to the git marketplace level
              const symlinkTarget = path.join(pluginsDir, entry.name)
              try {
                await fs.rm(symlinkTarget, { recursive: true, force: true })
              } catch {}
              await fs.symlink(pluginPath, symlinkTarget)
              // Copy .claude-plugin/plugin.json to plugin.json for unified discovery
              try {
                const legacyManifest = path.join(
                  pluginPath,
                  ".claude-plugin",
                  "plugin.json",
                )
                const unifiedManifest = path.join(pluginPath, "plugin.json")
                await fs.access(unifiedManifest).catch(async () => {
                  await fs.copyFile(legacyManifest, unifiedManifest)
                })
              } catch {}
              installedPlugins.push(entry.name)
            }
          }
        } catch {
          // No plugins/ subdirectory — the repo itself is the plugin
          installedPlugins = [repoName]
        }

        // Clear cache so new plugins are discovered
        clearPluginCache()

        return {
          success: true,
          installedDir: targetDir,
          plugins: installedPlugins,
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, error: msg, plugins: [] }
      }
    }),
})

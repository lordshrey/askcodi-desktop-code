/**
 * Plugin Scope Builder
 *
 * Builds system prompt content from a resolved plugin scope.
 * Used to inject plugin skills/agents into agent sessions when plugin mode is active.
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import matter from "gray-matter"
import type { PluginScope } from "./index"

/**
 * Resolve skill references by name from standard discovery paths.
 * Looks in: ~/.askcodi/skills/, ~/.claude/skills/ (legacy), project .askcodi/skills/
 */
async function resolveSkillByName(
  name: string,
  projectPath?: string,
): Promise<{ name: string; description: string; content: string } | null> {
  const searchPaths = [
    projectPath ? path.join(projectPath, ".askcodi", "skills", name, "SKILL.md") : null,
    projectPath ? path.join(projectPath, ".claude", "skills", name, "SKILL.md") : null,
    path.join(os.homedir(), ".askcodi", "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".claude", "skills", name, "SKILL.md"),
  ].filter(Boolean) as string[]

  for (const skillPath of searchPaths) {
    try {
      const raw = await fs.readFile(skillPath, "utf-8")
      const { data, content } = matter(raw)
      return {
        name: (data.name as string) || name,
        description: (data.description as string) || "",
        content: content.trim(),
      }
    } catch {
      // Not found at this path
    }
  }
  return null
}

/**
 * Resolve agent references by name from standard discovery paths.
 */
async function resolveAgentByName(
  name: string,
  projectPath?: string,
): Promise<{ name: string; description: string; prompt: string } | null> {
  const searchPaths = [
    projectPath ? path.join(projectPath, ".askcodi", "agents", `${name}.md`) : null,
    projectPath ? path.join(projectPath, ".claude", "agents", `${name}.md`) : null,
    path.join(os.homedir(), ".askcodi", "agents", `${name}.md`),
    path.join(os.homedir(), ".claude", "agents", `${name}.md`),
  ].filter(Boolean) as string[]

  for (const agentPath of searchPaths) {
    try {
      const raw = await fs.readFile(agentPath, "utf-8")
      const { data, content } = matter(raw)
      return {
        name: (data.name as string) || name,
        description: (data.description as string) || "",
        prompt: content.trim(),
      }
    } catch {
      // Not found at this path
    }
  }
  return null
}

/**
 * Load all skill content from a plugin's skills directory.
 * Returns an array of { name, description, content } for each skill.
 */
export async function loadPluginSkills(
  skillsDir: string | null,
): Promise<Array<{ name: string; description: string; content: string }>> {
  if (!skillsDir) return []

  const skills: Array<{ name: string; description: string; content: string }> = []

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md")
      try {
        const raw = await fs.readFile(skillMdPath, "utf-8")
        const { data, content } = matter(raw)
        skills.push({
          name: (data.name as string) || entry.name,
          description: (data.description as string) || "",
          content: content.trim(),
        })
      } catch {
        // No SKILL.md or unreadable, skip
      }
    }
  } catch {
    // Directory not readable
  }

  return skills
}

/**
 * Load all agent definitions from a plugin's agents directory.
 * Returns an array of { name, description, prompt } for each agent.
 */
export async function loadPluginAgents(
  agentsDir: string | null,
): Promise<Array<{ name: string; description: string; prompt: string }>> {
  if (!agentsDir) return []

  const agents: Array<{ name: string; description: string; prompt: string }> = []

  try {
    const entries = await fs.readdir(agentsDir)

    for (const filename of entries) {
      if (!filename.endsWith(".md")) continue

      const agentPath = path.join(agentsDir, filename)
      try {
        const raw = await fs.readFile(agentPath, "utf-8")
        const { data, content } = matter(raw)
        agents.push({
          name: (data.name as string) || filename.replace(".md", ""),
          description: (data.description as string) || "",
          prompt: content.trim(),
        })
      } catch {
        // Unreadable, skip
      }
    }
  } catch {
    // Directory not readable
  }

  return agents
}

/**
 * Build the system prompt append content for a plugin scope.
 * This content is injected into the agent's system prompt when plugin mode is active.
 */
export async function buildPluginSystemPrompt(
  scope: PluginScope,
  projectPath?: string,
): Promise<string> {
  const sections: string[] = []

  // Plugin header
  sections.push(`# Active Plugin: ${scope.pluginName}`)

  // Custom system prompt from manifest
  if (scope.systemPromptAppend) {
    sections.push(scope.systemPromptAppend)
  }

  // Skills content — from bundled directory OR resolved references
  let skills: Array<{ name: string; description: string; content: string }> = []
  if (scope.skillRefs.length > 0) {
    // Reference model: resolve each skill by name from discovery paths
    const resolved = await Promise.all(
      scope.skillRefs.map((name) => resolveSkillByName(name, projectPath)),
    )
    skills = resolved.filter(Boolean) as typeof skills
  } else {
    // Directory model: load from bundled plugin folder
    skills = await loadPluginSkills(scope.skillsDir)
  }
  if (skills.length > 0) {
    sections.push("## Available Skills")
    for (const skill of skills) {
      sections.push(`### ${skill.name}`)
      if (skill.description) {
        sections.push(`*${skill.description}*`)
      }
      sections.push(skill.content)
    }
  }

  // Agent descriptions — from bundled directory OR resolved references
  let agents: Array<{ name: string; description: string; prompt: string }> = []
  if (scope.agentRefs.length > 0) {
    const resolved = await Promise.all(
      scope.agentRefs.map((name) => resolveAgentByName(name, projectPath)),
    )
    agents = resolved.filter(Boolean) as typeof agents
  } else {
    agents = await loadPluginAgents(scope.agentsDir)
  }
  if (agents.length > 0) {
    sections.push("## Available Agents")
    for (const agent of agents) {
      sections.push(
        `- **${agent.name}**: ${agent.description || "No description"}`,
      )
    }
  }

  // MCP server info
  const mcpNames = Object.keys(scope.mcpServers)
  if (mcpNames.length > 0) {
    sections.push(
      `## MCP Tools Available\nThe following MCP servers are active: ${mcpNames.join(", ")}. Use their tools as needed.`,
    )
  }

  return sections.join("\n\n")
}

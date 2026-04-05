import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useSetAtom } from "jotai"
import { useListKeyboardNav } from "./use-list-keyboard-nav"
import { settingsPluginsSidebarWidthAtom } from "../../../features/agents/atoms"
import { agentsSettingsDialogActiveTabAtom, type SettingsTab } from "../../../lib/atoms"
import { trpc } from "../../../lib/trpc"
import { cn } from "../../../lib/utils"
import { Terminal, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react"
import { PluginFilledIcon, SkillIconFilled, CustomAgentIconFilled, OriginalMCPIcon } from "../../ui/icons"
import { Button } from "../../ui/button"
import { Label } from "../../ui/label"
import { Switch } from "../../ui/switch"
import { ResizableSidebar } from "../../ui/resizable-sidebar"
import { toast } from "sonner"

/** Format plugin name: "pyright-lsp" → "Pyright Lsp" */
function formatPluginName(name: string): string {
  return name
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

interface PluginComponent {
  name: string
  description?: string
}

interface PluginData {
  name: string
  version: string
  description?: string
  path: string
  source: string
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

interface McpServerStatus {
  status: string
  needsAuth: boolean
}

// --- Detail Panel ---
function PluginDetail({
  plugin,
  onToggleEnabled,
  isTogglingEnabled,
  onNavigateToTab,
  mcpServerStatuses,
  onMcpAuth,
  isAuthenticating,
  onUninstall,
  onRefetch,
}: {
  plugin: PluginData
  onToggleEnabled: (enabled: boolean) => void
  isTogglingEnabled: boolean
  onNavigateToTab: (tab: SettingsTab) => void
  mcpServerStatuses: Record<string, McpServerStatus>
  onMcpAuth: (serverName: string) => void
  isAuthenticating: boolean
  onUninstall?: () => void
  onRefetch: () => void
}) {
  // Check if this is a user-created plugin (has reference-model skills/agents)
  const scopeQuery = trpc.plugins.getPluginScope.useQuery(
    { pluginSource: plugin.source },
    { staleTime: 30_000 },
  )
  const pluginScope = scopeQuery.data
  const isUserPlugin = plugin.path.includes("/.askcodi/plugins/")
  const hasRefs = pluginScope && (pluginScope.skillRefs.length > 0 || pluginScope.agentRefs.length > 0 || (pluginScope.skillsDir === null && pluginScope.agentsDir === null))
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6 space-y-5">
          {/* Name & category with integrated toggle */}
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">{formatPluginName(plugin.name)}</h3>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <span className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    plugin.isDisabled ? "bg-muted-foreground/40" : "bg-emerald-500"
                  )} />
                  <span className={cn(
                    "text-sm font-medium",
                    plugin.isDisabled ? "text-muted-foreground" : "text-emerald-500"
                  )}>
                    {plugin.isDisabled ? "Disabled" : "Active"}
                  </span>
                </div>
                <Switch
                  checked={!plugin.isDisabled}
                  onCheckedChange={onToggleEnabled}
                  disabled={isTogglingEnabled}
                />
              </div>
            </div>
            {plugin.category && (
              <p className="text-xs text-muted-foreground mt-0.5 capitalize">{plugin.category}</p>
            )}
          </div>

          {/* Description */}
          {plugin.description && (
            <p className="text-sm text-muted-foreground">{plugin.description}</p>
          )}

        {/* Info */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Version</Label>
            <p className="text-sm text-foreground font-mono">{plugin.version}</p>
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <p className="text-sm text-foreground font-mono">{plugin.source}</p>
          </div>
          {plugin.homepage && (
            <div className="space-y-1.5">
              <Label>Homepage</Label>
              <a href={plugin.homepage} target="_blank" rel="noopener noreferrer" className="block text-sm text-blue-400 hover:underline break-all">{plugin.homepage}</a>
            </div>
          )}
          {plugin.tags && plugin.tags.length > 0 && (
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1">
                {plugin.tags.map((tag) => (
                  <span key={tag} className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{tag}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Components — clickable, navigate to respective tabs */}
        {plugin.components.commands.length > 0 && (
          <div className="space-y-1.5">
            <Label>Commands ({plugin.components.commands.length})</Label>
            <div className="space-y-1">
              {plugin.components.commands.map((cmd) => (
                <button
                  key={cmd.name}
                  onClick={() => onNavigateToTab("skills")}
                  className="w-full flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 hover:bg-foreground/5 transition-colors cursor-pointer text-left group"
                >
                  <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-mono font-medium text-foreground">/{cmd.name}</p>
                    {cmd.description && (
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{cmd.description}</p>
                    )}
                  </div>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}

        {plugin.components.skills.length > 0 && (
          <div className="space-y-1.5">
            <Label>Skills ({plugin.components.skills.length})</Label>
            <div className="space-y-1">
              {plugin.components.skills.map((skill) => (
                <button
                  key={skill.name}
                  onClick={() => onNavigateToTab("skills")}
                  className="w-full flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 hover:bg-foreground/5 transition-colors cursor-pointer text-left group"
                >
                  <SkillIconFilled className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-mono font-medium text-foreground">{skill.name}</p>
                    {skill.description && (
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{skill.description}</p>
                    )}
                  </div>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}

        {plugin.components.agents.length > 0 && (
          <div className="space-y-1.5">
            <Label>Agents ({plugin.components.agents.length})</Label>
            <div className="space-y-1">
              {plugin.components.agents.map((agent) => (
                <button
                  key={agent.name}
                  onClick={() => onNavigateToTab("agents")}
                  className="w-full flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 hover:bg-foreground/5 transition-colors cursor-pointer text-left group"
                >
                  <CustomAgentIconFilled className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-mono font-medium text-foreground">{agent.name}</p>
                    {agent.description && (
                      <p className="text-[11px] text-muted-foreground/60 mt-0.5">{agent.description}</p>
                    )}
                  </div>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}

        {plugin.components.mcpServers.length > 0 && (
          <div className="space-y-1.5">
            <Label>MCP Servers ({plugin.components.mcpServers.length})</Label>
            <div className="space-y-1">
              {plugin.components.mcpServers.map((serverName) => {
                const serverStatus = mcpServerStatuses[serverName]
                const needsAuth = serverStatus?.needsAuth
                const isConnected = serverStatus?.status === "connected"
                return (
                  <div
                    key={serverName}
                    className="w-full flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 group"
                  >
                    <OriginalMCPIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <button
                      onClick={() => onNavigateToTab("mcp")}
                      className="min-w-0 flex-1 text-left hover:underline"
                    >
                      <p className="text-xs font-mono font-medium text-foreground">{serverName}</p>
                    </button>
                    {needsAuth ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-6 px-2 text-[11px] shrink-0"
                        disabled={isAuthenticating}
                        onClick={() => onMcpAuth(serverName)}
                      >
                        {isAuthenticating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Sign in"}
                      </Button>
                    ) : isConnected ? (
                      <span className="text-[11px] text-emerald-500 shrink-0">Connected</span>
                    ) : serverStatus ? (
                      <span className="text-[11px] text-muted-foreground shrink-0">{serverStatus.status}</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Skill/Agent Assignment (for user-created or reference-model plugins) */}
        {isUserPlugin && pluginScope && (
          <SkillAssignmentSection
            pluginSource={plugin.source}
            currentSkillRefs={pluginScope.skillRefs || []}
            currentAgentRefs={pluginScope.agentRefs || []}
            onUpdated={() => { onRefetch(); scopeQuery.refetch() }}
          />
        )}

        {/* Uninstall (only for AskCodi plugins) */}
        {onUninstall && isUserPlugin && (
          <div className="pt-3 border-t border-border">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5"
              onClick={onUninstall}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Uninstall Plugin
            </Button>
          </div>
        )}

        </div>
      </div>
    </div>
  )
}

// --- Sidebar list item ---
function PluginListItem({
  plugin,
  isSelected,
  onSelect,
}: {
  plugin: PluginData
  isSelected: boolean
  onSelect: (source: string) => void
}) {
  return (
    <button
      data-item-id={plugin.source}
      onClick={() => onSelect(plugin.source)}
      className={cn(
        "w-full text-left py-1.5 px-2 rounded-md transition-colors duration-150 cursor-pointer outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70 focus-visible:-outline-offset-2",
        isSelected
          ? "bg-foreground/5 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      )}
    >
      <div className="text-sm leading-tight truncate">{formatPluginName(plugin.name)}</div>
      {plugin.description && (
        <div className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
          {plugin.description}
        </div>
      )}
    </button>
  )
}

// --- Create Plugin Dialog ---
function CreatePluginSection({ onCreated }: { onCreated: () => void }) {
  const [isOpen, setIsOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const createMutation = trpc.plugins.create.useMutation()

  const handleCreate = async () => {
    if (!name.trim()) return
    try {
      await createMutation.mutateAsync({
        name: name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        description: description.trim() || undefined,
      })
      toast.success(`Plugin "${name}" created`)
      setName("")
      setDescription("")
      setIsOpen(false)
      onCreated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!isOpen) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="w-full h-7 text-xs justify-start gap-1.5 text-muted-foreground"
        onClick={() => setIsOpen(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        New Plugin
      </Button>
    )
  }

  return (
    <div className="space-y-1.5 p-2 rounded-md border border-input bg-muted/30">
      <input
        placeholder="plugin-name (lowercase, hyphens)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        className="h-6 w-full rounded text-[11px] bg-background border border-input/50 px-2 placeholder:text-muted-foreground/30 outline-none"
        autoFocus
      />
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleCreate()}
        className="h-6 w-full rounded text-[11px] bg-background border border-input/50 px-2 placeholder:text-muted-foreground/30 outline-none"
      />
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] flex-1" onClick={() => setIsOpen(false)}>
          Cancel
        </Button>
        <Button variant="default" size="sm" className="h-6 px-2 text-[11px] flex-1" onClick={handleCreate} disabled={!name.trim() || createMutation.isPending}>
          {createMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create"}
        </Button>
      </div>
    </div>
  )
}

// --- Skill/Agent Assignment (Reference Model) ---
function SkillAssignmentSection({
  pluginSource,
  currentSkillRefs,
  currentAgentRefs,
  onUpdated,
}: {
  pluginSource: string
  currentSkillRefs: string[]
  currentAgentRefs: string[]
  onUpdated: () => void
}) {
  const [skillInput, setSkillInput] = useState("")
  const [agentInput, setAgentInput] = useState("")
  const updateRefsMutation = trpc.plugins.updateRefs.useMutation()

  const handleAddSkill = async () => {
    if (!skillInput.trim()) return
    const newRefs = [...currentSkillRefs, skillInput.trim()]
    try {
      await updateRefsMutation.mutateAsync({ pluginSource, skills: newRefs })
      setSkillInput("")
      onUpdated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRemoveSkill = async (name: string) => {
    const newRefs = currentSkillRefs.filter((r) => r !== name)
    try {
      await updateRefsMutation.mutateAsync({ pluginSource, skills: newRefs })
      onUpdated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleAddAgent = async () => {
    if (!agentInput.trim()) return
    const newRefs = [...currentAgentRefs, agentInput.trim()]
    try {
      await updateRefsMutation.mutateAsync({ pluginSource, agents: newRefs })
      setAgentInput("")
      onUpdated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRemoveAgent = async (name: string) => {
    const newRefs = currentAgentRefs.filter((r) => r !== name)
    try {
      await updateRefsMutation.mutateAsync({ pluginSource, agents: newRefs })
      onUpdated()
    } catch (err) {
      toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="space-y-3">
      {/* Skill References */}
      <div className="space-y-1.5">
        <Label>Referenced Skills</Label>
        {currentSkillRefs.map((ref) => (
          <div key={ref} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1">
            <SkillIconFilled className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono flex-1">{ref}</span>
            <button onClick={() => handleRemoveSkill(ref)} className="text-muted-foreground/40 hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="flex gap-1">
          <input
            placeholder="Skill name to add..."
            value={skillInput}
            onChange={(e) => setSkillInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddSkill()}
            className="h-6 flex-1 rounded text-[11px] bg-muted/50 border border-input/50 px-2 placeholder:text-muted-foreground/30 outline-none"
          />
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={handleAddSkill} disabled={!skillInput.trim()}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Agent References */}
      <div className="space-y-1.5">
        <Label>Referenced Agents</Label>
        {currentAgentRefs.map((ref) => (
          <div key={ref} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1">
            <CustomAgentIconFilled className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-xs font-mono flex-1">{ref}</span>
            <button onClick={() => handleRemoveAgent(ref)} className="text-muted-foreground/40 hover:text-destructive">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="flex gap-1">
          <input
            placeholder="Agent name to add..."
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddAgent()}
            className="h-6 flex-1 rounded text-[11px] bg-muted/50 border border-input/50 px-2 placeholder:text-muted-foreground/30 outline-none"
          />
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={handleAddAgent} disabled={!agentInput.trim()}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// --- Install from URL ---
/**
 * Parse a GitHub URL to extract the clone URL, subdirectory, and plugin name.
 * Supports:
 *   https://github.com/owner/repo/tree/branch/path/to/plugin → clone repo, subdir = path/to/plugin
 *   https://github.com/owner/repo.git → clone repo, no subdir
 *   https://github.com/owner/repo → clone repo, no subdir
 */
function parseGitUrl(input: string): { url: string; subdirectory?: string; name?: string } {
  const trimmed = input.trim()

  // Match GitHub tree URLs: github.com/owner/repo/tree/branch/path
  const treeMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/(.+?)$/,
  )
  if (treeMatch) {
    const [, owner, repo, subPath] = treeMatch
    const name = subPath.split("/").pop() || repo
    return {
      url: `https://github.com/${owner}/${repo}.git`,
      subdirectory: subPath,
      name,
    }
  }

  // Already a .git URL or plain repo URL
  const repoMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (repoMatch) {
    const [, owner, repo] = repoMatch
    return { url: `https://github.com/${owner}/${repo}.git` }
  }

  // Fallback: use as-is
  return { url: trimmed }
}

function InstallFromUrlSection() {
  const [url, setUrl] = useState("")
  const [isInstalling, setIsInstalling] = useState(false)
  const installMutation = trpc.plugins.installFromUrl.useMutation()
  const utils = trpc.useUtils()

  const handleInstall = async () => {
    if (!url.trim()) return
    setIsInstalling(true)
    try {
      const parsed = parseGitUrl(url)
      const result = await installMutation.mutateAsync({
        url: parsed.url,
        subdirectory: parsed.subdirectory,
        name: parsed.name,
      })
      if (result.success) {
        toast.success(
          `Installed ${result.plugins?.length || 0} plugin(s): ${result.plugins?.join(", ") || "none"}`,
        )
        setUrl("")
        utils.plugins.list.invalidate()
        utils.plugins.listForPluginMode.invalidate()
      } else {
        toast.error(`Install failed: ${result.error}`)
      }
    } catch (err) {
      toast.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsInstalling(false)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <input
        placeholder="GitHub URL or git URL..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleInstall()}
        className="h-6 w-full rounded text-[11px] bg-muted/50 border border-input/50 px-2 placeholder:text-muted-foreground/30 outline-none"
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px] shrink-0"
        onClick={handleInstall}
        disabled={isInstalling || !url.trim()}
      >
        {isInstalling ? <Loader2 className="h-3 w-3 animate-spin" /> : "Install"}
      </Button>
    </div>
  )
}

// --- Main Component ---
export function AgentsPluginsTab() {
  const [selectedPluginSource, setSelectedPluginSource] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const searchInputRef = useRef<HTMLInputElement>(null)
  const setActiveTab = useSetAtom(agentsSettingsDialogActiveTabAtom)

  // Focus search on "/" hotkey
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])

  const { data: plugins = [], isLoading, refetch } = trpc.plugins.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  })

  // MCP server statuses for showing auth state in plugin detail
  const { data: allMcpConfig, refetch: refetchMcp } = trpc.claude.getAllMcpConfig.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
  })
  const mcpServerStatuses = useMemo(() => {
    const map: Record<string, McpServerStatus> = {}
    if (!allMcpConfig?.groups) return map
    for (const group of allMcpConfig.groups) {
      for (const server of group.mcpServers) {
        map[server.name] = { status: server.status, needsAuth: server.needsAuth }
      }
    }
    return map
  }, [allMcpConfig])

  const startOAuthMutation = trpc.claude.startMcpOAuth.useMutation()
  const handleMcpAuth = useCallback(async (serverName: string) => {
    try {
      const result = await startOAuthMutation.mutateAsync({
        serverName,
        projectPath: "__global__",
      })
      if (result.success) {
        toast.success(`${serverName} authenticated`)
        await refetchMcp()
      } else {
        toast.error(result.error || "Authentication failed")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authentication failed")
    }
  }, [startOAuthMutation, refetchMcp])

  const setPluginEnabledMutation = trpc.claudeSettings.setPluginEnabled.useMutation()

  const filteredPlugins = useMemo(() => {
    if (!searchQuery.trim()) return plugins
    const q = searchQuery.toLowerCase()
    // Normalize query: match both "pyright lsp" and "pyright-lsp"
    const qNoDashes = q.replace(/-/g, " ")
    const qWithDashes = q.replace(/ /g, "-")
    return plugins.filter((p) => {
      const name = p.name.toLowerCase()
      if (name.includes(q) || name.includes(qNoDashes) || name.includes(qWithDashes)) return true
      if (p.source.toLowerCase().includes(q)) return true
      if (p.marketplace.toLowerCase().includes(q)) return true
      if (p.description?.toLowerCase().includes(q)) return true
      if (p.path.toLowerCase().includes(q)) return true
      if (p.components.commands.some((c) => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))) return true
      if (p.components.skills.some((c) => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))) return true
      if (p.components.agents.some((c) => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))) return true
      if (p.components.mcpServers.some((s) => s.toLowerCase().includes(q))) return true
      return false
    })
  }, [plugins, searchQuery])

  const enabledPlugins = filteredPlugins.filter((p) => !p.isDisabled)
  const disabledPlugins = filteredPlugins.filter((p) => p.isDisabled)

  // Group disabled plugins by marketplace
  const marketplaceGroups = useMemo(() => {
    const groups = new Map<string, PluginData[]>()
    for (const plugin of disabledPlugins) {
      const existing = groups.get(plugin.marketplace) || []
      existing.push(plugin)
      groups.set(plugin.marketplace, existing)
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [disabledPlugins])

  const allPluginSources = useMemo(
    () => [
      ...enabledPlugins.map((p) => p.source),
      ...marketplaceGroups.flatMap(([, plugins]) => plugins.map((p) => p.source)),
    ],
    [enabledPlugins, marketplaceGroups]
  )

  const { containerRef: listRef, onKeyDown: listKeyDown } = useListKeyboardNav({
    items: allPluginSources,
    selectedItem: selectedPluginSource,
    onSelect: setSelectedPluginSource,
  })

  const selectedPlugin = plugins.find((p) => p.source === selectedPluginSource) || null

  // Auto-select first plugin in display order (enabled first, then marketplace)
  useEffect(() => {
    if (selectedPluginSource || isLoading || plugins.length === 0) return
    const first = enabledPlugins[0] || marketplaceGroups[0]?.[1]?.[0]
    if (first) setSelectedPluginSource(first.source)
  }, [plugins, selectedPluginSource, isLoading, enabledPlugins, marketplaceGroups])

  const approveAllMutation = trpc.claudeSettings.approveAllPluginMcpServers.useMutation()
  const revokeAllMutation = trpc.claudeSettings.revokeAllPluginMcpServers.useMutation()
  const uninstallMutation = trpc.plugins.uninstall.useMutation()

  const handleToggleEnabled = useCallback(async (plugin: PluginData, enabled: boolean) => {
    try {
      await setPluginEnabledMutation.mutateAsync({
        pluginSource: plugin.source,
        enabled,
      })

      // Auto-approve/revoke MCP servers with the plugin
      if (plugin.components.mcpServers.length > 0) {
        if (enabled) {
          await approveAllMutation.mutateAsync({
            pluginSource: plugin.source,
            serverNames: plugin.components.mcpServers,
          })
        } else {
          await revokeAllMutation.mutateAsync({
            pluginSource: plugin.source,
          })
        }
      }

      toast.success(enabled ? "Plugin enabled" : "Plugin disabled", {
        description: formatPluginName(plugin.name),
      })
      await refetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update plugin"
      toast.error(message)
    }
  }, [setPluginEnabledMutation, approveAllMutation, revokeAllMutation, refetch])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar - plugin list */}
      <ResizableSidebar
        isOpen={true}
        onClose={() => {}}
        widthAtom={settingsPluginsSidebarWidthAtom}
        minWidth={200}
        maxWidth={400}
        side="left"
        animationDuration={0}
        initialWidth={240}
        exitWidth={240}
        disableClickToClose={true}
      >
        <div className="flex flex-col h-full bg-background border-r overflow-hidden" style={{ borderRightWidth: "0.5px" }}>
          {/* Search + Install */}
          <div className="px-2 pt-2 flex-shrink-0 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <input
                ref={searchInputRef}
                placeholder="Search plugins..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={listKeyDown}
                className="h-7 w-full rounded-lg text-sm bg-muted border border-input px-3 placeholder:text-muted-foreground/40 outline-none"
              />
            </div>
            <CreatePluginSection onCreated={() => refetch()} />
            <InstallFromUrlSection />
          </div>
          {/* Plugin list */}
          <div ref={listRef} onKeyDown={listKeyDown} tabIndex={-1} className="flex-1 overflow-y-auto px-2 pt-2 pb-2 outline-none">
            {isLoading ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-xs text-muted-foreground">Loading...</p>
              </div>
            ) : plugins.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-4">
                <PluginFilledIcon className="h-8 w-8 text-border mb-3" />
                <p className="text-sm text-muted-foreground mb-1">No plugins</p>
                <p className="text-[11px] text-muted-foreground/70">
                  Install plugins to ~/.claude/plugins/
                </p>
              </div>
            ) : filteredPlugins.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-xs text-muted-foreground">No results found</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Enabled Plugins */}
                {enabledPlugins.length > 0 && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1">
                      Enabled
                    </p>
                    <div className="space-y-0.5">
                      {enabledPlugins.map((plugin) => (
                        <PluginListItem
                          key={plugin.source}
                          plugin={plugin}
                          isSelected={selectedPluginSource === plugin.source}
                          onSelect={setSelectedPluginSource}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Marketplace groups (disabled plugins) */}
                {marketplaceGroups.map(([marketplace, groupPlugins]) => (
                  <div key={marketplace}>
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 mb-1">
                      {marketplace}
                    </p>
                    <div className="space-y-0.5">
                      {groupPlugins.map((plugin) => (
                        <PluginListItem
                          key={plugin.source}
                          plugin={plugin}
                          isSelected={selectedPluginSource === plugin.source}
                          onSelect={setSelectedPluginSource}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </ResizableSidebar>

      {/* Right content - detail panel */}
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        {selectedPlugin ? (
          <PluginDetail
            plugin={selectedPlugin}
            onToggleEnabled={(enabled) => handleToggleEnabled(selectedPlugin, enabled)}
            isTogglingEnabled={setPluginEnabledMutation.isPending}
            onNavigateToTab={setActiveTab}
            mcpServerStatuses={mcpServerStatuses}
            onMcpAuth={handleMcpAuth}
            isAuthenticating={startOAuthMutation.isPending}
            onUninstall={async () => {
              try {
                await uninstallMutation.mutateAsync({ pluginSource: selectedPlugin.source })
                toast.success(`Plugin "${selectedPlugin.name}" uninstalled`)
                setSelectedPluginSource(null)
                await refetch()
              } catch (err) {
                toast.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            }}
            onRefetch={() => refetch()}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <PluginFilledIcon className="h-12 w-12 text-border mb-4" />
            <p className="text-sm text-muted-foreground">
              {plugins.length > 0
                ? "Select a plugin to view details"
                : "No plugins installed"}
            </p>
            {plugins.length === 0 && (
              <p className="text-xs text-muted-foreground/70 mt-2">
                Install plugins to ~/.claude/plugins/marketplaces/
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

"use client"

import { Brain, ChevronRight, Zap } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../../../components/ui/command"
import { CheckIcon, ClaudeCodeIcon, IconChevronDown, ThinkingIcon } from "../../../components/ui/icons"
import { Switch } from "../../../components/ui/switch"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import { cn } from "../../../lib/utils"
import type { CodexThinkingLevel } from "../lib/models"
import { formatCodexThinkingLabel } from "../lib/models"

const AskCodiIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
  </svg>
)

const CodexIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
)

export type AgentProviderId = "claude-code" | "codex" | "askcodi"

type ClaudeModelOption = {
  id: string
  name: string
  version: string
}

type CodexModelOption = {
  id: string
  name: string
  thinkings: CodexThinkingLevel[]
}

type AskCodiModelOption = {
  id: string
  name: string
}

interface AgentModelSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedAgentId: AgentProviderId
  onSelectedAgentIdChange: (provider: AgentProviderId) => void
  selectedModelLabel: string
  triggerClassName?: string
  contentClassName?: string
  onOpenModelsSettings?: () => void
  claude: {
    models: ClaudeModelOption[]
    selectedModelId?: string
    onSelectModel: (modelId: string) => void
    hasCustomModelConfig: boolean
    isOffline: boolean
    ollamaModels: string[]
    selectedOllamaModel?: string
    recommendedOllamaModel?: string
    onSelectOllamaModel: (modelId: string) => void
    isConnected: boolean
    thinkingEnabled: boolean
    onThinkingChange: (enabled: boolean) => void
  }
  codex: {
    models: CodexModelOption[]
    selectedModelId: string
    onSelectModel: (modelId: string) => void
    selectedThinking: CodexThinkingLevel
    onSelectThinking: (thinking: CodexThinkingLevel) => void
    isConnected: boolean
  }
  askcodi?: {
    models: AskCodiModelOption[]
    selectedModelId: string
    onSelectModel: (modelId: string) => void
    isConnected: boolean
  }
}

type FlatModelItem =
  | { type: "claude"; model: ClaudeModelOption }
  | { type: "codex"; model: CodexModelOption }
  | { type: "askcodi"; model: AskCodiModelOption }
  | { type: "ollama"; modelName: string; isRecommended: boolean }
  | { type: "custom" }

function CodexThinkingSubMenu({
  thinkings,
  selectedThinking,
  onSelectThinking,
}: {
  thinkings: CodexThinkingLevel[]
  selectedThinking: CodexThinkingLevel
  onSelectThinking: (thinking: CodexThinkingLevel) => void
}) {
  const triggerRef = useRef<HTMLDivElement>(null)
  const subMenuRef = useRef<HTMLDivElement>(null)
  const [showSub, setShowSub] = useState(false)
  const [subPos, setSubPos] = useState({ top: 0, left: 0 })
  const closeTimeout = useRef<ReturnType<typeof setTimeout>>()

  const scheduleClose = useCallback(() => {
    closeTimeout.current = setTimeout(() => setShowSub(false), 150)
  }, [])

  const cancelClose = useCallback(() => {
    clearTimeout(closeTimeout.current)
  }, [])

  const handleTriggerEnter = useCallback(() => {
    cancelClose()
    if (triggerRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect()
      setSubPos({
        top: triggerRect.top - 4,
        left: triggerRect.right + 6,
      })
    }
    setShowSub(true)
  }, [cancelClose])

  const handleTriggerLeave = useCallback(
    (e: React.MouseEvent) => {
      const related = e.relatedTarget as Node | null
      if (subMenuRef.current?.contains(related)) return
      scheduleClose()
    },
    [scheduleClose],
  )

  const handleSubLeave = useCallback(
    (e: React.MouseEvent) => {
      const related = e.relatedTarget as Node | null
      if (triggerRef.current?.contains(related)) return
      scheduleClose()
    },
    [scheduleClose],
  )

  useEffect(() => {
    return () => clearTimeout(closeTimeout.current)
  }, [])

  return (
    <div className="py-1">
      <div
        ref={triggerRef}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleTriggerLeave}
        className={cn(
          "flex items-center justify-between gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 rounded-md text-sm cursor-default select-none outline-none transition-colors",
          showSub
            ? "dark:bg-neutral-800 bg-accent text-foreground"
            : "dark:hover:bg-neutral-800 hover:text-foreground",
        )}
      >
        <div className="flex items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span>Thinking</span>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground">
          <span className="text-xs">
            {formatCodexThinkingLabel(selectedThinking)}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        </div>
      </div>

      {showSub &&
        createPortal(
          <div
            ref={subMenuRef}
            onMouseEnter={cancelClose}
            onMouseLeave={handleSubLeave}
            className="fixed z-50 min-w-[180px] overflow-auto rounded-[10px] border border-border bg-popover text-sm text-popover-foreground shadow-lg py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-left-2"
            style={{ top: subPos.top, left: subPos.left }}
          >
            {thinkings.map((thinking) => {
              const isSelected = selectedThinking === thinking
              return (
                <button
                  key={thinking}
                  onClick={() => onSelectThinking(thinking)}
                  className="flex items-center justify-between gap-4 min-h-[32px] py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm cursor-default select-none outline-none dark:hover:bg-neutral-800 hover:text-foreground transition-colors"
                >
                  <span>{formatCodexThinkingLabel(thinking)}</span>
                  {isSelected && (
                    <CheckIcon className="h-3.5 w-3.5 shrink-0" />
                  )}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}

export function AgentModelSelector({
  open,
  onOpenChange,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedModelLabel,
  triggerClassName,
  contentClassName,
  onOpenModelsSettings,
  claude,
  codex,
  askcodi,
}: AgentModelSelectorProps) {
  const [search, setSearch] = useState("")

  // Build visible tabs dynamically: AskCodi always first, others only if connected
  const visibleTabs = useMemo(() => {
    const tabs: { id: AgentProviderId; label: string }[] = [
      { id: "askcodi", label: "AskCodi" },
    ]
    if (claude.isConnected) {
      tabs.push({ id: "claude-code", label: "Claude" })
    }
    if (codex.isConnected) {
      tabs.push({ id: "codex", label: "Codex" })
    }
    return tabs
  }, [claude.isConnected, codex.isConnected])

  // Fall back to "askcodi" if selected provider tab is no longer visible
  const activeTab = visibleTabs.some((t) => t.id === selectedAgentId)
    ? selectedAgentId
    : "askcodi"

  // Sync fallback back to parent if needed
  useEffect(() => {
    if (activeTab !== selectedAgentId) {
      onSelectedAgentIdChange(activeTab)
    }
  }, [activeTab, selectedAgentId, onSelectedAgentIdChange])

  const getProviderConnected = (id: AgentProviderId): boolean => {
    switch (id) {
      case "claude-code": return claude.isConnected
      case "codex": return codex.isConnected
      case "askcodi": return askcodi?.isConnected ?? false
    }
  }

  // Build flat list of models for the active tab only
  const filteredByProvider = useMemo<FlatModelItem[]>(() => {
    const items: FlatModelItem[] = []

    switch (activeTab) {
      case "claude-code":
        if (claude.isOffline && claude.ollamaModels.length > 0) {
          for (const m of claude.ollamaModels) {
            items.push({
              type: "ollama",
              modelName: m,
              isRecommended: m === claude.recommendedOllamaModel,
            })
          }
        } else if (claude.hasCustomModelConfig) {
          items.push({ type: "custom" })
        } else {
          for (const m of claude.models) {
            items.push({ type: "claude", model: m })
          }
        }
        break
      case "codex":
        for (const m of codex.models) {
          items.push({ type: "codex", model: m })
        }
        break
      case "askcodi":
        if (askcodi) {
          for (const m of askcodi.models) {
            items.push({ type: "askcodi", model: m })
          }
        }
        break
    }

    return items
  }, [activeTab, claude, codex, askcodi])

  // Filter by search
  const filteredModels = useMemo(() => {
    if (!search.trim()) return filteredByProvider
    const q = search.toLowerCase().trim()
    return filteredByProvider.filter((item) => {
      switch (item.type) {
        case "claude":
          return (
            item.model.name.toLowerCase().includes(q) ||
            item.model.version.toLowerCase().includes(q) ||
            `${item.model.name} ${item.model.version}`.toLowerCase().includes(q)
          )
        case "codex":
          return item.model.name.toLowerCase().includes(q)
        case "askcodi":
          return item.model.name.toLowerCase().includes(q) || "askcodi".includes(q)
        case "ollama":
          return item.modelName.toLowerCase().includes(q)
        case "custom":
          return "custom model".includes(q)
      }
    })
  }, [filteredByProvider, search])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen)
      if (!nextOpen) {
        setSearch("")
      }
    },
    [onOpenChange],
  )

  const handleTabClick = (providerId: AgentProviderId) => {
    onSelectedAgentIdChange(providerId)
  }

  const triggerIcon =
    selectedAgentId === "claude-code" &&
    claude.isOffline &&
    claude.ollamaModels.length > 0 ? (
      <Zap className="h-4 w-4" />
    ) : selectedAgentId === "askcodi" ? (
      <AskCodiIcon className="h-3.5 w-3.5" />
    ) : selectedAgentId === "codex" ? (
      <CodexIcon className="h-3.5 w-3.5" />
    ) : (
      <ClaudeCodeIcon className="h-3.5 w-3.5" />
    )

  const isItemSelected = (item: FlatModelItem): boolean => {
    switch (item.type) {
      case "claude":
        return selectedAgentId === "claude-code" && claude.selectedModelId === item.model.id
      case "codex":
        return selectedAgentId === "codex" && codex.selectedModelId === item.model.id
      case "askcodi":
        return selectedAgentId === "askcodi" && askcodi?.selectedModelId === item.model.id
      case "ollama":
        return selectedAgentId === "claude-code" && claude.selectedOllamaModel === item.modelName
      case "custom":
        return selectedAgentId === "claude-code"
    }
  }

  const handleItemClick = (item: FlatModelItem) => {
    switch (item.type) {
      case "claude":
        claude.onSelectModel(item.model.id)
        break
      case "codex":
        codex.onSelectModel(item.model.id)
        break
      case "askcodi":
        askcodi?.onSelectModel(item.model.id)
        break
      case "ollama":
        claude.onSelectOllamaModel(item.modelName)
        break
      case "custom":
        break
    }
    handleOpenChange(false)
  }

  const getItemIcon = (item: FlatModelItem) => {
    switch (item.type) {
      case "claude":
        return <ClaudeCodeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      case "codex":
        return <CodexIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      case "askcodi":
        return <AskCodiIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      case "ollama":
        return <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
      case "custom":
        return <ClaudeCodeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
    }
  }

  const getItemLabel = (item: FlatModelItem): string => {
    switch (item.type) {
      case "claude":
        return `${item.model.name} ${item.model.version}`
      case "codex":
        return item.model.name
      case "askcodi":
        return item.model.name
      case "ollama":
        return item.modelName + (item.isRecommended ? " (recommended)" : "")
      case "custom":
        return "Custom Model"
    }
  }

  const getItemKey = (item: FlatModelItem): string => {
    switch (item.type) {
      case "claude":
        return `claude-${item.model.id}`
      case "codex":
        return `codex-${item.model.id}`
      case "askcodi":
        return `askcodi-${item.model.id}`
      case "ollama":
        return `ollama-${item.modelName}`
      case "custom":
        return "custom"
    }
  }

  const getTabIcon = (id: AgentProviderId) => {
    switch (id) {
      case "claude-code":
        return <ClaudeCodeIcon className="h-3 w-3" />
      case "codex":
        return <CodexIcon className="h-3 w-3" />
      case "askcodi":
        return <AskCodiIcon className="h-3 w-3" />
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm text-muted-foreground transition-[background-color,color] duration-150 ease-out rounded-md outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
            "hover:text-foreground hover:bg-muted/50",
            triggerClassName,
          )}
        >
          {triggerIcon}
          <span className="truncate">{selectedModelLabel}</span>
          <IconChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-64 p-0", contentClassName)}
        align="start"
      >
        <Command shouldFilter={false}>
          {/* Provider tabs */}
          <div className="flex items-center gap-0.5 px-1.5 pt-1.5 pb-1">
            {visibleTabs.map((tab) => {
              const isActive = activeTab === tab.id
              const isConnected = getProviderConnected(tab.id)
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabClick(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors relative",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  )}
                >
                  {getTabIcon(tab.id)}
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full shrink-0",
                      isConnected ? "bg-green-500" : "bg-muted-foreground/30",
                    )}
                  />
                </button>
              )
            })}
          </div>

          <CommandInput
            placeholder="Search models..."
            value={search}
            onValueChange={setSearch}
          />

          {/* Claude thinking toggle — only when Claude tab active */}
          {activeTab === "claude-code" &&
            !claude.isOffline &&
            !claude.hasCustomModelConfig && (
            <>
              <div
                className="flex items-center justify-between min-h-[32px] py-[5px] px-1.5 mx-1"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1.5">
                  <ThinkingIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm">Thinking</span>
                </div>
                <Switch
                  checked={claude.thinkingEnabled}
                  onCheckedChange={claude.onThinkingChange}
                  className="scale-75"
                />
              </div>
              <CommandSeparator />
            </>
          )}

          {/* Codex thinking level selector — only when Codex tab active */}
          {activeTab === "codex" && (() => {
            const selectedCodexModel = codex.models.find((m) => m.id === codex.selectedModelId) || codex.models[0]
            if (!selectedCodexModel) return null
            return (
              <>
                <CodexThinkingSubMenu
                  thinkings={selectedCodexModel.thinkings}
                  selectedThinking={codex.selectedThinking}
                  onSelectThinking={codex.onSelectThinking}
                />
                <CommandSeparator />
              </>
            )
          })()}

          <CommandList className="max-h-[300px] overflow-y-auto">
            {filteredModels.length > 0 ? (
              <CommandGroup>
                {filteredModels.map((item) => {
                  const selected = isItemSelected(item)
                  return (
                    <CommandItem
                      key={getItemKey(item)}
                      value={getItemKey(item)}
                      onSelect={() => handleItemClick(item)}
                      className="gap-2"
                    >
                      {getItemIcon(item)}
                      <span className="truncate flex-1">{getItemLabel(item)}</span>
                      {selected && (
                        <CheckIcon className="h-4 w-4 shrink-0" />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : (
              <CommandEmpty>No models found.</CommandEmpty>
            )}
          </CommandList>

          {onOpenModelsSettings && (
            <div className="border-t border-border/50 py-1">
              <button
                onClick={() => {
                  onOpenModelsSettings()
                  handleOpenChange(false)
                }}
                className="flex items-center gap-1.5 min-h-[32px] py-[5px] px-1.5 mx-1 w-[calc(100%-8px)] rounded-md text-sm cursor-default select-none outline-none dark:hover:bg-neutral-800 hover:text-foreground transition-colors"
              >
                <span className="flex-1 text-left">Add Models</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

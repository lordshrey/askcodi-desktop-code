import { useAtom } from "jotai"
import { Puzzle, X } from "lucide-react"
import { useMemo } from "react"
import { Button } from "../../../components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import { trpc } from "../../../lib/trpc"
import { chatPluginIdAtomFamily } from "../atoms"

interface PluginModeSelectorProps {
  chatId: string
}

export function PluginModeSelector({ chatId }: PluginModeSelectorProps) {
  const [pluginId, setPluginId] = useAtom(chatPluginIdAtomFamily(chatId))
  const { data: plugins } = trpc.plugins.listForPluginMode.useQuery()
  const setPluginModeMutation = trpc.chats.setPluginMode.useMutation()

  const activePlugin = useMemo(
    () => plugins?.find((p) => p.source === pluginId),
    [plugins, pluginId],
  )

  const handleSelect = (source: string | null) => {
    setPluginId(source)
    setPluginModeMutation.mutate({ chatId, pluginId: source })
  }

  if (!plugins || plugins.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={activePlugin ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1.5 text-xs"
        >
          <Puzzle className="h-3.5 w-3.5" />
          {activePlugin ? activePlugin.name : "Plugin"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <div className="flex flex-col gap-0.5">
          {activePlugin && (
            <button
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => handleSelect(null)}
            >
              <X className="h-3.5 w-3.5" />
              No Plugin
            </button>
          )}
          {plugins.map((plugin) => (
            <button
              key={plugin.source}
              className={`flex flex-col items-start rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground ${
                plugin.source === pluginId
                  ? "bg-accent text-accent-foreground"
                  : ""
              }`}
              onClick={() => handleSelect(plugin.source)}
            >
              <span className="font-medium">{plugin.name}</span>
              {plugin.description && (
                <span className="text-xs text-muted-foreground line-clamp-1">
                  {plugin.description}
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

import { useEffect, useRef, useState } from "react"
import { trpc } from "@/lib/trpc"

interface RunConsoleEvent {
  id: number
  runId: string
  seq: number
  eventType: string
  stream: string
  level: string | null
  message: string | null
  payload: Record<string, unknown> | null
  createdAt: Date | string | null
}

interface RunConsoleProps {
  runId: string
  /** Max events to keep in memory. Older events are dropped from the view. */
  maxEvents?: number
}

const STREAM_COLOR: Record<string, string> = {
  stdout: "text-foreground",
  stderr: "text-red-400",
  system: "text-blue-400",
}

const META_LINE_COLOR = "text-muted-foreground"

function isTerminal(value: unknown): value is { type: "terminal"; status: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "terminal"
  )
}

/**
 * Real-time console for a run. Uses a tRPC subscription to receive events as they're
 * persisted; replays any events that landed before mount via the same subscription
 * (the backend backfills from `sinceSeq`).
 *
 * Events for "meta" / "tool_call" types are summarized in a single line so the
 * console doesn't drown in JSON. Click an event to expand the full payload.
 */
export function RunConsole({ runId, maxEvents = 500 }: RunConsoleProps) {
  const [events, setEvents] = useState<RunConsoleEvent[]>([])
  const [terminalStatus, setTerminalStatus] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  // Track seen seqs in a Set so dedup is O(1) per event instead of O(n) — at
  // 50 events/sec the array.some() walk was the dominant render cost.
  const seenSeqsRef = useRef<Set<number>>(new Set())

  trpc.agentRuns.subscribeEvents.useSubscription(
    { runId, sinceSeq: -1 },
    {
      onData: (data) => {
        if (isTerminal(data)) {
          setTerminalStatus(data.status)
          return
        }
        const ev = data as RunConsoleEvent
        if (seenSeqsRef.current.has(ev.seq)) return
        seenSeqsRef.current.add(ev.seq)
        setEvents((prev) => {
          const next = [...prev, ev]
          return next.length > maxEvents ? next.slice(next.length - maxEvents) : next
        })
      },
      onError: (err) => {
        // eslint-disable-next-line no-console
        console.error("[run-console] subscription error:", err)
      },
    },
  )

  // Auto-scroll to bottom when new events land.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events.length])

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/50">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Console
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {events.length} events
          {terminalStatus && (
            <span className="ml-2 capitalize text-foreground">· {terminalStatus}</span>
          )}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="max-h-96 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
      >
        {events.length === 0 ? (
          <div className="text-muted-foreground italic">
            {terminalStatus ? "No events recorded." : "Waiting for output..."}
          </div>
        ) : (
          events.map((ev) => {
            const isMeta =
              ev.eventType !== "stdout" && ev.eventType !== "stderr"
            const isExpanded = expandedIds.has(ev.id)
            const colorClass = isMeta
              ? META_LINE_COLOR
              : STREAM_COLOR[ev.stream] ?? "text-foreground"
            return (
              <div key={ev.id} className={colorClass}>
                {isMeta ? (
                  <button
                    type="button"
                    className="block w-full text-left hover:bg-muted/40"
                    onClick={() => {
                      setExpandedIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(ev.id)) next.delete(ev.id)
                        else next.add(ev.id)
                        return next
                      })
                    }}
                  >
                    <span className="opacity-70">[{ev.eventType}]</span>{" "}
                    {summarizeMeta(ev)}
                    {isExpanded && ev.payload && (
                      <pre className="mt-1 ml-4 whitespace-pre-wrap text-[10px] opacity-80">
                        {JSON.stringify(ev.payload, null, 2)}
                      </pre>
                    )}
                  </button>
                ) : (
                  <pre className="whitespace-pre-wrap">{ev.message}</pre>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function summarizeMeta(ev: RunConsoleEvent): string {
  const payload = ev.payload as Record<string, unknown> | null
  if (!payload) return ev.message ?? ""
  const type =
    typeof payload.type === "string"
      ? payload.type
      : ev.eventType
  const data = (payload.data ?? payload) as Record<string, unknown>
  switch (type) {
    case "tool_call": {
      const name = typeof data.name === "string" ? data.name : "tool"
      return `tool_call: ${name}`
    }
    case "tool_result":
    case "tool_error": {
      const id = typeof data.toolUseId === "string" ? data.toolUseId.slice(0, 8) : ""
      return `${type}${id ? ` (${id}…)` : ""}`
    }
    case "command_execution": {
      const cmd = typeof data.command === "string" ? data.command : ""
      return `bash: ${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}`
    }
    case "file_change": {
      const changes = Array.isArray(data.changes) ? data.changes.length : 0
      return `file_change: ${changes} change${changes === 1 ? "" : "s"}`
    }
    case "thinking":
      return "thinking…"
    case "lifecycle":
      return `lifecycle: ${data.phase ?? "?"}`
    default:
      return type
  }
}

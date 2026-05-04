import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
} from "lucide-react"
import { formatTimeAgo } from "@/lib/utils/format-time-ago"

// Renderer-side status metadata. Status-set constants + terminal helpers live
// in src/shared/orchestrator/run-status.ts so the main process can use them too;
// this file owns the icon + color mappings (lucide-react is renderer-only).
export {
  TERMINAL_ISSUE_STATUSES,
  TERMINAL_RUN_STATUSES,
  isTerminalIssueStatus,
  isTerminalRunStatus,
} from "../../../shared/orchestrator/run-status"

export const ISSUE_STATUS_META: Record<
  string,
  { Icon: typeof Circle; color: string; label: string }
> = {
  backlog: { Icon: Circle, color: "text-muted-foreground", label: "Backlog" },
  todo: { Icon: Circle, color: "text-rose-400", label: "Todo" },
  in_progress: { Icon: CircleDot, color: "text-amber-400", label: "In progress" },
  in_review: { Icon: CircleDashed, color: "text-blue-400", label: "In review" },
  blocked: { Icon: CircleX, color: "text-red-500", label: "Blocked" },
  done: { Icon: CircleCheck, color: "text-emerald-500", label: "Done" },
  cancelled: { Icon: CircleX, color: "text-muted-foreground", label: "Cancelled" },
}

export const RUN_STATUS_DOT: Record<string, string> = {
  queued: "bg-muted-foreground/40",
  running: "bg-emerald-500 animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-muted-foreground/40",
  timed_out: "bg-amber-500",
  scheduled_retry: "bg-blue-400",
}

export const AGENT_STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  running: "bg-emerald-500 animate-pulse",
  paused: "bg-amber-400",
  terminated: "bg-red-500/60",
  pending_approval: "bg-blue-400",
}

/** Standardized "5m ago" formatter with em-dash for null. */
export function timeAgo(d: Date | string | null | undefined): string {
  return formatTimeAgo(d, { suffix: " ago", nullLabel: "—" })
}

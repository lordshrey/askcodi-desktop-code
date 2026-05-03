interface FormatTimeAgoOptions {
  /** Suffix appended to non-"now" outputs, e.g. " ago" → "5m ago". Default: "". */
  suffix?: string
  /** What to render for sub-minute durations. Default: "now". */
  nowLabel?: string
  /** What to render for null/undefined input. Default: same as nowLabel. */
  nullLabel?: string
}

/**
 * Format a timestamp as a relative time string (e.g., "5m", "3h", "2d").
 * Pass `{ suffix: " ago" }` for "5m ago" formatting.
 */
export function formatTimeAgo(
  timestamp: Date | string | null | undefined,
  options: FormatTimeAgoOptions = {},
): string {
  const { suffix = "", nowLabel = "now", nullLabel } = options
  if (!timestamp) return nullLabel ?? nowLabel

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 60) return nowLabel

  const minute = 60
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day

  let unit: string
  if (diff >= year) unit = `${Math.floor(diff / year)}y`
  else if (diff >= month) unit = `${Math.floor(diff / month)}mo`
  else if (diff >= day) unit = `${Math.floor(diff / day)}d`
  else if (diff >= hour) unit = `${Math.floor(diff / hour)}h`
  else unit = `${Math.floor(diff / minute)}m`

  return unit + suffix
}

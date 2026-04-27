/**
 * Thin HTTP client for the askcodi-gateway swarm endpoints.
 *
 * v0.1 production note: the gateway base URL is read from MAIN_VITE_GATEWAY_URL
 * with a localhost fallback for dev. Production wiring (TLS, auth header
 * format, retry policy) is TODO before public launch.
 *
 * All calls fail open: a downed gateway must not break the user's session.
 * Fingerprint fetch returns null on any failure (callers fall back to the
 * cold-start subagent prompt). Quality event POSTs swallow errors and log.
 */
import type { CodebaseFingerprint, QualityEvent } from "./types"

const DEFAULT_TIMEOUT_MS = 5000

function getGatewayBaseUrl(): string {
  // import.meta.env is populated by electron-vite at build time.
  const fromEnv =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.MAIN_VITE_GATEWAY_URL
  return fromEnv || "http://127.0.0.1:8001"
}

function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  abortMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(abortMessage)), timeoutMs)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export type GatewayClientOptions = {
  baseUrl?: string
  timeoutMs?: number
  authToken?: string | null
  /** Injectable fetch for tests; defaults to global fetch. */
  fetch?: typeof fetch
}

/**
 * Fetches the codebase fingerprint for a project. Returns null on:
 * - 404 (gateway has no fingerprint yet — cold start)
 * - 5xx
 * - network error / timeout
 *
 * Never throws.
 */
export async function getFingerprint(
  projectId: string,
  opts: GatewayClientOptions = {},
): Promise<CodebaseFingerprint | null> {
  const baseUrl = opts.baseUrl ?? getGatewayBaseUrl()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetch ?? fetch
  const url = `${baseUrl}/v1/swarm/fingerprint/${encodeURIComponent(projectId)}`

  try {
    const res = await withTimeout(
      fetchImpl(url, {
        method: "GET",
        headers: opts.authToken
          ? { "x-desktop-token": opts.authToken }
          : undefined,
      }),
      timeoutMs,
      "swarm getFingerprint timeout",
    )

    if (res.status === 404) return null
    if (!res.ok) {
      console.warn(`[swarm] getFingerprint ${res.status}`)
      return null
    }
    const body = (await res.json()) as CodebaseFingerprint
    return body
  } catch (err) {
    console.warn("[swarm] getFingerprint failed:", (err as Error).message)
    return null
  }
}

/**
 * POSTs a batch of quality events. Fire-and-forget: returns true on success,
 * false on failure. Never throws. Events are dropped on hard failure (the
 * data is not critical to the user's session).
 */
export async function postQualityEvents(
  events: QualityEvent[],
  opts: GatewayClientOptions = {},
): Promise<boolean> {
  if (events.length === 0) return true
  const baseUrl = opts.baseUrl ?? getGatewayBaseUrl()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetch ?? fetch
  const url = `${baseUrl}/v1/swarm/quality-events`

  try {
    const res = await withTimeout(
      fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.authToken ? { "x-desktop-token": opts.authToken } : {}),
        },
        body: JSON.stringify({ events }),
      }),
      timeoutMs,
      "swarm postQualityEvents timeout",
    )
    if (!res.ok) {
      console.warn(`[swarm] postQualityEvents ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.warn("[swarm] postQualityEvents failed:", (err as Error).message)
    return false
  }
}

/**
 * Sends a freshly-scanned fingerprint to the gateway. Best-effort.
 */
export async function postFingerprint(
  fingerprint: CodebaseFingerprint,
  opts: GatewayClientOptions = {},
): Promise<boolean> {
  const baseUrl = opts.baseUrl ?? getGatewayBaseUrl()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = opts.fetch ?? fetch
  const url = `${baseUrl}/v1/swarm/fingerprint`

  try {
    const res = await withTimeout(
      fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.authToken ? { "x-desktop-token": opts.authToken } : {}),
        },
        body: JSON.stringify(fingerprint),
      }),
      timeoutMs,
      "swarm postFingerprint timeout",
    )
    if (!res.ok) {
      console.warn(`[swarm] postFingerprint ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.warn("[swarm] postFingerprint failed:", (err as Error).message)
    return false
  }
}

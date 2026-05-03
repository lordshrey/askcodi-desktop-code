// Classification of adapter execution errors. The heartbeat retry policy uses
// `errorFamily: "transient_upstream"` to schedule bounded retries (2m, 10m, 30m, 2h).
//
// "transient" means: the same prompt would likely succeed if retried later. Network
// blips, provider rate limits, server-side 5xx. Anything else (auth, syntax, invalid
// model) is permanent and retrying will not help.

const TRANSIENT_PATTERN =
  /rate.?limit|server.?error|upstream|timeout|ECONNRESET|EAI_AGAIN/i

export function isTransientUpstreamError(message: string | undefined | null): boolean {
  if (!message) return false
  return TRANSIENT_PATTERN.test(message)
}

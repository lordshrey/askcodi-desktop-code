// In-process Promise-based mutex per runtime agent.
//
// Protects against the same agent starting two runs concurrently within this Electron
// process (e.g. a user double-click and a timer tick firing simultaneously). For single-
// instance Electron this is sufficient. If you ever fork to multi-process, swap this
// for an advisory DB lock — the contract here is "serialize fn() per agentId".
//
// Lifted from paperclip's server/src/services/agent-start-lock.ts. Same pattern.

interface LockEntry {
  promise: Promise<void>
  startedAtMs: number
}

const startLocksByAgent = new Map<string, LockEntry>()

const STALE_LOCK_MS = 5 * 60 * 1000  // safety: assume any lock > 5min is stale

function waitForAgentStartLock(agentId: string, entry: LockEntry): Promise<void> {
  const ageMs = Date.now() - entry.startedAtMs
  if (ageMs > STALE_LOCK_MS) {
    // Stale lock detected — clear it. Almost certainly the previous holder crashed.
    if (startLocksByAgent.get(agentId) === entry) {
      startLocksByAgent.delete(agentId)
    }
    return Promise.resolve()
  }
  return entry.promise
}

/**
 * Run `fn` exclusively per `agentId`. If another caller already holds the lock for the
 * same agent, this waits until they finish. The lock auto-releases when fn() resolves
 * or rejects. Stale locks (>5min) are forcibly cleared.
 *
 * Usage: `await withAgentStartLock(agent.id, () => startNextQueuedRunForAgent(agent.id))`
 */
export async function withAgentStartLock<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = startLocksByAgent.get(agentId)
  const waitForPrevious = previous
    ? waitForAgentStartLock(agentId, previous)
    : Promise.resolve()
  const run = waitForPrevious.then(fn)
  const marker = run.then(
    () => undefined,
    () => undefined,
  )
  startLocksByAgent.set(agentId, { promise: marker, startedAtMs: Date.now() })
  try {
    return await run
  } finally {
    if (startLocksByAgent.get(agentId)?.promise === marker) {
      startLocksByAgent.delete(agentId)
    }
  }
}

export function isAgentStartLocked(agentId: string): boolean {
  return startLocksByAgent.has(agentId)
}

// Test helper. Do not use in production paths.
export function __resetStartLocksForTests(): void {
  startLocksByAgent.clear()
}

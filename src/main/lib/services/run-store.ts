import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"
import * as zlib from "node:zlib"
import { promisify } from "node:util"
import { app } from "electron"
import { eq, sql } from "drizzle-orm"
import {
  getDatabase,
  agentRuns,
  agentRunEvents,
  type NewAgentRunEvent,
} from "../db"

const gzipAsync = promisify(zlib.gzip)

// Run log persistence. Three sinks:
//   1) agent_run_events table  — one row per chunk; queryable, replayable
//   2) bulk log file           — under userData/runs/{runId}.log; gzipped on completion
//   3) live event publisher    — wired by heartbeat service (not here)
//
// MAX_PERSISTED_LOG_CHUNK_CHARS bounds the agent_run_events.message column. Bigger
// chunks truncate there but stay full in the bulk file.

const MAX_PERSISTED_LOG_CHUNK_CHARS = 16 * 1024
const EXCERPT_BYTES = 8 * 1024
const COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024

let runsDirCached: string | null = null

function getRunsDir(): string {
  if (runsDirCached) return runsDirCached
  // app.getPath is unavailable in early test contexts; fall back to a temp dir.
  let userData: string
  try {
    userData = app.getPath("userData")
  } catch {
    userData = path.join(process.cwd(), ".tmp")
  }
  runsDirCached = path.join(userData, "runs")
  return runsDirCached
}

export interface RunLogHandle {
  runId: string
  filePath: string
  bytesWritten: number
  stdoutTail: string[]   // ring buffer of recent stdout chunks for excerpt
  stderrTail: string[]
  fileHandle: fs.FileHandle | null
  /** In-memory monotonic counter so we never re-scan agent_run_events per chunk. */
  nextSeq: number
  /** Throttle for the lastOutputAt update on agent_runs (watchdog only needs ~1s granularity). */
  lastOutputFlushedAtMs: number
}

const handles = new Map<string, RunLogHandle>()

const LAST_OUTPUT_FLUSH_INTERVAL_MS = 1000

export async function openRunLog(runId: string): Promise<RunLogHandle> {
  const existing = handles.get(runId)
  if (existing) return existing
  const dir = getRunsDir()
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${runId}.log`)
  const fileHandle = await fs.open(filePath, "a")
  // Seed nextSeq from the highest existing seq so reopened runs (e.g., crash recovery)
  // continue the sequence rather than colliding with prior rows.
  const db = getDatabase()
  const seqRow = db
    .select({ maxSeq: sql<number>`COALESCE(MAX(${agentRunEvents.seq}), -1)` })
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId))
    .get()
  const handle: RunLogHandle = {
    runId,
    filePath,
    bytesWritten: 0,
    stdoutTail: [],
    stderrTail: [],
    fileHandle,
    nextSeq: (seqRow?.maxSeq ?? -1) + 1,
    lastOutputFlushedAtMs: 0,
  }
  handles.set(runId, handle)
  return handle
}

function pushTail(tail: string[], chunk: string): void {
  tail.push(chunk)
  // crude byte-cap: collapse oldest entries until total ≤ EXCERPT_BYTES
  let total = tail.reduce((sum, s) => sum + s.length, 0)
  while (total > EXCERPT_BYTES && tail.length > 1) {
    const removed = tail.shift()
    total -= removed?.length ?? 0
  }
}

/**
 * Append a chunk to all sinks. Called from the adapter's onLog callback wired by the
 * heartbeat service. Never throws — log failures must not crash a run.
 */
export async function appendRunLog(
  runId: string,
  stream: "stdout" | "stderr",
  chunk: string,
  options?: { eventType?: string; payload?: Record<string, unknown> | null },
): Promise<{ seq: number }> {
  let nextSeq = 0
  try {
    const handle = handles.get(runId) ?? (await openRunLog(runId))
    nextSeq = handle.nextSeq++
    const db = getDatabase()
    const truncated =
      chunk.length > MAX_PERSISTED_LOG_CHUNK_CHARS
        ? chunk.slice(0, MAX_PERSISTED_LOG_CHUNK_CHARS)
        : chunk
    const event: NewAgentRunEvent = {
      runId,
      seq: nextSeq,
      eventType: options?.eventType ?? stream,
      stream,
      message: truncated,
      payload: options?.payload ?? null,
    }
    db.insert(agentRunEvents).values(event).run()

    // Bulk file
    if (handle.fileHandle) {
      const buf = Buffer.from(chunk, "utf8")
      await handle.fileHandle.write(buf)
      handle.bytesWritten += buf.length
    }
    pushTail(stream === "stdout" ? handle.stdoutTail : handle.stderrTail, chunk)

    // Throttle lastOutputAt updates — the watchdog only checks ≥1s granularity, so
    // skipping intermediate updates saves a sync write per chunk on hot streams.
    const nowMs = Date.now()
    if (nowMs - handle.lastOutputFlushedAtMs >= LAST_OUTPUT_FLUSH_INTERVAL_MS) {
      handle.lastOutputFlushedAtMs = nowMs
      db
        .update(agentRuns)
        .set({ lastOutputAt: new Date(nowMs), lastOutputSeq: nextSeq })
        .where(eq(agentRuns.id, runId))
        .run()
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[run-store] appendRunLog failed:", error)
  }
  return { seq: nextSeq }
}

export interface FinalizeRunLogResult {
  logRef: string | null
  logBytes: number
  logCompressed: boolean
  logSha256: string | null
  stdoutExcerpt: string
  stderrExcerpt: string
}

/**
 * Close the file handle, optionally gzip the bulk log, and return excerpts plus
 * persistence metadata so the caller can write to agent_runs.
 */
export async function finalizeRunLog(runId: string): Promise<FinalizeRunLogResult> {
  const handle = handles.get(runId)
  if (!handle) {
    return {
      logRef: null,
      logBytes: 0,
      logCompressed: false,
      logSha256: null,
      stdoutExcerpt: "",
      stderrExcerpt: "",
    }
  }
  try {
    // Flush a final lastOutputAt so the watchdog sees a fresh timestamp at terminus.
    if (handle.lastOutputFlushedAtMs > 0 && handle.nextSeq > 0) {
      try {
        const db = getDatabase()
        db
          .update(agentRuns)
          .set({ lastOutputAt: new Date(), lastOutputSeq: handle.nextSeq - 1 })
          .where(eq(agentRuns.id, runId))
          .run()
      } catch {
        // non-fatal
      }
    }
    if (handle.fileHandle) {
      await handle.fileHandle.close()
      handle.fileHandle = null
    }
    let finalPath = handle.filePath
    let compressed = false
    if (handle.bytesWritten >= COMPRESS_THRESHOLD_BYTES) {
      try {
        const raw = await fs.readFile(handle.filePath)
        const gzipped = await gzipAsync(raw)
        const gzPath = `${handle.filePath}.gz`
        await fs.writeFile(gzPath, gzipped)
        await fs.unlink(handle.filePath)
        finalPath = gzPath
        compressed = true
      } catch (gzError) {
        // eslint-disable-next-line no-console
        console.error("[run-store] gzip failed; keeping uncompressed:", gzError)
      }
    }
    let sha256: string | null = null
    let bytes = 0
    try {
      const buf = await fs.readFile(finalPath)
      bytes = buf.length
      sha256 = crypto.createHash("sha256").update(buf).digest("hex")
    } catch {
      // file may have rolled / been removed; non-fatal
    }
    const stdoutExcerpt = handle.stdoutTail.join("").slice(-EXCERPT_BYTES)
    const stderrExcerpt = handle.stderrTail.join("").slice(-EXCERPT_BYTES)
    handles.delete(runId)
    return {
      logRef: finalPath,
      logBytes: bytes,
      logCompressed: compressed,
      logSha256: sha256,
      stdoutExcerpt,
      stderrExcerpt,
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[run-store] finalizeRunLog failed:", error)
    handles.delete(runId)
    return {
      logRef: null,
      logBytes: 0,
      logCompressed: false,
      logSha256: null,
      stdoutExcerpt: "",
      stderrExcerpt: "",
    }
  }
}

// Test helper.
export function __resetRunStoreForTests(): void {
  for (const handle of handles.values()) {
    void handle.fileHandle?.close()
  }
  handles.clear()
  runsDirCached = null
}

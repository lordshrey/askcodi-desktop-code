/**
 * Tests for the gateway client. Uses an injectable fetch so we never hit a
 * real network. Verifies the fail-open contract (network errors and HTTP
 * failures never throw — they return null/false and log).
 */
import { describe, it, expect, vi } from "vitest"
import {
  getFingerprint,
  postQualityEvents,
  postFingerprint,
} from "../gateway-client"
import type { CodebaseFingerprint, QualityEvent } from "../types"

const baseUrl = "http://gateway.test"

const fingerprint: CodebaseFingerprint = {
  project_id: "p1",
  scanned_at: "2026-04-27T12:00:00Z",
  language_breakdown: { ".ts": 10 },
  top_level_dirs: ["src"],
  package_manifests: [],
  frameworks_detected: [],
  total_files: 10,
  total_size_bytes: 1024,
}

const event: QualityEvent = {
  session_id: "s1",
  tool_call_id: "t1",
  subagent_type: "swarm_explore",
  outcome: "unknown",
  detection_method: null,
  latency_ms: 500,
  input_tokens_haiku: 0,
  output_tokens_haiku: 0,
  frontier_tokens_saved_estimate: null,
  emitted_at: "2026-04-27T12:00:01Z",
}

function makeRes(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response
}

describe("getFingerprint", () => {
  it("returns parsed fingerprint on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, fingerprint))
    const r = await getFingerprint("p1", { baseUrl, fetch: fetchMock })
    expect(r).toEqual(fingerprint)
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/v1/swarm/fingerprint/p1`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("returns null on 404 (cold start)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(404))
    const r = await getFingerprint("p1", { baseUrl, fetch: fetchMock })
    expect(r).toBeNull()
  })

  it("returns null on 5xx without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(503))
    const r = await getFingerprint("p1", { baseUrl, fetch: fetchMock })
    expect(r).toBeNull()
  })

  it("returns null on network error without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ENOTFOUND"))
    const r = await getFingerprint("p1", { baseUrl, fetch: fetchMock })
    expect(r).toBeNull()
  })

  it("returns null on timeout", async () => {
    const fetchMock = vi.fn(
      () => new Promise<Response>(() => undefined), // never resolves
    )
    const r = await getFingerprint("p1", {
      baseUrl,
      fetch: fetchMock,
      timeoutMs: 50,
    })
    expect(r).toBeNull()
  })

  it("URL-encodes the project id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, fingerprint))
    await getFingerprint("p1/with slashes", { baseUrl, fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/v1/swarm/fingerprint/p1%2Fwith%20slashes`,
      expect.anything(),
    )
  })

  it("attaches auth token header when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200, fingerprint))
    await getFingerprint("p1", {
      baseUrl,
      fetch: fetchMock,
      authToken: "tok123",
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { "x-desktop-token": "tok123" },
      }),
    )
  })
})

describe("postQualityEvents", () => {
  it("returns true on success and POSTs the events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(200))
    const ok = await postQualityEvents([event], { baseUrl, fetch: fetchMock })
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/v1/swarm/quality-events`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ events: [event] }),
      }),
    )
  })

  it("returns true and skips fetch when events array is empty", async () => {
    const fetchMock = vi.fn()
    const ok = await postQualityEvents([], { baseUrl, fetch: fetchMock })
    expect(ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns false on 5xx without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(500))
    const ok = await postQualityEvents([event], { baseUrl, fetch: fetchMock })
    expect(ok).toBe(false)
  })

  it("returns false on network error without throwing", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("net"))
    const ok = await postQualityEvents([event], { baseUrl, fetch: fetchMock })
    expect(ok).toBe(false)
  })

  it("returns false on timeout", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined))
    const ok = await postQualityEvents([event], {
      baseUrl,
      fetch: fetchMock,
      timeoutMs: 50,
    })
    expect(ok).toBe(false)
  })
})

describe("postFingerprint", () => {
  it("returns true on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(201))
    const ok = await postFingerprint(fingerprint, { baseUrl, fetch: fetchMock })
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/v1/swarm/fingerprint`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(fingerprint),
      }),
    )
  })

  it("returns false on failure without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRes(500))
    const ok = await postFingerprint(fingerprint, { baseUrl, fetch: fetchMock })
    expect(ok).toBe(false)
  })

  it("returns false on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("net"))
    const ok = await postFingerprint(fingerprint, { baseUrl, fetch: fetchMock })
    expect(ok).toBe(false)
  })
})

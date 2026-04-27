/**
 * Tests for the askcodi.com OAuth auth-manager.
 *
 * This code was previously archived and re-enabled. These tests guard against
 * the same regression that caused the archive — callers rely on
 * isAuthenticated() and getValidToken() returning real values, not no-ops.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"

// ── Mocks ────────────────────────────────────────────────────────────────
// electron has to be mocked because this test runs outside an Electron main
// process. We replace app.getPath and constants the AuthManager touches.

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/askcodi-auth-manager-test",
    getVersion: () => "0.0.0-test",
    isPackaged: false,
  },
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
  shell: { openExternal: vi.fn() },
}))

// import.meta.env isn't available under vitest's default resolver; fake it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).importMeta = { env: {} }

vi.mock("../constants", () => ({
  AUTH_SERVER_PORT: 9999,
}))

// Stub the store so we don't touch the filesystem.
const makeStore = () => {
  let saved: import("../auth-store").AuthData | null = null
  return {
    load: vi.fn(() => saved),
    save: vi.fn((data: import("../auth-store").AuthData) => {
      saved = data
    }),
    clear: vi.fn(() => {
      saved = null
    }),
    getRefreshToken: vi.fn(() => saved?.refreshToken ?? null),
    getUser: vi.fn(() => saved?.user ?? null),
    updateUser: vi.fn(),
    __setInitial: (data: import("../auth-store").AuthData | null) => {
      saved = data
    },
  }
}

type Store = ReturnType<typeof makeStore>
let storeInstance: Store

vi.mock("../auth-store", () => ({
  AuthStore: class {
    constructor() {
      return storeInstance
    }
  },
}))

// Import AFTER mocks are set up.
import { AuthManager } from "../auth-manager"
import type { AuthData } from "../auth-store"

const validSession: AuthData = {
  token: "tok-live",
  refreshToken: "refresh-live",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  user: {
    id: "u_1",
    email: "user@example.com",
    name: "User",
    imageUrl: null,
    username: null,
  },
}

const expiredSession: AuthData = {
  ...validSession,
  expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
}

const nearExpirySession: AuthData = {
  ...validSession,
  token: "tok-stale",
  // 2 min left — inside the 5-min refresh threshold
  expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("AuthManager", () => {
  let fetchMock: Mock

  beforeEach(() => {
    storeInstance = makeStore()
    fetchMock = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = fetchMock
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe("isAuthenticated", () => {
    it("returns false when no session is stored", () => {
      const mgr = new AuthManager()
      expect(mgr.isAuthenticated()).toBe(false)
    })

    it("returns false when stored session is expired", () => {
      storeInstance.__setInitial(expiredSession)
      const mgr = new AuthManager()
      expect(mgr.isAuthenticated()).toBe(false)
    })

    it("returns true for a valid stored session", () => {
      storeInstance.__setInitial(validSession)
      const mgr = new AuthManager()
      expect(mgr.isAuthenticated()).toBe(true)
    })
  })

  describe("getValidToken", () => {
    it("returns null when no session is stored", async () => {
      const mgr = new AuthManager()
      expect(await mgr.getValidToken()).toBe(null)
    })

    it("returns the stored token when far from expiry", async () => {
      storeInstance.__setInitial(validSession)
      const mgr = new AuthManager()
      expect(await mgr.getValidToken()).toBe("tok-live")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("refreshes proactively when within 5 minutes of expiry", async () => {
      storeInstance.__setInitial(nearExpirySession)
      const refreshed: AuthData = {
        ...validSession,
        token: "tok-refreshed",
        refreshToken: "refresh-rotated",
      }
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => refreshed,
      })

      const mgr = new AuthManager()
      const token = await mgr.getValidToken()

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/auth/desktop/refresh"),
        expect.objectContaining({ method: "POST" }),
      )
      expect(token).toBe("tok-refreshed")
    })

    it("returns null and logs out when refresh returns 401", async () => {
      storeInstance.__setInitial(nearExpirySession)
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "expired" }),
      })

      const mgr = new AuthManager()
      const token = await mgr.getValidToken()

      expect(token).toBe(null)
      expect(storeInstance.clear).toHaveBeenCalled()
    })
  })

  describe("exchangeCode", () => {
    it("stores auth data on successful exchange", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => validSession,
      })

      const mgr = new AuthManager()
      const result = await mgr.exchangeCode("abc123")

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/auth/desktop/exchange"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      )
      expect(storeInstance.save).toHaveBeenCalledWith(
        expect.objectContaining({ token: "tok-live" }),
      )
      expect(result.token).toBe("tok-live")
    })

    it("throws with the server error message on 4xx", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "bad code" }),
      })

      const mgr = new AuthManager()
      await expect(mgr.exchangeCode("wrong")).rejects.toThrow("bad code")
      expect(storeInstance.save).not.toHaveBeenCalled()
    })

    it("throws on network failure", async () => {
      fetchMock.mockRejectedValueOnce(new Error("boom"))

      const mgr = new AuthManager()
      await expect(mgr.exchangeCode("abc")).rejects.toThrow("boom")
    })
  })
})

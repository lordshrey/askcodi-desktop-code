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
    getGatewayApiKey: vi.fn(() => saved?.gatewayApiKey ?? null),
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
  gatewayApiKey: "ak-original-key",
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

    it("stores the gatewayApiKey returned by exchange", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...validSession, gatewayApiKey: "ak-fresh-from-exchange" }),
      })

      const mgr = new AuthManager()
      await mgr.exchangeCode("abc123")

      expect(storeInstance.save).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayApiKey: "ak-fresh-from-exchange" }),
      )
    })

    it("normalizes a missing gatewayApiKey in the response to null", async () => {
      // Server sends only token/refreshToken/expiresAt/user (e.g. older
      // build). The normalization in AuthManager should not crash and
      // gatewayApiKey should land as null in storage.
      const { gatewayApiKey: _ignored, ...withoutKey } = validSession
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => withoutKey,
      })

      const mgr = new AuthManager()
      await mgr.exchangeCode("abc123")

      expect(storeInstance.save).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayApiKey: null }),
      )
    })
  })

  // CRITICAL REGRESSION GUARD: refresh must NEVER overwrite the gatewayApiKey.
  // The ak- key is issued exactly once at exchange time and persists for the
  // life of the device session. Re-issuing on refresh would invalidate active
  // gateway calls in flight on the desktop.
  describe("refresh", () => {
    it("preserves the stored gatewayApiKey when the refresh response has no key field", async () => {
      storeInstance.__setInitial(validSession) // ak-original-key
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "tok-refreshed",
          refreshToken: "refresh-rotated",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          user: validSession.user,
          // NO gatewayApiKey in response — server is honest.
        }),
      })

      const mgr = new AuthManager()
      const ok = await mgr.refresh()

      expect(ok).toBe(true)
      // The save call must carry the ORIGINAL gateway key, not undefined or null.
      const savedCall = storeInstance.save.mock.calls.at(-1)?.[0]
      expect(savedCall?.gatewayApiKey).toBe("ak-original-key")
      expect(savedCall?.token).toBe("tok-refreshed")
    })

    it("preserves the stored gatewayApiKey EVEN IF the server mistakenly returns a different one", async () => {
      // Belt-and-suspenders: the server contract says refresh.js never returns
      // a gatewayApiKey, but the desktop side defensively ignores anything in
      // that field on refresh responses.
      storeInstance.__setInitial(validSession) // ak-original-key
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "tok-refreshed",
          refreshToken: "refresh-rotated",
          expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          user: validSession.user,
          gatewayApiKey: "ak-WRONG-must-be-ignored",
        }),
      })

      const mgr = new AuthManager()
      await mgr.refresh()

      const savedCall = storeInstance.save.mock.calls.at(-1)?.[0]
      expect(savedCall?.gatewayApiKey).toBe("ak-original-key")
      expect(savedCall?.gatewayApiKey).not.toBe("ak-WRONG-must-be-ignored")
    })
  })

  describe("logout", () => {
    it("clears local state and calls the server /logout endpoint", async () => {
      storeInstance.__setInitial(validSession)
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      })

      const mgr = new AuthManager()
      await mgr.logout()

      // Local cleared
      expect(storeInstance.clear).toHaveBeenCalled()
      // Server called with both refreshToken and gatewayApiKey for revocation
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/auth/desktop/logout"),
        expect.objectContaining({ method: "POST" }),
      )
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
      expect(body).toEqual({
        refreshToken: "refresh-live",
        gatewayApiKey: "ak-original-key",
      })
    })

    it("still clears local state when the server logout fails", async () => {
      storeInstance.__setInitial(validSession)
      fetchMock.mockRejectedValueOnce(new Error("network down"))

      const mgr = new AuthManager()
      await mgr.logout() // must not throw

      expect(storeInstance.clear).toHaveBeenCalled()
    })

    it("skips the server call when there is no refresh token to revoke", async () => {
      // No initial session — getRefreshToken returns null.
      const mgr = new AuthManager()
      await mgr.logout()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(storeInstance.clear).toHaveBeenCalled()
    })
  })

  describe("getGatewayApiKey", () => {
    it("returns the stored key when present", () => {
      storeInstance.__setInitial(validSession)
      const mgr = new AuthManager()
      expect(mgr.getGatewayApiKey()).toBe("ak-original-key")
    })

    it("returns null when no session is stored", () => {
      const mgr = new AuthManager()
      expect(mgr.getGatewayApiKey()).toBe(null)
    })
  })
})

import { AskCodiAuthStore, type AskCodiAuthData, type AskCodiUser } from "./askcodi-auth-store"
import { app } from "electron"

const ASKCODI_API_BASE = "http://127.0.0.1:8000/v1"

export class AskCodiAuthManager {
  private store: AskCodiAuthStore

  constructor() {
    this.store = new AskCodiAuthStore(app.getPath("userData"))
  }

  /**
   * Validate and store an API key
   * Tests key against /v1/models endpoint
   */
  async setApiKey(apiKey: string): Promise<{ success: boolean; error?: string }> {
    const url = `${ASKCODI_API_BASE}/models`
    console.log(`[AskCodi Auth] Validating API key against: ${url}`)
    console.log(`[AskCodi Auth] API key prefix: ${apiKey.substring(0, 4)}...`)
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      console.log(`[AskCodi Auth] Response status: ${response.status} ${response.statusText}`)

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>")
        console.error(`[AskCodi Auth] Error response body: ${body}`)
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: "Invalid API key" }
        }
        return { success: false, error: `Validation failed: ${response.status}` }
      }

      this.store.save({
        apiKey,
        authMethod: "api-key",
      })
      console.log(`[AskCodi Auth] API key validated and saved`)

      return { success: true }
    } catch (error) {
      const err = error as Error
      console.error(`[AskCodi Auth] Fetch failed:`, err.message)
      console.error(`[AskCodi Auth] Error cause:`, (err as any).cause ?? "none")
      return { success: false, error: `Connection failed: ${err.message}` }
    }
  }

  /**
   * Handle OAuth callback with token data
   */
  setOAuthTokens(data: {
    token: string
    refreshToken: string
    expiresAt: string
    user: AskCodiUser
  }): void {
    this.store.save({
      oauthToken: data.token,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
      user: data.user,
      authMethod: "oauth",
    })
  }

  /**
   * Get a valid credential (API key or OAuth token)
   */
  getValidCredential(): string | null {
    return this.store.getCredential()
  }

  /**
   * Check if any valid credential exists
   */
  isAuthenticated(): boolean {
    return this.store.isAuthenticated()
  }

  /**
   * Get stored user info
   */
  getUser(): AskCodiUser | null {
    return this.store.getUser()
  }

  /**
   * Get auth method
   */
  getAuthMethod(): "oauth" | "api-key" | null {
    return this.store.getAuthMethod()
  }

  /**
   * Get full auth data
   */
  getAuthData(): AskCodiAuthData | null {
    return this.store.load()
  }

  /**
   * Clear all stored credentials
   */
  logout(): void {
    this.store.clear()
  }

  /**
   * Start OAuth flow by opening browser
   */
  startOAuthFlow(): void {
    const { shell } = require("electron")
    // TODO: Replace with actual AskCodi OAuth URL when available
    shell.openExternal("https://askcodi.com/auth/desktop")
  }

  /**
   * Fetch available models from AskCodi API
   */
  async fetchModels(): Promise<Array<{ id: string; name: string }>> {
    const credential = this.getValidCredential()
    if (!credential) {
      console.error("[AskCodi Auth] fetchModels: not authenticated")
      throw new Error("Not authenticated with AskCodi")
    }

    const url = `${ASKCODI_API_BASE}/models`
    console.log(`[AskCodi Auth] fetchModels: ${url}`)
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${credential}` },
    })
    console.log(`[AskCodi Auth] fetchModels response: ${response.status}`)

    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable>")
      console.error(`[AskCodi Auth] fetchModels error body: ${body}`)
      throw new Error(`Failed to fetch models: ${response.status}`)
    }

    const data = await response.json()
    // OpenAI-compatible /models response: { data: [{ id, object, ... }] }
    const models = (data.data || []).map((m: any) => ({
      id: m.id,
      name: m.id, // Use ID as name, can be improved with display names
    }))
    console.log(`[AskCodi Auth] fetchModels: got ${models.length} models`)

    return models
  }
}

// Global singleton
let askCodiAuthManagerInstance: AskCodiAuthManager | null = null

export function initAskCodiAuthManager(): AskCodiAuthManager {
  if (!askCodiAuthManagerInstance) {
    askCodiAuthManagerInstance = new AskCodiAuthManager()
  }
  return askCodiAuthManagerInstance
}

export function getAskCodiAuthManager(): AskCodiAuthManager | null {
  return askCodiAuthManagerInstance
}

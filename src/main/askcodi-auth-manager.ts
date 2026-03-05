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
    try {
      const response = await fetch(`${ASKCODI_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: "Invalid API key" }
        }
        return { success: false, error: `Validation failed: ${response.status}` }
      }

      this.store.save({
        apiKey,
        authMethod: "api-key",
      })

      return { success: true }
    } catch (error) {
      return { success: false, error: `Connection failed: ${(error as Error).message}` }
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
      throw new Error("Not authenticated with AskCodi")
    }

    const response = await fetch(`${ASKCODI_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${credential}` },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`)
    }

    const data = await response.json()
    // OpenAI-compatible /models response: { data: [{ id, object, ... }] }
    const models = (data.data || []).map((m: any) => ({
      id: m.id,
      name: m.id, // Use ID as name, can be improved with display names
    }))

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

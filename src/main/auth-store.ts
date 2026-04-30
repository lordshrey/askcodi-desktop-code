import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { safeStorage } from "electron"

export interface AuthUser {
  id: string
  email: string
  name: string | null
  imageUrl: string | null
  username: string | null
}

export interface AuthData {
  token: string
  refreshToken: string
  expiresAt: string
  user: AuthUser
  // Long-lived ak- key for the AskCodi gateway, issued atomically alongside
  // the JWT by /api/auth/desktop/exchange. Refreshes do NOT touch this. May be
  // null on auth.dat files written by older builds; in that case the user
  // should re-OAuth to obtain one.
  gatewayApiKey: string | null
}

/**
 * Storage for desktop authentication tokens
 * Uses Electron's safeStorage API to encrypt sensitive data using OS keychain
 * Falls back to plaintext only if encryption is unavailable (rare edge case)
 */
export class AuthStore {
  private filePath: string
  // In-memory cache. AuthData lives for the lifetime of the main process and
  // is only mutated through this class, so caching it once avoids repeated
  // OS-keychain decryptions on every getter call.
  private cache: AuthData | null = null
  private cacheLoaded = false

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "auth.dat") // .dat for encrypted data
  }

  private isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  save(data: AuthData): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const jsonData = JSON.stringify(data)

      if (this.isEncryptionAvailable()) {
        // Encrypt using OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service)
        const encrypted = safeStorage.encryptString(jsonData)
        writeFileSync(this.filePath, encrypted)
      } else {
        console.warn("safeStorage not available - storing auth data without encryption")
        writeFileSync(this.filePath + ".json", jsonData, "utf-8")
      }
      this.cache = data
      this.cacheLoaded = true
    } catch (error) {
      console.error("Failed to save auth data:", error)
      throw error
    }
  }

  /**
   * Normalize a parsed AuthData blob so older auth.dat files (pre-gatewayApiKey)
   * still load cleanly. Returns null if the blob is missing required fields.
   */
  private normalize(parsed: unknown): AuthData | null {
    if (!parsed || typeof parsed !== "object") return null
    const obj = parsed as Partial<AuthData>
    if (!obj.token || !obj.refreshToken || !obj.expiresAt || !obj.user) return null
    return {
      token: obj.token,
      refreshToken: obj.refreshToken,
      expiresAt: obj.expiresAt,
      user: obj.user,
      gatewayApiKey: obj.gatewayApiKey ?? null,
    }
  }

  /**
   * Load authentication data (decrypts if encrypted). Cached after the first
   * successful read; mutations go through `save()` / `clear()` which keep the
   * cache in sync.
   */
  load(): AuthData | null {
    if (this.cacheLoaded) return this.cache
    const data = this.loadFromDisk()
    this.cache = data
    this.cacheLoaded = true
    return data
  }

  private loadFromDisk(): AuthData | null {
    try {
      // Try encrypted file first
      if (existsSync(this.filePath) && this.isEncryptionAvailable()) {
        const encrypted = readFileSync(this.filePath)
        const decrypted = safeStorage.decryptString(encrypted)
        return this.normalize(JSON.parse(decrypted))
      }

      // Fallback: try unencrypted file (for migration or when encryption unavailable)
      const fallbackPath = this.filePath + ".json"
      if (existsSync(fallbackPath)) {
        const content = readFileSync(fallbackPath, "utf-8")
        const data = this.normalize(JSON.parse(content))

        // Migrate to encrypted storage if now available
        if (data && this.isEncryptionAvailable()) {
          this.save(data)
          unlinkSync(fallbackPath) // Remove unencrypted file after migration
        }

        return data
      }

      // Legacy: check for old auth.json file and migrate
      const legacyPath = join(dirname(this.filePath), "auth.json")
      if (existsSync(legacyPath)) {
        const content = readFileSync(legacyPath, "utf-8")
        const data = this.normalize(JSON.parse(content))

        // Migrate to encrypted storage
        if (data) {
          this.save(data)
          unlinkSync(legacyPath) // Remove legacy unencrypted file
          console.log("Migrated auth data from plaintext to encrypted storage")
        }

        return data
      }

      return null
    } catch (error) {
      // If the encrypted file exists but can't be decrypted, delete it to stop repeated failures
      if (existsSync(this.filePath)) {
        console.warn("Auth data corrupted, clearing invalid auth.dat file")
        try { unlinkSync(this.filePath) } catch {}
      }
      return null
    }
  }

  /**
   * Clear all stored authentication data (both encrypted and fallback files)
   */
  clear(): void {
    this.cache = null
    this.cacheLoaded = true
    try {
      // Remove encrypted file
      if (existsSync(this.filePath)) {
        unlinkSync(this.filePath)
      }
      // Remove fallback unencrypted file if exists
      const fallbackPath = this.filePath + ".json"
      if (existsSync(fallbackPath)) {
        unlinkSync(fallbackPath)
      }
      // Remove legacy file if exists
      const legacyPath = join(dirname(this.filePath), "auth.json")
      if (existsSync(legacyPath)) {
        unlinkSync(legacyPath)
      }
    } catch (error) {
      console.error("Failed to clear auth data:", error)
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    const data = this.load()
    if (!data) return false

    // Check if token is expired
    const expiresAt = new Date(data.expiresAt).getTime()
    return expiresAt > Date.now()
  }

  /**
   * Get current user if authenticated
   */
  getUser(): AuthUser | null {
    const data = this.load()
    return data?.user ?? null
  }

  /**
   * Get current token if valid
   */
  getToken(): string | null {
    const data = this.load()
    if (!data) return null

    const expiresAt = new Date(data.expiresAt).getTime()
    if (expiresAt <= Date.now()) return null

    return data.token
  }

  /**
   * Get refresh token
   */
  getRefreshToken(): string | null {
    const data = this.load()
    return data?.refreshToken ?? null
  }

  /**
   * Get the AskCodi gateway ak- key, if one was issued at exchange time.
   */
  getGatewayApiKey(): string | null {
    const data = this.load()
    return data?.gatewayApiKey ?? null
  }

  /**
   * Check if token needs refresh (expires in less than 5 minutes)
   */
  needsRefresh(): boolean {
    const data = this.load()
    if (!data) return false

    const expiresAt = new Date(data.expiresAt).getTime()
    const fiveMinutes = 5 * 60 * 1000
    return expiresAt - Date.now() < fiveMinutes
  }

  /**
   * Update user data (e.g., after profile update)
   */
  updateUser(updates: Partial<AuthUser>): AuthUser | null {
    const data = this.load()
    if (!data) return null

    data.user = { ...data.user, ...updates }
    this.save(data)
    return data.user
  }
}

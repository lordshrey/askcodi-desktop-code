import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { safeStorage } from "electron"

export interface AskCodiUser {
  id: string
  email: string
  name: string | null
}

export interface AskCodiAuthData {
  apiKey?: string
  oauthToken?: string
  refreshToken?: string
  expiresAt?: string
  user?: AskCodiUser
  authMethod: "oauth" | "api-key"
}

/**
 * Encrypted storage for AskCodi credentials
 * Uses Electron's safeStorage API to encrypt sensitive data using OS keychain
 */
export class AskCodiAuthStore {
  private filePath: string

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, "askcodi-auth.dat")
  }

  private isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  save(data: AskCodiAuthData): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const jsonData = JSON.stringify(data)

      if (this.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(jsonData)
        writeFileSync(this.filePath, encrypted)
      } else {
        console.warn("safeStorage not available - storing AskCodi auth data without encryption")
        writeFileSync(this.filePath + ".json", jsonData, "utf-8")
      }
    } catch (error) {
      console.error("Failed to save AskCodi auth data:", error)
      throw error
    }
  }

  load(): AskCodiAuthData | null {
    try {
      if (existsSync(this.filePath) && this.isEncryptionAvailable()) {
        const encrypted = readFileSync(this.filePath)
        const decrypted = safeStorage.decryptString(encrypted)
        return JSON.parse(decrypted)
      }

      const fallbackPath = this.filePath + ".json"
      if (existsSync(fallbackPath)) {
        const content = readFileSync(fallbackPath, "utf-8")
        const data = JSON.parse(content)

        if (this.isEncryptionAvailable()) {
          this.save(data)
          unlinkSync(fallbackPath)
        }

        return data
      }

      return null
    } catch {
      console.error("Failed to load AskCodi auth data")
      return null
    }
  }

  clear(): void {
    try {
      if (existsSync(this.filePath)) {
        unlinkSync(this.filePath)
      }
      const fallbackPath = this.filePath + ".json"
      if (existsSync(fallbackPath)) {
        unlinkSync(fallbackPath)
      }
    } catch (error) {
      console.error("Failed to clear AskCodi auth data:", error)
    }
  }

  getApiKey(): string | null {
    const data = this.load()
    return data?.apiKey ?? null
  }

  getCredential(): string | null {
    const data = this.load()
    if (!data) return null

    if (data.authMethod === "api-key") {
      return data.apiKey ?? null
    }

    // OAuth: check expiry
    if (data.oauthToken && data.expiresAt) {
      const expiresAt = new Date(data.expiresAt).getTime()
      if (expiresAt > Date.now()) {
        return data.oauthToken
      }
    }

    return null
  }

  isAuthenticated(): boolean {
    return this.getCredential() !== null
  }

  getUser(): AskCodiUser | null {
    const data = this.load()
    return data?.user ?? null
  }

  getAuthMethod(): "oauth" | "api-key" | null {
    const data = this.load()
    return data?.authMethod ?? null
  }
}

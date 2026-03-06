import { safeStorage, shell } from "electron"
import { getDatabase, integrations } from "../db"
import { eq } from "drizzle-orm"
import { AUTH_SERVER_PORT } from "../../constants"

// GitHub OAuth config
const GITHUB_CLIENT_ID = import.meta.env.MAIN_VITE_GITHUB_CLIENT_ID || ""
const GITHUB_CLIENT_SECRET = import.meta.env.MAIN_VITE_GITHUB_CLIENT_SECRET || ""
const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_SCOPES = "repo read:org"

// Linear OAuth config
const LINEAR_CLIENT_ID = import.meta.env.MAIN_VITE_LINEAR_CLIENT_ID || ""
const LINEAR_CLIENT_SECRET = import.meta.env.MAIN_VITE_LINEAR_CLIENT_SECRET || ""
const LINEAR_AUTH_URL = "https://linear.app/oauth/authorize"
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token"
const LINEAR_SCOPES = "read write"

function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[Integrations] Encryption not available, storing as base64")
    return Buffer.from(token).toString("base64")
  }
  return safeStorage.encryptString(token).toString("base64")
}

export function decryptToken(encrypted: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return Buffer.from(encrypted, "base64").toString("utf-8")
  }
  const buffer = Buffer.from(encrypted, "base64")
  return safeStorage.decryptString(buffer)
}

function getRedirectUri(platform: "github" | "linear"): string {
  return `http://localhost:${AUTH_SERVER_PORT}/oauth/${platform}`
}

export function openGitHubOAuth(): void {
  const redirectUri = getRedirectUri("github")
  const state = Math.random().toString(36).substring(2, 15)
  const url = `${GITHUB_AUTH_URL}?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(GITHUB_SCOPES)}&state=${state}`
  shell.openExternal(url)
}

export function openLinearOAuth(): void {
  const redirectUri = getRedirectUri("linear")
  const state = Math.random().toString(36).substring(2, 15)
  const url = `${LINEAR_AUTH_URL}?client_id=${LINEAR_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(LINEAR_SCOPES)}&response_type=code&state=${state}&prompt=consent`
  shell.openExternal(url)
}

export async function exchangeGitHubCode(code: string): Promise<void> {
  const redirectUri = getRedirectUri("github")

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })

  const data = await response.json()
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`)
  }

  const accessToken = data.access_token as string
  const scope = (data.scope as string) || GITHUB_SCOPES

  // Fetch user info
  const userResponse = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const user = await userResponse.json()

  const db = getDatabase()

  // Delete existing GitHub integration
  const existing = db
    .select()
    .from(integrations)
    .where(eq(integrations.platform, "github"))
    .all()

  for (const row of existing) {
    db.delete(integrations).where(eq(integrations.id, row.id)).run()
  }

  // Store new integration
  db.insert(integrations)
    .values({
      platform: "github",
      accessToken: encryptToken(accessToken),
      scope,
      platformUserId: String(user.id),
      platformUsername: user.login,
    })
    .run()

  console.log("[Integrations] GitHub connected for user:", user.login)
}

export async function exchangeLinearCode(code: string): Promise<void> {
  const redirectUri = getRedirectUri("linear")

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: LINEAR_CLIENT_ID,
      client_secret: LINEAR_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  })

  const data = await response.json()
  if (data.error) {
    throw new Error(`Linear OAuth error: ${data.error_description || data.error}`)
  }

  const accessToken = data.access_token as string
  const scope = Array.isArray(data.scope) ? data.scope.join(" ") : (data.scope as string) || LINEAR_SCOPES

  // Fetch user info via GraphQL
  const userResponse = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken,
    },
    body: JSON.stringify({ query: "{ viewer { id name email } }" }),
  })
  const userData = await userResponse.json()
  const viewer = userData.data?.viewer

  const db = getDatabase()

  // Delete existing Linear integration
  const existing = db
    .select()
    .from(integrations)
    .where(eq(integrations.platform, "linear"))
    .all()

  for (const row of existing) {
    db.delete(integrations).where(eq(integrations.id, row.id)).run()
  }

  // Store new integration
  db.insert(integrations)
    .values({
      platform: "linear",
      accessToken: encryptToken(accessToken),
      refreshToken: data.refresh_token ? encryptToken(data.refresh_token) : null,
      tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
      scope,
      platformUserId: viewer?.id || "",
      platformUsername: viewer?.name || viewer?.email || "",
    })
    .run()

  console.log("[Integrations] Linear connected for user:", viewer?.name || viewer?.email)
}

export function getIntegration(platform: "github" | "linear") {
  const db = getDatabase()
  return db
    .select()
    .from(integrations)
    .where(eq(integrations.platform, platform))
    .get()
}

export function deleteIntegration(platform: "github" | "linear") {
  const db = getDatabase()
  db.delete(integrations).where(eq(integrations.platform, platform)).run()
  console.log(`[Integrations] ${platform} disconnected`)
}

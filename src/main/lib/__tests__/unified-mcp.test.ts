import { describe, it, expect } from "vitest"
import { toCodexSdkMcpConfig, toCodexSdkConfig } from "../unified-mcp"
import type { McpServerConfig } from "../claude-config"

describe("toCodexSdkMcpConfig", () => {
  it("converts stdio server config", () => {
    const servers: Record<string, McpServerConfig> = {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    }

    const result = toCodexSdkMcpConfig(servers)
    expect(result).toEqual({
      context7: {
        enabled: true,
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    })
  })

  it("converts HTTP server config", () => {
    const servers: Record<string, McpServerConfig> = {
      "my-api": {
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer sk-123" },
      },
    }

    const result = toCodexSdkMcpConfig(servers)
    expect(result).toEqual({
      "my-api": {
        enabled: true,
        url: "https://api.example.com/mcp",
        http_headers: { Authorization: "Bearer sk-123" },
      },
    })
  })

  it("strips _oauth fields from config", () => {
    const servers: Record<string, McpServerConfig> = {
      github: {
        url: "https://github.com/mcp",
        authType: "oauth",
        _oauth: {
          accessToken: "secret-token",
          refreshToken: "refresh-token",
          expiresAt: 9999999999,
        },
      },
    }

    const result = toCodexSdkMcpConfig(servers)
    expect(result.github).not.toHaveProperty("_oauth")
    expect(result.github).not.toHaveProperty("authType")
    expect(result.github).toEqual({
      enabled: true,
      url: "https://github.com/mcp",
    })
  })

  it("converts stdio server with env vars", () => {
    const servers: Record<string, McpServerConfig> = {
      "db-server": {
        command: "node",
        args: ["server.js"],
        env: { DATABASE_URL: "postgres://localhost:5432/mydb" },
      },
    }

    const result = toCodexSdkMcpConfig(servers)
    expect(result["db-server"]).toEqual({
      enabled: true,
      command: "node",
      args: ["server.js"],
      env: { DATABASE_URL: "postgres://localhost:5432/mydb" },
    })
  })

  it("handles empty server map", () => {
    expect(toCodexSdkMcpConfig({})).toEqual({})
  })

  it("handles multiple servers", () => {
    const servers: Record<string, McpServerConfig> = {
      server1: { command: "cmd1" },
      server2: { url: "https://example.com" },
    }

    const result = toCodexSdkMcpConfig(servers)
    expect(Object.keys(result)).toEqual(["server1", "server2"])
  })
})

describe("toCodexSdkConfig", () => {
  it("wraps servers in mcp_servers key", () => {
    const servers: Record<string, McpServerConfig> = {
      test: { command: "test-cmd" },
    }

    const result = toCodexSdkConfig(servers)
    expect(result).toEqual({
      mcp_servers: {
        test: {
          enabled: true,
          command: "test-cmd",
        },
      },
    })
  })
})

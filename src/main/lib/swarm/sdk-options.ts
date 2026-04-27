/**
 * Shared SDK option builder. Every algorithm's call to sdk.query needs
 * the same baseline (cwd, permissions, binary path, streaming config).
 * Extracted so algorithms only specify what's distinct (agents,
 * systemPrompt, canUseTool).
 */

export type BaseSdkOptionsInput = {
  cwd: string
  pathToClaudeCodeExecutable: string
}

export function buildBaseSdkOptions(
  input: BaseSdkOptionsInput,
): Record<string, unknown> {
  return {
    cwd: input.cwd,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    includePartialMessages: true,
  }
}

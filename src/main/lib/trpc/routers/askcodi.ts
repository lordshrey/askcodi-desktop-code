import { createOpenAI } from "@ai-sdk/openai"
import { observable } from "@trpc/server/observable"
import { streamText, stepCountIs, type UIMessage } from "ai"
import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  getAskCodiAuthManager,
  initAskCodiAuthManager,
} from "../../../askcodi-auth-manager"
import { createAskCodiTools } from "../../askcodi/tools"
import { getDatabase, subChats } from "../../db"
import { publicProcedure, router } from "../index"

const ASKCODI_API_BASE = "http://127.0.0.1:8001/v1"

const imageAttachmentSchema = z.object({
  base64Data: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
})

type ActiveAskCodiStream = {
  runId: string
  controller: AbortController
  cancelRequested: boolean
}

const activeStreams = new Map<string, ActiveAskCodiStream>()

// Models cache
let cachedModels: Array<{ id: string; name: string }> | null = null
let modelsCachedAt = 0
const MODELS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export function hasActiveAskCodiStreams(): boolean {
  return activeStreams.size > 0
}

export function abortAllAskCodiStreams(): void {
  for (const [subChatId, stream] of activeStreams) {
    console.log(`[askcodi] Aborting stream ${subChatId}`)
    stream.controller.abort()
  }
  activeStreams.clear()
}

function buildUserParts(
  prompt: string,
  images?: Array<{ base64Data: string; mediaType: string; filename?: string }>,
): any[] {
  const parts: any[] = []
  if (prompt) {
    parts.push({ type: "text", text: prompt })
  }
  if (images) {
    for (const img of images) {
      parts.push({
        type: "image",
        image: `data:${img.mediaType};base64,${img.base64Data}`,
      })
    }
  }
  return parts
}

function buildModelMessageContent(
  prompt: string,
  images?: Array<{ base64Data: string; mediaType: string; filename?: string }>,
): any {
  if (!images || images.length === 0) {
    return prompt
  }
  const parts: any[] = [{ type: "text", text: prompt }]
  for (const img of images) {
    parts.push({
      type: "image",
      image: `data:${img.mediaType};base64,${img.base64Data}`,
    })
  }
  return parts
}

export const askcodiRouter = router({
  chat: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        chatId: z.string(),
        runId: z.string(),
        prompt: z.string(),
        cwd: z.string(),
        projectPath: z.string().optional(),
        model: z.string(),
        mode: z.enum(["plan", "agent"]),
        sessionId: z.string().optional(),
        images: z.array(imageAttachmentSchema).optional(),
        apiKey: z.string().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<any>((emit) => {
        const abortController = new AbortController()
        let isActive = true

        const safeEmit = (chunk: any) => {
          if (isActive) {
            try {
              emit.next(chunk)
            } catch {
              // Subscription already closed
            }
          }
        }

        const safeComplete = () => {
          if (isActive) {
            try {
              emit.complete()
            } catch {
              // Already completed
            }
          }
        }

        // Prevent duplicate streams
        const existingStream = activeStreams.get(input.subChatId)
        if (existingStream) {
          existingStream.controller.abort()
          activeStreams.delete(input.subChatId)
        }

        activeStreams.set(input.subChatId, {
          runId: input.runId,
          controller: abortController,
          cancelRequested: false,
        })

        ;(async () => {
          try {
            console.log(`[askcodi] === Chat stream started ===`)
            console.log(`[askcodi] subChatId: ${input.subChatId}, model: ${input.model}, mode: ${input.mode}`)
            console.log(`[askcodi] cwd: ${input.cwd}`)
            console.log(`[askcodi] API base: ${ASKCODI_API_BASE}`)

            // Get credential
            const authManager = getAskCodiAuthManager()
            const apiKey =
              input.apiKey ||
              authManager?.getValidCredential()

            console.log(`[askcodi] API key: ${apiKey ? `${apiKey.slice(0, 8)}...` : "MISSING"}`)

            if (!apiKey) {
              safeEmit({
                type: "auth-error",
                errorText: "AskCodi API key not configured",
              })
              safeEmit({ type: "finish" })
              safeComplete()
              return
            }

            // Load existing messages from DB
            const db = getDatabase()
            const subChat = db
              .select()
              .from(subChats)
              .where(eq(subChats.id, input.subChatId))
              .get()

            let existingMessages: any[] = []
            if (subChat?.messages) {
              try {
                existingMessages = JSON.parse(subChat.messages as string)
              } catch {
                existingMessages = []
              }
            }

            console.log(`[askcodi] Existing messages: ${existingMessages.length}`)

            // Add user message
            const userMessage = {
              id: crypto.randomUUID(),
              role: "user",
              parts: buildUserParts(input.prompt, input.images),
              metadata: { model: input.model, provider: "askcodi" },
            }

            const messagesForStream = [...existingMessages, userMessage]

            // Persist user message immediately
            db.update(subChats)
              .set({
                messages: JSON.stringify(messagesForStream),
                updatedAt: new Date(),
              })
              .where(eq(subChats.id, input.subChatId))
              .run()

            // Create OpenAI-compatible provider for AskCodi
            // Use .chat() to force Chat Completions API format (not Responses API)
            // The AskCodi gateway expects standard OpenAI tool format with nested `function` field
            const openai = createOpenAI({
              baseURL: ASKCODI_API_BASE,
              apiKey,
            })

            // Create tools
            const tools = createAskCodiTools(input.cwd, input.mode)
            const toolNames = Object.keys(tools)
            console.log(`[askcodi] Tools created: ${toolNames.join(", ")} (${toolNames.length} total)`)

            // Log tool schemas for debugging
            for (const [name, t] of Object.entries(tools)) {
              const toolObj = t as any
              const hasInputSchema = !!toolObj.inputSchema
              const hasExecute = typeof toolObj.execute === "function"
              console.log(`[askcodi]   Tool "${name}": inputSchema=${hasInputSchema}, execute=${hasExecute}`)
            }

            const startedAt = Date.now()

            console.log(`[askcodi] Starting streamText with model: ${input.model}`)

            // Stream the response
            const result = streamText({
              model: openai.chat(input.model),
              messages: [
                {
                  role: "user",
                  content: buildModelMessageContent(
                    input.prompt,
                    input.images,
                  ),
                },
              ],
              tools,
              stopWhen: stepCountIs(50),
              abortSignal: abortController.signal,
              onStepFinish: ({ stepType, toolCalls, toolResults, finishReason, text }) => {
                console.log(`[askcodi] Step finished: type=${stepType}, finishReason=${finishReason}`)
                if (text) {
                  console.log(`[askcodi]   Text: ${text.slice(0, 200)}`)
                }
                if (toolCalls) {
                  for (const tc of toolCalls) {
                    console.log(`[askcodi]   Tool call: ${tc.toolName}(${JSON.stringify(tc.args ?? {}).slice(0, 300)})`)
                  }
                }
                if (toolResults) {
                  for (const tr of toolResults) {
                    console.log(`[askcodi]   Tool result [${tr.toolName}]: ${JSON.stringify(tr.result ?? {}).slice(0, 300)}`)
                  }
                }
              },
            })

            console.log(`[askcodi] streamText created, converting to UI stream`)

            const uiStream = result.toUIMessageStream({
              originalMessages: messagesForStream,
              generateMessageId: () => crypto.randomUUID(),
              messageMetadata: ({ part }) => {
                if (part.type === "finish") {
                  return {
                    model: input.model,
                    provider: "askcodi",
                    durationMs: Date.now() - startedAt,
                    resultSubtype:
                      part.finishReason === "error" ? "error" : "success",
                  }
                }
                return { model: input.model, provider: "askcodi" }
              },
              onFinish: async ({ responseMessage, isContinuation }) => {
                console.log(`[askcodi] Stream onFinish: isContinuation=${isContinuation}`)
                try {
                  const messagesToPersist = [
                    ...(isContinuation
                      ? messagesForStream.slice(0, -1)
                      : messagesForStream),
                    responseMessage,
                  ]

                  db.update(subChats)
                    .set({
                      messages: JSON.stringify(messagesToPersist),
                      updatedAt: new Date(),
                    })
                    .where(eq(subChats.id, input.subChatId))
                    .run()
                  console.log(`[askcodi] Messages persisted (${messagesToPersist.length} total)`)
                } catch (error) {
                  console.error(
                    "[askcodi] Failed to persist messages:",
                    error,
                  )
                }
              },
              onError: (error) => {
                console.error(`[askcodi] UI stream onError:`, error)
                if (error instanceof Error) return error.message
                return String(error)
              },
            })

            // Read and emit chunks
            const reader = uiStream.getReader()
            let pendingFinishChunk: any | null = null
            let chunkCount = 0

            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              chunkCount++

              if (chunkCount <= 5 || chunkCount % 20 === 0) {
                console.log(`[askcodi] Chunk #${chunkCount}: type=${value?.type}`, value?.type === "error" ? value : "")
              }

              if (value?.type === "error") {
                const errorText =
                  value.errorText || value.error || "Unknown error"
                console.error(`[askcodi] Error chunk received:`, JSON.stringify(value).slice(0, 500))
                // Check for auth errors
                if (
                  typeof errorText === "string" &&
                  (errorText.includes("401") ||
                    errorText.includes("403") ||
                    errorText.includes("unauthorized") ||
                    errorText.includes("invalid api key"))
                ) {
                  safeEmit({ ...value, type: "auth-error", errorText })
                } else {
                  safeEmit({ ...value, errorText })
                }
                continue
              }

              if (value?.type === "finish") {
                pendingFinishChunk = value
                continue
              }

              safeEmit(value)
            }

            console.log(`[askcodi] Stream complete. Total chunks: ${chunkCount}`)

            if (pendingFinishChunk) {
              safeEmit(pendingFinishChunk)
            } else {
              safeEmit({ type: "finish" })
            }

            safeComplete()
          } catch (error) {
            console.error("[askcodi] chat stream CAUGHT error:", error)
            if (error instanceof Error && error.stack) {
              console.error("[askcodi] Stack:", error.stack)
            }
            if (error && typeof error === "object" && "cause" in error) {
              console.error("[askcodi] Cause:", (error as any).cause)
            }
            const errorMsg =
              error instanceof Error ? error.message : String(error)

            if (
              errorMsg.includes("401") ||
              errorMsg.includes("403") ||
              errorMsg.includes("unauthorized")
            ) {
              safeEmit({ type: "auth-error", errorText: errorMsg })
            } else {
              safeEmit({ type: "error", errorText: errorMsg })
            }
            safeEmit({ type: "finish" })
            safeComplete()
          } finally {
            const activeStream = activeStreams.get(input.subChatId)
            if (activeStream?.runId === input.runId) {
              activeStreams.delete(input.subChatId)
            }
          }
        })()

        return () => {
          isActive = false
          abortController.abort()

          const activeStream = activeStreams.get(input.subChatId)
          if (activeStream?.runId === input.runId) {
            activeStream.cancelRequested = true
          }
        }
      })
    }),

  cancel: publicProcedure
    .input(
      z.object({
        subChatId: z.string(),
        runId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const activeStream = activeStreams.get(input.subChatId)
      if (!activeStream) {
        return { cancelled: false }
      }

      if (activeStream.runId !== input.runId) {
        return { cancelled: false }
      }

      activeStream.cancelRequested = true
      activeStream.controller.abort()
      return { cancelled: true }
    }),

  cleanup: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(({ input }) => {
      const activeStream = activeStreams.get(input.subChatId)
      if (activeStream) {
        activeStream.controller.abort()
        activeStreams.delete(input.subChatId)
      }
      return { ok: true }
    }),

  models: publicProcedure.query(async () => {
    // Return cached models if fresh
    if (cachedModels && Date.now() - modelsCachedAt < MODELS_CACHE_TTL) {
      return cachedModels
    }

    const authManager = getAskCodiAuthManager()
    if (!authManager) {
      return []
    }

    try {
      const models = await authManager.fetchModels()
      cachedModels = models
      modelsCachedAt = Date.now()
      return models
    } catch (error) {
      console.error("[askcodi] Failed to fetch models:", error)
      return cachedModels || []
    }
  }),

  validateApiKey: publicProcedure
    .input(z.object({ apiKey: z.string() }))
    .mutation(async ({ input }) => {
      const authManager = getAskCodiAuthManager() || initAskCodiAuthManager()
      return authManager.setApiKey(input.apiKey)
    }),

  getAuthStatus: publicProcedure.query(() => {
    const authManager = getAskCodiAuthManager()
    if (!authManager) {
      return { authenticated: false, method: null, user: null }
    }
    return {
      authenticated: authManager.isAuthenticated(),
      method: authManager.getAuthMethod(),
      user: authManager.getUser(),
    }
  }),

  logout: publicProcedure.mutation(() => {
    const authManager = getAskCodiAuthManager()
    if (authManager) {
      authManager.logout()
      cachedModels = null
      modelsCachedAt = 0
    }
    return { ok: true }
  }),
})

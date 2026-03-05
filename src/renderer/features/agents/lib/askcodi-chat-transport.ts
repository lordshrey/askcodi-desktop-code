import type { ChatTransport, UIMessage } from "ai"
import { toast } from "sonner"
import { appStore } from "../../../lib/jotai-store"
import { trpcClient } from "../../../lib/trpc"
import { askCodiApiKeyAtom, askCodiLoginModalOpenAtom } from "../../../lib/atoms"
import {
  pendingAuthRetryMessageAtom,
  subChatAskCodiModelIdAtomFamily,
} from "../atoms"
import type { AgentMessageMetadata } from "../ui/agent-message-usage"
import { useAgentSubChatStore } from "../stores/sub-chat-store"

type UIMessageChunk = any

type AskCodiChatTransportConfig = {
  chatId: string
  subChatId: string
  cwd: string
  projectPath?: string
  mode: "plan" | "agent"
  provider: "askcodi"
}

type ImageAttachment = {
  base64Data: string
  mediaType: string
  filename?: string
}

const forceFreshSessionSubChats = new Set<string>()
const DEFAULT_ASKCODI_MODEL = "askcodi-default"

function getSelectedAskCodiModel(subChatId: string): string {
  const selectedModelId = appStore.get(
    subChatAskCodiModelIdAtomFamily(subChatId),
  )
  return selectedModelId || DEFAULT_ASKCODI_MODEL
}

export class AskCodiChatTransport implements ChatTransport<UIMessage> {
  constructor(private config: AskCodiChatTransportConfig) {}

  async sendMessages(options: {
    messages: UIMessage[]
    abortSignal?: AbortSignal
  }): Promise<ReadableStream<UIMessageChunk>> {
    const lastUser = [...options.messages]
      .reverse()
      .find((message) => message.role === "user")

    const prompt = this.extractText(lastUser)
    const images = this.extractImages(lastUser)

    const lastAssistant = [...options.messages]
      .reverse()
      .find((message) => message.role === "assistant")
    const metadata = lastAssistant?.metadata as
      | AgentMessageMetadata
      | undefined
    const sessionId = metadata?.sessionId

    const currentMode =
      useAgentSubChatStore
        .getState()
        .allSubChats.find(
          (subChat) => subChat.id === this.config.subChatId,
        )?.mode || this.config.mode

    const forceNewSession = forceFreshSessionSubChats.has(
      this.config.subChatId,
    )
    if (forceNewSession) {
      forceFreshSessionSubChats.delete(this.config.subChatId)
    }

    const apiKey = appStore.get(askCodiApiKeyAtom) || undefined
    const selectedModel = getSelectedAskCodiModel(this.config.subChatId)

    return new ReadableStream({
      start: (controller) => {
        const runId = crypto.randomUUID()
        let sub: { unsubscribe: () => void } | null = null
        let didUnsubscribe = false

        const safeUnsubscribe = () => {
          if (didUnsubscribe) return
          didUnsubscribe = true
          sub?.unsubscribe()
        }

        sub = trpcClient.askcodi.chat.subscribe(
          {
            subChatId: this.config.subChatId,
            chatId: this.config.chatId,
            runId,
            prompt,
            cwd: this.config.cwd,
            ...(this.config.projectPath
              ? { projectPath: this.config.projectPath }
              : {}),
            model: selectedModel,
            mode: currentMode,
            ...(sessionId ? { sessionId } : {}),
            ...(images.length > 0 ? { images } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
          {
            onData: (chunk: UIMessageChunk) => {
              if (chunk.type === "auth-error") {
                forceFreshSessionSubChats.add(this.config.subChatId)

                appStore.set(pendingAuthRetryMessageAtom, {
                  subChatId: this.config.subChatId,
                  provider: "askcodi" as any,
                  prompt,
                  ...(images.length > 0 && { images }),
                  readyToRetry: false,
                })

                appStore.set(askCodiLoginModalOpenAtom, true)

                void trpcClient.askcodi.cleanup
                  .mutate({ subChatId: this.config.subChatId })
                  .catch(() => {})

                controller.error(
                  new Error("AskCodi authentication required"),
                )
                return
              }

              if (chunk.type === "error") {
                toast.error("AskCodi error", {
                  description:
                    chunk.errorText || "An unexpected error occurred.",
                })
              }

              try {
                controller.enqueue(chunk)
              } catch {
                // Stream already closed
              }

              if (chunk.type === "finish") {
                try {
                  controller.close()
                } catch {
                  // Stream already closed
                }
              }
            },
            onError: (error: Error) => {
              toast.error("AskCodi request failed", {
                description: error.message,
              })
              controller.error(error)
              safeUnsubscribe()
            },
            onComplete: () => {
              try {
                controller.close()
              } catch {
                // Stream already closed
              }
              safeUnsubscribe()
            },
          },
        )

        options.abortSignal?.addEventListener("abort", () => {
          const cancelPromise = trpcClient.askcodi.cancel
            .mutate({
              subChatId: this.config.subChatId,
              runId,
            })
            .catch(() => {})

          try {
            controller.close()
          } catch {
            // Stream already closed
          }

          void cancelPromise.finally(() => {
            setTimeout(() => safeUnsubscribe(), 5000)
          })
        })
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null
  }

  cleanup(): void {
    void trpcClient.askcodi.cleanup
      .mutate({ subChatId: this.config.subChatId })
      .catch(() => {})
  }

  private extractText(message: UIMessage | undefined): string {
    if (!message?.parts) return ""

    const textParts: string[] = []
    const fileContents: string[] = []

    for (const part of message.parts) {
      if (part.type === "text" && (part as any).text) {
        textParts.push((part as any).text)
      } else if ((part as any).type === "file-content") {
        const filePart = part as any
        const fileName =
          filePart.filePath?.split("/").pop() || filePart.filePath || "file"
        fileContents.push(`\n--- ${fileName} ---\n${filePart.content}`)
      }
    }

    return textParts.join("\n") + fileContents.join("")
  }

  private extractImages(message: UIMessage | undefined): ImageAttachment[] {
    if (!message?.parts) return []

    const images: ImageAttachment[] = []

    for (const part of message.parts) {
      if (part.type === "data-image" && (part as any).data) {
        const data = (part as any).data
        if (data.base64Data && data.mediaType) {
          images.push({
            base64Data: data.base64Data,
            mediaType: data.mediaType,
            filename: data.filename,
          })
        }
      }
    }

    return images
  }
}

import { useEffect, useRef } from "react"
import { useAtomValue } from "jotai"
import { selectedProjectAtom } from "@/features/agents/atoms"
import { trpc } from "@/lib/trpc"

/**
 * Auto-hires the founding engineer when a project is selected.
 *
 * - Idempotent: server-side `ensureFoundingEngineer` returns the existing row if
 *   one already exists for the project.
 * - Per-project memoization in this hook prevents redundant calls within a session
 *   even though the server is the source of truth.
 * - Mounted once at the orchestrator layout level. The chat layout doesn't trigger
 *   this — only orchestrator users hire a founding engineer.
 */
export function useEnsureFoundingEngineer(): void {
  const project = useAtomValue(selectedProjectAtom)
  const utils = trpc.useUtils()
  const ensureMutation = trpc.runtimeAgents.ensureFoundingEngineer.useMutation({
    onSuccess: () => {
      void utils.runtimeAgents.list.invalidate()
    },
  })
  const lastEnsuredProjectId = useRef<string | null>(null)

  useEffect(() => {
    if (!project?.id) return
    if (lastEnsuredProjectId.current === project.id) return
    lastEnsuredProjectId.current = project.id
    ensureMutation.mutate({ projectId: project.id })
    // ensureMutation is intentionally omitted from deps — we want exactly one call
    // per project change; including it would re-fire on every render while the
    // mutation result is in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])
}

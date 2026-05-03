import { createTRPCReact } from "@trpc/react-query"
import { createTRPCProxyClient } from "@trpc/client"
import { ipcLink } from "trpc-electron/renderer"
import type { AppRouter } from "../../main/lib/trpc/routers"
import type { inferRouterOutputs, inferRouterInputs } from "@trpc/server"
import superjson from "superjson"

/**
 * Inferred router output types — use for typing component props that consume
 * tRPC query data without re-declaring the shape.
 *
 *   const { data } = trpc.issues.list.useQuery()  // typed automatically
 *   type Issue = RouterOutputs["issues"]["list"][number]
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>
export type RouterInputs = inferRouterInputs<AppRouter>

/**
 * React hooks for tRPC
 */
export const trpc = createTRPCReact<AppRouter>()

/**
 * Vanilla client for use outside React components (stores, utilities)
 */
export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
})
